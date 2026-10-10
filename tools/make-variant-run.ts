/**
 * Runs payloads through variants of one real Make scenario and records each run id
 * and what the webhook caller got back. The scenario's own blueprint is put back at
 * the end, so its recorded reference runs still describe it.
 *
 *   node tools/make-variant-run.ts corpus/cases/C2.variants.json
 *
 * Set file: { name, scenarioId, hook (scenario letter in .make-hooks.json), restore, targets?, variants: [{ blueprint, payloads: [{ case, ... }] }] }
 * run: "webhook" (default; needs `hook`) or "api": Make's "run once" endpoint, for
 * scenarios without a webhook trigger. That endpoint needs an active scenario, so api
 * mode first sets the schedule to on-demand (active, but it only runs when asked) and
 * puts the original schedule back at the end.
 * targets: other scenarios the variants call (e.g. an echo webhook for HTTP probes),
 * as { scenarioId, blueprint, restore }. They are patched and started first, then
 * stopped and restored at the end. Free plan: at most 2 active scenarios.
 * Output:   corpus/responses/<name>.runs.json. The bundles themselves are session-only
 * (see tools/extract-reference.ts for how they are pulled and turned into cases).
 * Each payload costs one credit per module operation.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { hookUrl, makeToken } from './lib/make-account.ts';

const ZONE = 'https://eu1.make.com/api/v2';
const API_GAP_MS = 2500;
const token = makeToken();

interface VariantSet {
  name: string;
  scenarioId: number;
  hook?: string;
  run?: 'webhook' | 'api';
  restore: string;
  targets?: { scenarioId: number; blueprint: string; restore: string }[];
  variants: { blueprint: string; payloads: { case: string }[] }[];
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  await sleep(API_GAP_MS);
  const res = await fetch(`${ZONE}${path}`, {
    method,
    headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node tools/make-variant-run.ts <variants.json>');
  const set: VariantSet = JSON.parse(readFileSync(file, 'utf8'));
  const id = set.scenarioId;
  const runs: { case: string; blueprint: string; runId: string | null; response: { status: number; body: string }; error: unknown }[] = [];

  const start = async () => {
    const r = await api('POST', `/scenarios/${id}/start`);
    if (r.status !== 200 && !r.text.includes('IM306')) throw new Error(`start failed: ${r.status} ${r.text.slice(0, 300)}`); // IM306: already running
  };

  let originalScheduling: string | null = null;
  try {
    if (set.run === 'api') {
      const sc = await api('GET', `/scenarios/${id}`);
      originalScheduling = JSON.stringify(sc.json.scenario.scheduling);
      const r = await api('PATCH', `/scenarios/${id}`, { scheduling: JSON.stringify({ type: 'on-demand' }) });
      if (r.status !== 200) throw new Error(`setting on-demand scheduling failed: ${r.status} ${r.text.slice(0, 300)}`);
    }
    for (const t of set.targets ?? []) {
      await api('POST', `/scenarios/${t.scenarioId}/stop`);
      const patched = await api('PATCH', `/scenarios/${t.scenarioId}`, { blueprint: readFileSync(t.blueprint, 'utf8') });
      if (patched.status !== 200) throw new Error(`PATCH target ${t.blueprint} failed: ${patched.status} ${patched.text.slice(0, 300)}`);
      const started = await api('POST', `/scenarios/${t.scenarioId}/start`);
      if (started.status !== 200) throw new Error(`start target ${t.scenarioId} failed: ${started.status} ${started.text.slice(0, 300)}`);
    }
    for (const variant of set.variants) {
      await api('POST', `/scenarios/${id}/stop`);
      const patched = await api('PATCH', `/scenarios/${id}`, { blueprint: readFileSync(variant.blueprint, 'utf8') });
      if (patched.status !== 200) throw new Error(`PATCH ${variant.blueprint} failed: ${patched.status} ${patched.text.slice(0, 300)}`);
      for (const payload of variant.payloads) {
        const before = Date.now();
        let response: { status: number; body: string };
        if (set.run === 'api') {
          await start();
          const r = await api('POST', `/scenarios/${id}/run`, { responsive: true });
          response = { status: r.status, body: r.text.slice(0, 500) };
        } else {
          // Make switches a scenario off after a failed run; start it before every payload.
          await start();
          const res = await fetch(hookUrl(set.hook!), { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) });
          response = { status: res.status, body: await res.text() };
        }
        let run: any = null;
        for (let attempt = 0; attempt < 6 && !run; attempt++) {
          await sleep(2000);
          const logs = await api('GET', `/scenarios/${id}/logs?pg%5Blimit%5D=5`);
          run = logs.json.scenarioLogs.find((l: any) => l.eventType === 'EXECUTION_END' && Date.parse(l.timestamp) >= before - 2000) ?? null;
        }
        if (!run && set.run === 'api') {
          // A run with nothing to process (e.g. a trigger with no bundles) is not listed in
          // the scenario log at all (T-05); its execution id still comes back from /run.
          const executionId = response.status === 200 ? (JSON.parse(response.body) as { executionId?: string }).executionId : undefined;
          if (!executionId) throw new Error(`${payload.case}: the run failed to start (${response.status} ${response.body.slice(0, 200)}); stopping`);
          run = { id: executionId, error: null, notInLog: true };
        }
        if (!run) {
          const hook = await api('GET', `/scenarios/${id}`);
          const queued = (await api('GET', `/hooks/${hook.json.scenario.hookId}`)).json.hook.queueCount;
          throw new Error(`${payload.case}: no run appeared (${queued} webhook(s) queued); stopping`);
        }
        runs.push({ case: payload.case, blueprint: variant.blueprint, runId: run.id, response, error: run.error ?? null, ...(run.notInLog ? { notInLog: true } : {}) });
        console.log(`${payload.case}: run ${run.id} → ${response.status} ${JSON.stringify(response.body).slice(0, 90)}${run.error ? ` ${JSON.stringify(run.error)}` : ''}`);
      }
    }
  } finally {
    for (const t of set.targets ?? []) {
      await api('POST', `/scenarios/${t.scenarioId}/stop`);
      const r = await api('PATCH', `/scenarios/${t.scenarioId}`, { blueprint: readFileSync(t.restore, 'utf8') });
      if (r.status !== 200) console.error(`TARGET RESTORE FAILED (${t.scenarioId}): ${r.status} ${r.text.slice(0, 300)}`);
    }
    await api('POST', `/scenarios/${id}/stop`);
    const restored = await api('PATCH', `/scenarios/${id}`, { blueprint: readFileSync(set.restore, 'utf8'), ...(originalScheduling ? { scheduling: originalScheduling } : {}) });
    if (restored.status !== 200) console.error(`RESTORE FAILED: ${restored.status} ${restored.text.slice(0, 300)}`);
    const out = `corpus/responses/${set.name}.runs.json`;
    writeFileSync(out, `${JSON.stringify({ name: set.name, scenarioId: id, recordedAt: new Date().toISOString(), runs }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}

await main();

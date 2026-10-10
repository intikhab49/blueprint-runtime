/**
 * Runs payloads through variants of one real Make scenario and records each run id
 * and what the webhook caller got back. The scenario's own blueprint is put back at
 * the end, so its recorded reference runs still describe it.
 *
 *   node tools/make-variant-run.ts corpus/cases/C2.variants.json
 *
 * Set file: { name, scenarioId, hook (scenario letter in .make-hooks.json), restore, targets?, variants: [{ blueprint, payloads: [{ case, ... }] }] }
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
  hook: string;
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

  try {
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
        // Make switches a scenario off after a failed run; start it before every payload.
        await start();
        const before = Date.now();
        const res = await fetch(hookUrl(set.hook), { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) });
        const response = { status: res.status, body: await res.text() };
        let run: any = null;
        for (let attempt = 0; attempt < 6 && !run; attempt++) {
          await sleep(2000);
          const logs = await api('GET', `/scenarios/${id}/logs?pg%5Blimit%5D=5`);
          run = logs.json.scenarioLogs.find((l: any) => l.eventType === 'EXECUTION_END' && Date.parse(l.timestamp) >= before - 2000) ?? null;
        }
        if (!run) {
          const hook = await api('GET', `/scenarios/${id}`);
          const queued = (await api('GET', `/hooks/${hook.json.scenario.hookId}`)).json.hook.queueCount;
          throw new Error(`${payload.case}: no run appeared (${queued} webhook(s) queued); stopping`);
        }
        runs.push({ case: payload.case, blueprint: variant.blueprint, runId: run.id, response, error: run.error ?? null });
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
    const restored = await api('PATCH', `/scenarios/${id}`, { blueprint: readFileSync(set.restore, 'utf8') });
    if (restored.status !== 200) console.error(`RESTORE FAILED: ${restored.status} ${restored.text.slice(0, 300)}`);
    const out = `corpus/responses/${set.name}.runs.json`;
    writeFileSync(out, `${JSON.stringify({ name: set.name, scenarioId: id, recordedAt: new Date().toISOString(), runs }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}

await main();

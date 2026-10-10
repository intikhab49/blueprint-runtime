/**
 * Probes filter conditions on a real Make router scenario (scenario B).
 *
 *   node tools/make-filter-probe.ts <probe-set.json>
 *
 * Each probe becomes one route on a router: its first module (a Set variable) carries
 * the probe's filter, so one run evaluates every probe and Make's run log records
 * each decision (passed or stopped, with a per-condition report).
 *
 * Phase 1 finds probes Make rejects outright (an unknown operator fails scenario
 * validation) by bisection. Phase 2 runs every accepted probe once per payload.
 * The decisions themselves are in Make's run log, which only a logged-in browser
 * can read; the run ids are written out for that step.
 *
 * Output: corpus/responses/<name>.runs.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { FIRST_PROBE_MODULE, probeBlueprint, type FilterProbe, type FilterProbeSet } from './lib/filter-probe-blueprint.ts';
import { hookUrl, makeToken } from './lib/make-account.ts';

const ZONE = 'https://eu1.make.com/api/v2';
const SCENARIO = 7872008;
const HOOK_URL = hookUrl('B');
const TEMPLATE = 'corpus/blueprints/B.blueprint.json';
const API_GAP_MS = 2500;

const token = makeToken();

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

async function load(set: FilterProbeSet, probes: FilterProbe[]) {
  await api('POST', `/scenarios/${SCENARIO}/stop`);
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const bp = { ...template, ...probeBlueprint(template.flow[0], set, probes) };
  const patched = await api('PATCH', `/scenarios/${SCENARIO}`, { blueprint: JSON.stringify(bp) });
  if (patched.status !== 200) throw new Error(`PATCH failed: ${patched.status} ${patched.text.slice(0, 300)}`);
  const started = await api('POST', `/scenarios/${SCENARIO}/start`);
  if (started.status !== 200) throw new Error(`start failed: ${started.status} ${started.text.slice(0, 300)}`);
}

/** Send one payload and return Make's record of the run it caused. */
async function send(payload: unknown): Promise<{ runId: string; status: number; error: { name: string; message: string } | null }> {
  const before = Date.now();
  const res = await fetch(HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) });
  await res.text();
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(2000);
    const logs = await api('GET', `/scenarios/${SCENARIO}/logs?pg%5Blimit%5D=5`);
    const run = logs.json.scenarioLogs.find((l: any) => l.eventType === 'EXECUTION_END' && Date.parse(l.timestamp) >= before - 2000);
    if (run) return { runId: run.id, status: run.status, error: run.error ?? null };
  }
  const hook = await api('GET', `/scenarios/${SCENARIO}?cols%5B%5D=hookId`);
  const queued = (await api('GET', `/hooks/${hook.json.scenario.hookId}`)).json.hook.queueCount;
  throw new Error(`no run appeared for the payload (${queued} webhook(s) queued); stopping`);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node tools/make-filter-probe.ts <probe-set.json>');
  const set: FilterProbeSet = JSON.parse(readFileSync(file, 'utf8'));
  const [firstPayload] = Object.values(set.payloads);
  const rejected: Record<string, string> = {};

  // Phase 1: bisection until every remaining probe passes Make's validation.
  const validate = async (probes: FilterProbe[]): Promise<FilterProbe[]> => {
    if (probes.length === 0) return [];
    await load(set, probes);
    const r = await send(firstPayload);
    if (!r.error || r.error.name !== 'BlueprintValidationError') return probes;
    if (probes.length === 1) {
      rejected[probes[0]!.key] = r.error.message;
      console.log(`rejected ${probes[0]!.key}: ${r.error.message}`);
      return [];
    }
    const mid = Math.ceil(probes.length / 2);
    return [...(await validate(probes.slice(0, mid))), ...(await validate(probes.slice(mid)))];
  };

  const runs: { payload: string; runId: string; status: number; error: unknown }[] = [];
  let accepted: FilterProbe[] = [];
  try {
    accepted = await validate(set.probes);
    console.log(`${accepted.length} probes accepted, ${Object.keys(rejected).length} rejected`);
    // Phase 2: every accepted probe, once per payload.
    await load(set, accepted);
    for (const [name, payload] of Object.entries(set.payloads)) {
      const r = await send(payload);
      runs.push({ payload: name, ...r });
      console.log(`${name}: run ${r.runId} status ${r.status}${r.error ? ` ${JSON.stringify(r.error)}` : ''}`);
    }
  } finally {
    await api('POST', `/scenarios/${SCENARIO}/stop`);
    // Put scenario B back the way its recorded reference runs were made.
    await api('PATCH', `/scenarios/${SCENARIO}`, { blueprint: readFileSync(TEMPLATE, 'utf8') });
    const out = `corpus/responses/${set.name}.runs.json`;
    writeFileSync(out, `${JSON.stringify({ name: set.name, scenarioId: SCENARIO, firstProbeModule: FIRST_PROBE_MODULE, accepted: accepted.map((p) => p.key), rejected, runs }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}

await main();

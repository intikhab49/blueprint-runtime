/**
 * Runs expression probes on a real Make scenario and records Make's answers.
 *
 *   node tools/make-probe.ts <probe-set.json>
 *
 * The probe set is { "name", "payload", "probes": [[key, expression], ...] }.
 * All probes go into the body of scenario D's webhook response, the payload is sent
 * to its webhook, and each "key=<<value>>" line Make returns is recorded. One bad
 * expression fails the whole run, so a failing batch is split in half and re-run until
 * every probe has either a value or Make's exact error message.
 *
 * Needs .make-token (Make API token with scenarios read/write). Uses about 2 credits per run.
 * Output: corpus/responses/<name>.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { hookUrl, makeToken } from './lib/make-account.ts';

const ZONE = 'https://eu1.make.com/api/v2';
const SCENARIO = 7872039;
const HOOK_URL = hookUrl('D');
const TEMPLATE = 'corpus/blueprints/D.blueprint.json';
const API_GAP_MS = 2500; // the free plan allows 30 API calls a minute

interface ProbeSet {
  name: string;
  payload: unknown;
  probes: [string, string][];
}

type Answer = { value: string } | { error: { name: string; message: string } } | { invalid: string } | { http: number; body: string };

const token = makeToken();

class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  await sleep(API_GAP_MS);
  const res = await fetch(`${ZONE}${path}`, {
    method,
    headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, text, `${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Put the probes into the scenario and switch it on. Make accepts the start even when
 * an expression is invalid; it validates when a run begins, fails that run ("Scenario
 * validation failed") and switches the scenario off. So the scenario is restarted
 * before every run, and the failure itself is read from the run log.
 */
async function load(probes: [string, string][]): Promise<string | null> {
  await stop();
  await setBody(probes);
  try {
    await api('POST', `/scenarios/${SCENARIO}/start`);
    return null;
  } catch (e) {
    if (e instanceof ApiError && e.status < 500) return e.body;
    throw e;
  }
}

async function stop() {
  try {
    await api('POST', `/scenarios/${SCENARIO}/stop`);
  } catch (e) {
    if (!(e instanceof ApiError && e.body.includes('IM307'))) throw e; // already stopped
  }
}

async function setBody(probes: [string, string][]) {
  const bp = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  bp.name = 'bpr Scenario D (function probe)';
  bp.flow[1].mapper.body = probes.map(([k, e]) => `${k}=<<{{${e}}}>>`).join('\n');
  await api('PATCH', `/scenarios/${SCENARIO}`, { blueprint: JSON.stringify(bp) });
}

async function latestError(): Promise<{ name: string; message: string } | null> {
  const logs = await api('GET', `/scenarios/${SCENARIO}/logs?pg%5Blimit%5D=5`);
  const end = logs.scenarioLogs.find((l: any) => l.eventType === 'EXECUTION_END');
  return end?.error ?? null;
}

async function send(payload: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.text() };
}

type BatchFailure = { invalid: string } | { error: { name: string; message: string } | null; http: number; body: string };

async function runBatch(probes: [string, string][], payload: unknown): Promise<Map<string, Answer> | BatchFailure> {
  const invalid = await load(probes);
  if (invalid !== null) return { invalid };
  const r = await send(payload);
  // "Accepted" means Make queued the webhook instead of running the scenario. Never keep sending then.
  if (r.status === 200 && r.body === 'Accepted') throw new Error('Make queued the webhook (scenario not running); stopping to avoid filling the queue');
  if (r.status !== 200) {
    await sleep(3000);
    return { error: await latestError(), http: r.status, body: r.body };
  }
  const values = new Map<string, Answer>([...r.body.matchAll(/^(\w+)=<<(.*?)>>$/gms)].map((m) => [m[1]!, { value: m[2]! }]));
  for (const [k] of probes) if (!values.has(k)) values.set(k, { http: r.status, body: r.body.slice(0, 200) });
  return values;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node tools/make-probe.ts <probe-set.json>');
  const set: ProbeSet = JSON.parse(readFileSync(file, 'utf8'));
  const answers: Record<string, Answer & { expr: string }> = {};
  let runs = 0;
  // Bisection: a failing batch is split in half until each failure is a single probe.
  const solve = async (probes: [string, string][]): Promise<void> => {
    if (probes.length === 0) return;
    runs++;
    const batch = await runBatch(probes, set.payload);
    if (batch instanceof Map) {
      for (const [k, e] of probes) answers[k] = { expr: e, ...batch.get(k)! };
      console.log(`ok   ${probes.length} probe(s): ${probes.map(([k]) => k).join(' ')}`);
      return;
    }
    if (probes.length === 1) {
      const [k, e] = probes[0]!;
      answers[k] = 'invalid' in batch ? { expr: e, invalid: batch.invalid } : { expr: e, ...(batch.error ? { error: batch.error } : { http: batch.http, body: batch.body }) };
      console.log(`fail ${k}: ${JSON.stringify(answers[k])}`);
      return;
    }
    const mid = Math.ceil(probes.length / 2);
    await solve(probes.slice(0, mid));
    await solve(probes.slice(mid));
  };
  try {
    await solve(set.probes);
    console.log(`${runs} Make runs`);
  } finally {
    await stop();
    mkdirSync('corpus/responses', { recursive: true });
    const out = `corpus/responses/${set.name}.json`;
    const missing = set.probes.filter(([k]) => !(k in answers)).map(([k]) => k);
    writeFileSync(out, `${JSON.stringify({ name: set.name, recordedAt: new Date().toISOString(), timezone: 'Asia/Karachi', payload: set.payload, answers, missing }, null, 2)}\n`);
    console.log(`wrote ${out}${missing.length ? ` (${missing.length} probes without an answer)` : ''}`);
  }
}

await main();

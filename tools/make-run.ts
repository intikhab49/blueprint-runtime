/**
 * Sends payloads through a real Make scenario and records what came back.
 *
 *   node tools/make-run.ts <scenario-id> <hook-url> <out.json> <payload.json>...
 *
 * The scenario is started before every payload (Make switches a scenario off after
 * a failed run) and stopped at the end. If Make ever queues a webhook instead of
 * running it, the tool stops at once so the queue does not fill up.
 * Each payload costs one credit per module that runs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { hookUrl, makeToken } from './lib/make-account.ts';

const ZONE = 'https://eu1.make.com/api/v2';
const API_GAP_MS = 2500;
const token = makeToken();

async function api(method: string, path: string): Promise<{ status: number; body: string }> {
  await sleep(API_GAP_MS);
  const res = await fetch(`${ZONE}${path}`, { method, headers: { Authorization: `Token ${token}` } });
  return { status: res.status, body: await res.text() };
}

async function main() {
  const [scenarioId, hook, out, ...payloads] = process.argv.slice(2);
  const url = hook && /^[A-Z]$/.test(hook) ? hookUrl(hook) : hook;
  if (!scenarioId || !url || !out || payloads.length === 0) throw new Error('usage: node tools/make-run.ts <scenario-id> <hook-url> <out.json> <payload.json>...');
  const results: Record<string, unknown> = {};
  try {
    for (const file of payloads) {
      const name = basename(file, '.json');
      const start = await api('POST', `/scenarios/${scenarioId}/start`);
      if (start.status !== 200 && !start.body.includes('IM306')) throw new Error(`start failed: ${start.status} ${start.body}`); // IM306: already running
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: readFileSync(file) });
      const body = await res.text();
      // "Accepted" is ambiguous: Make sends it for a queued webhook, and also when a
      // Webhook response module returns an empty body (corpus A-004). Check the queue.
      if (res.status === 200 && body === 'Accepted') {
        const hookId = JSON.parse((await api('GET', `/scenarios/${scenarioId}?cols%5B%5D=hookId`)).body).scenario.hookId;
        const queued = JSON.parse((await api('GET', `/hooks/${hookId}`)).body).hook.queueCount;
        if (queued > 0) throw new Error(`${name}: Make queued the webhook instead of running it (${queued} in queue); stopping`);
      }
      let error: unknown = null;
      if (res.status !== 200) {
        await sleep(3000);
        const logs = JSON.parse((await api('GET', `/scenarios/${scenarioId}/logs?pg%5Blimit%5D=5`)).body);
        error = logs.scenarioLogs.find((l: { eventType?: string }) => l.eventType === 'EXECUTION_END')?.error ?? null;
      }
      results[name] = { response: { status: res.status, body }, error };
      console.log(`${name}: ${res.status} ${JSON.stringify(body).slice(0, 80)}${error ? ` ${JSON.stringify(error)}` : ''}`);
    }
  } finally {
    const stop = await api('POST', `/scenarios/${scenarioId}/stop`);
    if (stop.status !== 200 && !stop.body.includes('IM307')) console.error(`stop failed: ${stop.status} ${stop.body}`);
    writeFileSync(out, `${JSON.stringify({ scenarioId: Number(scenarioId), recordedAt: new Date().toISOString(), results }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}

await main();

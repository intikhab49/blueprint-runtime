/**
 * Turns raw Make run data (corpus/engine-logs/, gitignored because it contains the
 * account email and ids) into tracked, scrubbed reference cases:
 *
 *   corpus/reference/<case>/case.json       the spec's case contract (section 10)
 *   corpus/reference/<case>/input.json      the webhook payload as Make parsed it
 *   corpus/reference/<case>/reference.json  Make's per-module bundles, outcome and response
 *
 *   node tools/extract-reference.ts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hookUrl } from './lib/make-account.ts';

interface ModuleEntry {
  input: boolean;
  module: number;
  operation: number;
  data: string[];
}
interface RawRun {
  scenarioId: number;
  /** Set for runs of a blueprint variant (tools/make-variant-run.ts); overrides the scenario's own. */
  blueprint?: string;
  log?: { logs: { type?: number; module?: { id: number }; error?: { name: string; message: string }; timestamp?: string; report?: boolean[][] }[] } | undefined;
  modules: Record<string, ModuleEntry[]>;
}

const SCENARIOS: Record<number, { letter: string; blueprint: string }> = {
  7871965: { letter: 'A', blueprint: '../../blueprints/A.blueprint.json' },
  7872008: { letter: 'B', blueprint: '../../blueprints/B.blueprint.json' },
  7872022: { letter: 'C', blueprint: '../../blueprints/C.import.json' },
  7872039: { letter: 'D', blueprint: '../../blueprints/D.blueprint.json' },
};

const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const logs: Record<string, { scenarioId: number; log: RawRun['log'] }> = read('corpus/engine-logs/make-engine-logs-41.json');
const bundles: Record<string, RawRun> = read('corpus/engine-logs/make-module-bundles-41.json');
const aRuns: Record<string, RawRun> = read('corpus/engine-logs/make-A-runs-9.json');

const runs = new Map<string, RawRun>();
for (const [id, r] of Object.entries(bundles)) runs.set(id, { ...r, log: logs[id]?.log });
for (const [id, r] of Object.entries(aRuns)) runs.set(id, r);
// Variant runs made with tools/make-variant-run.ts on scenario C's slot: C2 (iterator
// probes), E (HTTP module probes) and T (Basic trigger probes, started with Make's
// "run once" API: no webhook, so no response, and the bundles are in the blueprint, so
// the case input is null). The live copies the tool sent carry webhook ids; the tracked
// blueprint is the same file under corpus/blueprints/.
type VariantRuns = { runs: { case: string; blueprint: string; runId: string; response: { status: number; body: string } }[] };
const variantSets: [string, VariantRuns, 'webhook' | 'api'][] = [
  ['corpus/engine-logs/make-C2-runs-14.json', read('corpus/responses/C2.runs.json'), 'webhook'],
  ['corpus/engine-logs/make-E-runs-5.json', read('corpus/responses/E.runs.json'), 'webhook'],
  ['corpus/engine-logs/make-T-runs-8.json', read('corpus/responses/T.runs.json'), 'api'],
];
const caseOfRun = new Map<string, string>();
const apiRuns = new Set<string>();
for (const [file, set, mode] of variantSets) {
  const raw: Record<string, RawRun> = read(file);
  for (const r of set.runs) {
    if (!raw[r.runId]) throw new Error(`no engine data for ${r.case} (${r.runId})`);
    runs.set(r.runId, { ...raw[r.runId]!, blueprint: `../../blueprints/${r.blueprint.split('/').pop()!.replace(/^live-/, '')}` });
    caseOfRun.set(r.runId, r.case);
    if (mode === 'api') apiRuns.add(r.runId);
  }
}

// The E probes called scenario A's webhook, turned into a JSON echo for the run. Its URL
// is a live trigger, and the responses carry a Cloudflare cookie and Make execution ids:
// replaced, the same way in references and fixtures, so comparison stays exact.
const ECHO_URL = hookUrl('A');
const scrub = (text: string) =>
  text
    .split(ECHO_URL)
    .join('https://echo.example.test/hook')
    .replace(/__cf_bm=[^;"]+/g, '__cf_bm=<redacted>')
    .replace(/("x-make-scenario-execution-id",\s*(?:"value": )?)"[0-9a-f]{32}"/g, '$1"<execution-id>"');

/**
 * The HTTP fixture that reproduces a recorded E run: the request the module built and
 * the response it got. The body is not in the bundle; it is the echo's reply, rebuilt
 * from the parsed data and checked against fileSize. For the 404 run Make kept no
 * output, so the body is what the echo sends for that payload.
 */
function httpFixture(input: Record<string, unknown>, output: Record<string, unknown> | null, payload: Record<string, unknown>) {
  const raw = input['bodyType'] === 'raw';
  const echoBody = JSON.stringify({ echo: payload['name'], n: 2, list: [1, 'b'] });
  const body = output === null ? echoBody : typeof output['data'] === 'string' ? (output['data'] as string) : JSON.stringify(output['data']);
  if (output !== null && body.length !== output['fileSize']) throw new Error(`rebuilt body length ${body.length} != fileSize ${String(output['fileSize'])}`);
  const headers = output === null ? [['content-type', 'application/json; charset=utf-8']] : (output['headers'] as { name: string; value: string }[]).map((h) => [h.name, h.value]);
  return {
    schemaVersion: 1,
    fixtures: [
      {
        module: 2,
        occurrence: 1,
        mode: 'http',
        request: { method: String(input['method']).toUpperCase(), url: input['url'], contentType: raw ? input['contentType'] : null, body: raw ? input['data'] : null },
        response: { status: output === null ? Number(payload['status']) : output['statusCode'], headers, body },
      },
    ],
  };
}

// What the webhook caller received, where it was recorded.
const responses = new Map<string, { status: number; body: string }>();
for (const [k, v] of Object.entries(read('corpus/responses/A-cases.json').results as Record<string, { response: { status: number; body: string } }>)) responses.set(k, v.response);
responses.set('A-001', { status: 200, body: 'TEST' });
for (const line of readFileSync('corpus/responses/C.txt', 'utf8').split('\n')) {
  const m = /^\{"case":"([^"]+)".*?-> (.*?) \[(\d+)\]$/.exec(line.trim()) ?? /^(C-12b) \(utf8 file\) -> (.*)$/.exec(line.trim());
  if (m) responses.set(m[1] === 'C-12b' ? 'C-12b-unicode-utf8' : m[1]!, { status: m[3] ? Number(m[3]) : 200, body: m[2]! });
}
for (const c of ['D-01-base', 'D-02-unicode', 'D-03-numbers-edge', 'D-04-empties', 'D-06-leap-dst']) {
  responses.set(c, { status: 200, body: readFileSync(`corpus/responses/D/${c}.txt`, 'utf8') });
}
for (const c of ['D-05-types-swapped', 'D-05b-types-swapped-s-string']) responses.set(c, { status: 500, body: 'Scenario failed to complete.' });
for (const [, set, mode] of variantSets) if (mode === 'webhook') for (const r of set.runs) responses.set(r.case, r.response);

rmSync('corpus/reference', { recursive: true, force: true });
let n = 0;
for (const [runId, run] of runs) {
  const scenario = SCENARIOS[run.scenarioId];
  if (!scenario) continue;
  const events = run.log?.logs ?? [];
  // Steps in Make's execution order, from the run log: filter decisions (event 14 = stopped,
  // 18 = passed) and module operations (event 5 = input, 6 = output; one operation per
  // module start). Bundles come from the per-module data, matched by operation number.
  const steps: unknown[] = [];
  const opCount = new Map<number, number>();
  const openOp = new Map<number, boolean>();
  const bundlesOf = (id: number, op: number, input: boolean) =>
    (run.modules[id] ?? []).filter((e) => e.input === input && e.operation === op).flatMap((e) => e.data.map((d) => JSON.parse(d)));
  for (const e of events) {
    const id = e.module?.id;
    if (id === undefined) continue;
    if (e.type === 14 || e.type === 18) {
      steps.push({ kind: 'filter', moduleId: id, passed: e.type === 18, report: e.report ?? [] });
    } else if (e.type === 5 || (e.type === 6 && !openOp.get(id))) {
      const op = (opCount.get(id) ?? 0) + 1;
      opCount.set(id, op);
      openOp.set(id, e.type === 5);
      steps.push({ kind: 'module', id, operation: op, input: bundlesOf(id, op, true), output: bundlesOf(id, op, false) });
    } else if (e.type === 6) {
      openOp.set(id, false);
    }
  }
  const modules = steps.filter((s): s is { kind: 'module'; id: number; output: { case?: string }[] } => (s as { kind: string }).kind === 'module');
  const failed = events.find((e) => e.type === 6 && e.error);
  const payload = modules.find((m) => m.id === 1)?.output[0];
  const caseName: string = caseOfRun.get(runId) ?? payload?.case ?? `${scenario.letter}-001`;
  const blueprint = run.blueprint ?? scenario.blueprint;
  const started = events.find((e) => e.type === 24)?.timestamp ?? null;

  const reference = {
    schemaVersion: 2,
    source: 'make',
    scenarioId: run.scenarioId,
    runId,
    recordedAt: started,
    timezone: 'Asia/Karachi',
    status: failed ? 'error' : 'success',
    ...(failed ? { error: { moduleId: failed.module!.id, name: failed.error!.name, message: failed.error!.message } } : {}),
    steps,
    ...(responses.has(caseName) ? { response: responses.get(caseName) } : scenario.letter === 'B' ? { response: { status: 200, body: 'Accepted' } } : {}),
  };
  const dir = `corpus/reference/${caseName}`;
  mkdirSync(dir, { recursive: true });
  const http = modules.find((m) => m.id === 2 && /E-/.test(blueprint));
  const fixtures = http ? httpFixture((http as unknown as { input: Record<string, unknown>[] }).input[0]!, (http.output[0] ?? null) as Record<string, unknown> | null, payload as Record<string, unknown>) : null;
  const write = (file: string, value: unknown) => writeFileSync(`${dir}/${file}`, scrub(`${JSON.stringify(value, null, 2)}\n`));
  write('input.json', apiRuns.has(runId) ? null : payload);
  write('reference.json', reference);
  if (fixtures) write('fixtures.json', fixtures);
  write('case.json', {
    schemaVersion: 1, name: caseName, blueprint, input: './input.json', ...(fixtures ? { fixtures: './fixtures.json' } : {}),
    environment: { timezone: 'Asia/Karachi' }, expected: './reference.json',
  });
  n++;
}
console.log(`wrote ${n} reference cases to corpus/reference/`);

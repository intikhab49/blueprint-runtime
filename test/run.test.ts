import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadBlueprint } from '../src/blueprint/load.ts';
import { UnsupportedError } from '../src/expr/errors.ts';
import { runCase } from '../src/run/case.ts';
import { compareExecutions, firstDifference } from '../src/run/compare.ts';
import { LimitExceededError, runScenario } from '../src/run/scheduler.ts';
import { OPERATORS } from '../src/run/operators.ts';
import type { Execution } from '../src/run/trace.ts';
import { fromJson, MISSING } from '../src/expr/values.ts';

const planOf = (doc: unknown) => {
  const r = loadBlueprint(new TextEncoder().encode(JSON.stringify(doc)));
  assert.ok(r.plan, JSON.stringify(r.findings));
  return r.plan;
};
const hook = { id: 1, module: 'gateway:CustomWebHook', version: 1, parameters: {}, mapper: {} };
const respond = (body: string, id = 2) => ({ id, module: 'gateway:WebhookRespond', version: 1, parameters: {}, mapper: { body, status: '200', headers: [] } });

describe('scenarios A, B, C, the C2 iterator probes and the E HTTP probes against every recorded Make run', () => {
  // C2-nl-02: for the bare bundle 0, Make read the previous bundle's value; refused, not modeled.
  const refused = new Set(['C2-nl-02-numbers']);
  for (const c of readdirSync('corpus/reference').filter((d) => /^(A|B|C|C2|E)-/.test(d))) {
    it(c, () => {
      const r = runCase(`corpus/reference/${c}/case.json`);
      assert.equal(r.verdict, refused.has(c) ? 'unsupported' : 'pass', r.message);
    });
  }
});

describe('a broken mapping is caught at the first difference', () => {
  it('upper → capitalize differs at module 2 input /value', () => {
    const r = runCase('examples/broken-mapping/cases/A-002-plain/case.json');
    assert.equal(r.verdict, 'fail');
    assert.deepEqual(
      { where: r.divergence?.where, moduleId: r.divergence?.moduleId, bundle: r.divergence?.bundle, pointer: r.divergence?.pointer, expected: r.divergence?.expected, actual: r.divergence?.actual },
      { where: 'input', moduleId: 2, bundle: 1, pointer: '/value', expected: 'ADA LOVELACE', actual: 'Ada Lovelace' },
    );
  });

  it('an input the edit does not affect still matches', () => {
    assert.equal(runCase('examples/broken-mapping/cases/A-004-empty-name/case.json').verdict, 'pass');
  });
});

describe('linear scheduler', () => {
  it('records a mapping failure the way Make did (corpus D-05)', () => {
    const t = runScenario(planOf({ flow: [hook, respond('{{first(1.x)}}')] }), { x: 'notarray' }, { timezone: null });
    assert.equal(t.status, 'error');
    assert.deepEqual(t.error, { moduleId: 2, name: 'DataError', message: "Failed to map 'body': Function 'first' finished with error! 'notarray' is not a valid array." });
    assert.deepEqual(t.steps[1], { kind: 'module', id: 2, operation: 1, input: [], output: [null] });
    assert.deepEqual(t.response, { status: 500, body: 'Scenario failed to complete.' });
  });

  it('answers "Accepted" when nothing responds, or the body is empty (corpus B, A-004)', () => {
    assert.deepEqual(runScenario(planOf({ flow: [hook] }), {}, { timezone: null }).response, { status: 200, body: 'Accepted' });
    assert.deepEqual(runScenario(planOf({ flow: [hook, respond('{{1.x}}')] }), { x: '' }, { timezone: null }).response, { status: 200, body: 'Accepted' });
  });

  it('refuses structure it cannot run yet', () => {
    assert.throws(() => runScenario(planOf({ flow: [{ ...respond('x', 1) }] }), {}, { timezone: null }), UnsupportedError);
  });

  it('enforces the operation budget', () => {
    assert.throws(() => runScenario(planOf({ flow: [hook, respond('a', 2), respond('b', 3)] }), {}, { timezone: null, maxOperations: 2 }), LimitExceededError);
  });
});

describe('iterator and text aggregator', () => {
  const iterator = { id: 2, module: 'builtin:BasicFeeder', version: 1, parameters: {}, mapper: { array: '{{1.items}}' } };
  const line = { id: 3, module: 'util:SetVariable2', version: 1, mapper: { name: 'line', value: '{{2.name}}' } };
  const agg = (parameters: Record<string, unknown> = {}) => ({ id: 4, module: 'util:TextAggregator', version: 1, parameters: { rowSeparator: 'other', otherRowSeparator: '|', feeder: 2, ...parameters }, mapper: { value: '{{3.line}}' } });
  const run = (flow: unknown[], items: unknown) => runScenario(planOf({ flow: [hook, ...flow] }), { items } as never, { timezone: null });
  const refused = (flow: unknown[], items: unknown, re: RegExp) => assert.throws(() => run(flow, items), (e) => e instanceof UnsupportedError && re.test(e.message));

  it('joins the rows that reached the aggregator, with 1 operation each for iterator and aggregator', () => {
    const t = run([iterator, line, agg()], [{ name: 'a' }, { name: 'b' }]);
    assert.deepEqual(t.steps.map((s) => (s.kind === 'module' ? `${s.id}#${s.operation}` : 'filter')), ['1#1', '2#1', '3#1', '3#2', '4#1']);
    assert.deepEqual(t.steps.at(-1), { kind: 'module', id: 4, operation: 1, input: [{ value: 'a' }, { value: 'b' }], output: [{ text: 'a|b' }] });
  });

  it('runs the rest of the flow per bundle, depth-first, when there is no aggregator (C2-noagg-01)', () => {
    const second = { id: 4, module: 'util:SetVariable2', version: 1, mapper: { name: 's', value: '{{3.line}}' } };
    const t = run([iterator, line, second], ['a', 'b']);
    assert.deepEqual(t.steps.map((s) => (s.kind === 'module' ? `${s.id}#${s.operation}` : 'filter')), ['1#1', '2#1', '3#1', '4#1', '3#2', '4#2']);
    assert.deepEqual(t.response, { status: 200, body: 'Accepted' });
  });

  it('reads the iterator as missing after its aggregator ran (C2-after)', () => {
    const t = run([iterator, line, agg(), respond('[{{4.text}}]({{2.name}})({{3.line}})', 5)], [{ name: 'a' }]);
    assert.deepEqual(t.response, { status: 200, body: '[a]()()' });
  });

  it('fails the run on a null element, the way Make did (C2-nl-03)', () => {
    const t = run([iterator, line, agg()], ['a', null]);
    assert.equal(t.status, 'error');
    assert.deepEqual(t.error, { moduleId: 2, name: 'TypeError', message: 'Cannot convert undefined or null to object' });
    assert.deepEqual(t.steps.at(-1), { kind: 'module', id: 2, operation: 1, input: [{ array: ['a', null] }], output: [null] });
  });

  it('refuses iterator shapes Make was not recorded running', () => {
    refused([iterator, respond('x', 3), agg()], [], /once per bundle/);
    refused([iterator, line, agg({ rowSeparator: 'comma' })], [], /row separator/);
    refused([iterator, line, agg()], ['a', { name: 'b' }], /mixes collections/);
    refused([iterator, line, agg()], [1, 0], /previous bundle/);
  });
});

describe('routers and filters', () => {
  const setVar = (id: number, value: string, filter?: unknown) => ({ id, module: 'util:SetVariable2', version: 1, mapper: { name: 'route', value }, ...(filter ? { filter } : {}) });
  const eq = (a: string, b: string) => ({ name: 'f', conditions: [[{ a, o: 'text:equal', b }]] });
  const router = (routes: unknown[][], elseRoute?: number) => ({
    id: 2, module: 'builtin:BasicRouter', version: 1, mapper: null, parameters: elseRoute === undefined ? {} : { else: elseRoute }, routes: routes.map((flow) => ({ flow })),
  });
  const doc = { flow: [hook, router([[setVar(3, 'r1', eq('{{1.t}}', 'a'))], [setVar(4, 'r2', eq('{{1.u}}', 'b'))], [setVar(5, 'fb', { name: 'fallback', conditions: [] })]], 2)] };
  const ran = (payload: unknown) => runScenario(planOf(doc), payload as never, { timezone: null }).steps.filter((s) => s.kind === 'module').map((s) => (s.kind === 'module' ? s.id : 0));

  it('runs every route whose filter passes, in order', () => {
    assert.deepEqual(ran({ t: 'a', u: 'b' }), [1, 3, 4]);
    assert.deepEqual(ran({ t: 'a' }), [1, 3]);
  });

  it('runs the fallback only when no other route passed, and logs it with an empty report', () => {
    const t = runScenario(planOf(doc), { t: 'x' }, { timezone: null });
    assert.deepEqual(t.steps.slice(1).map((s) => (s.kind === 'filter' ? [s.moduleId, s.passed, s.report] : s.id)), [[3, false, [[false]]], [4, false, [[false]]], [5, true, []], 5]);
  });

  it('refuses filter shapes that have not been observed', () => {
    const empty = { name: 'empty', conditions: [[]] };
    assert.throws(() => runScenario(planOf({ flow: [hook, setVar(2, 'x', empty)] }), { t: 'a' }, { timezone: null }), UnsupportedError);
    const op = { name: 'op', conditions: [[{ a: '{{1.t}}', o: 'text:fuzzy', b: 'a' }]] };
    assert.throws(() => runScenario(planOf({ flow: [hook, setVar(2, 'x', op)] }), { t: 'a' }, { timezone: null }), UnsupportedError);
  });

  it('short-circuits AND groups and records only evaluated conditions (F1 and_tf, or_and)', () => {
    const c = (b: string) => ({ a: '{{1.t}}', o: 'text:equal', b });
    const t = runScenario(planOf({ flow: [hook, setVar(2, 'x', { name: 'f', conditions: [[c('no'), c('a')], [c('a')]] })] }), { t: 'a' }, { timezone: null });
    assert.deepEqual(t.steps[1], { kind: 'filter', moduleId: 2, passed: true, report: [[false], [true]] });
  });

  it('stops only the filtered path', () => {
    const t = runScenario(planOf({ flow: [hook, setVar(2, 'x', eq('{{1.t}}', 'nope')), setVar(3, 'y')] }), { t: 'a' }, { timezone: null });
    assert.deepEqual(t.steps.map((s) => s.kind), ['module', 'filter']);
  });
});

describe('filter operators outside the probes', () => {
  const v = (x: unknown) => fromJson(x as never);
  const ctx = { timezone: 'UTC' };
  it('refuses inputs Make was not seen handling', () => {
    assert.throws(() => OPERATORS['number:greater']!(v(' 12'), v('1'), ctx), UnsupportedError);
    assert.throws(() => OPERATORS['number:notequal']!(v('abc'), v('1'), ctx), UnsupportedError);
    assert.throws(() => OPERATORS['text:equal:ci']!(v('Straße'), v('strasse'), ctx), UnsupportedError);
    assert.throws(() => OPERATORS['boolean:equal']!(v('yes'), v('true'), ctx), UnsupportedError);
    assert.throws(() => OPERATORS['array:contain']!(v([1]), v('1'), ctx), UnsupportedError);
  });

  it('refuses a date without a time when the timezone would change the answer', () => {
    assert.throws(() => OPERATORS['date:greater']!(v('2026-01-30T20:00:00.000Z'), v('2026-01-31'), { timezone: 'Asia/Karachi' }), UnsupportedError);
    assert.equal(OPERATORS['date:greater']!(v('2026-03-01T00:00:00.000Z'), v('2026-01-31'), { timezone: 'Asia/Karachi' }), true);
  });
});

describe('comparator', () => {
  const run = (modules: { id: number; input: never[]; output: unknown[] }[], extra: Partial<Execution> = {}): Execution => ({
    schemaVersion: 2,
    status: 'success',
    steps: modules.map((m) => ({ kind: 'module' as const, id: m.id, operation: 1, input: m.input, output: m.output as never[] })),
    ...extra,
  });

  it('ignores object key order and finds the first differing path', () => {
    assert.equal(firstDifference({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), null);
    assert.deepEqual(firstDifference({ a: [1, { c: 2 }] }, { a: [1, { c: 3 }] }), { pointer: '/a/1/c', expected: 2, actual: 3 });
    assert.deepEqual(firstDifference({ a: null }, {}), { pointer: '/a', expected: null, actual: undefined });
  });

  it('reports module order, bundle counts, outcome and response, in that order', () => {
    const base = [{ id: 1, input: [], output: [{ x: 1 }] }];
    assert.equal(compareExecutions(run(base), run([]))?.where, 'step');
    assert.equal(compareExecutions(run(base), run([{ id: 1, input: [], output: [] }]))?.where, 'output');
    assert.equal(compareExecutions(run(base, { status: 'error', error: { moduleId: 1, name: 'DataError', message: 'x' } }), run(base))?.where, 'outcome');
    assert.equal(compareExecutions(run(base, { response: { status: 200, body: 'a' } }), run(base, { response: { status: 200, body: 'b' } }))?.pointer, '/body');
    assert.equal(compareExecutions(run(base), run(base)), null);
  });
});

describe('bpr test exit codes', () => {
  const bpr = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8' });

  it('0 when every case matches Make, 1 when one differs', () => {
    assert.equal(bpr('test', 'corpus/reference/A-001').status, 0);
    assert.equal(bpr('test', 'examples/broken-mapping').status, 1);
  });

  it('3 for cases that cannot run yet, unless --allow-unsupported', () => {
    assert.equal(bpr('test', 'corpus/reference/D-01-base').status, 3);
    assert.equal(bpr('test', 'corpus/reference', '--allow-unsupported').status, 0);
  });

  it('2 for a case that does not exist', () => {
    assert.equal(bpr('test', 'nope/case.json').status, 2);
  });
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { inspectBytes } from '../src/inspect.ts';

const inspectFile = (f: string) => inspectBytes(f, readFileSync(f));
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('inspect on the real Make corpus', () => {
  for (const f of ['A.blueprint.json', 'B.blueprint.json', 'C.import.json']) {
    it(`${f} is eligible`, () => {
      const r = inspectFile(`corpus/blueprints/${f}`);
      assert.deepEqual(r.findings, []);
      assert.equal(r.verdict, 'eligible');
      assert.equal(r.exitCode, 0);
    });
  }

  it('D is refused only for the regex literal probe, whose meaning in Make is unknown', () => {
    const r = inspectFile('corpus/blueprints/D.blueprint.json');
    assert.deepEqual(r.findings.map((f) => f.code), ['EXPRESSION_UNSUPPORTED']);
    assert.match(r.findings[0]!.message, /\/o\/g/);
    assert.equal(r.exitCode, 3);
  });

  it('reports every expression of the D probe and the functions it uses', () => {
    const r = inspectFile('corpus/blueprints/D.blueprint.json');
    assert.equal(r.expressions.length, JSON.parse(readFileSync('corpus/blueprints/D.probes.json', 'utf8')).length);
    assert.ok(r.functions.every((f) => f.supported));
    assert.ok(r.functions.some((f) => f.name === 'formatDate' && f.count === 5));
  });

  it('describes where routed modules sit, including the fallback', () => {
    const r = inspectFile('corpus/blueprints/B.blueprint.json');
    assert.deepEqual(r.modules.map((m) => m.where), ['main', 'main', 'router 2 › route 1', 'router 2 › route 2', 'router 2 › route 3 (fallback)']);
  });
});

describe('inspect findings', () => {
  const hook = { id: 1, module: 'gateway:CustomWebHook', version: 1, parameters: {}, mapper: {} };

  it('marks unknown modules, versions, operators, functions and error handlers as unsupported', () => {
    const doc = {
      flow: [
        hook,
        { id: 2, module: 'json:ParseJSON', version: 1, mapper: { json: '{{1.url}}' } },
        { id: 3, module: 'util:SetVariable2', version: 9, mapper: { value: '{{formatDuration(1.x)}}' } },
        { id: 4, module: 'util:SetVariable2', version: 1, mapper: { value: '{{uuid}}' }, filter: { conditions: [[{ a: '{{1.a}}', o: 'text:contains', b: 'x' }]] }, onerror: [] },
      ],
    };
    const r = inspectBytes('t.json', enc(doc));
    assert.deepEqual(r.findings.map((f) => f.code).sort(), [
      'ERROR_HANDLER_UNSUPPORTED', 'FILTER_OPERATOR_UNSUPPORTED', 'FUNCTION_UNSUPPORTED', 'KEYWORD_UNSUPPORTED', 'MODULE_UNSUPPORTED', 'MODULE_VERSION_UNSUPPORTED',
    ]);
    assert.equal(r.verdict, 'unsupported');
    assert.equal(r.exitCode, 3);
  });

  it('refuses references to modules that do not run first (Make accepts them, the value is unrecorded)', () => {
    const doc = {
      flow: [
        hook,
        { id: 2, module: 'builtin:BasicRouter', version: 1, parameters: {}, mapper: null, routes: [
          { flow: [{ id: 3, module: 'util:SetVariable2', version: 1, mapper: { value: '{{4.x}}' } }] },
          { flow: [{ id: 4, module: 'util:SetVariable2', version: 1, mapper: { value: '{{9.x}}' } }] },
        ] },
      ],
    };
    const r = inspectBytes('t.json', enc(doc));
    assert.deepEqual(r.findings.map((f) => [f.code, f.severity]), [['REF_NOT_UPSTREAM', 'unsupported'], ['REF_UNKNOWN_MODULE', 'unsupported']]);
    assert.equal(r.exitCode, 3);
  });

  it('reports expression syntax errors and refused syntax', () => {
    const doc = { flow: [hook, { id: 2, module: 'util:SetVariable2', version: 1, mapper: { a: '{{upper(1.s}}', b: '{{replace(1.a; /x/; "y")}}', c: '{{1 +}}' } }] };
    assert.deepEqual(inspectBytes('t.json', enc(doc)).findings.map((f) => [f.code, f.severity]), [
      ['EXPRESSION_UNTERMINATED', 'unsupported'],
      ['EXPRESSION_UNSUPPORTED', 'unsupported'],
      ['EXPRESSION_SYNTAX', 'unsupported'],
    ]);
  });

  it('names Make variables and other word.path forms instead of calling them syntax errors', () => {
    const doc = { flow: [hook, { id: 2, module: 'util:SetVariable2', version: 1, mapper: { a: '{{var.organization.KEY}}', b: '{{connection.x}}' } }] };
    const f = inspectBytes('t.json', enc(doc)).findings;
    assert.deepEqual(f.map((x) => x.code), ['EXPRESSION_UNSUPPORTED', 'EXPRESSION_UNSUPPORTED']);
    assert.match(f[0]!.message, /custom variable/);
  });

  it('applies the runtime setting-based refusals, so eligible means runnable (public survey)', () => {
    const codes = (flow: unknown[]) => inspectBytes('t.json', enc({ flow })).findings.filter((f) => f.severity === 'unsupported').map((f) => f.code);
    const http = (mapper: Record<string, unknown>, parameters: Record<string, unknown> = { handleErrors: true }) => ({ id: 2, module: 'http:ActionSendData', version: 3, parameters, mapper: { url: 'https://x.test', method: 'get', parseResponse: true, ...mapper } });
    assert.deepEqual(codes([{ id: 1, module: 'gateway:CustomMailHook', version: 1, mapper: {} }]), ['TRIGGER_UNSUPPORTED', 'MODULE_UNSUPPORTED']);
    assert.deepEqual(codes([hook, http({}, { handleErrors: false })]), ['MODULE_CONFIG_UNSUPPORTED']);
    assert.deepEqual(codes([hook, http({ headers: [{ name: 'a', value: 'b' }] })]), ['MODULE_CONFIG_UNSUPPORTED']);
    assert.deepEqual(codes([hook, http({ headers: '{{1.h}}' })]), []);
    assert.deepEqual(codes([hook, { id: 2, module: 'gateway:WebhookRespond', version: 1, mapper: { status: '200', body: 'x', headers: [{ key: 'a', value: 'b' }] } }]), ['MODULE_CONFIG_UNSUPPORTED']);
    assert.deepEqual(codes([hook, { id: 2, module: 'util:SetVariable2', version: 1, mapper: { name: 'a', value: 'x' }, filter: { name: 'f', conditions: [[]] } }]), ['FILTER_SHAPE_UNSUPPORTED']);
    assert.deepEqual(codes([hook, { id: 2, module: 'util:SetVariable2', version: 1, mapper: { name: 'a', value: '{{1.items[].name}}' } }]), []);
    assert.deepEqual(codes([hook, { id: 2, module: 'util:SetVariable2', version: 1, mapper: { name: 'a', value: 'x' }, filter: { name: 'f', conditions: [[{ a: '{{now}}', o: 'date:greater', b: '{{1.d}}' }]] } }]), ['KEYWORD_UNSUPPORTED']);
    const clock = inspectBytes('t.json', enc({ flow: [hook, { id: 2, module: 'util:SetVariable2', version: 1, mapper: { name: 'a', value: '{{now}}' } }] }));
    assert.equal(clock.verdict, 'eligible');
    assert.equal(clock.needsClock, true);
    assert.deepEqual(codes([hook, { id: 2, module: 'slack:CreateMessage', version: 4, mapper: null }]), ['MODULE_CONFIG_UNSUPPORTED']);
  });

  it('unwraps {"blueprint": …} and the API response {"response": {"blueprint": …}}', () => {
    for (const doc of [{ blueprint: { flow: [hook] } }, { response: { blueprint: { flow: [hook] } } }]) {
      const r = inspectBytes('t.json', enc(doc));
      assert.equal(r.verdict, 'eligible');
      assert.deepEqual(r.findings.map((x) => x.code), ['FORMAT_WRAPPED']);
      assert.ok(r.modules[0]!.pointer.endsWith('blueprint/flow/0'));
    }
  });

  it('only allows an iterator or the trigger as an aggregator source (T-04)', () => {
    const agg = (feeder: number) => ({ id: 2, module: 'util:TextAggregator', version: 1, parameters: { feeder, rowSeparator: 'other', otherRowSeparator: '|' }, mapper: { value: 'x' } });
    assert.deepEqual(inspectBytes('t.json', enc({ flow: [hook, agg(9)] })).findings.map((f) => f.code), ['AGGREGATOR_SOURCE_UNSUPPORTED']);
    assert.deepEqual(inspectBytes('t.json', enc({ flow: [hook, agg(1)] })).findings.map((f) => f.code), []);
  });

  it('treats a third-party app trigger as input-fed and the Basic trigger as supported', () => {
    const r = inspectBytes('t.json', enc({ flow: [{ id: 1, module: 'google-sheets:watchRows', version: 2, parameters: {}, mapper: {} }, { id: 2, module: 'util:SetVariable2', version: 1, mapper: { name: 'a', value: '{{1.x}}' } }] }));
    assert.equal(r.verdict, 'eligible');
    assert.deepEqual(r.fixtures, [{ moduleId: 1, module: 'google-sheets:watchRows', mode: 'trigger' }]);
    assert.deepEqual(r.findings.map((f) => f.code), ['TRIGGER_FROM_INPUT']);
    const basic = { id: 1, module: 'util:BasicTrigger', version: 1, parameters: { values: [{ spec: [{ name: 'a', value: 1 }] }] }, mapper: {} };
    assert.deepEqual(inspectBytes('t.json', enc({ flow: [basic] })).findings.map((f) => f.code), ['MODULE_CONFIG_UNSUPPORTED']);
  });

  it('flags iterator structure the scheduler would refuse', () => {
    const it2 = { id: 2, module: 'builtin:BasicFeeder', version: 1, mapper: { array: '{{1.items}}' } };
    const agg = (rowSeparator: string) => ({ id: 4, module: 'util:TextAggregator', version: 1, parameters: { feeder: 2, rowSeparator, otherRowSeparator: '|' }, mapper: { value: 'x' } });
    const respond3 = { id: 3, module: 'gateway:WebhookRespond', version: 1, mapper: { body: 'x', status: '200', headers: [] } };
    const codes = (flow: unknown[]) => inspectBytes('t.json', enc({ flow })).findings.map((f) => f.code);
    assert.deepEqual(codes([hook, it2, agg('other')]), []);
    assert.deepEqual(codes([hook, it2]), []);
    assert.deepEqual(codes([hook, it2, agg('\n')]), []);
    assert.deepEqual(codes([hook, it2, respond3, agg('other')]), ['ITERATOR_SCOPE_UNSUPPORTED']);
    assert.deepEqual(codes([hook, it2, respond3]), ['ITERATOR_SCOPE_UNSUPPORTED']);
    assert.deepEqual(codes([hook, it2, agg('comma')]), ['AGGREGATOR_SEPARATOR_UNSUPPORTED']);
  });
});

describe('bpr CLI', () => {
  const bpr = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8' });

  it('exits 0 for eligible files and prints versioned JSON', () => {
    const r = bpr('inspect', 'corpus/blueprints/A.blueprint.json', '--json');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.schemaVersion, 1);
    assert.equal(out.modules.length, 3);
  });

  it('exits 3 for unsupported and 2 for invalid input', () => {
    assert.equal(bpr('inspect', 'corpus/public/make-skills/router-fanout.json').status, 3);
    assert.equal(bpr('inspect', 'does-not-exist.json').status, 2);
    assert.equal(bpr('inspect').status, 2);
    assert.equal(bpr('frobnicate').status, 2);
  });
});

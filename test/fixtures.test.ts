import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { loadBlueprint } from '../src/blueprint/load.ts';
import { UnsupportedError } from '../src/expr/errors.ts';
import { inspectBytes } from '../src/inspect.ts';
import { FixtureError, FixtureSet } from '../src/run/fixtures.ts';
import { runScenario } from '../src/run/scheduler.ts';

const enc = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc));
const planOf = (doc: unknown) => {
  const r = loadBlueprint(enc(doc));
  assert.ok(r.plan, JSON.stringify(r.findings));
  return r.plan;
};
const hook = { id: 1, module: 'gateway:CustomWebHook', version: 1, parameters: {}, mapper: {} };
const respond = (body: string, id: number) => ({ id, module: 'gateway:WebhookRespond', version: 1, parameters: {}, mapper: { body, status: '200', headers: [] } });
const http = (mapper: Record<string, unknown> = {}) => ({
  id: 2, module: 'http:ActionSendData', version: 3, parameters: { handleErrors: true },
  mapper: { url: 'https://api.example.test/x', method: 'post', bodyType: 'raw', contentType: 'application/json', data: '{"q":"{{1.q}}"}', parseResponse: true, ...mapper },
});
const httpFixture = (response: Record<string, unknown> = {}, request: Record<string, unknown> = {}) => ({
  module: 2, occurrence: 1, mode: 'http',
  request: { method: 'POST', url: 'https://api.example.test/x', contentType: 'application/json', body: '{"q":"a"}', ...request },
  response: { status: 200, headers: [['Content-Type', 'application/json'], ['Set-Cookie', 'k=v']], body: '{"answer":42}', ...response },
});
const run = (flow: unknown[], fixtures: unknown[], payload: unknown = { q: 'a' }) =>
  runScenario(planOf({ flow: [hook, ...flow] }), payload as never, { timezone: null, fixtures: FixtureSet.fromJson({ schemaVersion: 1, fixtures: fixtures as never }) });

describe('HTTP fixtures', () => {
  it('builds the output bundle the way Make recorded it (corpus E)', () => {
    const t = run([http(), respond('[{{2.data.answer}}]', 3)], [httpFixture()]);
    const step = t.steps[1]!;
    assert.ok(step.kind === 'module');
    assert.deepEqual(JSON.parse(JSON.stringify(step.output)), [{ statusCode: 200, headers: [{ name: 'content-type', value: 'application/json' }, { name: 'set-cookie', value: 'k=v' }], cookieHeaders: ['k=v'], data: { answer: 42 }, fileSize: 13 }]);
    assert.deepEqual(t.response, { status: 200, body: '[42]' });
    assert.deepEqual(t.fixtures, [{ module: 2, occurrence: 1, mode: 'http' }]);
  });

  it('keeps the body as text when parseResponse is off (E-text-01)', () => {
    const t = run([http({ parseResponse: false }), respond('{{2.data}}', 3)], [httpFixture()]);
    assert.deepEqual(t.response, { status: 200, body: '{"answer":42}' });
  });

  it('fails the module on 404 like Make, with its input recorded (E-json-03)', () => {
    const t = run([http(), respond('x', 3)], [httpFixture({ status: 404 })]);
    assert.equal(t.status, 'error');
    assert.deepEqual(t.error, { moduleId: 2, name: 'DataError', message: 'Error: 404 Not Found' });
    assert.deepEqual(t.response, { status: 500, body: 'Scenario failed to complete.' });
  });

  it('fails closed: no fixture, wrong request, wrong mode', () => {
    assert.throws(() => run([http()], []), (e) => e instanceof FixtureError && /no fixture/.test(e.message));
    assert.throws(() => run([http()], [httpFixture()], { q: 'b' }), (e) => e instanceof FixtureError && /request \/body expected/.test(e.message));
    assert.throws(() => run([http()], [{ module: 2, occurrence: 1, mode: 'module', input: {}, output: [{}] }]), (e) => e instanceof FixtureError && /needs "http"/.test(e.message));
  });

  it('reports a fixture that was never used', () => {
    const set = FixtureSet.fromJson({ schemaVersion: 1, fixtures: [httpFixture() as never, { ...httpFixture(), occurrence: 2 } as never] });
    runScenario(planOf({ flow: [hook, http()] }), { q: 'a' }, { timezone: null, fixtures: set });
    assert.throws(() => set.assertAllUsed(), /never used: module 2, invocation 2/);
  });

  it('refuses what was not recorded', () => {
    const refused = (flow: unknown[], fx: unknown, re: RegExp) => assert.throws(() => run(flow, [fx]), (e) => e instanceof UnsupportedError && re.test(e.message));
    refused([http()], httpFixture({ status: 500 }), /status 500/);
    refused([http()], httpFixture({ headers: [['content-type', 'text/plain']] }), /parsing a "text\/plain"/);
    refused([http({ authUser: 'me' })], httpFixture(), /authUser/);
    refused([http()], httpFixture({ body: '{"a":"é"}' }), /non-ASCII/);
  });
});

describe('opaque module fixtures', () => {
  const sheets = { id: 2, module: 'google-sheets:addRow', version: 2, parameters: {}, mapper: { values: { 0: '{{1.q}}' } } };
  const fx = (extra: Record<string, unknown>) => ({ module: 2, occurrence: 1, mode: 'module', input: { values: { 0: 'a' } }, ...extra });

  it('checks the mapped input and replays the output', () => {
    const t = run([sheets, respond('[{{2.rowNumber}}]', 3)], [fx({ output: [{ rowNumber: 7 }] })]);
    assert.deepEqual(t.response, { status: 200, body: '[7]' });
    assert.deepEqual(t.fixtures, [{ module: 2, occurrence: 1, mode: 'module' }]);
  });

  it('fails on a different mapped input', () => {
    assert.throws(() => run([sheets], [fx({ output: [{}] })], { q: 'b' }), (e) => e instanceof FixtureError && /input \/values\/0 expected "a"/.test(e.message));
  });

  it('can stand in for a service error', () => {
    const t = run([sheets], [fx({ error: { name: 'RuntimeError', message: 'quota' } })]);
    assert.deepEqual(t.error, { moduleId: 2, name: 'RuntimeError', message: 'quota' });
  });

  it('refuses several output bundles (that would fan out like an iterator)', () => {
    assert.throws(() => run([sheets], [fx({ output: [{}, {}] })]), UnsupportedError);
  });

  it('never stands in for a module that runs inside Make', () => {
    assert.throws(() => run([{ id: 2, module: 'json:ParseJSON', version: 1, mapper: { json: '{}' } }], [fx({ output: [{}] })]), UnsupportedError);
  });
});

describe('fixture files', () => {
  it('rejects malformed and duplicate entries', () => {
    assert.throws(() => FixtureSet.fromJson({ fixtures: [] }), /schemaVersion/);
    assert.throws(() => FixtureSet.fromJson({ schemaVersion: 1, fixtures: [httpFixture() as never, httpFixture() as never] }), /two fixtures for module 2, invocation 1/);
    assert.throws(() => FixtureSet.fromJson({ schemaVersion: 1, fixtures: [{ module: 2, occurrence: 1, mode: 'module', input: {}, output: [], error: { name: 'a', message: 'b' } }] }), /exactly one of/);
    assert.throws(() => FixtureSet.fromJson({ schemaVersion: 1, fixtures: [{ module: 2, occurrence: 1, mode: 'magic' }] }), /"mode"/);
  });
});

describe('inspect names the fixtures a blueprint needs', () => {
  it('HTTP and third-party modules are eligible with fixtures', () => {
    const r = inspectBytes('t.json', enc({ flow: [hook, http(), { id: 3, module: 'google-sheets:addRow', version: 2, mapper: {} }] }));
    assert.equal(r.verdict, 'eligible');
    assert.deepEqual(r.fixtures, [{ moduleId: 2, module: 'http:ActionSendData', mode: 'http' }, { moduleId: 3, module: 'google-sheets:addRow', mode: 'module' }]);
    assert.deepEqual(r.findings.map((f) => f.code), ['FIXTURE_REQUIRED', 'FIXTURE_REQUIRED']);
  });
});

describe('bpr exit code 5', () => {
  const bpr = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8' });

  it('test: 0 when the fixture matches, 5 when it is wrong, unused or missing', () => {
    assert.equal(bpr('test', 'examples/http-fixture/cases/1-matches').status, 0);
    for (const c of ['2-wrong-request', '3-unused-fixture', '4-no-fixture']) assert.equal(bpr('test', `examples/http-fixture/cases/${c}`).status, 5, c);
  });

  it('run: --fixtures serves the HTTP call; without it the run fails closed', () => {
    const args = ['run', 'corpus/blueprints/E-json.import.json', '--input', 'corpus/reference/E-json-01/input.json'];
    const ok = bpr(...args, '--fixtures', 'corpus/reference/E-json-01/fixtures.json');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).response.body, '[200][x]');
    assert.equal(bpr(...args).status, 5);
  });
});

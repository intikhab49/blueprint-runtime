import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_LIMITS, loadBlueprint } from '../src/blueprint/load.ts';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const codes = (r: ReturnType<typeof loadBlueprint>) => r.findings.map((f) => f.code);
const mod = (id: number, extra: Record<string, unknown> = {}) => ({ id, module: 'util:SetVariable2', version: 1, mapper: { name: 'x', value: '1' }, ...extra });
const router = (id: number, routes: unknown[], extra: Record<string, unknown> = {}) => ({ id, module: 'builtin:BasicRouter', version: 1, parameters: {}, mapper: null, routes, ...extra });

describe('loadBlueprint: bounded import (BR-008)', () => {
  it('rejects oversized files before parsing', () => {
    const r = loadBlueprint(enc({ flow: [] }), { ...DEFAULT_LIMITS, maxBytes: 5 });
    assert.deepEqual(codes(r), ['BP_TOO_LARGE']);
    assert.equal(r.bytes, 11);
  });

  it('rejects invalid UTF-8', () => {
    assert.deepEqual(codes(loadBlueprint(new Uint8Array([0x7b, 0xff, 0x7d]))), ['BP_NOT_UTF8']);
  });

  it('hashes the original bytes, so reformatting changes sha256', () => {
    const a = loadBlueprint(new TextEncoder().encode('{"flow":[]}'));
    const b = loadBlueprint(new TextEncoder().encode('{ "flow": [] }'));
    assert.equal(a.sha256, createHash('sha256').update('{"flow":[]}').digest('hex'));
    assert.notEqual(a.sha256, b.sha256);
  });

  it('rejects duplicate module ids anywhere in the tree', () => {
    const r = loadBlueprint(enc({ flow: [mod(1), router(2, [{ flow: [mod(1)] }])] }));
    const f = r.findings.find((x) => x.code === 'BP_DUPLICATE_MODULE_ID');
    assert.ok(f);
    assert.equal(f.pointer, '/flow/1/routes/0/flow/0/id');
    assert.equal(r.plan, null);
  });

  it('rejects bad ids, names and versions', () => {
    assert.ok(codes(loadBlueprint(enc({ flow: [mod(0)] }))).includes('BP_BAD_MODULE_ID'));
    assert.ok(codes(loadBlueprint(enc({ flow: [{ id: 1, module: 'nocolon', version: 1 }] }))).includes('BP_BAD_MODULE_NAME'));
    assert.ok(codes(loadBlueprint(enc({ flow: [{ id: 1, module: 'a:b' }] }))).includes('BP_BAD_MODULE_VERSION'));
  });

  it('rejects invalid routes', () => {
    assert.ok(codes(loadBlueprint(enc({ flow: [router(1, [{ nope: [] }])] }))).includes('BP_FLOW_NOT_ARRAY'));
    assert.ok(codes(loadBlueprint(enc({ flow: [{ ...mod(1), routes: [] }] }))).includes('BP_ROUTES_ON_NON_ROUTER'));
    // Make exports a router with nothing attached without "routes", and its empty module slot
    // with "id": null and no version (public survey): valid files, refused later by inspect.
    assert.deepEqual(codes(loadBlueprint(enc({ flow: [{ id: 1, module: 'builtin:BasicRouter', version: 1 }] }))), []);
    assert.deepEqual(codes(loadBlueprint(enc({ flow: [{ id: null, module: 'placeholder:Placeholder' }] }))), []);
    assert.ok(codes(loadBlueprint(enc({ flow: [{ id: null, module: 'util:SetVariable2', version: 1 }] }))).includes('BP_BAD_MODULE_ID'));
    assert.ok(codes(loadBlueprint(enc({ flow: [router(1, [{ flow: [] }]), mod(2)] }))).includes('BP_MODULE_AFTER_ROUTER'));
    assert.ok(codes(loadBlueprint(enc({ flow: [router(1, [{ flow: [] }], { parameters: { else: 1 } })] }))).includes('BP_BAD_ELSE_ROUTE'));
  });

  it('rejects malformed filters', () => {
    assert.ok(codes(loadBlueprint(enc({ flow: [mod(1, { filter: { conditions: [{ a: 1, o: 'x' }] } })] }))).includes('BP_BAD_FILTER'));
    assert.ok(codes(loadBlueprint(enc({ flow: [mod(1, { filter: { conditions: [[{ a: 1 }]] } })] }))).includes('BP_BAD_FILTER_CONDITION'));
  });

  it('enforces the module limit', () => {
    const flow = Array.from({ length: 5 }, (_, i) => mod(i + 1));
    assert.ok(codes(loadBlueprint(enc({ flow }), { ...DEFAULT_LIMITS, maxModules: 3 })).includes('BP_TOO_MANY_MODULES'));
  });

  it('warns about unknown module keys instead of ignoring them', () => {
    const r = loadBlueprint(enc({ flow: [mod(1, { surprise: true })] }));
    assert.deepEqual(r.findings.map((f) => [f.code, f.severity]), [['BP_UNKNOWN_MODULE_KEY', 'warning']]);
    assert.ok(r.plan);
  });

  it('reports a line and column for structural findings', () => {
    const text = '{\n  "flow": [\n    {"id": 1, "module": "a:b", "version": 1},\n    {"id": 1, "module": "a:c", "version": 1}\n  ]\n}';
    const f = loadBlueprint(new TextEncoder().encode(text)).findings[0];
    assert.equal(f?.code, 'BP_DUPLICATE_MODULE_ID');
    assert.equal(f?.loc?.line, 4);
  });

  it('recognises Make\'s flat modules format and refuses it clearly', () => {
    const r = loadBlueprint(enc({ name: 'x', modules: [{ id: 1, module: 'gateway:CustomWebHook', version: 1 }] }));
    assert.equal(r.format, 'modules-schema');
    assert.deepEqual(r.findings.map((f) => [f.code, f.severity]), [['FORMAT_MODULES_SCHEMA', 'unsupported']]);
  });

  it('rejects documents that are not blueprints', () => {
    assert.deepEqual(codes(loadBlueprint(enc([]))), ['BP_NOT_AN_OBJECT']);
    assert.deepEqual(codes(loadBlueprint(enc({ name: 'x' }))), ['BP_NO_FLOW']);
  });
});

describe('buildPlan: normalized plan (BR-009)', () => {
  const B = JSON.parse(readFileSync('corpus/blueprints/B.blueprint.json', 'utf8'));
  const hash = (doc: unknown) => {
    const r = loadBlueprint(enc(doc));
    assert.ok(r.plan, JSON.stringify(r.findings));
    return r.plan.semanticHash;
  };

  it('keeps ids, versions, execution order, branches and the fallback route', () => {
    const plan = loadBlueprint(enc(B)).plan!;
    assert.deepEqual(plan.modules.map((m) => [m.id, m.order, m.branch.map((b) => `${b.owner}:${b.index}`).join('>')]), [
      [1, 0, ''], [2, 1, ''], [3, 2, '2:0'], [4, 3, '2:1'], [5, 4, '2:2'],
    ]);
    assert.equal(plan.modules[1]?.elseRoute, 2);
    assert.deepEqual(plan.modules[3]?.upstream, [1, 2]);
    assert.equal(plan.modules[3]?.filter?.conditions[0]?.[0]?.o, 'number:greater');
  });

  it('presentation changes leave the semantic hash unchanged', () => {
    const moved = structuredClone(B);
    moved.name = 'renamed';
    moved.flow[0].metadata.designer = { x: 999, y: -5 };
    moved.flow[1].routes[0].flow[0].filter.name = 'a different label';
    moved.metadata.designer = { orphans: [] };
    moved.metadata.notes = [{ text: 'hi' }];
    moved.flow[1].routes[0].flow[0].mapper = { value: moved.flow[1].routes[0].flow[0].mapper.value, name: moved.flow[1].routes[0].flow[0].mapper.name };
    assert.equal(hash(moved), hash(B));
  });

  it('semantic changes alter the hash', () => {
    const base = hash(B);
    const mapping = structuredClone(B);
    mapping.flow[1].routes[0].flow[0].mapper.value = 'changed';
    const operator = structuredClone(B);
    operator.flow[1].routes[1].flow[0].filter.conditions[0][0].o = 'number:less';
    const fallback = structuredClone(B);
    fallback.flow[1].parameters.else = 1;
    const order = structuredClone(B);
    order.flow[1].routes.reverse();
    const setting = structuredClone(B);
    setting.metadata.scenario.sequential = true;
    for (const changed of [mapping, operator, fallback, order, setting]) assert.notEqual(hash(changed), base);
  });

  it('gives error-handler modules the failing module\'s upstream, not its output', () => {
    const doc = { flow: [mod(1), mod(2, { onerror: [mod(3)] })] };
    const plan = loadBlueprint(enc(doc)).plan!;
    const handler = plan.modules.find((m) => m.id === 3)!;
    assert.deepEqual(handler.upstream, [1]);
    assert.deepEqual(handler.branch, [{ owner: 2, kind: 'onerror', index: 0 }]);
  });
});

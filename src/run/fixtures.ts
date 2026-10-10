import { isObject, type JsonObject, type JsonValue } from '../json/parse.ts';
import { firstDifference } from './compare.ts';

/**
 * Fixture substitution (spec section 7). A fixture stands in for a module that would
 * reach outside the scenario: it proves how the scenario handles a supplied response,
 * not that the live service would send it.
 *
 *   { "schemaVersion": 1, "fixtures": [
 *     { "module": 2, "occurrence": 1, "mode": "http",
 *       "request":  { "method": "POST", "url": "https://api.example.test/x", "contentType": "application/json", "body": "{...}" },
 *       "response": { "status": 200, "headers": [["content-type", "application/json"]], "body": "{...}" } },
 *     { "module": 5, "occurrence": 1, "mode": "module",
 *       "input": { ...the mapped input bundle... }, "output": [ { ...one output bundle... } ] }
 *   ] }
 *
 * Matching fails closed (spec 7.1): every invocation needs exactly one fixture for its
 * module and occurrence (the module's operation number), the request or input must
 * match it exactly, and a fixture that is never used fails the case. There is no
 * network fallback.
 */

export type FixtureMode = 'http' | 'module';

export interface HttpRequest {
  method: string;
  url: string;
  contentType: string | null;
  body: string | null;
}

export interface HttpFixture {
  module: number;
  occurrence: number;
  mode: 'http';
  request: HttpRequest;
  response: { status: number; headers: [string, string][]; body: string };
}

export interface ModuleFixture {
  module: number;
  occurrence: number;
  mode: 'module';
  input: JsonValue;
  output?: JsonValue[];
  error?: { name: string; message: string };
}

export type Fixture = HttpFixture | ModuleFixture;

/** A fixture is missing, ambiguous, unused or does not match: exit 5. */
export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

/** The fixtures a run used, for the report (spec 7: reports name the mode). */
export interface FixtureUse {
  module: number;
  occurrence: number;
  mode: FixtureMode;
}

const key = (module: number, occurrence: number) => `${module}#${occurrence}`;

export class FixtureSet {
  private readonly byKey = new Map<string, Fixture>();
  private readonly used = new Set<string>();
  readonly uses: FixtureUse[] = [];

  constructor(fixtures: Fixture[] = []) {
    for (const f of fixtures) {
      const k = key(f.module, f.occurrence);
      if (this.byKey.has(k)) throw new FixtureError(`two fixtures for module ${f.module}, invocation ${f.occurrence}`);
      this.byKey.set(k, f);
    }
  }

  /** Validates a parsed fixtures file. Throws FixtureError with the offending entry. */
  static fromJson(doc: JsonValue): FixtureSet {
    if (!isObject(doc) || doc['schemaVersion'] !== 1 || !Array.isArray(doc['fixtures'])) throw new FixtureError('a fixtures file needs "schemaVersion": 1 and a "fixtures" array');
    return new FixtureSet(doc['fixtures'].map((f, i) => parseFixture(f, i)));
  }

  private take(module: number, occurrence: number, mode: FixtureMode): Fixture {
    const k = key(module, occurrence);
    const f = this.byKey.get(k);
    if (!f) throw new FixtureError(`module ${module}, invocation ${occurrence}: no fixture (offline runs never reach the network)`);
    if (f.mode !== mode) throw new FixtureError(`module ${module}, invocation ${occurrence}: the fixture is "${f.mode}", this module needs "${mode}"`);
    if (this.used.has(k)) throw new FixtureError(`module ${module}, invocation ${occurrence}: fixture used twice`);
    this.used.add(k);
    this.uses.push({ module, occurrence, mode });
    return f;
  }

  /** The HTTP fixture for this call, after checking the request the scenario built. */
  http(module: number, occurrence: number, request: HttpRequest): HttpFixture {
    const f = this.take(module, occurrence, 'http') as HttpFixture;
    const d = firstDifference(f.request as unknown as JsonValue, request as unknown as JsonValue);
    if (d) throw new FixtureError(`module ${module}, invocation ${occurrence}: request ${d.pointer || '/'} expected ${JSON.stringify(d.expected ?? null)}, the scenario built ${JSON.stringify(d.actual ?? null)}. Fixture was not consumed.`);
    return f;
  }

  /** The module fixture for this call, after checking the mapped input. */
  module(module: number, occurrence: number, input: JsonValue): ModuleFixture {
    const f = this.take(module, occurrence, 'module') as ModuleFixture;
    const d = firstDifference(f.input, input);
    if (d) throw new FixtureError(`module ${module}, invocation ${occurrence}: input ${d.pointer || '/'} expected ${JSON.stringify(d.expected ?? null)}, the scenario mapped ${JSON.stringify(d.actual ?? null)}. Fixture was not consumed.`);
    return f;
  }

  /** Fails if any fixture was never used (spec 7.1: required fixture unused). */
  assertAllUsed(): void {
    const unused = [...this.byKey.keys()].filter((k) => !this.used.has(k));
    if (unused.length) throw new FixtureError(`fixture${unused.length > 1 ? 's' : ''} never used: ${unused.map((k) => `module ${k.replace('#', ', invocation ')}`).join('; ')}`);
  }
}

function parseFixture(f: JsonValue, i: number): Fixture {
  const bad = (why: string) => new FixtureError(`fixtures[${i}]: ${why}`);
  if (!isObject(f)) throw bad('expected an object');
  const { module, occurrence, mode } = f;
  if (typeof module !== 'number' || !Number.isSafeInteger(module) || module < 1) throw bad('"module" must be a module id');
  if (typeof occurrence !== 'number' || !Number.isSafeInteger(occurrence) || occurrence < 1) throw bad('"occurrence" must be a 1-based invocation number');
  const allowed = (keys: string[]) => {
    const extra = Object.keys(f).filter((k) => !keys.includes(k));
    if (extra.length) throw bad(`unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}`);
  };
  if (mode === 'http') {
    allowed(['module', 'occurrence', 'mode', 'request', 'response']);
    const req = f['request'];
    const res = f['response'];
    if (!isObject(req) || typeof req['method'] !== 'string' || typeof req['url'] !== 'string') throw bad('"request" needs "method" and "url"');
    for (const k of ['contentType', 'body'] as const) if (!(k in req) || (req[k] !== null && typeof req[k] !== 'string')) throw bad(`"request.${k}" must be text or null`);
    if (Object.keys(req).length !== 4) throw bad('"request" takes exactly method, url, contentType and body');
    if (!isObject(res) || typeof res['status'] !== 'number' || typeof res['body'] !== 'string') throw bad('"response" needs a numeric "status" and a text "body"');
    const headers = res['headers'] ?? [];
    if (!Array.isArray(headers) || !headers.every((h) => Array.isArray(h) && h.length === 2 && typeof h[0] === 'string' && typeof h[1] === 'string')) throw bad('"response.headers" must be a list of [name, value] pairs');
    return {
      module, occurrence, mode,
      request: { method: req['method'], url: req['url'], contentType: req['contentType'] as string | null, body: req['body'] as string | null },
      response: { status: res['status'], headers: headers as [string, string][], body: res['body'] },
    };
  }
  if (mode === 'module') {
    allowed(['module', 'occurrence', 'mode', 'input', 'output', 'error']);
    if (!('input' in f)) throw bad('"input" (the expected mapped input bundle) is required');
    const output = f['output'];
    const error = f['error'];
    if ((output === undefined) === (error === undefined)) throw bad('give exactly one of "output" or "error"');
    if (output !== undefined && !Array.isArray(output)) throw bad('"output" must be a list of bundles');
    if (error !== undefined && (!isObject(error) || typeof error['name'] !== 'string' || typeof error['message'] !== 'string')) throw bad('"error" needs "name" and "message"');
    const fx: ModuleFixture = { module, occurrence, mode, input: f['input']! };
    if (output !== undefined) fx.output = output as JsonValue[];
    if (error !== undefined) fx.error = { name: (error as JsonObject)['name'] as string, message: (error as JsonObject)['message'] as string };
    return fx;
  }
  throw bad('"mode" must be "http" or "module"');
}

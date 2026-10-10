import type { PlanModule } from '../blueprint/plan.ts';
import { DataError, UnsupportedError } from '../expr/errors.ts';
import { evaluateMapper, type EvalContext } from '../expr/evaluate.ts';
import { MISSING, toJson, toText, type Value } from '../expr/values.ts';
import { isObject, JsonParseError, parseJson, type JsonObject, type JsonValue } from '../json/parse.ts';
import type { FixtureSet } from './fixtures.ts';
import type { HttpResponse } from './trace.ts';

/**
 * Module behavior, one entry per module type the scheduler can execute. Each was
 * matched against real Make runs (corpus/reference).
 */

export interface ModuleResult {
  input: JsonValue[];
  output: JsonValue[];
  response?: HttpResponse;
}

/** What a module invocation needs besides its mapping: which operation it is, and the case's fixtures. */
export interface ModuleCall {
  operation: number;
  fixtures: FixtureSet;
}

export interface ModuleHandler {
  run(module: PlanModule, ctx: EvalContext, call: ModuleCall): ModuleResult;
  /**
   * Refusals decided by the module's settings alone, whatever the payload. `bpr inspect`
   * calls this, so a file it calls eligible is not refused by the same rule at run time.
   */
  check?(module: PlanModule): void;
}

/** A mapper value that is fixed in the blueprint (no {{…}} anywhere inside), or undefined. */
function literal(v: JsonValue | undefined): JsonValue | undefined {
  if (v === undefined) return undefined;
  return JSON.stringify(v).includes('{{') ? undefined : v;
}

const mapperIsObject = (module: PlanModule) => {
  if (!isObject(module.mapper)) throw new UnsupportedError(`module ${module.id}: a mapper that is not an object has not been observed in Make`);
};

/**
 * Evaluate a mapper into the module's input bundle. Each top-level field is evaluated
 * on its own so a failure names it, as Make does: "Failed to map 'body': ..." (corpus D-05).
 * A field that comes out as empty text, missing or null is recorded as null
 * (upper("") gave {"value": null} in corpus A-004, A-005, A-006).
 */
export function mapInput(mapper: JsonValue, ctx: EvalContext): JsonObject {
  if (!isObject(mapper)) throw new UnsupportedError(`a mapper that is not an object (${typeof mapper}) has not been observed in Make`);
  const out: JsonObject = {};
  for (const key of Object.keys(mapper)) {
    let v: Value;
    try {
      v = evaluateMapper(mapper[key]!, ctx);
    } catch (e) {
      if (e instanceof DataError) throw new DataError(`Failed to map '${key}': ${e.message}`);
      throw e;
    }
    out[key] = v.kind === 'string' && v.value === '' ? null : toJson(v);
  }
  return out;
}

const webhookTrigger: ModuleHandler = {
  run() {
    throw new Error('the trigger is handled by the scheduler');
  },
};

/** Set variable: input {name, value}, output {[name]: value} (corpus A-001..A-009). */
const setVariable: ModuleHandler = {
  check: mapperIsObject,
  run(module, ctx) {
    const input = mapInput(module.mapper, ctx);
    const name = input['name'];
    if (typeof name !== 'string' || name === '') throw new UnsupportedError(`Set variable ${module.id}: a variable name of ${JSON.stringify(name)} has not been observed in Make`);
    return { input: [input], output: [{ [name]: input['value'] ?? null }] };
  },
};

/**
 * Webhook response: input {body, status, headers}. Make turns the mapped status "200"
 * into the number 200, and records one null output bundle. A null body reaches the
 * caller as "Accepted" (corpus A-004).
 */
const webhookRespond: ModuleHandler = {
  check(module) {
    mapperIsObject(module);
    const headers = literal((module.mapper as JsonObject)['headers']);
    if (Array.isArray(headers) && headers.length > 0) throw new UnsupportedError(`Webhook response ${module.id}: custom headers have not been observed in Make`);
  },
  run(module, ctx) {
    const input = mapInput(module.mapper, ctx);
    const status = input['status'];
    const code = typeof status === 'number' ? status : typeof status === 'string' && /^\d+$/.test(status) ? Number(status) : NaN;
    if (!Number.isInteger(code) || code < 100) throw new UnsupportedError(`Webhook response ${module.id}: status ${JSON.stringify(status)} has not been observed in Make`);
    input['status'] = code;
    const headers = input['headers'] ?? [];
    if (!Array.isArray(headers) || headers.length > 0) throw new UnsupportedError(`Webhook response ${module.id}: custom headers have not been observed in Make`);
    input['headers'] = headers;
    const body = input['body'] ?? null;
    if (body !== null && typeof body !== 'string') throw new UnsupportedError(`Webhook response ${module.id}: a body that is not text (${JSON.stringify(body).slice(0, 40)}) has not been observed in Make`);
    return { input: [input], output: [null], response: { status: code, body: body ?? 'Accepted' } };
  },
};

const onlyKeys = (module: PlanModule, what: 'mapper' | 'parameters', allowed: string[]) => {
  const v = module[what];
  if (what === 'mapper' && !isObject(v)) return;
  for (const k of Object.keys(isObject(v) ? v : {})) {
    if (!allowed.includes(k)) throw new UnsupportedError(`module ${module.id} (${module.module}): the ${what} field "${k}" has not been observed in Make`);
  }
};

/**
 * A module that started (its input was mapped) and then failed inside Make. Recorded
 * with its input, one null output and Make's error name (corpus C2-nl-03).
 */
export class ModuleFailure extends Error {
  readonly errorName: string;
  readonly input: JsonValue[];
  constructor(errorName: string, message: string, input: JsonValue[]) {
    super(message);
    this.name = 'ModuleFailure';
    this.errorName = errorName;
    this.input = input;
  }
}

/**
 * Iterator: input {array}, one output bundle per element; the scheduler sends each
 * bundle down the flow on its own. 1 operation however many bundles (corpus C).
 * - array of collections: each bundle is the collection plus __IMTINDEX__ (1-based) and __IMTLENGTH__ (C-01)
 * - array of plain values or of arrays: each bundle is the bare element, 0 included (C2-nl-01, -02, -05)
 * - an array with a null element: TypeError, the run fails (C2-nl-03)
 * - a single collection: treated as a 1-element array (C-14)
 * - text (empty text too), a number or a boolean: one bundle, the bare value (C-13, C2-nl-06..08)
 * - [], null or missing: no bundles (C-04, C-05; missing is recorded as null)
 * Unlike other modules, empty text stays "" in the input bundle (C2-nl-06).
 */
const iterator: ModuleHandler = {
  check: mapperIsObject,
  run(module, ctx) {
    onlyKeys(module, 'mapper', ['array']);
    const mapper = isObject(module.mapper) ? module.mapper : {};
    let raw: Value;
    try {
      raw = mapper['array'] === undefined ? MISSING : evaluateMapper(mapper['array'], ctx);
    } catch (e) {
      if (e instanceof DataError) throw new DataError(`Failed to map 'array': ${e.message}`);
      throw e;
    }
    const source = raw.kind === 'missing' ? null : toJson(raw);
    const input: JsonValue[] = [{ array: source }];
    let output: JsonValue[];
    if (source === null) output = [];
    else if (Array.isArray(source)) {
      if (source.includes(null)) throw new ModuleFailure('TypeError', 'Cannot convert undefined or null to object', input);
      if (source.every(isObject)) output = source.map((item, i) => ({ ...(item as JsonObject), __IMTINDEX__: i + 1, __IMTLENGTH__: source.length }));
      else if (source.some(isObject)) throw new UnsupportedError(`Iterator ${module.id}: an array that mixes collections and other values has not been observed in Make`);
      else output = source;
    } else if (isObject(source)) output = [{ ...source, __IMTINDEX__: 1, __IMTLENGTH__: 1 }];
    else output = [source];
    return { input, output };
  },
};

/** Validates a Text aggregator's settings and returns its row separator. */
export function textAggregatorSeparator(module: PlanModule): string {
  onlyKeys(module, 'mapper', ['value']);
  onlyKeys(module, 'parameters', ['rowSeparator', 'otherRowSeparator', 'feeder']);
  const p = module.parameters;
  // "\n" and "\t" are the separator itself (C2-nl, C2-tab); "other" uses otherRowSeparator (C).
  if (p['rowSeparator'] === '\n' || p['rowSeparator'] === '\t') return p['rowSeparator'];
  if (p['rowSeparator'] !== 'other') throw new UnsupportedError(`Text aggregator ${module.id}: row separator ${JSON.stringify(p['rowSeparator'] ?? null)} has not been observed in Make`);
  const sep = p['otherRowSeparator'];
  if (typeof sep !== 'string') throw new UnsupportedError(`Text aggregator ${module.id}: separator ${JSON.stringify(sep ?? null)} has not been observed in Make`);
  return sep;
}

/**
 * Text aggregator, one bundle collected: input {value}, the value written as text
 * (1 → "1", true → "true", {"k":1} → JSON, [1,"b"] → "1, b" with a no-break space;
 * C2-nl-02, -08, -09). Empty, null and missing are stored as null and become an
 * empty row (C2-nl-04, -05).
 */
export function textAggregatorRow(module: PlanModule, ctx: EvalContext): JsonObject {
  const mapper = isObject(module.mapper) ? module.mapper['value'] : undefined;
  let v: Value;
  try {
    v = mapper === undefined ? MISSING : evaluateMapper(mapper, ctx);
  } catch (e) {
    if (e instanceof DataError) throw new DataError(`Failed to map 'value': ${e.message}`);
    throw e;
  }
  const text = v.kind === 'missing' || v.kind === 'null' ? '' : toText(v);
  return { value: text === '' ? null : text };
}

/** Text aggregator output: the rows joined, one bundle {text}, "" when no bundle arrived (C-03, C-04). */
export function textAggregatorResult(rows: JsonObject[], separator: string): ModuleResult {
  return { input: rows, output: [{ text: rows.map((r) => (r['value'] as string | null) ?? '').join(separator) }] };
}

/**
 * HTTP "Make a request" (http:ActionSendData v3), served from an HTTP fixture. The
 * request is built from the mapped input and must match the fixture; the fixture's
 * response becomes the output bundle the way Make recorded it (corpus E):
 *   {statusCode, headers: [{name, value}] (names lowercased, in order),
 *    cookieHeaders: [every set-cookie value], data, fileSize}
 * - data is the parsed JSON when parseResponse is on and the response is JSON
 *   (E-json-01, E-get-01), the body text when it is off (E-text-01)
 * - fileSize is the body length (33 for a 33-character ASCII body)
 * - 200 and 201 succeed; 404 fails the module with DataError "Error: 404 Not Found",
 *   recorded with its input (E-json-03)
 * Inferred, not observed: cookieHeaders is [] when no set-cookie header came back
 * (every recorded response had one).
 */
const HTTP_OPTIONS: Record<string, JsonValue> = {
  ca: null, qs: [], headers: [], gzip: true, timeout: null, useMtls: false, authPass: null, authUser: null,
  serializeUrl: false, shareCookies: false, followRedirect: true, useQuerystring: false, followAllRedirects: false, rejectUnauthorized: true,
};

const httpRequest: ModuleHandler = {
  check(module) {
    onlyKeys(module, 'parameters', ['handleErrors', 'useNewZLibDeCompress']);
    if (module.parameters['handleErrors'] !== true) throw new UnsupportedError(`HTTP ${module.id}: "Evaluate all states as errors" switched off has not been observed in Make`);
    mapperIsObject(module);
    onlyKeys(module, 'mapper', [...Object.keys(HTTP_OPTIONS), 'url', 'method', 'bodyType', 'contentType', 'data', 'parseResponse']);
    const mapper = module.mapper as JsonObject;
    for (const [k, v] of Object.entries(HTTP_OPTIONS)) {
      const fixed = literal(mapper[k]);
      if (fixed !== undefined && JSON.stringify(fixed === '' ? null : fixed) !== JSON.stringify(v)) throw new UnsupportedError(`HTTP ${module.id}: ${k} = ${JSON.stringify(fixed).slice(0, 60)} has not been observed in Make`);
    }
    const bodyType = literal(mapper['bodyType']);
    if (bodyType !== undefined && bodyType !== '' && bodyType !== 'raw') throw new UnsupportedError(`HTTP ${module.id}: body type ${JSON.stringify(bodyType)} has not been observed in Make`);
  },
  run(module, ctx, call) {
    httpRequest.check!(module);
    const input = mapInput(module.mapper, ctx);
    const unobserved = (what: string) => new UnsupportedError(`HTTP ${module.id}: ${what} has not been observed in Make`);
    for (const [k, v] of Object.entries(HTTP_OPTIONS)) {
      if (k in input && JSON.stringify(input[k]) !== JSON.stringify(v)) throw unobserved(`${k} = ${JSON.stringify(input[k]).slice(0, 60)}`);
    }
    const { url, method, bodyType, parseResponse } = input;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw unobserved(`the URL ${JSON.stringify(url ?? null)}`);
    if (typeof method !== 'string' || !['get', 'post', 'put', 'patch', 'delete'].includes(method)) throw unobserved(`method ${JSON.stringify(method ?? null)}`);
    if (typeof parseResponse !== 'boolean') throw unobserved(`parseResponse = ${JSON.stringify(parseResponse ?? null)}`);
    let contentType: string | null = null;
    let body: string | null = null;
    if (bodyType === 'raw') {
      if (typeof input['contentType'] !== 'string' || typeof input['data'] !== 'string') throw unobserved('a raw body without a content type or with empty data');
      contentType = input['contentType'];
      body = input['data'];
    } else if (bodyType !== null && bodyType !== undefined) {
      throw unobserved(`body type ${JSON.stringify(bodyType)}`);
    }

    const fixture = call.fixtures.http(module.id, call.operation, { method: method.toUpperCase(), url, contentType, body });
    const { status, headers, body: text } = fixture.response;
    if (status === 404) throw new ModuleFailure('DataError', 'Error: 404 Not Found', [input]);
    if (status !== 200 && status !== 201) throw unobserved(`a response with status ${status} (recorded: 200, 201, 404)`);
    if (text === '' || /[^\x00-\x7f]/.test(text)) throw unobserved('an empty or non-ASCII response body (fileSize is only known for ASCII)');
    let data: JsonValue = text;
    if (parseResponse) {
      const type = headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] ?? '';
      if (!/^application\/json\b/i.test(type)) throw unobserved(`parsing a "${type}" response`);
      try {
        data = parseJson(text, 64).value;
      } catch (e) {
        if (e instanceof JsonParseError) throw unobserved(`parsing a response that is not valid JSON (${e.message})`);
        throw e;
      }
    }
    const output: JsonObject = {
      statusCode: status,
      headers: headers.map(([name, value]) => ({ name: name.toLowerCase(), value })),
      cookieHeaders: headers.filter(([n]) => n.toLowerCase() === 'set-cookie').map(([, v]) => v),
      data,
      fileSize: text.length,
    };
    return { input: [input], output: [output] };
  },
};

/**
 * Apps whose modules run inside Make. They are engine behavior and must be
 * implemented and recorded, never replaced by a fixture.
 */
const LOCAL_APPS = new Set(['builtin', 'util', 'gateway', 'json', 'regexp', 'http', 'datastore', 'tools', 'csv', 'xml', 'markdown', 'code', 'scenario-service', 'placeholder']);

/** A third-party app module (e.g. google-sheets:addRow): runs only from an opaque module fixture. */
export const isOpaqueModule = (module: string): boolean => !LOCAL_APPS.has(module.slice(0, module.indexOf(':')));

/**
 * Opaque module fixture (spec 7: the connector stays unverified). The mapped input
 * must equal the fixture's; the fixture's output, or its error, stands in for the
 * service. Exactly one output bundle: modules that return several act like
 * iterators, which has not been observed.
 */
const opaqueModule: ModuleHandler = {
  check: mapperIsObject,
  run(module, ctx, call) {
    const input = mapInput(module.mapper, ctx);
    const fixture = call.fixtures.module(module.id, call.operation, input);
    if (fixture.error) throw new ModuleFailure(fixture.error.name, fixture.error.message, [input]);
    if (fixture.output!.length !== 1) throw new UnsupportedError(`module ${module.id} (${module.module}): a fixture with ${fixture.output!.length} output bundles; only 1 is supported (several would fan out like an iterator)`);
    return { input: [input], output: fixture.output! };
  },
};

/**
 * Basic trigger (Tools): emits the bundles written in its settings, each a collection of
 * name/value text pairs, in order. Values stay text, empty text included (T-08); no
 * __IMTINDEX__ is added (T-01). Only text values have been recorded.
 */
export function basicTriggerBundles(module: PlanModule): JsonObject[] {
  onlyKeys(module, 'parameters', ['values']);
  if (isObject(module.mapper) && Object.keys(module.mapper).length > 0) throw new UnsupportedError(`Basic trigger ${module.id}: mapped fields have not been observed in Make`);
  const values = module.parameters['values'];
  if (!Array.isArray(values)) throw new UnsupportedError(`Basic trigger ${module.id}: bundles that are not a list have not been observed in Make`);
  return values.map((item, i) => {
    const spec = isObject(item) ? item['spec'] : undefined;
    if (!Array.isArray(spec)) throw new UnsupportedError(`Basic trigger ${module.id}: bundle ${i + 1} has no item list`);
    const bundle: JsonObject = {};
    for (const s of spec) {
      if (!isObject(s) || typeof s['name'] !== 'string' || typeof s['value'] !== 'string') throw new UnsupportedError(`Basic trigger ${module.id}: bundle ${i + 1} has an item that is not a text name and value; only text has been observed in Make`);
      if (s['name'] in bundle) throw new UnsupportedError(`Basic trigger ${module.id}: bundle ${i + 1} repeats the name "${s['name']}"; that has not been observed in Make`);
      bundle[s['name']] = s['value'];
    }
    return bundle;
  });
}

const basicTrigger: ModuleHandler = {
  check(module) {
    basicTriggerBundles(module);
  },
  run() {
    throw new Error('the trigger is handled by the scheduler');
  },
};

/**
 * Sleep (Tools): input {duration} as a number of seconds, one null output bundle (corpus
 * N-01: the mapped "3" was recorded as 3). Offline it does not wait; the clock for `now`
 * comes from the case, not from the wall.
 */
const sleep: ModuleHandler = {
  check(module) {
    mapperIsObject(module);
    onlyKeys(module, 'mapper', ['duration']);
  },
  run(module, ctx) {
    sleep.check!(module);
    const input = mapInput(module.mapper, ctx);
    const d = input['duration'];
    const seconds = typeof d === 'number' ? d : typeof d === 'string' && /^\d+$/.test(d) ? Number(d) : NaN;
    if (!Number.isInteger(seconds) || seconds < 1) throw new UnsupportedError(`Sleep ${module.id}: a duration of ${JSON.stringify(d ?? null)} has not been observed in Make`);
    input['duration'] = seconds;
    return { input: [input], output: [null] };
  },
};

/** The handler for a module, or undefined if it cannot run. */
export function handlerFor(module: string): ModuleHandler | undefined {
  return HANDLERS[module] ?? (isOpaqueModule(module) ? opaqueModule : undefined);
}

export const HANDLERS: Readonly<Record<string, ModuleHandler>> = {
  'gateway:CustomWebHook': webhookTrigger,
  'util:SetVariable2': setVariable,
  'gateway:WebhookRespond': webhookRespond,
  'builtin:BasicFeeder': iterator,
  'http:ActionSendData': httpRequest,
  'util:BasicTrigger': basicTrigger,
  'util:FunctionSleep': sleep,
};

import { isObject, type JsonValue } from '../json/parse.ts';
import { UnsupportedError } from './errors.ts';

/**
 * A value inside the runtime. "missing" (the field is absent) and "null" (the field
 * is JSON null) stay distinct (spec section 6). Dates are instants in epoch ms.
 */
export type Value =
  | { kind: 'missing' }
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'date'; value: number }
  | { kind: 'binary'; value: Uint8Array }
  | { kind: 'array'; value: Value[] }
  | { kind: 'object'; value: Map<string, Value> };

export type Kind = Value['kind'];

export const MISSING: Value = Object.freeze({ kind: 'missing' });
export const NULL: Value = Object.freeze({ kind: 'null' });
export const str = (value: string): Value => ({ kind: 'string', value });
export const num = (value: number): Value => ({ kind: 'number', value });
export const bool = (value: boolean): Value => ({ kind: 'boolean', value });
export const arr = (value: Value[]): Value => ({ kind: 'array', value });
export const obj = (value: Map<string, Value>): Value => ({ kind: 'object', value });
export const date = (value: number): Value => ({ kind: 'date', value });

export function fromJson(v: JsonValue | undefined): Value {
  if (v === undefined) return MISSING;
  if (v === null) return NULL;
  if (typeof v === 'boolean') return bool(v);
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string') return str(v);
  if (Array.isArray(v)) return arr(v.map(fromJson));
  if (isObject(v)) return obj(new Map(Object.keys(v).map((k) => [k, fromJson(v[k])])));
  throw new TypeError('not a JSON value');
}

/** Plain JSON for a value. Dates become ISO strings; missing object members are dropped. */
export function toJson(v: Value): JsonValue {
  switch (v.kind) {
    case 'missing':
    case 'null':
      return null;
    case 'boolean':
    case 'number':
    case 'string':
      return v.value;
    case 'date':
      return new Date(v.value).toISOString();
    case 'binary':
      throw new UnsupportedError('converting binary data to JSON has not been observed in Make');
    case 'array':
      return v.value.map(toJson);
    case 'object': {
      const out = Object.create(null) as Record<string, JsonValue>;
      for (const [k, x] of v.value) if (x.kind !== 'missing') out[k] = toJson(x);
      return out;
    }
  }
}

/** Make joins array elements with a comma and a NO-BREAK SPACE (U+00A0), not a normal space (corpus D). */
const ARRAY_SEPARATOR = ',' + String.fromCharCode(0xa0);

/** JavaScript number formatting, which matches every Make output seen: -2.3333333333333335, 1e+21, Infinity, NaN. */
export function numberText(n: number): string {
  return String(n);
}

/**
 * How Make writes a value into text (a field with text around an expression,
 * or join). Observed in corpus D:
 *   missing, null    → ""
 *   true / false     → "true" / "false"
 *   array            → elements joined with "," + NO-BREAK SPACE (U+00A0), not a normal space
 *   object           → compact JSON                  ({"k1":"v1","k2":2})
 *   date             → ISO 8601 with milliseconds, UTC
 */
export function toText(v: Value): string {
  switch (v.kind) {
    case 'missing':
    case 'null':
      return '';
    case 'boolean':
      return v.value ? 'true' : 'false';
    case 'number':
      return numberText(v.value);
    case 'string':
      return v.value;
    case 'date':
      return new Date(v.value).toISOString();
    case 'binary':
      throw new UnsupportedError('writing binary data as text has not been observed in Make');
    case 'array':
      return arrayText(v.value);
    case 'object':
      return JSON.stringify(toJson(v));
  }
}

/**
 * Arrays have two observed separators (corpus D, D2):
 *   [c, a, b]                     → "c,␣a,␣b"        comma + NO-BREAK SPACE
 *   [{…}, {…}]                    → "{…}, {…}"       each as JSON, comma + normal space
 *   [[1, 2], [3, [4]]]            → "1,␣2, 3,␣4"     each inner array flattened and joined
 *                                                     like a plain array, comma + normal space
 * Arrays mixing plain values and collections have not been observed.
 */
function arrayText(xs: Value[]): string {
  const isCollection = (x: Value) => x.kind === 'array' || x.kind === 'object';
  if (!xs.some(isCollection)) return xs.map(toText).join(ARRAY_SEPARATOR);
  if (xs.every((x) => x.kind === 'object')) return xs.map(toText).join(', ');
  if (xs.every((x) => x.kind === 'array')) return xs.map((x) => flatText(x)).join(', ');
  throw new UnsupportedError('writing an array that mixes plain values and collections as text has not been observed in Make');
}

function flatText(v: Value): string {
  const flat: Value[] = [];
  const walk = (x: Value) => (x.kind === 'array' ? x.value.forEach(walk) : flat.push(x));
  walk(v);
  if (flat.some((x) => x.kind === 'object')) throw new UnsupportedError('writing nested arrays that contain collections as text has not been observed in Make');
  return flat.map(toText).join(ARRAY_SEPARATOR);
}

export function describe(v: Value): string {
  return v.kind === 'string' ? `text ${JSON.stringify(v.value.length > 40 ? `${v.value.slice(0, 37)}...` : v.value)}` : v.kind;
}

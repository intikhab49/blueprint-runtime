import { createHash } from 'node:crypto';
import * as dates from './dates.ts';
import { UnsupportedError } from './errors.ts';
import { arr, bool, date, describe, MISSING, num, obj, str, toText, type Value } from './values.ts';

/**
 * Make's built-in functions. Each one accepts only the argument types it was
 * seen handling in a real Make run (corpus D, see corpus/NOTES.md). Anything else
 * throws UnsupportedError instead of guessing.
 */

export interface FnContext {
  /** Scenario timezone (IANA name). Date functions refuse to run without it. */
  timezone: string | null;
}

/** A failure Make itself reports. The evaluator wraps it as "Function 'x' finished with error! ...". */
export class FnFailure extends Error {}

type Impl = (args: Value[], ctx: FnContext) => Value;

export interface FnDef {
  min: number;
  max: number;
  impl: Impl;
}

const unsupported = (fn: string, why: string): never => {
  throw new UnsupportedError(`${fn}(): ${why} has not been observed in Make`);
};

function text(fn: string, v: Value | undefined, i: number): string {
  if (v?.kind === 'string') return v.value;
  return unsupported(fn, `${describe(v ?? MISSING)} as argument ${i + 1}`);
}
function number(fn: string, v: Value | undefined, i: number): number {
  if (v?.kind === 'number') return v.value;
  return unsupported(fn, `${describe(v ?? MISSING)} as argument ${i + 1}`);
}
function array(fn: string, v: Value | undefined, i: number): Value[] {
  if (v?.kind === 'array') return v.value;
  return unsupported(fn, `${describe(v ?? MISSING)} as argument ${i + 1}`);
}
function object(fn: string, v: Value | undefined, i: number): Map<string, Value> {
  if (v?.kind === 'object') return v.value;
  return unsupported(fn, `${describe(v ?? MISSING)} as argument ${i + 1}`);
}
function tz(fn: string, ctx: FnContext): string {
  if (!ctx.timezone) throw new UnsupportedError(`${fn}() depends on the scenario timezone, and none is configured`);
  return ctx.timezone;
}
function instant(fn: string, v: Value | undefined, i: number): number {
  if (v?.kind === 'date') return v.value;
  if (v?.kind === 'string') {
    const t = dates.parseIsoInstant(v.value);
    if (t !== null) return t;
  }
  return unsupported(fn, `${describe(v ?? MISSING)} as a date (argument ${i + 1})`);
}

/** Equality used by contains/remove/switch/map filters: same kind only (strings and numbers observed). */
function sameValue(fn: string, a: Value, b: Value): boolean {
  if (a.kind !== b.kind) {
    if ((a.kind === 'string' || a.kind === 'number') && (b.kind === 'string' || b.kind === 'number')) {
      return unsupported(fn, `comparing ${a.kind} with ${b.kind}`);
    }
    return false;
  }
  if (a.kind === 'string' || a.kind === 'number' || a.kind === 'boolean') return a.value === (b as typeof a).value;
  return unsupported(fn, `comparing ${a.kind} values`);
}

const primitiveText = (fn: string, v: Value): string => {
  if (v.kind === 'string' || v.kind === 'number' || v.kind === 'boolean') return toText(v);
  return unsupported(fn, `${v.kind} elements`);
};

const utf8 = (s: string) => Buffer.from(s, 'utf8');
const hash = (alg: string) => (fn: string): FnDef => ({ min: 1, max: 1, impl: ([s]) => str(createHash(alg).update(utf8(text(fn, s, 0))).digest('hex')) });
const textFn = (fn: string, f: (s: string) => string): FnDef => ({ min: 1, max: 1, impl: ([s]) => str(f(text(fn, s, 0))) });
/** Like textFn, but missing and null count as "": upper(1.nope) = "" and lower(null) = "" (corpus D2). */
const emptyTextFn = (fn: string, f: (s: string) => string): FnDef => ({
  min: 1,
  max: 1,
  impl: ([s]) => str(f(s?.kind === 'missing' || s?.kind === 'null' ? '' : text(fn, s, 0))),
});

function numbersOf(fn: string, args: Value[]): number[] {
  if (args.length === 1 && args[0]?.kind === 'array') return args[0].value.map((v, i) => number(fn, v, i));
  return args.map((v, i) => number(fn, v, i));
}

const DEFS: Record<string, (fn: string) => FnDef> = {
  // text
  // Numbers and arrays become text first, the JavaScript way: upper(123) = "123",
  // upper(["a", "b"]) = "A,B" with a plain comma (corpus A-007, A-009).
  upper: (fn) => ({
    min: 1,
    max: 1,
    impl: ([s]) => {
      if (s?.kind === 'number') return str(toText(s).toUpperCase());
      if (s?.kind === 'array') return str(s.value.map((v) => (v.kind === 'missing' || v.kind === 'null' ? '' : primitiveText(fn, v))).join(',').toUpperCase());
      if (s?.kind === 'missing' || s?.kind === 'null') return str('');
      return str(text(fn, s, 0).toUpperCase());
    },
  }),
  lower: (fn) => emptyTextFn(fn, (s) => s.toLowerCase()),
  capitalize: (fn) => textFn(fn, (s) => s.charAt(0).toUpperCase() + s.slice(1)),
  // "ÜBER" → "Über": the rest of each word is lowercased (corpus D-02). Only space-separated words observed.
  startcase: (fn) => textFn(fn, (s) => s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())),
  trim: (fn) => emptyTextFn(fn, (s) => s.trim()),
  // Removes every non-ASCII character: "café ÜBER" → "caf BER" (corpus D-02).
  ascii: (fn) => textFn(fn, (s) => s.replace(/[^\x00-\x7F]/g, '')),
  encodeURL: (fn) => textFn(fn, (s) => encodeURIComponent(s)),
  decodeURL: (fn) =>
    textFn(fn, (s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return unsupported(fn, 'malformed percent-encoding');
      }
    }),
  escapeHTML: (fn) =>
    textFn(fn, (s) => {
      if (/["']/.test(s)) unsupported(fn, 'text containing quotes');
      return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    }),
  stripHTML: (fn) => textFn(fn, (s) => s.replace(/<[^>]*>/g, '')),
  escapeMarkdown: (fn) =>
    textFn(fn, (s) => {
      if (/[\\`*_{}[\]()#+\-.!|>~<]/.test(s)) unsupported(fn, 'text containing Markdown characters');
      return s;
    }),
  base64: (fn) => textFn(fn, (s) => utf8(s).toString('base64')),
  md5: hash('md5'),
  sha1: hash('sha1'),
  sha256: hash('sha256'),
  length: (fn) => ({
    min: 1,
    max: 1,
    impl: ([v]) => {
      if (v?.kind === 'string' || v?.kind === 'array') return num(v.value.length); // UTF-16 units: an emoji counts 2 (corpus D-02)
      if (v?.kind === 'missing' || v?.kind === 'null') return num(0); // length(1.nope) = 0 (corpus D2)
      return unsupported(fn, describe(v ?? MISSING));
    },
  }),
  substring: (fn) => ({ min: 3, max: 3, impl: ([s, a, b]) => str(text(fn, s, 0).substring(number(fn, a, 1), number(fn, b, 2))) }),
  indexOf: (fn) => ({
    min: 2,
    max: 2,
    impl: ([s, q]) => {
      const hay = text(fn, s, 0);
      // A bare word is missing; Make returned -1 for indexOf("hello world"; o) (corpus D-01).
      if (q?.kind === 'missing') return num(hay.indexOf('undefined'));
      return num(hay.indexOf(text(fn, q, 1)));
    },
  }),
  // Plain text replaces every occurrence: "o" in "hello world" → "hell0 w0rld" (corpus D-01).
  // Text shaped like a regex is one: "/o/g" replaces all, "/o/" and "/l+/" the first match.
  // "/O/gi" changed nothing, so other flags are refused (corpus D2).
  replace: (fn) => ({
    min: 3,
    max: 3,
    impl: ([s, q, r]) => {
      const hay = text(fn, s, 0);
      const needle = q?.kind === 'missing' ? 'undefined' : text(fn, q, 1);
      const rep = r?.kind === 'string' || r?.kind === 'number' ? toText(r) : unsupported(fn, `${describe(r ?? MISSING)} as the replacement`);
      const re = /^\/(.+)\/([a-z]*)$/s.exec(needle);
      if (!re) return str(hay.split(needle).join(rep));
      if (re[2] !== '' && re[2] !== 'g') return unsupported(fn, `the regex flags "${re[2]}"`);
      if (rep.includes('$')) return unsupported(fn, 'a "$" in the replacement of a regex');
      let pattern: RegExp;
      try {
        pattern = new RegExp(re[1]!, re[2]);
      } catch {
        return unsupported(fn, `the pattern ${JSON.stringify(re[1])}`);
      }
      return str(hay.replace(pattern, rep));
    },
  }),
  contains: (fn) => ({
    min: 2,
    max: 2,
    impl: ([h, n]) => {
      if (h?.kind === 'string') return bool(h.value.includes(text(fn, n, 1)));
      if (h?.kind === 'array') return bool(h.value.some((x) => sameValue(fn, x, n ?? MISSING)));
      if (h?.kind === 'number') throw new FnFailure('array.indexOf is not a function'); // corpus D-05
      return unsupported(fn, describe(h ?? MISSING));
    },
  }),
  // split("") is an empty array in Make, not [""] (corpus D-04).
  split: (fn) => ({ min: 2, max: 2, impl: ([s, sep]) => {
    const t = text(fn, s, 0);
    return arr(t === '' ? [] : t.split(text(fn, sep, 1)).map(str));
  } }),
  toString: (fn: string): FnDef => ({
    min: 1,
    max: 2,
    impl: ([v, enc]: Value[]) => {
      if (v?.kind === 'binary') {
        if (enc?.kind === 'string' && enc.value === 'hex') return str(Buffer.from(v.value).toString('hex'));
        return unsupported(fn, `binary with encoding ${describe(enc ?? MISSING)}`);
      }
      if (enc !== undefined) return unsupported(fn, 'an encoding for non-binary input');
      if (v?.kind === 'number' || v?.kind === 'string') return str(toText(v));
      return unsupported(fn, describe(v ?? MISSING));
    },
  }),
  toBinary: (fn) => ({ min: 1, max: 1, impl: ([s]) => ({ kind: 'binary', value: new Uint8Array(utf8(text(fn, s, 0))) }) }),

  // math
  round: (fn) => ({ min: 1, max: 1, impl: ([n]) => num(Math.round(number(fn, n, 0))) }), // round(-2.5) = -2 (corpus D-01)
  ceil: (fn) => ({ min: 1, max: 1, impl: ([n]) => num(Math.ceil(number(fn, n, 0))) }),
  floor: (fn) => ({ min: 1, max: 1, impl: ([n]) => num(Math.floor(number(fn, n, 0))) }),
  max: (fn) => ({ min: 1, max: Infinity, impl: (a) => num(Math.max(...numbersOf(fn, a))) }), // max([]) = -Infinity (corpus D-03)
  min: (fn) => ({ min: 1, max: Infinity, impl: (a) => num(Math.min(...numbersOf(fn, a))) }),
  sum: (fn) => ({ min: 1, max: 1, impl: ([a]) => num(array(fn, a, 0).reduce((t, v, i) => t + number(fn, v, i), 0)) }),
  average: (fn) => ({
    min: 1,
    max: 1,
    impl: ([a]) => {
      const xs = array(fn, a, 0).map((v, i) => number(fn, v, i));
      return num(xs.reduce((t, x) => t + x, 0) / xs.length); // average([]) = NaN (corpus D-03)
    },
  }),
  // parseNumber("1.234,56"; ",") = 1234.56 and parseNumber("abc"; ",") = 0 (corpus D-01, D-03).
  parseNumber: (fn) => ({
    min: 2,
    max: 2,
    impl: ([t, sep]) => {
      const s = text(fn, t, 0);
      const d = text(fn, sep, 1);
      if (d.length !== 1) unsupported(fn, `decimal separator ${JSON.stringify(d)}`);
      const kept = [...s].filter((c) => /[0-9-]/.test(c) || c === d).join('').replaceAll(d, '.');
      return num(Number(kept));
    },
  }),
  formatNumber: (fn) => ({
    min: 4,
    max: 4,
    impl: ([n, dec, dsep, tsep]) => {
      const x = number(fn, n, 0);
      const digits = number(fn, dec, 1);
      const fixed = Math.abs(x).toFixed(digits);
      const [int, frac] = fixed.split('.');
      const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, text(fn, tsep, 3));
      return str(`${x < 0 ? '-' : ''}${grouped}${frac === undefined ? '' : text(fn, dsep, 2) + frac}`);
    },
  }),

  // logic
  // The evaluator handles if() itself so that only the chosen branch is evaluated.
  if: () => ({ min: 3, max: 3, impl: ([c, a, b]) => (truthy(c ?? MISSING) ? a! : b!) }),
  ifempty: (fn) => ({
    min: 2,
    max: 2,
    impl: ([v, fb]) => {
      const x = v ?? MISSING;
      // Only "", null and missing are empty. [], {}, 0 and false come back unchanged (corpus D2).
      if (x.kind === 'missing' || x.kind === 'null' || (x.kind === 'string' && x.value === '')) return fb!;
      return x;
    },
  }),
  switch: (fn) => ({
    min: 3,
    max: Infinity,
    impl: ([v, ...rest]) => {
      for (let i = 0; i + 1 < rest.length; i += 2) if (sameValue(fn, v ?? MISSING, rest[i]!)) return rest[i + 1]!;
      return rest.length % 2 === 1 ? rest[rest.length - 1]! : MISSING;
    },
  }),

  // arrays and collections
  // Nested arrays are flattened first: join([[1, 2], [3, [4]]]; "|") = "1|2|3|4"; join(1.nope; ",") = "" (corpus D2).
  join: (fn) => ({
    min: 2,
    max: 2,
    impl: ([a, sep]) => {
      if (a?.kind === 'missing' || a?.kind === 'null') return str('');
      return str(deepFlatten(array(fn, a, 0)).map((v) => (v.kind === 'missing' || v.kind === 'null' ? '' : primitiveText(fn, v))).join(text(fn, sep, 1)));
    },
  }),
  first: (fn) => ({
    min: 1,
    max: 1,
    impl: ([a]) => {
      if (a?.kind === 'string') throw new FnFailure(`'${a.value}' is not a valid array.`); // corpus D-05b
      return array(fn, a, 0)[0] ?? MISSING;
    },
  }),
  last: (fn) => ({ min: 1, max: 1, impl: ([a]) => array(fn, a, 0).at(-1) ?? MISSING }),
  reverse: (fn) => ({ min: 1, max: 1, impl: ([a]) => arr([...array(fn, a, 0)].reverse()) }),
  // Text sorts by UTF-16 code units: [é, e, z, É] → e, z, É, é (corpus D-02).
  // Numbers sort numerically: [1, 2, 3, 10] stays 1, 2, 3, 10 (corpus D2). Mixed arrays are refused.
  sort: (fn) => ({
    min: 1,
    max: 2,
    impl: ([a, order]) => {
      const xs = [...array(fn, a, 0)];
      if (xs.every((v) => v.kind === 'string')) xs.sort((x, y) => (x.value < y.value ? -1 : x.value > y.value ? 1 : 0));
      else if (xs.every((v) => v.kind === 'number')) xs.sort((x, y) => x.value - y.value);
      else return unsupported(fn, 'an array mixing types');
      if (order === undefined) return arr(xs);
      if (order.kind === 'string' && order.value === 'desc') return arr(xs.reverse());
      return unsupported(fn, `sort order ${describe(order)}`);
    },
  }),
  slice: (fn) => ({ min: 3, max: 3, impl: ([a, s, e]) => arr(array(fn, a, 0).slice(number(fn, s, 1), number(fn, e, 2))) }), // 0-based (corpus D-01)
  // 1 and "1" count as the same value (corpus D-01).
  deduplicate: (fn) => ({
    min: 1,
    max: 1,
    impl: ([a]) => {
      const seen = new Set<string>();
      return arr(array(fn, a, 0).filter((v) => {
        const k = primitiveText(fn, v);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }));
    },
  }),
  add: (fn) => ({ min: 2, max: Infinity, impl: ([a, ...vs]) => arr([...array(fn, a, 0), ...vs]) }),
  remove: (fn) => ({ min: 2, max: Infinity, impl: ([a, ...vs]) => arr(array(fn, a, 0).filter((x) => !vs.some((v) => sameValue(fn, x, v)))) }),
  merge: (fn) => ({ min: 1, max: Infinity, impl: (as) => arr(as.flatMap((a, i) => array(fn, a, i))) }),
  // All levels: length(flatten([[1, 2], [3, [4]]])) = 4 (corpus D2).
  flatten: (fn) => ({ min: 1, max: 1, impl: ([a]) => arr(deepFlatten(array(fn, a, 0))) }),
  map: (fn) => ({
    min: 2,
    max: Infinity,
    impl: ([a, key, fkey, ...fvals]) => {
      const k = text(fn, key, 1);
      let items = array(fn, a, 0).map((v, i) => object(fn, v, i));
      if (fkey !== undefined) {
        const fk = text(fn, fkey, 2);
        items = items.filter((m) => fvals.some((fv) => sameValue(fn, m.get(fk) ?? MISSING, fv)));
      }
      return arr(items.map((m) => m.get(k) ?? unsupported(fn, `an item without the key ${JSON.stringify(k)}`)));
    },
  }),
  keys: (fn) => ({ min: 1, max: 1, impl: ([o]) => arr([...object(fn, o, 0).keys()].map(str)) }),
  // get(people; "1.name"): numeric path segments index arrays from 1 (corpus D-01).
  get: (fn) => ({
    min: 2,
    max: 2,
    impl: ([c, path]) => {
      let cur: Value = c ?? MISSING;
      for (const seg of text(fn, path, 1).split('.')) {
        if (cur.kind === 'object') cur = cur.value.get(seg) ?? MISSING;
        else if (cur.kind === 'array' && /^\d+$/.test(seg)) cur = cur.value[Number(seg) - 1] ?? MISSING;
        else if (cur.kind === 'missing' || cur.kind === 'null') return MISSING;
        else return unsupported(fn, `the path segment ${JSON.stringify(seg)} on ${cur.kind}`);
      }
      return cur;
    },
  }),
  toArray: (fn) => ({ min: 1, max: 1, impl: ([o]) => arr([...object(fn, o, 0)].map(([k, v]) => obj(new Map([['key', str(k)], ['value', v]])))) }),
  pick: (fn) => ({ min: 2, max: Infinity, impl: ([o, ...ks]) => {
    const m = object(fn, o, 0);
    const want = ks.map((k, i) => text(fn, k, i + 1));
    return obj(new Map([...m].filter(([k]) => want.includes(k))));
  } }),
  omit: (fn) => ({ min: 2, max: Infinity, impl: ([o, ...ks]) => {
    const m = object(fn, o, 0);
    const drop = ks.map((k, i) => text(fn, k, i + 1));
    return obj(new Map([...m].filter(([k]) => !drop.includes(k))));
  } }),

  // dates (scenario timezone)
  parseDate: (fn) => ({ min: 2, max: 3, impl: ([t, f, zone], ctx) => date(dates.parseDate(text(fn, t, 0), text(fn, f, 1), zone === undefined ? tz(fn, ctx) : text(fn, zone, 2))) }),
  formatDate: (fn) => ({ min: 2, max: 3, impl: ([d, f, zone], ctx) => str(dates.formatDate(instant(fn, d, 0), text(fn, f, 1), zone === undefined ? tz(fn, ctx) : text(fn, zone, 2))) }),
  addDays: (fn) => ({ min: 2, max: 2, impl: ([d, n], ctx) => date(dates.addDays(instant(fn, d, 0), number(fn, n, 1), tz(fn, ctx))) }),
  addMonths: (fn) => ({ min: 2, max: 2, impl: ([d, n], ctx) => date(dates.addMonths(instant(fn, d, 0), number(fn, n, 1), tz(fn, ctx))) }),
  addHours: (fn) => ({ min: 2, max: 2, impl: ([d, n]) => date(instant(fn, d, 0) + number(fn, n, 1) * 3_600_000) }),
  // Moves within the Sunday-first week: Saturday 2026-01-31 → Monday 2026-01-26 (corpus D-01).
  setDay: (fn) => ({
    min: 2,
    max: 2,
    impl: ([d, day], ctx) => {
      const zone = tz(fn, ctx);
      const t = instant(fn, d, 0);
      const target = dates.DAY_NAMES.indexOf(text(fn, day, 1).toLowerCase());
      if (target === -1) unsupported(fn, `day ${describe(day!)}`);
      return date(dates.addDays(t, target - dates.weekday(t, zone), zone));
    },
  }),
};

export const FUNCTIONS: Readonly<Record<string, FnDef>> = Object.fromEntries(Object.entries(DEFS).map(([name, make]) => [name, make(name)]));

/**
 * if() truthiness is JavaScript's: "false", "0", "abc", -1, [] and {} are true; false,
 * 0, "", null and missing are false (corpus D-01, D2).
 */
export function truthy(v: Value): boolean {
  switch (v.kind) {
    case 'boolean':
      return v.value;
    case 'number':
      return v.value !== 0 && !Number.isNaN(v.value);
    case 'string':
      return v.value !== '';
    case 'missing':
    case 'null':
      return false;
    default:
      return true;
  }
}

function deepFlatten(xs: Value[]): Value[] {
  return xs.flatMap((v) => (v.kind === 'array' ? deepFlatten(v.value) : [v]));
}

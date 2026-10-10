import * as dates from '../expr/dates.ts';
import { UnsupportedError } from '../expr/errors.ts';
import { describe, toText, type Value } from '../expr/values.ts';

/**
 * Filter operators, each matched against Make's recorded decisions (corpus B, C and
 * the F1 filter probe: corpus/responses/F1-filters.*). Values Make was not seen
 * handling are refused instead of guessed (spec 2.1).
 */

export interface OperatorContext {
  timezone: string | null;
}

type Operator = (a: Value, b: Value, ctx: OperatorContext) => boolean;

const refuse = (op: string, v: Value, why = ''): never => {
  throw new UnsupportedError(`filter "${op}" with ${describe(v)}${why ? ` (${why})` : ''} has not been observed in Make`);
};

/**
 * Text form for text operators: numbers become text (42 equals "42"), and missing
 * and null are "" (missing equals "", null equals ""). F1: te_num_text, te_missing_empty, te_null_empty.
 */
function text(op: string, v: Value): string {
  if (v.kind === 'missing' || v.kind === 'null') return '';
  if (v.kind === 'string' || v.kind === 'number') return toText(v);
  return refuse(op, v);
}

/** Case-insensitive variants: only ASCII text has been observed. */
function lower(op: string, s: string): string {
  if (/[^\x00-\x7F]/.test(s)) throw new UnsupportedError(`filter "${op}" on non-ASCII text has not been observed in Make`);
  return s.toLowerCase();
}

const DECIMAL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Number form for number operators. Observed: "150" → 150, "1e3" → 1000, true → 1,
 * false → 0; "", "abc", "150abc", null and missing are not numbers, so every
 * comparison with them is false (corpus B, F1: ng_empty, ng_null, ng_suffix, ng_bool).
 */
function number(op: string, v: Value): number {
  switch (v.kind) {
    case 'number':
      return v.value;
    case 'boolean':
      return v.value ? 1 : 0;
    case 'missing':
    case 'null':
      return NaN;
    case 'string':
      if (DECIMAL.test(v.value)) return Number(v.value);
      if (Number.isNaN(Number(v.value)) || v.value.trim() === '') return NaN;
      return refuse(op, v, 'a number format other than plain decimal');
    default:
      return refuse(op, v);
  }
}

/** "true" and "false" as text count as booleans (F1: be_text). */
function bool(op: string, v: Value): boolean {
  if (v.kind === 'boolean') return v.value;
  if (v.kind === 'string' && (v.value === 'true' || v.value === 'false')) return v.value === 'true';
  return refuse(op, v);
}

/**
 * An instant for date operators. Full ISO timestamps compare as instants (F1: dg_same).
 * A date without a time is midnight in some timezone; when the scenario timezone and UTC
 * would decide differently, the comparison is refused.
 */
function instants(op: string, v: Value, ctx: OperatorContext): number[] {
  if (v.kind === 'date') return [v.value];
  if (v.kind === 'string') {
    const t = dates.parseIsoInstant(v.value);
    if (t !== null) return [t];
    if (/^\d{4}-\d{2}-\d{2}$/.test(v.value)) {
      const utc = Date.parse(`${v.value}T00:00:00.000Z`);
      if (!ctx.timezone) return [utc];
      return [utc, dates.parseDate(v.value, 'YYYY-MM-DD', ctx.timezone)];
    }
  }
  return refuse(op, v, 'not an ISO date');
}

function dateCompare(op: string, cmp: (x: number, y: number) => boolean): Operator {
  return (a, b, ctx) => {
    const results = new Set(instants(op, a, ctx).flatMap((x) => instants(op, b, ctx).map((y) => cmp(x, y))));
    if (results.size > 1) throw new UnsupportedError(`filter "${op}": the result depends on whether a date without a time is read in UTC or the scenario timezone, which has not been observed`);
    return [...results][0]!;
  };
}

function regex(op: string, source: string, flags: string): RegExp {
  try {
    return new RegExp(source, flags);
  } catch {
    throw new UnsupportedError(`filter "${op}": the pattern ${JSON.stringify(source)} is not a valid regular expression`);
  }
}

const textOp = (op: string, f: (x: string, y: string) => boolean, ci = false): Operator => (a, b) => {
  const x = text(op, a);
  const y = text(op, b);
  return ci ? f(lower(op, x), lower(op, y)) : f(x, y);
};

const numOp = (op: string, f: (x: number, y: number) => boolean): Operator => (a, b) => f(number(op, a), number(op, b));

/** Existence: missing, null and "" do not exist; 0, false and [] do (F1: ex_*). */
const exists = (v: Value) => !(v.kind === 'missing' || v.kind === 'null' || (v.kind === 'string' && v.value === ''));

function arrayContains(op: string, a: Value, b: Value): boolean {
  if (a.kind !== 'array') return refuse(op, a, 'not an array');
  const needle = text(op, b);
  return a.value.some((el) => (el.kind === 'string' ? el.value === needle : refuse(op, el, 'array elements that are not text')));
}

export const OPERATORS: Readonly<Record<string, Operator>> = {
  // Text: case-sensitive unless :ci, no trimming (corpus B, F1).
  'text:equal': textOp('text:equal', (x, y) => x === y),
  'text:equal:ci': textOp('text:equal:ci', (x, y) => x === y, true),
  'text:notequal': textOp('text:notequal', (x, y) => x !== y),
  'text:notequal:ci': textOp('text:notequal:ci', (x, y) => x !== y, true),
  'text:contain': textOp('text:contain', (x, y) => x.includes(y)),
  'text:contain:ci': textOp('text:contain:ci', (x, y) => x.includes(y), true),
  'text:notcontain': textOp('text:notcontain', (x, y) => !x.includes(y)),
  'text:notcontain:ci': textOp('text:notcontain:ci', (x, y) => !x.includes(y), true),
  'text:startwith': textOp('text:startwith', (x, y) => x.startsWith(y)),
  'text:startwith:ci': textOp('text:startwith:ci', (x, y) => x.startsWith(y), true),
  'text:notstartwith': textOp('text:notstartwith', (x, y) => !x.startsWith(y)),
  'text:endwith': textOp('text:endwith', (x, y) => x.endsWith(y)),
  'text:endwith:ci': textOp('text:endwith:ci', (x, y) => x.endsWith(y), true),
  'text:notendwith': textOp('text:notendwith', (x, y) => !x.endsWith(y)),
  'text:pattern': textOp('text:pattern', (x, y) => regex('text:pattern', y, '').test(x)),
  'text:pattern:ci': (a, b) => regex('text:pattern:ci', text('text:pattern:ci', b), 'i').test(text('text:pattern:ci', a)),
  'text:notpattern': textOp('text:notpattern', (x, y) => !regex('text:notpattern', y, '').test(x)),

  // Numbers (corpus B, C, F1).
  'number:equal': numOp('number:equal', (x, y) => x === y),
  'number:notequal': numOp('number:notequal', (x, y) => {
    if (Number.isNaN(x) || Number.isNaN(y)) throw new UnsupportedError('filter "number:notequal" with a value that is not a number has not been observed in Make');
    return x !== y;
  }),
  'number:greater': numOp('number:greater', (x, y) => x > y),
  'number:less': numOp('number:less', (x, y) => x < y),
  'number:greaterorequal': numOp('number:greaterorequal', (x, y) => x >= y),
  'number:lessorequal': numOp('number:lessorequal', (x, y) => x <= y),

  // Existence (F1). The second operand is ignored.
  exist: (a) => exists(a),
  notexist: (a) => !exists(a),

  // Booleans (F1).
  'boolean:equal': (a, b) => bool('boolean:equal', a) === bool('boolean:equal', b),
  'boolean:notequal': (a, b) => bool('boolean:notequal', a) !== bool('boolean:notequal', b),

  // Arrays of text, case-sensitive (F1).
  'array:contain': (a, b) => arrayContains('array:contain', a, b),
  'array:notcontain': (a, b) => !arrayContains('array:notcontain', a, b),

  // Dates (F1).
  'date:greater': dateCompare('date:greater', (x, y) => x > y),
  'date:less': dateCompare('date:less', (x, y) => x < y),
};

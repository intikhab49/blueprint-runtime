import { isObject, type JsonValue } from '../json/parse.ts';
import { DataError, UnsupportedError } from './errors.ts';
import { decAdd, decDiv, decMod, decMul, decSub } from './decimal.ts';
import { FnFailure, FUNCTIONS, truthy, type FnContext } from './functions.ts';
import { parseTemplate, type BinaryOp, type Node, type TemplatePart } from './parser.ts';
import { arr, bool, describe, fromJson, MISSING, num, obj, str, toText, type Value } from './values.ts';

export interface EvalContext extends FnContext {
  /** Output bundle of a module that already ran, or MISSING. */
  output(moduleId: number): Value;
}

/** Keywords whose values were observed in Make (corpus D). Other known keywords are refused. */
const KEYWORDS: Record<string, Value> = {
  true: bool(true),
  false: bool(false),
  emptystring: str(''),
  space: str(' '),
};
const UNOBSERVED_KEYWORDS = new Set(['null', 'now', 'timestamp', 'random', 'uuid', 'pi', 'nbsp', 'tab', 'newline', 'carriagereturn', 'emptyarray']);

export function evaluate(node: Node, ctx: EvalContext): Value {
  switch (node.type) {
    case 'number':
      return num(node.value);
    case 'string':
      return str(node.value);
    case 'word': {
      const k = KEYWORDS[node.name];
      if (k) return k;
      if (UNOBSERVED_KEYWORDS.has(node.name)) throw new UnsupportedError(`the keyword "${node.name}" has not been observed in Make`);
      // A bare word is not text in Make: indexOf("hello world"; o) = -1 (corpus D-01).
      return MISSING;
    }
    case 'ref': {
      let cur = ctx.output(node.moduleId);
      for (const [i, seg] of node.path.entries()) {
        if ('all' in seg) throw new UnsupportedError('mapping over an array with [] has not been observed in Make');
        if (cur.kind === 'missing' || cur.kind === 'null') return MISSING;
        // An iterator over plain values emits bare bundles. Any field of a bare text, number
        // or boolean reads as the value itself: 2.value and 2.__IMTINDEX__ gave "a" (C2-nl-01,
        // C2-noagg-01), and 2.qty on "hello" failed qty > 0 (C-13). A field of a bare array
        // reads as missing (C2-nl-05), and so does one of empty text (C2-nl-06, only bundle).
        // For 0, Make returned the previous bundle's value (C2-nl-02), so 0 and false are refused.
        if (i === 0 && 'key' in seg && (cur.kind === 'string' || cur.kind === 'number' || cur.kind === 'boolean' || cur.kind === 'array')) {
          if (cur.kind === 'array' || (cur.kind === 'string' && cur.value === '')) return MISSING;
          if (cur.value === 0 || cur.value === false) throw new UnsupportedError(`reading a field of the bare bundle ${String(cur.value)}: Make returned the previous bundle's value (corpus C2-nl-02), which is not modeled`);
          return cur;
        }
        if ('key' in seg) {
          if (cur.kind !== 'object') throw new UnsupportedError(`reading the field "${seg.key}" of ${describe(cur)} has not been observed in Make`);
          cur = cur.value.get(seg.key) ?? MISSING;
        } else {
          if (cur.kind !== 'array') throw new UnsupportedError(`indexing ${describe(cur)} with [${seg.index}] has not been observed in Make`);
          cur = cur.value[seg.index - 1] ?? MISSING; // 1-based: 1.arr[2] is the second element (corpus D-01)
        }
      }
      return cur;
    }
    case 'call': {
      const def = FUNCTIONS[node.name];
      if (!def) throw new UnsupportedError(`the function ${node.name}() has no recorded Make behavior yet`);
      if (node.args.length < def.min || node.args.length > def.max) {
        throw new UnsupportedError(`${node.name}() with ${node.args.length} argument(s) has not been observed in Make`);
      }
      // if() evaluates only the branch it picks: if(true; "picked"; first(bad)) gave "picked" (corpus D2).
      if (node.name === 'if') {
        return evaluate(truthy(evaluate(node.args[0]!, ctx)) ? node.args[1]! : node.args[2]!, ctx);
      }
      // Every other function gets all arguments evaluated first. Whether Make skips
      // unused arguments elsewhere (ifempty, switch) has not been observed.
      const args = node.args.map((a) => evaluate(a, ctx));
      try {
        return def.impl(args, ctx);
      } catch (e) {
        if (e instanceof FnFailure) throw new DataError(`Function '${node.name}' finished with error! ${e.message}`);
        throw e;
      }
    }
    case 'binary':
      return binary(node.op, evaluate(node.left, ctx), evaluate(node.right, ctx));
  }
}

/**
 * Number coercion for -, *, / and %: JavaScript's, except that a missing value counts
 * as 0. Observed: "007" * 1 = 7, "abc" * 2 = NaN, 1.nope * 2 = 0 (corpus D-03, D2).
 */
function toNum(op: string, v: Value): number {
  switch (v.kind) {
    case 'number':
      return v.value;
    case 'string':
      return Number(v.value);
    case 'missing':
    case 'null':
      return 0;
    case 'boolean':
      return v.value ? 1 : 0;
    default:
      throw new UnsupportedError(`"${op}" with ${describe(v)} has not been observed in Make`);
  }
}

/** A primitive as JavaScript sees it, for equality and ordering. */
function primitive(op: string, v: Value): string | number | boolean | null | undefined {
  switch (v.kind) {
    case 'missing':
      return undefined;
    case 'null':
      return null;
    case 'boolean':
    case 'number':
    case 'string':
      return v.value;
    default:
      throw new UnsupportedError(`"${op}" with ${describe(v)} has not been observed in Make`);
  }
}

/**
 * / and % are only trusted where exact decimal and JavaScript double arithmetic agree.
 * Observed results (1 / 3, -7 / 3, -7 % 3) fit both, so Make's choice is still unknown.
 */
function agreed(op: string, x: number, y: number, js: number, dec: number): number {
  if (Object.is(js, dec) || (Number.isNaN(js) && Number.isNaN(dec))) return js;
  throw new UnsupportedError(`${x} ${op} ${y}: decimal and floating-point results differ (${dec} vs ${js}); Make's rule for "${op}" has not been observed`);
}

function binary(op: BinaryOp, a: Value, b: Value): Value {
  switch (op) {
    case '+':
      // Two numbers add exactly in decimal: 0.1 + 0.2 = 0.3 (corpus D-01, D2).
      if (a.kind === 'number' && b.kind === 'number') return num(decAdd(a.value, b.value));
      // Anything else joins as text: "42" + 1 = "421", true + 1 = "true1", 1.nope + 1 = "1" (corpus D-01, D2).
      return str(toText(a) + toText(b));
    case '-':
      return num(decSub(toNum(op, a), toNum(op, b)));
    case '*':
      return num(decMul(toNum(op, a), toNum(op, b)));
    case '/': {
      const x = toNum(op, a);
      const y = toNum(op, b);
      return num(agreed(op, x, y, x / y, decDiv(x, y)));
    }
    case '%': {
      const x = toNum(op, a);
      const y = toNum(op, b);
      return num(agreed(op, x, y, x % y, decMod(x, y)));
    }
    case '=':
    case '!=': {
      // JavaScript's loose equality: 0 = false, null = missing and "42.0" = 42 are true,
      // true = "true" and null = "" are false (corpus D-01, D-03, D2).
      const eq = primitive(op, a) == primitive(op, b);
      return bool(op === '=' ? eq : !eq);
    }
    case '<':
    case '>':
    case '<=':
    case '>=': {
      // Text against text compares as text; otherwise numerically ("42" > 9, corpus D-01).
      // Missing and null have not been observed here: JavaScript would compare them as NaN and 0.
      if (a.kind === 'missing' || a.kind === 'null' || b.kind === 'missing' || b.kind === 'null') {
        throw new UnsupportedError(`"${op}" with ${a.kind === 'missing' || a.kind === 'null' ? a.kind : b.kind} has not been observed in Make`);
      }
      const x = primitive(op, a) as string | number | boolean;
      const y = primitive(op, b) as string | number | boolean;
      return bool(op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y);
    }
    case '&':
    case '|':
      if (a.kind === 'boolean' && b.kind === 'boolean') return bool(op === '&' ? a.value && b.value : a.value || b.value);
      throw new UnsupportedError(`"${op}" with ${describe(a)} and ${describe(b)} has not been observed in Make`);
  }
}

/**
 * A mapped field. One expression and nothing else keeps its type ({{1.items}} gave the
 * iterator a real array, corpus C); anything with surrounding text becomes text.
 */
export function evaluateTemplate(parts: TemplatePart[], ctx: EvalContext): Value {
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only && 'expr' in only) return evaluate(only.expr, ctx);
  return str(parts.map((p) => ('text' in p ? p.text : toText(evaluate(p.expr, ctx)))).join(''));
}

/** Evaluate a module's mapper: every string is a template; arrays and objects map through. */
export function evaluateMapper(v: JsonValue, ctx: EvalContext): Value {
  if (typeof v === 'string') return v.includes('{{') ? evaluateTemplate(parseTemplate(v), ctx) : str(v);
  if (Array.isArray(v)) return arr(v.map((x) => evaluateMapper(x, ctx)));
  if (isObject(v)) return obj(new Map(Object.keys(v).map((k) => [k, evaluateMapper(v[k]!, ctx)])));
  return fromJson(v);
}

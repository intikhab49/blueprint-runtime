import { ExprSyntaxError, UnsupportedError } from './errors.ts';
import { scanTemplate } from './scan.ts';

/**
 * Parser for Make's expression language (IML), the text between {{ and }}.
 * Builds an AST; nothing is ever turned into JavaScript (spec section 6).
 */

export type PathSeg = { key: string } | { index: number } | { all: true };

export type Node =
  | { type: 'number'; value: number; start: number; end: number; paren?: boolean }
  | { type: 'string'; value: string; start: number; end: number; paren?: boolean }
  | { type: 'word'; name: string; start: number; end: number; paren?: boolean }
  | { type: 'ref'; moduleId: number; path: PathSeg[]; start: number; end: number; paren?: boolean }
  | { type: 'call'; name: string; args: Node[]; start: number; end: number; paren?: boolean }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node; start: number; end: number; paren?: boolean };

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '=' | '!=' | '<' | '>' | '<=' | '>=' | '&' | '|';

type Tok =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'str'; v: string; s: number; e: number }
  | { t: 'ident'; v: string; s: number; e: number }
  | { t: 'tick'; v: string; s: number; e: number }
  | { t: 'ref'; v: number; s: number; e: number }
  | { t: 'op'; v: string; s: number; e: number }
  | { t: 'eof'; s: number; e: number };

const OPS = ['!=', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '%', '&', '|', '!', '(', ')', ';', '[', ']', '.'];

function lex(src: string, base: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const s = base + i;
    if (/\d/.test(ch)) {
      const digits = /^\d+/.exec(src.slice(i))![0];
      const after = src[i + digits.length];
      const next = src[i + digits.length + 1];
      if (after === '.' && next !== undefined && /[A-Za-z_$`]/.test(next)) {
        toks.push({ t: 'ref', v: Number(digits), s, e: s + digits.length });
        i += digits.length;
        continue;
      }
      const m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i))![0];
      toks.push({ t: 'num', v: Number(m), s, e: s + m.length });
      i += m.length;
      continue;
    }
    if (ch === '"') {
      const close = src.indexOf('"', i + 1);
      if (close === -1) throw new ExprSyntaxError('Unterminated string', s);
      // A backslash is not an escape: a string ends at the next quote. Make rejected
      // the expression "a\"b" as invalid (corpus D2), which is what this reading gives.
      toks.push({ t: 'str', v: src.slice(i + 1, close), s, e: base + close + 1 });
      i = close + 1;
      continue;
    }
    if (ch === '`') {
      const close = src.indexOf('`', i + 1);
      if (close === -1) throw new ExprSyntaxError('Unterminated `name`', s);
      toks.push({ t: 'tick', v: src.slice(i + 1, close), s, e: base + close + 1 });
      i = close + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i))![0];
      toks.push({ t: 'ident', v: m, s, e: s + m.length });
      i += m.length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      toks.push({ t: 'op', v: op, s, e: s + op.length });
      i += op.length;
      continue;
    }
    throw new ExprSyntaxError(`Unexpected character ${JSON.stringify(ch)}`, s);
  }
  toks.push({ t: 'eof', s: base + src.length, e: base + src.length });
  return toks;
}

/**
 * Lowest to highest precedence, all left-associative. Matches every Make result in
 * corpus D2: 1 + 2 * 3 = 7, 10 - 4 - 3 = 3, 2 * 3 % 4 = 2, true | false & false = true,
 * 1 + 2 = 3 is true.
 */
const LEVELS: BinaryOp[][] = [['|'], ['&'], ['=', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];

/**
 * Parse one expression (the text inside {{ }}). `base` is the offset of that text
 * in the whole field, so errors point at the right place.
 */
export function parseExpression(src: string, base = 0): Node {
  const toks = lex(src, base);
  let p = 0;
  const peek = () => toks[p]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.t === 'op' && t.v === v;
  };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new ExprSyntaxError(`Expected "${v}"`, peek().s);
    return toks[p++]!;
  };

  const parseLevel = (level: number): Node => {
    if (level === LEVELS.length) return parseUnary();
    let left = parseLevel(level + 1);
    while (true) {
      const t = peek();
      if (t.t !== 'op' || !(LEVELS[level] as string[]).includes(t.v)) return left;
      p++;
      const right = parseLevel(level + 1);
      left = { type: 'binary', op: t.v as BinaryOp, left, right, start: left.start, end: right.end };
    }
  };

  const parseUnary = (): Node => {
    const t = peek();
    if (t.t === 'op' && t.v === '-') {
      const next = toks[p + 1]!;
      if (next.t === 'num') {
        p += 2;
        return { type: 'number', value: -next.v, start: t.s, end: next.e };
      }
      throw new UnsupportedError('unary minus on anything but a number literal has not been observed in Make');
    }
    if (t.t === 'op' && t.v === '!') throw new UnsupportedError('the "!" operator has not been observed in Make');
    if (t.t === 'op' && t.v === '/') throw new UnsupportedError('regex literals like /o/g: Make ignored replace(s; /o/g; "0") in a real run, so their meaning is unknown');
    return parsePrimary();
  };

  const parsePath = (): PathSeg[] => {
    const path: PathSeg[] = [];
    while (true) {
      if (isOp('.')) {
        p++;
        const t = peek();
        if (t.t === 'ident' || t.t === 'tick') {
          p++;
          path.push({ key: t.v });
        } else throw new ExprSyntaxError('Expected a field name after "."', t.s);
      } else if (isOp('[')) {
        p++;
        const t = peek();
        if (t.t === 'num' && Number.isInteger(t.v)) {
          p++;
          path.push({ index: t.v });
        } else if (t.t === 'op' && t.v === ']') {
          path.push({ all: true });
        } else throw new ExprSyntaxError('Expected a whole number or nothing inside [ ]', t.s);
        expectOp(']');
      } else return path;
    }
  };

  const parsePrimary = (): Node => {
    const t = peek();
    switch (t.t) {
      case 'num':
        p++;
        return { type: 'number', value: t.v, start: t.s, end: t.e };
      case 'str':
        p++;
        return { type: 'string', value: t.v, start: t.s, end: t.e };
      case 'ref': {
        p++;
        const path = parsePath();
        return { type: 'ref', moduleId: t.v, path, start: t.s, end: toks[p - 1]!.e };
      }
      case 'tick': {
        p++;
        if (/^\d+$/.test(t.v)) return { type: 'ref', moduleId: Number(t.v), path: parsePath(), start: t.s, end: toks[p - 1]!.e };
        throw new ExprSyntaxError(`\`${t.v}\` on its own is not a reference`, t.s);
      }
      case 'ident': {
        p++;
        // var.organization.X, var.scenario.X, var.input.X are Make's custom variables and
        // scenario inputs; other word.path forms (connection.x, parameters.x) appear in
        // public blueprints too. None has been recorded.
        if (isOp('.')) {
          if (t.v === 'var') throw new UnsupportedError('{{var.…}} reads a Make custom variable or scenario input; those are not supported yet');
          throw new UnsupportedError(`"${t.v}.…" is not a module reference; how Make reads it has not been recorded`);
        }
        if (!isOp('(')) return { type: 'word', name: t.v, start: t.s, end: t.e };
        p++;
        const args: Node[] = [];
        if (isOp(')')) {
          p++;
          return { type: 'call', name: t.v, args, start: t.s, end: toks[p - 1]!.e };
        }
        while (true) {
          args.push(parseLevel(0));
          if (isOp(';')) {
            p++;
            continue;
          }
          const close = expectOp(')');
          return { type: 'call', name: t.v, args, start: t.s, end: close.e };
        }
      }
      case 'op':
        if (t.v === '(') {
          p++;
          const inner = parseLevel(0);
          const close = expectOp(')');
          return { ...inner, paren: true, start: t.s, end: close.e };
        }
        throw new ExprSyntaxError(`Unexpected "${t.v}"`, t.s);
      case 'eof':
        throw new ExprSyntaxError('Unexpected end of expression', t.s);
    }
  };

  const node = parseLevel(0);
  if (peek().t !== 'eof') throw new ExprSyntaxError('Unexpected text after the expression', peek().s);
  return node;
}

export type TemplatePart = { text: string } | { expr: Node; source: string };

/** Split a mapped field into literal text and parsed expressions. */
export function parseTemplate(field: string): TemplatePart[] {
  const scanned = scanTemplate(field);
  if (scanned.errors.length) throw new ExprSyntaxError(scanned.errors[0]!.message, scanned.errors[0]!.offset);
  const parts: TemplatePart[] = [];
  let at = 0;
  for (const e of scanned.exprs) {
    if (e.start > at) parts.push({ text: field.slice(at, e.start) });
    parts.push({ expr: parseExpression(e.text, e.start + 2), source: e.text });
    at = e.end;
  }
  if (at < field.length) parts.push({ text: field.slice(at) });
  return parts;
}

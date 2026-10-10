import type { Loc } from '../findings.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export class JsonParseError extends Error {
  readonly code: string;
  readonly loc: Loc;
  readonly pointer: string | undefined;

  constructor(code: string, message: string, loc: Loc, pointer?: string) {
    super(message);
    this.name = 'JsonParseError';
    this.code = code;
    this.loc = loc;
    this.pointer = pointer;
  }
}

export interface ParsedJson {
  value: JsonValue;
  /** Start offset of every value, keyed by JSON pointer ("" is the root). */
  offsets: Map<string, number>;
  locate(offset: number): Loc;
  locatePointer(pointer: string): Loc | undefined;
}

export function escapePointerToken(token: string | number): string {
  return String(token).replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Strict RFC 8259 JSON parser. Unlike JSON.parse it rejects duplicate object keys
 * (JSON.parse silently keeps the last one), enforces a nesting limit, and records
 * where each value starts so findings can point at a line and column.
 *
 * Numbers become IEEE-754 doubles, which matches what Make's webhook parser was
 * observed to do (corpus C-16: 9007199254740993 arrived as 9007199254740992).
 */
export function parseJson(text: string, maxDepth: number): ParsedJson {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);

  const locate = (offset: number): Loc => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo]! + 1, offset };
  };

  const offsets = new Map<string, number>();
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const fail = (code: string, message: string, at = pos, pointer?: string): never => {
    throw new JsonParseError(code, message, locate(at), pointer);
  };

  const skipWs = () => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) pos++;
      else break;
    }
  };

  const describe = (at: number) => (at >= text.length ? 'end of input' : JSON.stringify(text[at]));

  const parseString = (): string => {
    const start = pos;
    pos++; // opening quote
    let out = '';
    let chunk = pos;
    while (true) {
      if (pos >= text.length) fail('JSON_UNTERMINATED_STRING', 'Unterminated string', start);
      const c = text.charCodeAt(pos);
      if (c === 34) {
        out += text.slice(chunk, pos);
        pos++;
        return out;
      }
      if (c < 0x20) fail('JSON_CONTROL_CHAR', 'Unescaped control character in string');
      if (c === 92) {
        out += text.slice(chunk, pos);
        const e = text[pos + 1];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = text.slice(pos + 2, pos + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('JSON_BAD_ESCAPE', 'Invalid \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            fail('JSON_BAD_ESCAPE', `Invalid escape \\${e ?? ''}`);
        }
        pos += 2;
        chunk = pos;
        continue;
      }
      pos++;
    }
  };

  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  const parseValue = (pointer: string, depth: number): JsonValue => {
    skipWs();
    offsets.set(pointer, pos);
    const c = text[pos];
    if (c === '{' || c === '[') {
      if (depth >= maxDepth) fail('JSON_TOO_DEEP', `Nesting deeper than ${maxDepth} levels`, pos, pointer);
    }
    if (c === '{') {
      pos++;
      const obj = Object.create(null) as JsonObject;
      const seen = new Set<string>();
      skipWs();
      if (text[pos] === '}') {
        pos++;
        return obj;
      }
      while (true) {
        skipWs();
        if (text[pos] !== '"') fail('JSON_SYNTAX', `Expected a property name, found ${describe(pos)}`);
        const keyAt = pos;
        const key = parseString();
        const child = `${pointer}/${escapePointerToken(key)}`;
        if (seen.has(key)) {
          fail('JSON_DUPLICATE_KEY', `Duplicate key ${JSON.stringify(key)}; JSON.parse would silently keep the last one`, keyAt, child);
        }
        seen.add(key);
        skipWs();
        if (text[pos] !== ':') fail('JSON_SYNTAX', `Expected ":" after property name, found ${describe(pos)}`);
        pos++;
        obj[key] = parseValue(child, depth + 1);
        skipWs();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return obj;
        }
        fail('JSON_SYNTAX', `Expected "," or "}", found ${describe(pos)}`);
      }
    }
    if (c === '[') {
      pos++;
      const arr: JsonValue[] = [];
      skipWs();
      if (text[pos] === ']') {
        pos++;
        return arr;
      }
      while (true) {
        arr.push(parseValue(`${pointer}/${arr.length}`, depth + 1));
        skipWs();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return arr;
        }
        fail('JSON_SYNTAX', `Expected "," or "]", found ${describe(pos)}`);
      }
    }
    if (c === '"') return parseString();
    if (text.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    NUMBER.lastIndex = pos;
    const m = NUMBER.exec(text);
    if (m) {
      pos += m[0].length;
      return Number(m[0]);
    }
    return fail('JSON_SYNTAX', `Unexpected ${describe(pos)}`);
  };

  const value = parseValue('', 0);
  skipWs();
  if (pos < text.length) fail('JSON_SYNTAX', `Unexpected ${describe(pos)} after the document`);

  return {
    value,
    offsets,
    locate,
    locatePointer(pointer: string) {
      const at = offsets.get(pointer);
      return at === undefined ? undefined : locate(at);
    },
  };
}

export function isObject(v: JsonValue | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

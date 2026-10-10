/**
 * Locates {{ ... }} expressions inside a mapped string and lists what they touch.
 * This is a scanner, not the Day 4 parser: it never evaluates anything, it only
 * finds expression boundaries, module references and function names so `inspect`
 * can report them.
 */

export interface ModuleRef {
  moduleId: number;
  /** Field path after the module id, e.g. "items" or "people[1].name"; "" for the whole bundle. */
  path: string;
}

export interface ScannedExpr {
  /** Text between the braces. */
  text: string;
  /** Offsets of the opening "{{" and one past the closing "}}" in the field. */
  start: number;
  end: number;
  refs: ModuleRef[];
  functions: string[];
  keywords: string[];
  /**
   * Unquoted words that are not keywords, functions or references. In a real Make
   * run these did NOT behave as strings: indexOf("hello world"; o) returned -1
   * (corpus D-01). Reported so a user can check them.
   */
  bareWords: string[];
}

export interface ScanResult {
  exprs: ScannedExpr[];
  errors: { message: string; offset: number }[];
}

/** Bare identifiers Make treats as values, seen in real Make runs (corpus D) or documented. */
const KEYWORDS = new Set(['true', 'false', 'null', 'emptystring', 'space', 'nbsp', 'tab', 'newline', 'carriagereturn', 'now', 'timestamp', 'random', 'uuid', 'pi', 'emptyarray']);

// 1.name, 1.`Field name`, 1.items[2].name, 22.array[].name (empty [] maps over the array; seen in public blueprints)
const REF = /(?<![\w.$`])(\d+)\.((?:`[^`]*`|[A-Za-z_$][\w$]*)(?:\.(?:`[^`]*`|[A-Za-z_$][\w$]*)|\[\d*\])*)/g;
// `22` on its own: the whole output bundle of module 22 (seen as an iterator source in public blueprints)
const WHOLE_REF = /(?<![\w.$])`(\d+)`(?![.\w])/g;
const CALL = /(?<![\w.$])([A-Za-z_][\w]*)\s*\(/g;
const IDENT = /(?<![\w.$`])([A-Za-z_][\w]*)(?![\w(.`])/g;

/**
 * Replace double-quoted string contents with spaces so regexes don't match inside
 * literals. A backslash is not an escape in Make: a string ends at the next quote.
 */
function blankStrings(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '"') {
        inStr = false;
        out += ch;
      } else out += ' ';
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

/** Also blank out regex literals like /o/g that appear as function arguments. */
function blankRegexLiterals(s: string): string {
  return s.replace(/(^|[;(]\s*)\/((?:\\.|[^/\\])+)\/([a-z]*)/g, (_m, pre: string, body: string, flags: string) => `${pre}/${' '.repeat(body.length)}/${' '.repeat(flags.length)}`);
}

export function scanTemplate(s: string): ScanResult {
  const exprs: ScannedExpr[] = [];
  const errors: ScanResult['errors'] = [];
  let i = 0;
  while (true) {
    const open = s.indexOf('{{', i);
    if (open === -1) break;
    let j = open + 2;
    let depth = 0;
    let inStr = false;
    let close = -1;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '}' && s[j + 1] === '}' && depth <= 0) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      errors.push({ message: inStr ? 'Unterminated string inside {{ }}' : depth > 0 ? 'Unclosed "(" inside {{ }}' : 'Missing closing "}}"', offset: open });
      break;
    }
    const text = s.slice(open + 2, close);
    const code = blankRegexLiterals(blankStrings(text));
    const refs: ModuleRef[] = [];
    const refSpans: [number, number][] = [];
    for (const m of code.matchAll(REF)) {
      refs.push({ moduleId: Number(m[1]), path: text.slice(m.index! + m[1]!.length + 1, m.index! + m[0].length) });
      refSpans.push([m.index!, m.index! + m[0].length]);
    }
    for (const m of code.matchAll(WHOLE_REF)) {
      refs.push({ moduleId: Number(m[1]), path: '' });
      refSpans.push([m.index!, m.index! + m[0].length]);
    }
    const functions = [...code.matchAll(CALL)].map((m) => m[1]!);
    const idents = [...code.matchAll(IDENT)]
      .filter((m) => !refSpans.some(([a, b]) => m.index! >= a && m.index! < b))
      .map((m) => m[1]!);
    const keywords = idents.filter((w) => KEYWORDS.has(w));
    const bareWords = idents.filter((w) => !KEYWORDS.has(w));
    exprs.push({ text, start: open, end: close + 2, refs, functions, keywords, bareWords });
    i = close + 2;
  }
  return { exprs, errors };
}

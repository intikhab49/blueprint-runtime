import { readFileSync } from 'node:fs';
import { DataError, ExprSyntaxError, UnsupportedError } from '../../src/expr/errors.ts';
import { evaluateTemplate } from '../../src/expr/evaluate.ts';
import { parseTemplate } from '../../src/expr/parser.ts';
import { fromJson, MISSING, toText } from '../../src/expr/values.ts';
import { parseJson } from '../../src/json/parse.ts';

/**
 * Scenario D replay: every probe expression, evaluated against every payload that
 * was sent to the real Make scenario, compared with the text Make returned.
 */

export const TIMEZONE = 'Asia/Karachi'; // org timezone of the Make account the corpus came from (engine log)
export const PASSING_CASES = ['D-01-base', 'D-02-unicode', 'D-03-numbers-edge', 'D-04-empties', 'D-06-leap-dst'];

export type Outcome =
  | { status: 'match'; got: string }
  | { status: 'mismatch'; got: string; expected: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; kind: string; message: string; expected: string };

export const probes: [string, string][] = JSON.parse(readFileSync('corpus/blueprints/D.probes.json', 'utf8'));

export function payload(caseName: string) {
  return fromJson(parseJson(readFileSync(`corpus/cases/D/${caseName}.json`, 'utf8'), 64).value);
}

export function recorded(caseName: string): Map<string, string> {
  const t = readFileSync(`corpus/responses/D/${caseName}.txt`, 'utf8');
  return new Map([...t.matchAll(/^(\w+)=<<(.*?)>>$/gms)].map((m) => [m[1]!, m[2]!]));
}

export function evalProbe(expr: string, input: ReturnType<typeof payload>): string {
  const ctx = { timezone: TIMEZONE, output: (id: number) => (id === 1 ? input : MISSING) };
  return toText(evaluateTemplate(parseTemplate(`{{${expr}}}`), ctx));
}

/** A probe set recorded with tools/make-probe.ts: one payload, one answer per probe. */
export interface RecordedSet {
  name: string;
  payload: unknown;
  answers: Record<string, { expr: string; value?: string; error?: { name: string; message: string } }>;
}

export function loadSet(name: string): RecordedSet {
  return JSON.parse(readFileSync(`corpus/responses/${name}.json`, 'utf8'));
}

export function runSet(set: RecordedSet): Map<string, Outcome | { status: 'rejected-by-make'; got: string }> {
  const input = fromJson(parseJson(JSON.stringify(set.payload), 64).value);
  const out = new Map<string, Outcome | { status: 'rejected-by-make'; got: string }>();
  for (const [key, a] of Object.entries(set.answers)) {
    let got: string | Error;
    try {
      got = evalProbe(a.expr, input);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      got = e;
    }
    if (a.error?.name === 'BlueprintValidationError') {
      // Make refused to run the expression at all; the engine must reject it as invalid syntax.
      out.set(key, got instanceof ExprSyntaxError ? { status: 'match', got: 'syntax error' } : { status: 'rejected-by-make', got: got instanceof Error ? got.message : got });
      continue;
    }
    const expected = a.value ?? `error: ${a.error?.message}`;
    if (got instanceof UnsupportedError) out.set(key, { status: 'unsupported', reason: got.message });
    else if (got instanceof Error) out.set(key, { status: 'error', kind: got.name, message: got.message, expected });
    else out.set(key, got === expected ? { status: 'match', got } : { status: 'mismatch', got, expected });
  }
  return out;
}

export function runCase(caseName: string): Map<string, Outcome> {
  const input = payload(caseName);
  const want = recorded(caseName);
  const out = new Map<string, Outcome>();
  for (const [key, expr] of probes) {
    const expected = want.get(key);
    if (expected === undefined) throw new Error(`${caseName}: no recorded value for ${key}`);
    try {
      const got = evalProbe(expr, input);
      out.set(key, got === expected ? { status: 'match', got } : { status: 'mismatch', got, expected });
    } catch (e) {
      if (e instanceof UnsupportedError) out.set(key, { status: 'unsupported', reason: e.message });
      else if (e instanceof DataError || e instanceof ExprSyntaxError) out.set(key, { status: 'error', kind: e.name, message: e.message, expected });
      else throw e;
    }
  }
  return out;
}

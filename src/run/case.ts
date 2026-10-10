import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadBlueprint } from '../blueprint/load.ts';
import { UnsupportedError } from '../expr/errors.ts';
import { inspectBytes } from '../inspect.ts';
import { isObject, JsonParseError, parseJson, type JsonValue } from '../json/parse.ts';
import { compareExecutions, type Divergence } from './compare.ts';
import { FixtureError, FixtureSet } from './fixtures.ts';
import { InvalidInputError, LimitExceededError, runScenario } from './scheduler.ts';
import type { Reference, Trace } from './trace.ts';

/**
 * A test case (spec section 10): a blueprint, an input payload and the run Make
 * actually produced for it. Paths are relative to the case file.
 *
 *   { "schemaVersion": 1, "name": "A-001", "blueprint": "../../blueprints/A.blueprint.json",
 *     "input": "./input.json", "environment": { "timezone": "Asia/Karachi" },
 *     "expected": "./reference.json" }
 *
 * Optional: "fixtures": "./fixtures.json" for HTTP and third-party modules (src/run/fixtures.ts).
 * A missing, mismatched or unused fixture gives the verdict "fixture" (exit 5).
 */

export type Verdict = 'pass' | 'fail' | 'unsupported' | 'invalid' | 'limit' | 'fixture';

export interface CaseResult {
  name: string;
  file: string;
  verdict: Verdict;
  message?: string;
  divergence?: Divergence;
  trace?: Trace;
}

class CaseError extends Error {}

function readJson(file: string, what: string): JsonValue {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new CaseError(`cannot read the ${what} ${file}`);
  }
  try {
    return parseJson(text, 64).value;
  } catch (e) {
    if (e instanceof JsonParseError) throw new CaseError(`${what} ${file} line ${e.loc.line}: ${e.message}`);
    throw e;
  }
}

export function runCase(file: string): CaseResult {
  const base: CaseResult = { name: file, file, verdict: 'invalid' };
  try {
    const spec = readJson(file, 'case');
    if (!isObject(spec) || spec['schemaVersion'] !== 1) throw new CaseError('a case needs "schemaVersion": 1');
    const str = (k: string) => {
      const v = spec[k];
      if (typeof v !== 'string' || v === '') throw new CaseError(`a case needs a "${k}" path`);
      return resolve(dirname(file), v);
    };
    if (typeof spec['name'] === 'string') base.name = spec['name'];
    const env = spec['environment'];
    const timezone = isObject(env) && typeof env['timezone'] === 'string' ? env['timezone'] : null;

    const blueprintFile = str('blueprint');
    const bytes = (() => {
      try {
        return readFileSync(blueprintFile);
      } catch {
        throw new CaseError(`cannot read the blueprint ${blueprintFile}`);
      }
    })();
    const report = inspectBytes(blueprintFile, bytes);
    if (report.verdict === 'invalid') return { ...base, verdict: 'invalid', message: report.findings.find((f) => f.severity === 'error')?.message ?? 'invalid blueprint' };
    if (report.verdict === 'unsupported') return { ...base, verdict: 'unsupported', message: report.findings.find((f) => f.severity === 'unsupported')?.message ?? 'unsupported' };
    const plan = loadBlueprint(bytes).plan!;

    const input = readJson(str('input'), 'input');
    const expected = readJson(str('expected'), 'expected run') as unknown as Reference;
    if (!isObject(expected as unknown as JsonValue) || expected.schemaVersion !== 2 || !Array.isArray(expected.steps)) throw new CaseError('the expected run is not a reference (schemaVersion 2 with steps)');

    let fixtures: FixtureSet;
    try {
      fixtures = typeof spec['fixtures'] === 'string' ? FixtureSet.fromJson(readJson(str('fixtures'), 'fixtures')) : new FixtureSet();
    } catch (e) {
      if (e instanceof FixtureError) return { ...base, verdict: 'invalid', message: e.message };
      throw e;
    }

    let trace: Trace;
    try {
      trace = runScenario(plan, input, { timezone, fixtures });
      fixtures.assertAllUsed();
    } catch (e) {
      if (e instanceof FixtureError) return { ...base, verdict: 'fixture', message: e.message };
      if (e instanceof InvalidInputError) return { ...base, verdict: 'invalid', message: e.message };
      if (e instanceof UnsupportedError) return { ...base, verdict: 'unsupported', message: e.message };
      if (e instanceof LimitExceededError) return { ...base, verdict: 'limit', message: e.message };
      throw e;
    }
    const divergence = compareExecutions(expected, trace);
    return divergence ? { ...base, verdict: 'fail', divergence, message: divergence.message, trace } : { ...base, verdict: 'pass', trace };
  } catch (e) {
    if (e instanceof CaseError) return { ...base, verdict: 'invalid', message: e.message };
    throw e;
  }
}

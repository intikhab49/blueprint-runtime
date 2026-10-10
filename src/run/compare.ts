import { escapePointerToken, isObject, type JsonValue } from '../json/parse.ts';
import type { Execution, Step } from './trace.ts';

/**
 * Compares a local run with a recorded Make run and reports the FIRST place they
 * differ, in execution order (spec 8.2): step by step (filter decisions and module
 * operations), then the run outcome, then the HTTP response.
 */

export interface Divergence {
  where: 'step' | 'filter' | 'input' | 'output' | 'outcome' | 'response';
  /** 1-based position in the step list, when the difference is in a step. */
  step?: number;
  moduleId?: number;
  operation?: number;
  /** 1-based bundle number within the module's input or output. */
  bundle?: number;
  /** JSON pointer inside the bundle, or the field that differs. */
  pointer?: string;
  expected: JsonValue | undefined;
  actual: JsonValue | undefined;
  message: string;
}

const show = (v: JsonValue | undefined) => (v === undefined ? '(absent)' : JSON.stringify(v));

const describeStep = (s: Step | undefined) =>
  !s ? 'nothing' : s.kind === 'module' ? `module ${s.id}${s.operation > 1 ? ` (operation ${s.operation})` : ''}` : `the filter before module ${s.moduleId}`;

/** First difference between two JSON values, or null. Object key order does not matter. */
export function firstDifference(expected: JsonValue | undefined, actual: JsonValue | undefined, pointer = ''): { pointer: string; expected: JsonValue | undefined; actual: JsonValue | undefined } | null {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      const d = firstDifference(expected[i], actual[i], `${pointer}/${i}`);
      if (d) return d;
    }
    return null;
  }
  if (isObject(expected) && isObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
    for (const k of keys) {
      const d = firstDifference(expected[k], actual[k], `${pointer}/${escapePointerToken(k)}`);
      if (d) return d;
    }
    return null;
  }
  return Object.is(expected, actual) ? null : { pointer, expected, actual };
}

export function compareExecutions(expected: Execution, actual: Execution): Divergence | null {
  const n = Math.max(expected.steps.length, actual.steps.length);
  for (let i = 0; i < n; i++) {
    const e = expected.steps[i];
    const a = actual.steps[i];
    const same = e && a && e.kind === a.kind && (e.kind === 'module' ? a.kind === 'module' && e.id === a.id && e.operation === a.operation : a.kind === 'filter' && e.moduleId === a.moduleId);
    if (!same) {
      return {
        where: 'step',
        step: i + 1,
        expected: e ? (e.kind === 'module' ? e.id : `filter ${e.moduleId}`) : null,
        actual: a ? (a.kind === 'module' ? a.id : `filter ${a.moduleId}`) : null,
        message: !a ? `step ${i + 1}: Make did ${describeStep(e)}, the local run had stopped` : !e ? `step ${i + 1}: the local run did ${describeStep(a)}, which Make did not` : `step ${i + 1}: Make did ${describeStep(e)}, the local run did ${describeStep(a)}`,
      };
    }
    if (e.kind === 'filter' && a.kind === 'filter') {
      if (e.passed !== a.passed || firstDifference(e.report, a.report)) {
        return {
          where: 'filter',
          step: i + 1,
          moduleId: e.moduleId,
          expected: { passed: e.passed, report: e.report },
          actual: { passed: a.passed, report: a.report },
          message: `step ${i + 1}, filter before module ${e.moduleId}: Make ${e.passed ? 'passed' : 'stopped'} the bundle ${show(e.report)}, the local run ${a.passed ? 'passed' : 'stopped'} it ${show(a.report)}`,
        };
      }
      continue;
    }
    if (e.kind !== 'module' || a.kind !== 'module') continue;
    for (const side of ['input', 'output'] as const) {
      const eb = e[side];
      const ab = a[side];
      if (eb.length !== ab.length) {
        return { where: side, step: i + 1, moduleId: e.id, operation: e.operation, expected: eb.length, actual: ab.length, message: `${describeStep(e)} ${side}: Make had ${eb.length} bundle(s), the local run ${ab.length}` };
      }
      for (let b = 0; b < eb.length; b++) {
        const d = firstDifference(eb[b], ab[b]);
        if (d) {
          return {
            where: side,
            step: i + 1,
            moduleId: e.id,
            operation: e.operation,
            bundle: b + 1,
            pointer: d.pointer,
            expected: d.expected,
            actual: d.actual,
            message: `${describeStep(e)} ${side} bundle ${b + 1} at ${d.pointer || '(whole bundle)'}: Make had ${show(d.expected)}, the local run ${show(d.actual)}`,
          };
        }
      }
    }
  }

  const outcome = (x: Execution) => (x.status === 'error' ? { status: x.status, ...x.error } : { status: x.status });
  const od = firstDifference(outcome(expected) as JsonValue, outcome(actual) as JsonValue);
  if (od) {
    return { where: 'outcome', pointer: od.pointer, expected: od.expected, actual: od.actual, message: `run outcome ${od.pointer}: Make had ${show(od.expected)}, the local run ${show(od.actual)}` };
  }

  if (expected.response) {
    const rd = firstDifference(expected.response as unknown as JsonValue, (actual.response ?? null) as unknown as JsonValue);
    if (rd) {
      return { where: 'response', pointer: rd.pointer, expected: rd.expected, actual: rd.actual, message: `webhook response ${rd.pointer}: Make sent ${show(rd.expected)}, the local run ${show(rd.actual)}` };
    }
  }
  return null;
}

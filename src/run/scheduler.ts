import type { BranchStep, Plan, PlanModule } from '../blueprint/plan.ts';
import { DataError, UnsupportedError } from '../expr/errors.ts';
import { evaluateMapper, type EvalContext } from '../expr/evaluate.ts';
import { fromJson, MISSING, type Value } from '../expr/values.ts';
import type { JsonObject, JsonValue } from '../json/parse.ts';
import { handlerFor, ModuleFailure, textAggregatorResult, textAggregatorRow, textAggregatorSeparator } from './modules.ts';
import { FixtureSet } from './fixtures.ts';
import { OPERATORS } from './operators.ts';
import type { FilterStep, Step, Trace } from './trace.ts';

export interface RunOptions {
  /** Scenario timezone (IANA). Date functions refuse to run without one. */
  timezone: string | null;
  /** Operation budget; exceeding it is a local limit (exit 6), not a Make behavior. */
  maxOperations?: number;
  /** Stand-ins for HTTP and third-party modules. Without one, such a module fails with FixtureError. */
  fixtures?: FixtureSet;
}

export class LimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitExceededError';
  }
}

/** Unwinds the run after a module error, the way Make stops the scenario. */
class RunStopped extends Error {}

const branchKey = (b: BranchStep[]) => b.map((s) => `${s.owner}:${s.kind}:${s.index}`).join('/');

/**
 * Runs a scenario that starts with a Custom webhook: the main flow, router routes in
 * order, and filters. Every route whose filter passes runs; the fallback route runs
 * only when no other route did (corpus B). An iterator sends each bundle through the
 * rest of its flow, or up to the Text aggregator that collects it (corpus C, C2).
 */
export function runScenario(plan: Plan, payload: JsonValue, options: RunOptions): Trace {
  const [trigger] = plan.modules;
  if (!trigger || trigger.module !== 'gateway:CustomWebHook') {
    throw new UnsupportedError(`only scenarios that start with a Custom webhook can run yet (this one starts with ${trigger?.module ?? 'nothing'})`);
  }
  for (const m of plan.modules) {
    if (m.hasErrorHandler) throw new UnsupportedError(`module ${m.id} has an error handler; error handlers do not run yet`);
    if (m.module !== 'builtin:BasicRouter' && m.module !== 'util:TextAggregator' && !handlerFor(m.module)) throw new UnsupportedError(`module ${m.id} (${m.module}) cannot run yet`);
  }

  // The plan is a flat depth-first list; group it back into flows (main flow, each route).
  const flows = new Map<string, PlanModule[]>();
  for (const m of plan.modules) {
    const key = branchKey(m.branch);
    flows.set(key, [...(flows.get(key) ?? []), m]);
  }

  const budget = options.maxOperations ?? 10_000;
  const fixtures = options.fixtures ?? new FixtureSet();
  const outputs = new Map<number, Value>();
  const operations = new Map<number, number>();
  const ctx: EvalContext = { timezone: options.timezone, output: (id) => outputs.get(id) ?? MISSING };
  const steps: Step[] = [];
  const trace: Trace = { schemaVersion: 2, source: 'blueprint-runtime', status: 'success', steps };
  let total = 0;

  const nextOperation = (id: number) => {
    if (++total > budget) throw new LimitExceededError(`more than ${budget} operations`);
    const n = (operations.get(id) ?? 0) + 1;
    operations.set(id, n);
    return n;
  };

  const evalFilter = (m: PlanModule, fallback: boolean): boolean => {
    const conditions = m.filter?.conditions ?? [];
    if (fallback) {
      if (conditions.some((g) => g.length > 0)) throw new UnsupportedError(`module ${m.id}: a fallback route with its own conditions has not been observed in Make`);
      steps.push({ kind: 'filter', moduleId: m.id, passed: true, report: [] }); // corpus B-04: fallback logged with an empty report
      return true;
    }
    if (conditions.length === 0 || conditions.some((g) => g.length === 0)) throw new UnsupportedError(`module ${m.id}: a filter with an empty condition group has not been observed in Make`);
    const test = (c: (typeof conditions)[number][number]): boolean => {
      const op = OPERATORS[c.o];
      if (!op) throw new UnsupportedError(`module ${m.id}: filter operator "${c.o}" has not been observed in Make`);
      try {
        return op(evaluateMapper(c.a, ctx), c.b === undefined ? MISSING : evaluateMapper(c.b, ctx), ctx);
      } catch (e) {
        if (e instanceof DataError) throw new UnsupportedError(`module ${m.id}: an error inside a filter has not been observed in Make (${e.message})`);
        throw e;
      }
    };
    // OR of ANDs, short-circuited like Make: an AND group stops at its first false
    // condition, and the report only lists conditions that were evaluated
    // (F1 and_tf: [[false]], or_and: [[false], [true]]). Stopping the OR at the first
    // passing group is assumed from the same evaluation style; it has not been observed.
    const report: boolean[][] = [];
    let passed = false;
    for (const group of conditions) {
      const results: boolean[] = [];
      for (const c of group) {
        const r = test(c);
        results.push(r);
        if (!r) break;
      }
      report.push(results);
      if (results.length === group.length && results.every(Boolean)) {
        passed = true;
        break;
      }
    }
    const step: FilterStep = { kind: 'filter', moduleId: m.id, passed, report };
    steps.push(step);
    return step.passed;
  };

  const runModule = (m: PlanModule): JsonValue[] => {
    const operation = nextOperation(m.id);
    try {
      const result = handlerFor(m.module)!.run(m, ctx, { operation, fixtures });
      steps.push({ kind: 'module', id: m.id, operation, input: result.input, output: result.output });
      const first = result.output[0];
      outputs.set(m.id, first === undefined ? MISSING : fromJson(first));
      if (result.response && !trace.response) trace.response = result.response;
      return result.output;
    } catch (e) {
      if (e instanceof ModuleFailure) {
        steps.push({ kind: 'module', id: m.id, operation, input: e.input, output: [null] });
        trace.status = 'error';
        trace.error = { moduleId: m.id, name: e.errorName, message: e.message };
        throw new RunStopped();
      }
      if (!(e instanceof DataError)) throw e;
      // Make records the failing module with no input and one null output, then stops (corpus D-05).
      steps.push({ kind: 'module', id: m.id, operation, input: [], output: [null] });
      trace.status = 'error';
      trace.error = { moduleId: m.id, name: 'DataError', message: e.message };
      throw new RunStopped();
    }
  };

  const runRouter = (router: PlanModule) => {
    const count = router.routeCount ?? 0;
    const fallback = router.elseRoute;
    if (fallback !== undefined && fallback !== count - 1) throw new UnsupportedError(`router ${router.id}: a fallback that is not the last route has not been observed in Make`);
    let anyPassed = false;
    for (let r = 0; r < count; r++) {
      if (r === fallback) continue;
      if (runFlow(routeFlow(router, r), false)) anyPassed = true;
    }
    if (fallback !== undefined && !anyPassed) runFlow(routeFlow(router, fallback), true);
  };

  const routeFlow = (router: PlanModule, r: number): PlanModule[] => {
    const flow = flows.get(branchKey([...router.branch, { owner: router.id, kind: 'route', index: r }])) ?? [];
    if (flow.length === 0) throw new UnsupportedError(`router ${router.id}: an empty route has not been observed in Make`);
    return flow;
  };

  /**
   * An iterator. Each bundle runs the modules after it, depth-first, before the next
   * bundle starts (C2-noagg-01 logged 3,4,3,4,3,4). They run up to the Text aggregator
   * that collects the iterator, or to the end of the flow if there is none. The
   * aggregator then runs once with the rows that reached it: 1 operation, even with
   * none (C-03, C-04). After it, the iterator and the modules in between read as
   * missing (C2-after-01, -02). Returns the index of the last module it ran.
   */
  const runIteration = (flow: PlanModule[], i: number): number => {
    const feeder = flow[i]!;
    const j = flow.findIndex((m, k) => k > i && m.module === 'util:TextAggregator' && m.parameters['feeder'] === feeder.id);
    const aggregator = j < 0 ? null : flow[j]!;
    const scope = j < 0 ? flow.slice(i + 1) : flow.slice(i + 1, j);
    for (const m of scope) {
      if (m.module !== 'util:SetVariable2') throw new UnsupportedError(`module ${m.id} (${m.module}) running once per bundle of iterator ${feeder.id} has not been observed in Make`);
    }
    if (aggregator?.filter) throw new UnsupportedError(`aggregator ${aggregator.id}: a filter on an aggregator has not been observed in Make`);
    const separator = aggregator ? textAggregatorSeparator(aggregator) : '';

    const rows: JsonObject[] = [];
    for (const bundle of runModule(feeder)) {
      outputs.set(feeder.id, fromJson(bundle));
      const reached = scope.every((m) => {
        if (m.filter && !evalFilter(m, false)) return false;
        runModule(m);
        return true;
      });
      if (!reached || !aggregator) continue;
      try {
        rows.push(textAggregatorRow(aggregator, ctx));
      } catch (e) {
        if (e instanceof DataError) throw new UnsupportedError(`aggregator ${aggregator.id}: a mapping error inside an aggregator has not been observed in Make (${e.message})`);
        throw e;
      }
    }
    if (!aggregator) return flow.length - 1;
    for (const m of [feeder, ...scope]) outputs.delete(m.id);
    const result = textAggregatorResult(rows, separator);
    steps.push({ kind: 'module', id: aggregator.id, operation: nextOperation(aggregator.id), input: result.input, output: result.output });
    outputs.set(aggregator.id, fromJson(result.output[0]));
    return j;
  };

  /** Runs a flow from its first module. Returns false if the first module's filter stopped the bundle. */
  const runFlow = (flow: PlanModule[], isFallback: boolean): boolean => {
    for (let i = 0; i < flow.length; i++) {
      const m = flow[i]!;
      if ((m.filter || (isFallback && i === 0)) && !evalFilter(m, isFallback && i === 0)) return i > 0;
      if (m.module === 'builtin:BasicRouter') {
        runRouter(m);
        return true;
      }
      if (m.module === 'builtin:BasicFeeder') {
        i = runIteration(flow, i);
        continue;
      }
      if (m.module === 'util:TextAggregator') throw new UnsupportedError(`aggregator ${m.id} has no iterator before it in the same flow; that has not been observed in Make`);
      runModule(m);
    }
    return true;
  };

  // The trigger's single output bundle is the payload as Make parsed it.
  steps.push({ kind: 'module', id: trigger.id, operation: nextOperation(trigger.id), input: [], output: [payload] });
  outputs.set(trigger.id, fromJson(payload));
  try {
    runFlow((flows.get('') ?? []).slice(1), false);
  } catch (e) {
    if (!(e instanceof RunStopped)) throw e;
  }

  if (fixtures.uses.length) trace.fixtures = fixtures.uses;
  if (!trace.response) {
    // What the webhook caller gets when no Webhook response module answered (corpus B, D-05).
    trace.response = trace.status === 'error' ? { status: 500, body: 'Scenario failed to complete.' } : { status: 200, body: 'Accepted' };
  }
  return trace;
}

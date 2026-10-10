import type { JsonValue } from '../json/parse.ts';
import type { FixtureUse } from './fixtures.ts';

/**
 * What one execution produced, as an ordered list of steps. The same shape is used
 * for a local run (a trace) and a recorded Make run (a reference), so the two can be
 * compared step by step in execution order.
 *
 * Bundles are plain JSON exactly as Make shows them: absent fields are left out.
 */

/** One operation of a module: the bundles it received and produced. */
export interface ModuleStep {
  kind: 'module';
  id: number;
  /** 1-based count of this module's operations in the run (an iterator makes later modules run several times). */
  operation: number;
  input: JsonValue[];
  output: JsonValue[];
}

/**
 * A filter decision taken before a module ran. `report` has one boolean per
 * condition, grouped like the filter (OR of ANDs), as Make's run log records it.
 * A fallback route records an empty report.
 */
export interface FilterStep {
  kind: 'filter';
  moduleId: number;
  passed: boolean;
  report: boolean[][];
}

export type Step = ModuleStep | FilterStep;

export interface RunError {
  moduleId: number;
  name: string;
  message: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface Execution {
  schemaVersion: 2;
  status: 'success' | 'error';
  error?: RunError;
  steps: Step[];
  response?: HttpResponse;
}

export interface Trace extends Execution {
  source: 'blueprint-runtime';
  /** Modules that ran from a fixture instead of a real service (spec 7: reports name the mode). */
  fixtures?: FixtureUse[];
}

export interface Reference extends Execution {
  source: 'make';
  scenarioId: number;
  runId: string;
  recordedAt: string | null;
  timezone: string;
}

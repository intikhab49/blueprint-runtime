/**
 * What this runtime has real Make evidence for. An entry exists only when the
 * behavior was observed in a real Make run captured in corpus/ (see
 * corpus/NOTES.md). Anything else is reported as unsupported; there is no
 * best-effort fallback (spec BR-010).
 *
 * "evidence" names the corpus cases that exercised the item.
 */

import { FUNCTIONS as ENGINE_FUNCTIONS } from './expr/functions.ts';
import { OPERATORS as ENGINE_OPERATORS } from './run/operators.ts';

export interface ModuleSupport {
  versions: number[];
  role: 'trigger' | 'action' | 'router' | 'iterator' | 'aggregator' | 'responder' | 'http';
  /** Runs only from a fixture of this mode (src/run/fixtures.ts). */
  fixture?: 'http';
  evidence: string;
}

export const MODULES: Readonly<Record<string, ModuleSupport>> = {
  'gateway:CustomWebHook': { versions: [1], role: 'trigger', evidence: 'A-001, B-*, C-*, D-*' },
  'gateway:WebhookRespond': { versions: [1], role: 'responder', evidence: 'A-001, C-*, D-*' },
  'util:SetVariable2': { versions: [1], role: 'action', evidence: 'A-001, B-*, C-*' },
  'builtin:BasicRouter': { versions: [1], role: 'router', evidence: 'B-01..B-16' },
  'builtin:BasicFeeder': { versions: [1], role: 'iterator', evidence: 'C-01..C-16' },
  'util:TextAggregator': { versions: [1], role: 'aggregator', evidence: 'C-01..C-16, C2-*' },
  'http:ActionSendData': { versions: [3], role: 'http', fixture: 'http', evidence: 'E-*' },
  'util:BasicTrigger': { versions: [1], role: 'trigger', evidence: 'T-01..T-08' },
  'util:FunctionSleep': { versions: [1], role: 'action', evidence: 'N-01' },
};

/** Filter operators the scheduler implements (src/run/operators.ts), each matched against recorded Make runs. */
export const FILTER_OPERATORS: Readonly<Record<string, string>> = Object.fromEntries(Object.keys(ENGINE_OPERATORS).map((o) => [o, 'corpus B, C, F']));

/**
 * Functions the expression engine implements. Each one was replayed against real Make
 * output by the scenario D conformance tests (test/conformance-d.test.ts).
 */
export const FUNCTIONS: Readonly<Record<string, string>> = Object.fromEntries(Object.keys(ENGINE_FUNCTIONS).map((f) => [f, 'D-01..D-06 replay']));

/** Bare keywords whose value was observed in a real Make run. */
export const KEYWORDS: Readonly<Record<string, string>> = {
  true: 'D-01..D-06',
  false: 'D-01..D-06',
  emptystring: 'D-01..D-06',
  space: 'D-01..D-06',
  now: 'D3, N-01 (needs a clock: environment.now)',
};

/** Keys a module object may carry in an exported blueprint. Others are reported. */
export const KNOWN_MODULE_KEYS = new Set(['id', 'module', 'version', 'parameters', 'mapper', 'metadata', 'filter', 'routes', 'onerror']);

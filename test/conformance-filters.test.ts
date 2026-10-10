import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadBlueprint } from '../src/blueprint/load.ts';
import { runScenario } from '../src/run/scheduler.ts';
import type { FilterStep } from '../src/run/trace.ts';
import { FIRST_PROBE_MODULE, probeBlueprint, type FilterProbeSet } from '../tools/lib/filter-probe-blueprint.ts';

/**
 * Probe set F1: 60 filter conditions, each on its own route, run on the real Make
 * scenario with two payloads. Every local filter decision, including the
 * per-condition report, must equal the one in Make's run log.
 */
const set: FilterProbeSet = JSON.parse(readFileSync('corpus/blueprints/F1.filter-probes.json', 'utf8'));
const runs: { runs: { payload: string; runId: string }[] } = JSON.parse(readFileSync('corpus/responses/F1-filters.runs.json', 'utf8'));
const events: Record<string, { type: number; module: number; report: boolean[][] }[]> = JSON.parse(readFileSync('corpus/responses/F1-filters.events.json', 'utf8'));
const template = JSON.parse(readFileSync('corpus/blueprints/B.blueprint.json', 'utf8'));
const loaded = loadBlueprint(new TextEncoder().encode(JSON.stringify(probeBlueprint(template.flow[0], set))));
assert.ok(loaded.plan, JSON.stringify(loaded.findings));

const local = new Map<string, Map<number, FilterStep>>();
for (const { payload } of runs.runs) {
  const trace = runScenario(loaded.plan, set.payloads[payload] as never, { timezone: 'Asia/Karachi' });
  local.set(payload, new Map(trace.steps.filter((s): s is FilterStep => s.kind === 'filter').map((s) => [s.moduleId, s])));
}

describe('filter probe F1 replay: each condition against Make\'s recorded decision', () => {
  set.probes.forEach((probe, i) => {
    const moduleId = FIRST_PROBE_MODULE + i;
    const text = probe.conditions.map((g) => g.map((c) => `${c.a} ${c.o}${c.b === undefined ? '' : ` ${JSON.stringify(c.b)}`}`).join(' AND ')).join(' OR ');
    it(`${probe.key}: ${text}`, () => {
      for (const { payload, runId } of runs.runs) {
        const made = events[runId]!.find((e) => e.module === moduleId)!;
        const got = local.get(payload)!.get(moduleId);
        assert.deepEqual(got && { passed: got.passed, report: got.report }, { passed: made.type === 18, report: made.report }, `payload ${payload}`);
      }
    });
  });
});

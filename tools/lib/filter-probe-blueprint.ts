/**
 * The router blueprint a filter probe set becomes: one route per probe, whose first
 * module (a Set variable) carries the probe's filter. Shared by tools/make-filter-probe.ts
 * (which runs it on Make) and the conformance test (which runs it locally).
 */

export const FIRST_PROBE_MODULE = 100;

export interface FilterProbe {
  key: string;
  conditions: { a: string; o: string; b?: string }[][];
}

export interface FilterProbeSet {
  name: string;
  payloads: Record<string, unknown>;
  probes: FilterProbe[];
}

export function probeBlueprint(trigger: unknown, set: FilterProbeSet, probes: FilterProbe[] = set.probes) {
  return {
    name: `bpr Scenario B (filter probe: ${set.name})`,
    flow: [
      trigger,
      {
        id: 2,
        module: 'builtin:BasicRouter',
        version: 1,
        parameters: {},
        mapper: null,
        metadata: { designer: { x: 300, y: 0 } },
        routes: probes.map((p) => ({
          flow: [
            {
              id: FIRST_PROBE_MODULE + set.probes.indexOf(p),
              module: 'util:SetVariable2',
              version: 1,
              parameters: {},
              filter: { name: p.key, conditions: p.conditions },
              mapper: { name: 'probe', value: p.key },
              metadata: { designer: { x: 600, y: 0 } },
            },
          ],
        })),
      },
    ],
  };
}

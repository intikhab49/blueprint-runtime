import { createHash } from 'node:crypto';
import type { Finding } from '../findings.ts';
import { escapePointerToken, isObject, type JsonObject, type JsonValue } from '../json/parse.ts';
import { KNOWN_MODULE_KEYS } from '../registry.ts';

export interface BranchStep {
  /** Router or module that owns the branch. */
  owner: number;
  kind: 'route' | 'onerror';
  /** 0-based route index (always 0 for onerror). */
  index: number;
}

export interface PlanCondition {
  a: JsonValue;
  o: string;
  b?: JsonValue;
}

export interface PlanFilter {
  /** Label shown in the editor. Presentation only; not part of the semantic hash. */
  label: string | null;
  /** OR of ANDs, exactly as Make stores it: [[c1 AND c2] OR [c3]]. */
  conditions: PlanCondition[][];
}

export interface PlanModule {
  id: number;
  /** "app:name" exactly as in the blueprint. */
  module: string;
  app: string;
  name: string;
  version: number;
  pointer: string;
  /** Position in depth-first (Make execution) order, starting at 0. */
  order: number;
  branch: BranchStep[];
  /** Ids of modules whose outputs this module can reference. */
  upstream: number[];
  parameters: JsonObject;
  mapper: JsonValue;
  filter: PlanFilter | null;
  /** Routers only. */
  routeCount?: number;
  /** Routers only: 0-based index of the fallback route, from parameters.else. */
  elseRoute?: number;
  hasErrorHandler: boolean;
  unknownKeys: string[];
}

export interface Plan {
  name: string | null;
  /** metadata.scenario plus metadata.instant: settings that change execution. */
  settings: JsonObject;
  modules: PlanModule[];
  /** sha256 of the canonical semantic form. Canvas layout, labels and UI metadata do not affect it. */
  semanticHash: string;
}

export interface PlanLimits {
  maxModules: number;
}

/** Stable JSON: object keys sorted, arrays kept in order. */
export function canonicalJson(v: JsonValue | undefined): string {
  if (v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function buildPlan(doc: JsonObject, limits: PlanLimits, base = ''): { plan: Plan | null; findings: Finding[] } {
  const findings: Finding[] = [];
  const modules: PlanModule[] = [];
  const firstSeen = new Map<number, string>();
  const err = (code: string, message: string, pointer: string) => findings.push({ code, severity: 'error', message, pointer });
  const warn = (code: string, message: string, pointer: string) => findings.push({ code, severity: 'warning', message, pointer });
  let tooMany = false;

  const walkFlow = (flow: JsonValue | undefined, pointer: string, branch: BranchStep[], upstreamIn: number[]) => {
    if (!Array.isArray(flow)) {
      err('BP_FLOW_NOT_ARRAY', 'Expected an array of modules', pointer);
      return;
    }
    const upstream = [...upstreamIn];
    flow.forEach((raw, i) => {
      const p = `${pointer}/${i}`;
      if (tooMany) return;
      if (modules.length >= limits.maxModules) {
        err('BP_TOO_MANY_MODULES', `More than ${limits.maxModules} modules`, p);
        tooMany = true;
        return;
      }
      if (!isObject(raw)) {
        err('BP_MODULE_NOT_OBJECT', 'Expected a module object', p);
        return;
      }
      // Make exports the editor's empty module slot with "id": null (public survey); give it a
      // negative id of its own so it cannot collide with, or be referenced as, a real module.
      const id = raw['id'] === null && raw['module'] === 'placeholder:Placeholder' ? -(modules.length + 1) : raw['id'];
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || (id < 1 && raw['module'] !== 'placeholder:Placeholder')) {
        err('BP_BAD_MODULE_ID', `Module id must be a positive integer, got ${JSON.stringify(id ?? null)}`, `${p}/id`);
        return;
      }
      const prev = firstSeen.get(id);
      if (prev !== undefined) {
        err('BP_DUPLICATE_MODULE_ID', `Module id ${id} is used twice (first at ${prev})`, `${p}/id`);
        return;
      }
      firstSeen.set(id, p);

      const moduleName = raw['module'];
      const colon = typeof moduleName === 'string' ? moduleName.indexOf(':') : -1;
      if (typeof moduleName !== 'string' || colon < 1 || colon === moduleName.length - 1) {
        err('BP_BAD_MODULE_NAME', `Module ${id}: "module" must look like "app:name", got ${JSON.stringify(moduleName ?? null)}`, `${p}/module`);
        return;
      }
      // Make's own exports contain version 0 (its AI Agent module, ai-local-agent:RunLocalAIAgent)
      // and no version at all on placeholder:Placeholder, the empty module slot of the editor
      // (public survey, 2026-10-10). Anything else must be a whole number.
      const rawVersion = raw['version'];
      const version = rawVersion === undefined && moduleName === 'placeholder:Placeholder' ? 0 : rawVersion;
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
        err('BP_BAD_MODULE_VERSION', `Module ${id}: "version" must be a whole number, got ${JSON.stringify(version ?? null)}`, `${p}/version`);
        return;
      }
      if (i > 0 && modules.length > 0) {
        const before = flow[i - 1];
        if (isObject(before) && before['routes'] !== undefined) {
          err('BP_MODULE_AFTER_ROUTER', `Module ${id} follows a router in the same flow; after a router, execution only continues inside its routes`, p);
        }
      }

      const parameters = raw['parameters'] ?? {};
      if (!isObject(parameters)) err('BP_BAD_PARAMETERS', `Module ${id}: "parameters" must be an object`, `${p}/parameters`);

      const filter = readFilter(raw['filter'], `${p}/filter`, id, err);
      const unknownKeys = Object.keys(raw).filter((k) => !KNOWN_MODULE_KEYS.has(k));
      for (const k of unknownKeys) warn('BP_UNKNOWN_MODULE_KEY', `Module ${id}: unknown key "${k}" (not seen in exported blueprints)`, `${p}/${escapePointerToken(k)}`);

      const pm: PlanModule = {
        id,
        module: moduleName,
        app: moduleName.slice(0, colon),
        name: moduleName.slice(colon + 1),
        version,
        pointer: p,
        order: modules.length,
        branch,
        upstream: [...upstream],
        parameters: isObject(parameters) ? parameters : {},
        mapper: raw['mapper'] ?? null,
        filter,
        hasErrorHandler: raw['onerror'] !== undefined,
        unknownKeys,
      };
      modules.push(pm);
      upstream.push(id);

      const routes = raw['routes'];
      if (routes !== undefined) {
        if (moduleName !== 'builtin:BasicRouter') err('BP_ROUTES_ON_NON_ROUTER', `Module ${id} (${moduleName}) has "routes" but is not a router`, `${p}/routes`);
        if (!Array.isArray(routes)) {
          err('BP_ROUTES_NOT_ARRAY', `Router ${id}: "routes" must be an array`, `${p}/routes`);
        } else {
          pm.routeCount = routes.length;
          if (routes.length === 0) warn('BP_ROUTER_NO_ROUTES', `Router ${id} has no routes`, `${p}/routes`);
          routes.forEach((route, r) => {
            const rp = `${p}/routes/${r}`;
            if (!isObject(route)) {
              err('BP_ROUTE_NOT_OBJECT', `Router ${id}: route ${r + 1} must be an object with a "flow" array`, rp);
              return;
            }
            walkFlow(route['flow'], `${rp}/flow`, [...branch, { owner: id, kind: 'route', index: r }], upstream);
          });
          const elseIdx = isObject(parameters) ? parameters['else'] : undefined;
          if (elseIdx !== undefined) {
            if (typeof elseIdx !== 'number' || !Number.isSafeInteger(elseIdx) || elseIdx < 0 || elseIdx >= routes.length) {
              err('BP_BAD_ELSE_ROUTE', `Router ${id}: fallback route index ${JSON.stringify(elseIdx)} is not one of its ${routes.length} routes`, `${p}/parameters/else`);
            } else {
              pm.elseRoute = elseIdx;
            }
          }
        }
      } else if (moduleName === 'builtin:BasicRouter') {
        // Make exports a router with no routes attached without a "routes" key (public survey).
        pm.routeCount = 0;
      }

      const onerror = raw['onerror'];
      if (onerror !== undefined) {
        // Error-handler modules see the failing module's inputs, not its outputs.
        walkFlow(onerror, `${p}/onerror`, [...branch, { owner: id, kind: 'onerror', index: 0 }], upstream.slice(0, -1));
      }
    });
  };

  walkFlow(doc['flow'], `${base}/flow`, [], []);
  if (findings.some((f) => f.severity === 'error')) return { plan: null, findings };

  const meta = isObject(doc['metadata']) ? doc['metadata'] : {};
  const settings: JsonObject = {};
  if (isObject(meta['scenario'])) settings['scenario'] = meta['scenario'];
  if (meta['instant'] !== undefined) settings['instant'] = meta['instant'];

  const semantic = {
    settings,
    modules: modules.map((m) => ({
      id: m.id,
      module: m.module,
      version: m.version,
      branch: m.branch.map((b) => ({ owner: b.owner, kind: b.kind, index: b.index })),
      parameters: m.parameters,
      mapper: m.mapper,
      filter: m.filter ? m.filter.conditions.map((g) => g.map((c) => ({ a: c.a, o: c.o, b: c.b ?? null }))) : null,
      elseRoute: m.elseRoute ?? null,
      hasErrorHandler: m.hasErrorHandler,
    })),
  } as unknown as JsonValue;
  const semanticHash = createHash('sha256').update(canonicalJson(semantic)).digest('hex');

  const name = doc['name'];
  return { plan: { name: typeof name === 'string' ? name : null, settings, modules, semanticHash }, findings };
}

function readFilter(raw: JsonValue | undefined, pointer: string, id: number, err: (code: string, message: string, pointer: string) => void): PlanFilter | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) {
    err('BP_BAD_FILTER', `Module ${id}: "filter" must be an object`, pointer);
    return null;
  }
  const conds = raw['conditions'] ?? [];
  if (!Array.isArray(conds) || !conds.every((g) => Array.isArray(g))) {
    err('BP_BAD_FILTER', `Module ${id}: filter "conditions" must be an array of arrays (OR of ANDs)`, `${pointer}/conditions`);
    return null;
  }
  const conditions: PlanCondition[][] = [];
  conds.forEach((group, gi) => {
    const out: PlanCondition[] = [];
    (group as JsonValue[]).forEach((c, ci) => {
      const cp = `${pointer}/conditions/${gi}/${ci}`;
      if (!isObject(c) || typeof c['o'] !== 'string' || c['a'] === undefined) {
        err('BP_BAD_FILTER_CONDITION', `Module ${id}: each filter condition needs "a" and an operator "o"`, cp);
        return;
      }
      const cond: PlanCondition = { a: c['a'], o: c['o'] };
      if (c['b'] !== undefined) cond.b = c['b'];
      out.push(cond);
    });
    conditions.push(out);
  });
  const label = raw['name'];
  return { label: typeof label === 'string' ? label : null, conditions };
}

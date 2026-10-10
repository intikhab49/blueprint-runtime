import { EXIT, type Finding } from './findings.ts';
import { loadBlueprint, type BlueprintFormat, type LoadLimits, DEFAULT_LIMITS } from './blueprint/load.ts';
import type { PlanModule } from './blueprint/plan.ts';
import { ExprSyntaxError, UnsupportedError } from './expr/errors.ts';
import { parseExpression } from './expr/parser.ts';
import { scanTemplate, type ModuleRef } from './expr/scan.ts';
import { escapePointerToken, isObject, type JsonValue } from './json/parse.ts';
import { FILTER_OPERATORS, FUNCTIONS, KEYWORDS, MODULES } from './registry.ts';
import { handlerFor, isOpaqueModule } from './run/modules.ts';

export type Verdict = 'eligible' | 'unsupported' | 'invalid';

export interface InspectModule {
  order: number;
  id: number;
  module: string;
  version: number;
  where: string;
  pointer: string;
  supported: boolean;
  evidence: string | null;
  filter: { label: string | null; operators: string[] } | null;
  routeCount?: number;
  elseRoute?: number;
}

export interface InspectExpression {
  moduleId: number;
  pointer: string;
  text: string;
  refs: ModuleRef[];
  functions: string[];
  keywords: string[];
  bareWords: string[];
}

export interface InspectReport {
  schemaVersion: 1;
  tool: 'blueprint-runtime';
  command: 'inspect';
  file: string;
  sha256: string;
  bytes: number;
  format: BlueprintFormat;
  name: string | null;
  semanticHash: string | null;
  modules: InspectModule[];
  expressions: InspectExpression[];
  functions: { name: string; count: number; supported: boolean }[];
  filterOperators: { operator: string; count: number; supported: boolean }[];
  /** The blueprint reads `now`: a case needs environment.now (a fixed test clock). */
  needsClock: boolean;
  /** Modules that need a fixture to run offline, with the fixture mode. */
  fixtures: { moduleId: number; module: string; mode: 'http' | 'module' | 'trigger' }[];
  findings: Finding[];
  verdict: Verdict;
  exitCode: number;
}

function describeWhere(m: PlanModule, byId: Map<number, PlanModule>): string {
  if (m.branch.length === 0) return 'main';
  return m.branch
    .map((b) => {
      if (b.kind === 'onerror') return `error handler of ${b.owner}`;
      const router = byId.get(b.owner);
      const fallback = router?.elseRoute === b.index ? ' (fallback)' : '';
      return `router ${b.owner} › route ${b.index + 1}${fallback}`;
    })
    .join(' › ');
}

/** Every string under a value, with its JSON pointer. */
function* strings(v: JsonValue | undefined, pointer: string): Generator<[string, string]> {
  if (typeof v === 'string') yield [v, pointer];
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* strings(v[i], `${pointer}/${i}`);
  else if (isObject(v)) for (const k of Object.keys(v)) yield* strings(v[k], `${pointer}/${escapePointerToken(k)}`);
}

export function inspectBytes(file: string, bytes: Uint8Array, limits: LoadLimits = DEFAULT_LIMITS): InspectReport {
  const loaded = loadBlueprint(bytes, limits);
  const findings = [...loaded.findings];
  const report: InspectReport = {
    schemaVersion: 1,
    tool: 'blueprint-runtime',
    command: 'inspect',
    file,
    sha256: loaded.sha256,
    bytes: loaded.bytes,
    format: loaded.format,
    name: loaded.plan?.name ?? (typeof loaded.doc?.['name'] === 'string' ? loaded.doc['name'] : null),
    semanticHash: loaded.plan?.semanticHash ?? null,
    modules: [],
    expressions: [],
    functions: [],
    filterOperators: [],
    needsClock: false,
    fixtures: [],
    findings,
    verdict: 'eligible',
    exitCode: EXIT.ok,
  };

  const plan = loaded.plan;
  if (plan) {
    const byId = new Map(plan.modules.map((m) => [m.id, m] as const));
    const locate = (pointer: string) => loaded.json?.locatePointer(pointer);
    const add = (f: Finding) => {
      const loc = f.pointer === undefined ? undefined : locate(f.pointer);
      findings.push(loc ? { ...f, loc } : f);
    };
    const fnCounts = new Map<string, number>();
    const opCounts = new Map<string, number>();

    const trigger = plan.modules[0];
    const appTrigger = trigger !== undefined && isOpaqueModule(trigger.module);
    if (appTrigger) {
      report.fixtures.push({ moduleId: trigger.id, module: trigger.module, mode: 'trigger' });
      add({ code: 'TRIGGER_FROM_INPUT', severity: 'warning', message: `The scenario starts with ${trigger.module}: a case's input is the list of bundles this trigger emitted (the connector itself is not verified)`, pointer: `${trigger.pointer}/module` });
    } else if (trigger && trigger.module !== 'gateway:CustomWebHook' && trigger.module !== 'util:BasicTrigger') {
      add({ code: 'TRIGGER_UNSUPPORTED', severity: 'unsupported', message: `The scenario starts with ${trigger.module}; only a Custom webhook, the Basic trigger or a third-party app trigger can start a run yet`, pointer: `${trigger.pointer}/module` });
    }
    for (const m of plan.modules) {
      const support = MODULES[m.module];
      const versionOk = support?.versions.includes(m.version) ?? false;
      const opaque = !support && isOpaqueModule(m.module);
      if ((opaque && m !== trigger) || support?.fixture) {
        const mode = opaque ? 'module' : support!.fixture!;
        report.fixtures.push({ moduleId: m.id, module: m.module, mode });
        add({ code: 'FIXTURE_REQUIRED', severity: 'warning', message: `Module ${m.id} (${m.module}) runs offline only from ${mode === 'http' ? 'an HTTP fixture (the request it builds is checked)' : 'a module fixture (its mapped input is checked; the connector itself is not verified)'}`, pointer: `${m.pointer}/module` });
      }
      if (!support && !opaque) {
        add({ code: 'MODULE_UNSUPPORTED', severity: 'unsupported', message: `Module ${m.id} uses ${m.module}, which has no recorded Make behavior in this runtime yet`, pointer: `${m.pointer}/module` });
      } else if (support && !versionOk) {
        add({ code: 'MODULE_VERSION_UNSUPPORTED', severity: 'unsupported', message: `Module ${m.id}: ${m.module} version ${m.version} is not covered (known: ${support.versions.join(', ')})`, pointer: `${m.pointer}/version` });
      }
      try {
        handlerFor(m.module)?.check?.(m);
      } catch (e) {
        if (!(e instanceof UnsupportedError)) throw e;
        add({ code: 'MODULE_CONFIG_UNSUPPORTED', severity: 'unsupported', message: e.message, pointer: m.pointer });
      }
      // Filter and router shapes the scheduler refuses (src/run/scheduler.ts).
      const fallbackStart = m.branch.length > 0 && (() => {
        const b = m.branch[m.branch.length - 1]!;
        const router = byId.get(b.owner);
        return router?.elseRoute === b.index && plan.modules.find((x) => JSON.stringify(x.branch) === JSON.stringify(m.branch)) === m;
      })();
      if (m.filter && !fallbackStart && (m.filter.conditions.length === 0 || m.filter.conditions.some((g) => g.length === 0))) {
        add({ code: 'FILTER_SHAPE_UNSUPPORTED', severity: 'unsupported', message: `Module ${m.id}: a filter with an empty condition group has not been observed in Make`, pointer: `${m.pointer}/filter` });
      }
      if (fallbackStart && m.filter?.conditions.some((g) => g.length > 0)) {
        add({ code: 'FILTER_SHAPE_UNSUPPORTED', severity: 'unsupported', message: `Module ${m.id}: a fallback route with its own conditions has not been observed in Make`, pointer: `${m.pointer}/filter` });
      }
      if (m.module === 'builtin:BasicRouter') {
        const count = m.routeCount ?? 0;
        if (m.elseRoute !== undefined && m.elseRoute !== count - 1) add({ code: 'ROUTER_SHAPE_UNSUPPORTED', severity: 'unsupported', message: `Router ${m.id}: a fallback that is not the last route has not been observed in Make`, pointer: `${m.pointer}/parameters` });
        for (let r = 0; r < count; r++) {
          if (!plan.modules.some((x) => x.branch.length === m.branch.length + 1 && x.branch.at(-1)?.owner === m.id && x.branch.at(-1)?.index === r)) {
            add({ code: 'ROUTER_SHAPE_UNSUPPORTED', severity: 'unsupported', message: `Router ${m.id}: route ${r + 1} is empty; an empty route has not been observed in Make`, pointer: `${m.pointer}/routes/${r}` });
          }
        }
      }
      if (m.hasErrorHandler) {
        add({ code: 'ERROR_HANDLER_UNSUPPORTED', severity: 'unsupported', message: `Module ${m.id} has an error-handler route; error handlers are not supported yet`, pointer: `${m.pointer}/onerror` });
      }
      // Iterator structure the scheduler can run (src/run/scheduler.ts runIteration, corpus C):
      // iterator → Set variable modules → optional Text aggregator, all in the same flow.
      const sameFlow = (x: PlanModule) => JSON.stringify(x.branch) === JSON.stringify(m.branch);
      if (m.module === 'util:TextAggregator') {
        const feeder = m.parameters['feeder'];
        const source = typeof feeder === 'number' ? byId.get(feeder) : undefined;
        const fromTrigger = source !== undefined && source === trigger && m.branch.length === 0; // T-04
        if (!source || (!fromTrigger && (!m.upstream.includes(source.id) || source.module !== 'builtin:BasicFeeder' || !sameFlow(source)))) {
          add({ code: 'AGGREGATOR_SOURCE_UNSUPPORTED', severity: 'unsupported', message: `Aggregator ${m.id}: only an iterator earlier in the same flow, or the trigger, as the source is supported, got ${JSON.stringify(feeder ?? null)}`, pointer: `${m.pointer}/parameters/feeder` });
        }
        if (fromTrigger) {
          for (const x of plan.modules) {
            if (x.order > trigger.order && x.order < m.order && x.branch.length === 0 && x.module !== 'util:SetVariable2') {
              add({ code: 'ITERATOR_SCOPE_UNSUPPORTED', severity: 'unsupported', message: `Module ${x.id} (${x.module}) runs once per trigger bundle before aggregator ${m.id}: only Set variable has recorded Make behavior there`, pointer: x.pointer });
            }
          }
        }
        if (!['other', '\n', '\t'].includes(m.parameters['rowSeparator'] as string)) {
          add({ code: 'AGGREGATOR_SEPARATOR_UNSUPPORTED', severity: 'unsupported', message: `Aggregator ${m.id}: row separator ${JSON.stringify(m.parameters['rowSeparator'] ?? null)} has no recorded Make behavior yet`, pointer: `${m.pointer}/parameters/rowSeparator` });
        }
      }
      if (m.module === 'builtin:BasicFeeder') {
        const aggregator = plan.modules.find((x) => x.module === 'util:TextAggregator' && x.parameters['feeder'] === m.id && x.order > m.order && sameFlow(x));
        // Without an aggregator, the rest of the flow runs once per bundle (C2-noagg).
        const end = aggregator?.order ?? Infinity;
        for (const x of plan.modules) {
          if (x.order > m.order && x.order < end && sameFlow(x) && x.module !== 'util:SetVariable2') {
            add({ code: 'ITERATOR_SCOPE_UNSUPPORTED', severity: 'unsupported', message: `Module ${x.id} (${x.module}) runs once per bundle of iterator ${m.id}: only Set variable has recorded Make behavior there`, pointer: x.pointer });
          }
        }
      }

      const operators: string[] = [];
      m.filter?.conditions.forEach((group, gi) =>
        group.forEach((c, ci) => {
          operators.push(c.o);
          opCounts.set(c.o, (opCounts.get(c.o) ?? 0) + 1);
          if (!(c.o in FILTER_OPERATORS)) {
            add({ code: 'FILTER_OPERATOR_UNSUPPORTED', severity: 'unsupported', message: `Module ${m.id}: filter operator "${c.o}" has no recorded Make behavior yet`, pointer: `${m.pointer}/filter/conditions/${gi}/${ci}/o` });
          }
        }),
      );

      const im: InspectModule = {
        order: m.order,
        id: m.id,
        module: m.module,
        version: m.version,
        where: describeWhere(m, byId),
        pointer: m.pointer,
        supported: (Boolean(support) && versionOk) || opaque,
        evidence: support?.evidence ?? null,
        filter: m.filter ? { label: m.filter.label, operators } : null,
      };
      if (m.routeCount !== undefined) im.routeCount = m.routeCount;
      if (m.elseRoute !== undefined) im.elseRoute = m.elseRoute;
      report.modules.push(im);

      // Expressions: mapper, parameters and filter operands.
      const sources: [JsonValue | undefined, string][] = [
        [m.mapper, `${m.pointer}/mapper`],
        [m.parameters, `${m.pointer}/parameters`],
      ];
      m.filter?.conditions.forEach((g, gi) =>
        g.forEach((c, ci) => {
          sources.push([c.a, `${m.pointer}/filter/conditions/${gi}/${ci}/a`]);
          if (c.b !== undefined) sources.push([c.b, `${m.pointer}/filter/conditions/${gi}/${ci}/b`]);
        }),
      );
      for (const [value, base] of sources) {
        for (const [s, pointer] of strings(value, base)) {
          if (!s.includes('{{')) continue;
          const scanned = scanTemplate(s);
          for (const e of scanned.errors) {
            add({ code: 'EXPRESSION_UNTERMINATED', severity: 'unsupported', message: `Module ${m.id}: ${e.message} (Make's handling of this is unknown)`, pointer });
          }
          for (const x of scanned.exprs) {
            try {
              parseExpression(x.text, x.start + 2);
            } catch (e) {
              // Not "invalid": Make accepts a scenario with an expression it cannot read and
              // only fails when it runs (corpus NOTES, D2 safety), so the file is still valid.
              if (e instanceof ExprSyntaxError) add({ code: 'EXPRESSION_SYNTAX', severity: 'unsupported', message: `Module ${m.id}: {{${x.text.length > 120 ? `${x.text.slice(0, 120)}…` : x.text}}}: bpr cannot read this (${e.message} at character ${e.offset + 1}); how Make reads it has not been recorded`, pointer });
              else if (e instanceof UnsupportedError) add({ code: 'EXPRESSION_UNSUPPORTED', severity: 'unsupported', message: `Module ${m.id}: {{${x.text}}}: ${e.message}`, pointer });
              else throw e;
            }
            report.expressions.push({ moduleId: m.id, pointer, text: x.text, refs: x.refs, functions: x.functions, keywords: x.keywords, bareWords: x.bareWords });
            for (const f of x.functions) fnCounts.set(f, (fnCounts.get(f) ?? 0) + 1);
            for (const k of x.keywords) {
              if (!(k in KEYWORDS)) add({ code: 'KEYWORD_UNSUPPORTED', severity: 'unsupported', message: `Module ${m.id}: keyword "${k}" has no recorded Make behavior yet`, pointer });
              else if (k === 'now') {
                // Recorded only in a module's mapping, where it is the time the module starts (N-01).
                if (pointer.includes('/filter/') || m.module === 'util:TextAggregator') {
                  add({ code: 'KEYWORD_UNSUPPORTED', severity: 'unsupported', message: `Module ${m.id}: "now" in a ${m.module === 'util:TextAggregator' ? 'Text aggregator' : 'filter'} has not been observed in Make (only in a module's mapping)`, pointer });
                } else report.needsClock = true;
              }
            }
            for (const r of x.refs) {
              if (!byId.has(r.moduleId)) {
                add({ code: 'REF_UNKNOWN_MODULE', severity: 'unsupported', message: `Module ${m.id} references {{${r.moduleId}.${r.path}}}, but there is no module ${r.moduleId} (left over from a deleted module?); what Make reads there has not been recorded`, pointer });
              } else if (!m.upstream.includes(r.moduleId)) {
                add({ code: 'REF_NOT_UPSTREAM', severity: 'unsupported', message: `Module ${m.id} references module ${r.moduleId}, which does not run before it on this path; what Make reads there has not been recorded`, pointer });
              }
            }
          }
        }
      }
    }

    report.functions = [...fnCounts].sort().map(([name, count]) => ({ name, count, supported: name in FUNCTIONS }));
    for (const f of report.functions) {
      if (!f.supported) add({ code: 'FUNCTION_UNSUPPORTED', severity: 'unsupported', message: `Function ${f.name}() is used ${f.count}× and has no recorded Make behavior yet` });
    }
    report.filterOperators = [...opCounts].sort().map(([operator, count]) => ({ operator, count, supported: operator in FILTER_OPERATORS }));
  }

  if (findings.some((f) => f.severity === 'error')) {
    report.verdict = 'invalid';
    report.exitCode = EXIT.invalidInput;
  } else if (findings.some((f) => f.severity === 'unsupported')) {
    report.verdict = 'unsupported';
    report.exitCode = EXIT.unsupported;
  }
  return report;
}

export function renderInspect(r: InspectReport): string {
  const out: string[] = [];
  const short = (h: string | null) => (h ? h.slice(0, 12) : '-');
  out.push(`${r.file}`);
  out.push(`  format   ${r.format}   ${r.bytes} bytes   sha256 ${short(r.sha256)}   semantic ${short(r.semanticHash)}`);
  if (r.name) out.push(`  name     ${r.name}`);

  if (r.modules.length) {
    out.push('', `  modules (${r.modules.length})`);
    const w = Math.max(...r.modules.map((m) => `${m.module} v${m.version}`.length));
    for (const m of r.modules) {
      const mod = `${m.module} v${m.version}`.padEnd(w);
      const extra = [
        m.routeCount !== undefined ? `${m.routeCount} routes${m.elseRoute !== undefined ? `, fallback = route ${m.elseRoute + 1}` : ''}` : '',
        m.filter ? `filter${m.filter.label ? ` "${m.filter.label}"` : ''}: ${m.filter.operators.join(', ') || 'none'}` : '',
      ].filter(Boolean);
      out.push(`  ${m.supported ? 'ok ' : 'NO '} ${String(m.id).padStart(3)}  ${mod}  ${m.where}${extra.length ? `  [${extra.join('; ')}]` : ''}`);
    }
  }

  if (r.expressions.length) {
    out.push('', `  expressions (${r.expressions.length})`);
    const shown = r.expressions.slice(0, 25);
    for (const e of shown) {
      const text = e.text.length > 70 ? `${e.text.slice(0, 67)}...` : e.text;
      out.push(`    ${String(e.moduleId).padStart(3)}  {{${text}}}`);
    }
    if (r.expressions.length > shown.length) out.push(`    ... ${r.expressions.length - shown.length} more (use --json for all)`);
    const bare = [...new Set(r.expressions.flatMap((e) => e.bareWords))];
    if (bare.length) out.push(`  bare words (not strings in Make; check these): ${bare.join(', ')}`);
  }
  if (r.functions.length) out.push('', `  functions  ${r.functions.map((f) => `${f.supported ? '' : '!'}${f.name}×${f.count}`).join('  ')}`);
  if (r.filterOperators.length) out.push(`  operators  ${r.filterOperators.map((o) => `${o.supported ? '' : '!'}${o.operator}×${o.count}`).join('  ')}`);

  if (r.findings.length) {
    out.push('', `  findings (${r.findings.length})`);
    for (const f of r.findings) {
      const where = f.loc ? ` (line ${f.loc.line}:${f.loc.column})` : '';
      out.push(`    ${f.severity.padEnd(11)} ${f.code}${where}`);
      out.push(`                ${f.message}`);
    }
  }

  const verdictText = {
    eligible: r.fixtures.length
      ? `ELIGIBLE WITH FIXTURES: runs offline once ${r.fixtures.length} module${r.fixtures.length > 1 ? 's get fixtures' : ' gets a fixture'} (${r.fixtures.map((f) => `${f.moduleId} ${f.mode}`).join(', ')}); everything else has recorded Make behavior`
      : 'ELIGIBLE: every module, operator and function here has recorded Make behavior',
    unsupported: 'NOT YET SUPPORTED: uses things without recorded Make behavior (see findings)',
    invalid: 'INVALID: the file has errors (see findings)',
  }[r.verdict];
  out.push('', `  ${verdictText}`);
  return out.join('\n');
}

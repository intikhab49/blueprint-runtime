import { createHash } from 'node:crypto';
import type { Finding } from '../findings.ts';
import { isObject, JsonParseError, parseJson, type JsonObject, type ParsedJson } from '../json/parse.ts';
import { buildPlan, type Plan } from './plan.ts';

export interface LoadLimits {
  maxBytes: number;
  maxDepth: number;
  maxModules: number;
}

export const DEFAULT_LIMITS: LoadLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxDepth: 64,
  maxModules: 1000,
};

/**
 * blueprint      a scenario exported from the Make editor (top-level "flow")
 * modules-schema Make's flat format with "modules" + parent/follows links, used by
 *                Make's own AI skill examples (integromat/make-skills); not an export
 */
export type BlueprintFormat = 'blueprint' | 'modules-schema' | 'unknown';

export interface LoadResult {
  sha256: string;
  bytes: number;
  format: BlueprintFormat;
  doc: JsonObject | null;
  json: ParsedJson | null;
  plan: Plan | null;
  findings: Finding[];
}

export function loadBlueprint(input: Uint8Array, limits: LoadLimits = DEFAULT_LIMITS): LoadResult {
  const result: LoadResult = {
    sha256: createHash('sha256').update(input).digest('hex'),
    bytes: input.byteLength,
    format: 'unknown',
    doc: null,
    json: null,
    plan: null,
    findings: [],
  };
  const error = (code: string, message: string, extra: Partial<Finding> = {}) => {
    result.findings.push({ code, severity: 'error', message, ...extra });
    return result;
  };

  if (input.byteLength > limits.maxBytes) {
    return error('BP_TOO_LARGE', `File is ${input.byteLength} bytes; the limit is ${limits.maxBytes}`);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return error('BP_NOT_UTF8', 'File is not valid UTF-8');
  }

  try {
    result.json = parseJson(text, limits.maxDepth);
  } catch (e) {
    if (e instanceof JsonParseError) {
      return error(e.code, e.message, e.pointer === undefined ? { loc: e.loc } : { loc: e.loc, pointer: e.pointer });
    }
    throw e;
  }

  const root = result.json.value;
  if (!isObject(root)) return error('BP_NOT_AN_OBJECT', 'A blueprint is a JSON object', { pointer: '' });
  // Exports are often saved wrapped: {"blueprint": {...}} or the API's {"response": {"blueprint": {...}}}.
  let doc = root;
  let base = '';
  const inner = (o: JsonObject, k: string) => (isObject(o[k]) ? (o[k] as JsonObject) : null);
  if (!Array.isArray(root['flow'])) {
    const wrapped = inner(root, 'blueprint') ?? (inner(root, 'response') && inner(inner(root, 'response')!, 'blueprint'));
    if (wrapped && Array.isArray(wrapped['flow'])) {
      doc = wrapped;
      base = isObject(root['blueprint']) ? '/blueprint' : '/response/blueprint';
      result.findings.push({ code: 'FORMAT_WRAPPED', severity: 'warning', message: `The blueprint is wrapped in ${base.slice(1).split('/').map((k) => `"${k}"`).join(' → ')}; inspecting the blueprint inside`, pointer: base });
    }
  }
  result.doc = doc;

  if (Array.isArray(doc['flow'])) {
    result.format = 'blueprint';
  } else if (Array.isArray(doc['modules'])) {
    result.format = 'modules-schema';
    result.findings.push({
      code: 'FORMAT_MODULES_SCHEMA',
      severity: 'unsupported',
      message:
        'This file uses Make\'s flat "modules" format (parent/follows links), not an exported blueprint. ' +
        'Open the scenario in Make and use ⋮ → Export blueprint, then inspect that file.',
      pointer: `${base}/modules`,
    });
    return result;
  } else {
    return error('BP_NO_FLOW', 'No top-level "flow" array; this does not look like an exported Make blueprint', { pointer: '' });
  }

  const { plan, findings } = buildPlan(doc, limits, base);
  result.plan = plan;
  for (const f of findings) {
    const loc = f.pointer === undefined ? undefined : result.json.locatePointer(f.pointer);
    result.findings.push(loc ? { ...f, loc } : f);
  }
  return result;
}

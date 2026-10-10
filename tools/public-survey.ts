/**
 * Eligibility survey over public Make blueprints found on GitHub.
 *
 *   node tools/public-survey.ts            # download missing files, inspect, write results
 *
 * corpus/survey/sources.tsv pins one blueprint per repository by git blob sha, so the
 * same bytes are surveyed every time. The files themselves are not redistributed: they
 * are downloaded into corpus/survey/cache/ (gitignored). Set GITHUB_TOKEN to lift
 * GitHub's 60 requests/hour limit for anonymous API calls.
 *
 * Every file `inspect` calls eligible is then run through the scheduler with a stub
 * that answers any fixture, so a file counted as eligible is one the runtime does not
 * refuse either (it has no live data, so this proves no refusal, not correctness).
 * Results: corpus/survey/results.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadBlueprint } from '../src/blueprint/load.ts';
import { UnsupportedError } from '../src/expr/errors.ts';
import { inspectBytes } from '../src/inspect.ts';
import { FixtureSet, type HttpFixture, type ModuleFixture } from '../src/run/fixtures.ts';
import { runScenario } from '../src/run/scheduler.ts';

const SOURCES = 'corpus/survey/sources.tsv';
const CACHE = 'corpus/survey/cache';
const OUT = 'corpus/survey/results.json';

/** Answers every call, so the smoke run gets past HTTP and third-party modules. */
class AnyFixture extends FixtureSet {
  override http(): HttpFixture {
    return { module: 0, occurrence: 0, mode: 'http', request: { method: '', url: '', contentType: null, body: null }, response: { status: 200, headers: [['content-type', 'application/json']], body: '{}' } };
  }
  override module(): ModuleFixture {
    return { module: 0, occurrence: 0, mode: 'module', input: {}, output: [{}] };
  }
}

async function download(repo: string, sha: string, file: string) {
  const headers: Record<string, string> = { Accept: 'application/vnd.github.raw' };
  if (process.env['GITHUB_TOKEN']) headers['Authorization'] = `Bearer ${process.env['GITHUB_TOKEN']}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${sha}`, { headers });
  if (!res.ok) throw new Error(`${repo} ${sha}: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const why = (code: string, message: string) => {
  if (code === 'MODULE_UNSUPPORTED') return `module ${/uses (\S+),/.exec(message)?.[1] ?? '?'}`;
  if (code === 'KEYWORD_UNSUPPORTED') return `keyword ${/"([^"]+)"/.exec(message)?.[1] ?? '?'}`;
  if (code === 'FUNCTION_UNSUPPORTED') return `function ${/Function (\S+)\(/.exec(message)?.[1] ?? '?'}()`;
  if (code === 'TRIGGER_UNSUPPORTED') return 'a polling or app trigger instead of a Custom webhook';
  // Group the open-ended messages by their reason, without ids, values or the expression text.
  const reason = (m: string) => m.replace(/^.*?\}\}: /, '').replace(/^(?:HTTP|Webhook response|module|Module|Router|Iterator|Text aggregator) \d+(?: \([^)]*\))?: /, '').replace(/ = .*? has not/, ' has not').replace(/"[^"]*"/g, '"…"').replace(/\d+/g, 'N').replace(/ \(.*$/, '').slice(0, 90);
  if (code === 'EXPRESSION_SYNTAX') return `${code}: ${(/bpr cannot read this \((.+?) at character \d+\); how Make/s.exec(message)?.[1] ?? '?').replace(/"[^"]*"/g, '"…"')}`;
  if (code === 'EXPRESSION_UNSUPPORTED' || code === 'MODULE_CONFIG_UNSUPPORTED') return `${code}: ${reason(message)}`;
  return code;
};

interface SurveyRow {
  repo: string;
  path: string;
  sha: string;
  verdict: string;
  modules: number;
  fixtures: string[];
  blockers: string[];
  smoke: string | null;
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const sources = readFileSync(SOURCES, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t') as [string, string, string]);
  const results: SurveyRow[] = [];
  for (const [repo, path, sha] of sources) {
    const file = `${CACHE}/${sha}.json`;
    if (!existsSync(file)) await download(repo, sha, file);
    const bytes = readFileSync(file);
    const r = inspectBytes(`${repo}/${path}`, bytes);
    const blockers = [...new Set(r.findings.filter((f) => f.severity !== 'warning').map((f) => why(f.code, f.message)))];
    let smoke: string | null = null;
    if (r.verdict === 'eligible') {
      try {
        smoke = `ran (${runScenario(loadBlueprint(bytes).plan!, {}, { timezone: 'UTC', fixtures: new AnyFixture() }).status})`;
      } catch (e) {
        if (!(e instanceof UnsupportedError)) throw e;
        smoke = `REFUSED: ${e.message}`;
      }
    }
    results.push({ repo, path, sha, verdict: r.verdict, modules: r.modules.length, fixtures: r.fixtures.map((f) => `${f.moduleId} ${f.mode}`), blockers, smoke });
  }
  writeFileSync(OUT, `${JSON.stringify({ schemaVersion: 1, surveyedAt: new Date().toISOString().slice(0, 10), files: results.length, results }, null, 2)}\n`);

  const n = (f: (r: SurveyRow) => boolean) => results.filter(f).length;
  const eligible = results.filter((r) => r.verdict === 'eligible');
  console.log(`${results.length} public blueprints, one per repository`);
  console.log(`  eligible:          ${eligible.length} (${n((r) => r.verdict === 'eligible' && r.fixtures.length === 0)} fully offline, ${n((r) => r.verdict === 'eligible' && r.fixtures.length > 0)} with fixtures)`);
  console.log(`  not yet supported: ${n((r) => r.verdict === 'unsupported')}`);
  console.log(`  invalid:           ${n((r) => r.verdict === 'invalid')} (structure Make itself could not have exported)`);
  const refused = eligible.filter((r) => !r.smoke?.startsWith('ran'));
  console.log(`  eligible but refused by the runtime: ${refused.length}${refused.length ? ` (${refused.map((r) => r.repo).join(', ')})` : ''}`);
  const count = new Map<string, number>();
  for (const r of results) if (r.verdict === 'unsupported') for (const b of r.blockers) count.set(b, (count.get(b) ?? 0) + 1);
  console.log('\n  most common blockers (files):');
  for (const [b, c] of [...count].sort((a, b) => b[1] - a[1]).slice(0, 16)) console.log(`    ${String(c).padStart(4)}  ${b}`);
  const sole = new Map<string, number>();
  for (const r of results) if (r.verdict === 'unsupported' && r.blockers.length === 1) sole.set(r.blockers[0]!, (sole.get(r.blockers[0]!) ?? 0) + 1);
  console.log('\n  files held back by exactly one thing:');
  for (const [b, c] of [...sole].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    ${String(c).padStart(4)}  ${b}`);
  console.log(`\nwrote ${OUT}`);
}

await main();

#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadBlueprint } from './blueprint/load.ts';
import { UnsupportedError } from './expr/errors.ts';
import { EXIT } from './findings.ts';
import { inspectBytes, renderInspect, type InspectReport } from './inspect.ts';
import { parseJson } from './json/parse.ts';
import { runCase, type CaseResult } from './run/case.ts';
import { FixtureError, FixtureSet } from './run/fixtures.ts';
import { LimitExceededError, runScenario } from './run/scheduler.ts';

const USAGE = `blueprint-runtime (bpr): run and test Make.com scenario blueprints offline

usage:
  bpr inspect <blueprint.json>... [--json]
  bpr test <case.json | folder>... [--json] [--allow-unsupported]
  bpr run <blueprint.json> --input <payload.json> [--fixtures <fixtures.json>] [--timezone <IANA name>]

exit codes:
  0  success (inspect: eligible; test: every case matched Make)
  1  a test case differs from Make's recorded run
  2  invalid input (bad JSON, broken structure, unreadable file)
  3  uses something without recorded Make behavior
  4  a run failed (bpr run only: the scenario hit an error, as Make would have)
  5  a fixture is missing, does not match, or was never used (never a network call)
  6  a local limit was exceeded
`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function inspect(args: string[]): number {
  const json = args.includes('--json');
  const unknownFlags = args.filter((a) => a.startsWith('-') && a !== '--json');
  if (unknownFlags.length) {
    process.stderr.write(`unknown option ${unknownFlags.join(', ')}\n`);
    return EXIT.invalidInput;
  }
  const files = args.filter((a) => !a.startsWith('-'));
  if (files.length === 0) {
    process.stderr.write(`inspect needs at least one file\n\n${USAGE}`);
    return EXIT.invalidInput;
  }
  const reports: InspectReport[] = [];
  let exitCode: number = EXIT.ok;
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(file);
    } catch (e) {
      process.stderr.write(`cannot read ${file}: ${(e as Error).message}\n`);
      exitCode = EXIT.invalidInput;
      continue;
    }
    const report = inspectBytes(file, bytes);
    reports.push(report);
    if (report.exitCode === EXIT.invalidInput || (report.exitCode === EXIT.unsupported && exitCode === EXIT.ok)) exitCode = report.exitCode;
  }
  if (json) {
    const payload = reports.length === 1 && files.length === 1 ? reports[0] : { schemaVersion: 1, tool: 'blueprint-runtime', command: 'inspect', reports, exitCode };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${reports.map(renderInspect).join('\n\n')}\n`);
    if (reports.length > 1) {
      const count = (v: string) => reports.filter((r) => r.verdict === v).length;
      process.stdout.write(`\n${reports.length} files: ${count('eligible')} eligible, ${count('unsupported')} not yet supported, ${count('invalid')} invalid\n`);
    }
  }
  return exitCode;
}

function findCases(path: string): string[] {
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? findCases(join(path, e.name)) : e.name === 'case.json' ? [join(path, e.name)] : []));
}

function test(args: string[]): number {
  const json = args.includes('--json');
  const allowUnsupported = args.includes('--allow-unsupported');
  const unknownFlags = args.filter((a) => a.startsWith('-') && a !== '--json' && a !== '--allow-unsupported');
  if (unknownFlags.length) {
    process.stderr.write(`unknown option ${unknownFlags.join(', ')}\n`);
    return EXIT.invalidInput;
  }
  const files = args.filter((a) => !a.startsWith('-')).flatMap(findCases);
  if (files.length === 0) {
    process.stderr.write(`test needs at least one case.json or a folder containing them\n\n${USAGE}`);
    return EXIT.invalidInput;
  }
  const results: CaseResult[] = files.map(runCase);
  const count = (v: CaseResult['verdict']) => results.filter((r) => r.verdict === v).length;
  const exitCode = count('fail') ? EXIT.assertionFailed : count('invalid') ? EXIT.invalidInput : count('fixture') ? EXIT.fixtureMismatch : count('limit') ? EXIT.limitExceeded : count('unsupported') && !allowUnsupported ? EXIT.unsupported : EXIT.ok;

  if (json) {
    const payload = { schemaVersion: 1, tool: 'blueprint-runtime', command: 'test', results: results.map(({ trace: _trace, ...r }) => r), exitCode };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return exitCode;
  }
  const label: Record<CaseResult['verdict'], string> = { pass: 'PASS', fail: 'FAIL', unsupported: 'SKIP', invalid: 'BAD ', limit: 'LIMIT', fixture: 'FIXT' };
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const why = r.verdict === 'pass' ? '' : r.verdict === 'unsupported' ? `  not supported yet: ${r.message}` : `  ${r.message}`;
    process.stdout.write(`${`${label[r.verdict]}  ${r.name.padEnd(width)}${why}`.trimEnd()}\n`);
  }
  process.stdout.write(`\n${results.length} cases: ${count('pass')} matched Make, ${count('fail')} differ, ${count('unsupported')} not supported yet, ${count('invalid')} invalid${count('fixture') ? `, ${count('fixture')} fixture problem${count('fixture') > 1 ? 's' : ''}` : ''}${count('limit') ? `, ${count('limit')} over a limit` : ''}\n`);
  return exitCode;
}

function run(args: string[]): number {
  const [file] = args.filter((a, i) => !a.startsWith('-') && !['--input', '--timezone', '--fixtures'].includes(args[i - 1] ?? ''));
  const inputFile = flagValue(args, '--input');
  if (!file || !inputFile) {
    process.stderr.write(`run needs a blueprint and --input <payload.json>\n\n${USAGE}`);
    return EXIT.invalidInput;
  }
  let loaded;
  let payload;
  let fixtures: FixtureSet;
  try {
    loaded = loadBlueprint(readFileSync(file));
    payload = parseJson(readFileSync(inputFile, 'utf8'), 64).value;
    const fixturesFile = flagValue(args, '--fixtures');
    fixtures = fixturesFile ? FixtureSet.fromJson(parseJson(readFileSync(fixturesFile, 'utf8'), 64).value) : new FixtureSet();
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return EXIT.invalidInput;
  }
  if (!loaded.plan) {
    process.stderr.write(`${file} is not a runnable blueprint:\n${loaded.findings.map((f) => `  ${f.code}: ${f.message}`).join('\n')}\n`);
    return loaded.findings.some((f) => f.severity === 'error') ? EXIT.invalidInput : EXIT.unsupported;
  }
  try {
    const trace = runScenario(loaded.plan, payload, { timezone: flagValue(args, '--timezone') ?? null, fixtures });
    fixtures.assertAllUsed();
    process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
    return trace.status === 'error' ? EXIT.runtimeFailure : EXIT.ok;
  } catch (e) {
    if (e instanceof FixtureError) {
      process.stderr.write(`fixture: ${e.message}\n`);
      return EXIT.fixtureMismatch;
    }
    if (e instanceof UnsupportedError) {
      process.stderr.write(`not supported yet: ${e.message}\n`);
      return EXIT.unsupported;
    }
    if (e instanceof LimitExceededError) {
      process.stderr.write(`${e.message}\n`);
      return EXIT.limitExceeded;
    }
    throw e;
  }
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(USAGE);
    return command ? EXIT.ok : EXIT.invalidInput;
  }
  switch (command) {
    case 'inspect':
      return inspect(rest);
    case 'test':
      return test(rest);
    case 'run':
      return run(rest);
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return EXIT.invalidInput;
  }
}

process.exitCode = main(process.argv.slice(2));

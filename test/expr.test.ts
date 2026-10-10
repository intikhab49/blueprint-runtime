import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as dates from '../src/expr/dates.ts';
import { ExprSyntaxError, UnsupportedError } from '../src/expr/errors.ts';
import { evaluate, evaluateMapper, evaluateTemplate, type EvalContext } from '../src/expr/evaluate.ts';
import { parseExpression, parseTemplate } from '../src/expr/parser.ts';
import { arr, fromJson, MISSING, NULL, num, str, toText, type Value } from '../src/expr/values.ts';

const ctxWith = (outputs: Record<number, unknown>, timezone: string | null = 'UTC'): EvalContext => ({
  timezone,
  output: (id) => (id in outputs ? fromJson(outputs[id] as never) : MISSING),
});
const run = (expr: string, outputs: Record<number, unknown> = {}, tz: string | null = 'UTC'): Value => evaluate(parseExpression(expr), ctxWith(outputs, tz));
const text = (expr: string, outputs: Record<number, unknown> = {}) => toText(run(expr, outputs));
const refuses = (f: () => unknown) => assert.throws(f, UnsupportedError);

describe('parser', () => {
  it('parses references with keys, backtick keys and 1-based indexes', () => {
    assert.deepEqual(parseExpression('1.people[2].`first name`'), {
      type: 'ref', moduleId: 1, path: [{ key: 'people' }, { index: 2 }, { key: 'first name' }], start: 0, end: 24,
    });
  });

  it('separates arguments with ";" and keeps negative literals', () => {
    const n = parseExpression('addHours(1.iso; -5)');
    assert.equal(n.type, 'call');
    assert.deepEqual(n.type === 'call' && n.args[1], { type: 'number', value: -5, start: 16, end: 18 });
  });

  it('tells decimals from references', () => {
    assert.equal(parseExpression('0.5').type, 'number');
    assert.equal(parseExpression('1.n').type, 'ref');
  });

  it('allows one operator, or several with parentheses', () => {
    assert.equal(parseExpression('2.qty * 2').type, 'binary');
    assert.doesNotThrow(() => parseExpression('(1.a + 1) * 2'));
  });

  it('uses the precedence and left associativity Make showed (corpus D2)', () => {
    assert.deepEqual(run('1 + 2 * 3'), num(7));
    assert.deepEqual(run('10 - 4 - 3'), num(3));
    assert.deepEqual(run('true | false & false'), { kind: 'boolean', value: true });
  });

  it('refuses regex literals and "!"', () => {
    refuses(() => parseExpression('replace(1.s; /o/g; "0")'));
    refuses(() => parseExpression('!1.b'));
  });

  it('treats backslash as a plain character, so "a\\"b" is invalid, as Make said (corpus D2)', () => {
    assert.throws(() => parseExpression('"a\\"b"'), ExprSyntaxError);
    assert.deepEqual(run('"a\\b"'), str('a\\b'));
  });

  it('reports syntax errors with their offset', () => {
    assert.throws(() => parseExpression('upper(1.s', 10), (e: unknown) => e instanceof ExprSyntaxError && e.offset === 19);
    assert.throws(() => parseExpression('1 +'), ExprSyntaxError);
    assert.throws(() => parseExpression('upper(1.s) x'), ExprSyntaxError);
  });

  it('contains no dynamic code evaluation anywhere in src/', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    for (const f of walk('src')) {
      const code = readFileSync(f, 'utf8');
      assert.doesNotMatch(code, /\beval\s*\(|new Function\s*\(|\bvm\.\w+/, f);
    }
  });
});

describe('values and references', () => {
  it('keeps missing and null apart', () => {
    assert.deepEqual(run('1.nope', { 1: { a: null } }), MISSING);
    assert.deepEqual(run('1.a', { 1: { a: null } }), NULL);
    assert.deepEqual(run('1.a.b', { 1: { a: null } }), MISSING);
    assert.deepEqual(run('5.x'), MISSING);
  });

  it('indexes arrays from 1', () => {
    assert.deepEqual(run('1.arr[1]', { 1: { arr: ['c', 'a'] } }), str('c'));
    assert.deepEqual(run('1.arr[3]', { 1: { arr: ['c', 'a'] } }), MISSING);
  });

  it('refuses paths Make was not seen handling', () => {
    refuses(() => run('1.s.x', { 1: { s: 'text' } }));
    refuses(() => run('1.n[].x', { 1: { n: 5 } }));
  });

  it('writes values into text the way Make did', () => {
    const nbsp = String.fromCharCode(0xa0);
    assert.equal(text('1.arr', { 1: { arr: ['c', 'a', 'b'] } }), `c,${nbsp}a,${nbsp}b`);
    assert.equal(text('1.o', { 1: { o: { k1: 'v1', k2: 2 } } }), '{"k1":"v1","k2":2}');
    assert.equal(text('1.n / 0', { 1: { n: -7 } }), '-Infinity');
    assert.equal(toText(num(1e21 * 2)), '2e+21');
  });
});

describe('templates', () => {
  const ctx = ctxWith({ 1: { items: [1, 2], name: 'Ann' } });

  it('a lone expression keeps its type (the iterator got a real array, corpus C)', () => {
    assert.deepEqual(evaluateTemplate(parseTemplate('{{1.items}}'), ctx), arr([num(1), num(2)]));
  });

  it('text around expressions makes the result text', () => {
    assert.deepEqual(evaluateTemplate(parseTemplate('Hi {{1.name}} ({{1.items}})'), ctx), str(`Hi Ann (1,${String.fromCharCode(0xa0)}2)`));
  });

  it('evaluates a whole mapper, as scenario A did', () => {
    const out = evaluateMapper({ name: 'upper_name', value: '{{upper(1.name)}}' }, ctx);
    assert.equal(out.kind, 'object');
    assert.deepEqual(out.kind === 'object' && out.value.get('value'), str('ANN'));
  });
});

describe('operators (only the coercions observed in Make)', () => {
  it('"+" joins text and adds numbers', () => {
    assert.deepEqual(run('1.sn + 1', { 1: { sn: '007' } }), str('0071'));
    assert.deepEqual(run('1.n + 1', { 1: { n: 42 } }), num(43));
  });

  it('adds, subtracts and multiplies in exact decimal, as Make does (corpus D2)', () => {
    assert.deepEqual(run('0.1 + 0.2'), num(0.3));
    assert.deepEqual(run('100.1 - 100'), num(0.1));
    assert.deepEqual(run('1.005 * 1000'), num(1005));
  });

  it('refuses / and % where decimal and floating point disagree', () => {
    assert.deepEqual(run('1 / 3'), num(1 / 3));
    refuses(() => run('0.3 / 0.1'));
  });

  it('coerces like JavaScript, with missing as 0 (corpus D2)', () => {
    assert.deepEqual(run('1.sn * 1', { 1: { sn: '007' } }), num(7));
    assert.ok(Number.isNaN((run('"abc" * 2') as { value: number }).value));
    assert.deepEqual(run('1.nope * 2'), num(0));
    assert.deepEqual(run('true + 1'), str('true1'));
  });

  it('uses JavaScript loose equality (corpus D2)', () => {
    assert.deepEqual(run('1.sn = 42', { 1: { sn: '007' } }), { kind: 'boolean', value: false });
    assert.deepEqual(run('1.a = 1.nope', { 1: { a: null } }), { kind: 'boolean', value: true });
    assert.deepEqual(run('0 = false'), { kind: 'boolean', value: true });
    refuses(() => run('1.arr = 1.arr', { 1: { arr: [] } }));
  });

  it('"&" and "|" need booleans', () => {
    assert.deepEqual(run('1.b & true', { 1: { b: true } }), { kind: 'boolean', value: true });
    refuses(() => run('1.b & true', { 1: { b: 'false' } }));
  });
});

describe('functions outside the probe payloads', () => {
  it('refuses unknown functions and unobserved argument counts', () => {
    refuses(() => run('formatDuration(1)'));
    refuses(() => run('substring("abc"; 1)'));
  });

  it('uses JavaScript truthiness and evaluates only the chosen branch (corpus D2)', () => {
    assert.deepEqual(run('if("false"; 1; 2)'), num(1));
    assert.deepEqual(run('if(1.nope; 1; 2)'), num(2));
    assert.deepEqual(run('if(true; "picked"; first("x"))'), str('picked'));
  });

  it('needs a timezone for calendar functions', () => {
    refuses(() => run('addDays("2026-01-31T00:00:00.000Z"; 1)', {}, null));
  });

  it('refuses date format letters that were not observed', () => {
    refuses(() => run('formatDate("2026-01-31T00:00:00.000Z"; "dddd")'));
  });
});

describe('dates', () => {
  it('uses the scenario timezone (Asia/Karachi is UTC+5)', () => {
    assert.equal(dates.offsetMs(Date.UTC(2026, 0, 1), 'Asia/Karachi'), 5 * 3600_000);
    assert.equal(new Date(dates.parseDate('2026-01-31', 'YYYY-MM-DD', 'Asia/Karachi')).toISOString(), '2026-01-30T19:00:00.000Z');
  });

  it('keeps wall-clock time when adding days across a DST change', () => {
    const before = Date.parse('2026-03-07T15:00:00.000Z'); // 10:00 in New York, the day before DST starts
    const after = dates.addDays(before, 1, 'America/New_York');
    assert.equal(dates.formatDate(after, 'HH:mm', 'America/New_York'), '10:00');
    assert.equal(after - before, 23 * 3600_000);
  });

  it('clamps the day when adding months', () => {
    assert.equal(dates.formatDate(dates.addMonths(Date.parse('2026-01-31T12:00:00Z'), 1, 'UTC'), 'YYYY-MM-DD', 'UTC'), '2026-02-28');
  });

  it('refuses text that does not match the format', () => {
    refuses(() => dates.parseDate('31/01/2026', 'YYYY-MM-DD', 'UTC'));
    refuses(() => dates.parseDate('2026-02-30', 'YYYY-MM-DD', 'UTC'));
  });
});

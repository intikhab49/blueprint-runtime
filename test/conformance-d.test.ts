import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataError } from '../src/expr/errors.ts';
import { evalProbe, loadSet, PASSING_CASES, payload, probes, runCase, runSet, type Outcome } from './support/corpus-d.ts';

/**
 * Every probe from scenario D, replayed against every payload sent to the real Make
 * scenario. A probe either matches Make's output exactly on all five payloads or is
 * listed here as refused, with the reason. A wrong answer is never acceptable.
 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  replace_regex: 'unquoted regex literal /o/g; Make ignored it, meaning unknown',
};

const results = new Map(PASSING_CASES.map((c) => [c, runCase(c)] as const));

describe('scenario D replay: each function against real Make output', () => {
  for (const [key, expr] of probes) {
    it(`${key}: {{${expr}}}`, () => {
      for (const c of PASSING_CASES) {
        const o = results.get(c)!.get(key) as Outcome;
        if (key in KNOWN_UNSUPPORTED) {
          assert.equal(o.status, 'unsupported', `${c}: expected a refusal, got ${JSON.stringify(o)}`);
        } else {
          assert.equal(o.status, 'match', `${c}: ${JSON.stringify(o)}`);
        }
      }
    });
  }

  it('matches every other probe on every payload', () => {
    const total = PASSING_CASES.length * probes.length;
    const matched = [...results.values()].reduce((n, m) => n + [...m.values()].filter((o) => o.status === 'match').length, 0);
    assert.equal(matched, total - PASSING_CASES.length * Object.keys(KNOWN_UNSUPPORTED).length);
  });
});

/**
 * Probe set D2 (tools/make-probe.ts): decimal arithmetic, precedence, truthiness,
 * equality, coercion, regex text, lazy if(). Same rule: match Make or refuse.
 */
const D2_UNSUPPORTED: Record<string, string> = {
  r_q2: 'replace with "/O/gi": Make changed nothing; why ("gi" unsupported, or treated as text) is unknown',
};

describe('probe set D2 replay', () => {
  const set = loadSet('D2-semantics');
  const results = runSet(set);
  for (const [key, a] of Object.entries(set.answers)) {
    it(`${key}: {{${a.expr}}} → ${a.value === undefined ? 'rejected by Make' : JSON.stringify(a.value)}`, () => {
      const o = results.get(key)!;
      assert.equal(o.status, key in D2_UNSUPPORTED ? 'unsupported' : 'match', JSON.stringify(o));
    });
  }
});

/**
 * Probe set D3: [] (reads the first element), and the `now` keyword. A probe whose answer
 * is a timestamp read the clock itself; the others use the instant n_text recorded (all
 * probes ran within a minute, on the same day).
 */
describe('probe set D3 replay ([] and now)', () => {
  const set = loadSet('D3-arrays-now');
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const base = Date.parse(set.answers['n_text']!.value!);
  const results = runSet(set, (key) => {
    const v = set.answers[key]!.value;
    return v !== undefined && iso.test(v) ? Date.parse(v) : base;
  });
  for (const [key, a] of Object.entries(set.answers)) {
    it(`${key}: {{${a.expr}}} → ${a.value === undefined ? `error ${a.error?.message}` : JSON.stringify(a.value)}`, () => {
      assert.equal(results.get(key)!.status, 'match', JSON.stringify(results.get(key)));
    });
  }
});

describe('Make errors reproduced word for word (corpus D-05, D-05b)', () => {
  it('contains() on a number', () => {
    assert.throws(() => evalProbe('contains(1.s; "ell")', payload('D-05-types-swapped')), (e: unknown) => e instanceof DataError && e.message === "Function 'contains' finished with error! array.indexOf is not a function");
  });

  it('first() on text', () => {
    assert.throws(() => evalProbe('first(1.arr)', payload('D-05b-types-swapped-s-string')), (e: unknown) => e instanceof DataError && e.message === "Function 'first' finished with error! 'notarray' is not a valid array.");
  });
});

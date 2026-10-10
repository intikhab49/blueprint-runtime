import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanTemplate } from '../src/expr/scan.ts';

const one = (s: string) => {
  const r = scanTemplate(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.exprs.length, 1);
  return r.exprs[0]!;
};

describe('scanTemplate', () => {
  it('finds expressions and their offsets in mixed text', () => {
    const r = scanTemplate('Hi {{1.name}}, you owe {{2.total * 2}}.');
    assert.deepEqual(r.exprs.map((e) => [e.text, e.start, e.end]), [['1.name', 3, 13], ['2.total * 2', 23, 38]]);
  });

  it('extracts module references with nested paths', () => {
    assert.deepEqual(one('{{1.people[2].name}}').refs, [{ moduleId: 1, path: 'people[2].name' }]);
    assert.deepEqual(one('{{4.`0`}}').refs, [{ moduleId: 4, path: '`0`' }]);
    assert.deepEqual(one('{{22.array[].name}}').refs, [{ moduleId: 22, path: 'array[].name' }]);
    assert.deepEqual(one('{{`22`}}').refs, [{ moduleId: 22, path: '' }]);
  });

  it('does not treat numbers as references', () => {
    assert.deepEqual(one('{{1.n - 0.5}}').refs, [{ moduleId: 1, path: 'n' }]);
    assert.deepEqual(one('{{0.1 + 0.2}}').refs, []);
  });

  it('lists functions, including nested calls', () => {
    assert.deepEqual(one('{{upper(substring(trim(1.pad); 0; 3))}}').functions, ['upper', 'substring', 'trim']);
  });

  it('ignores anything inside string literals', () => {
    const e = one('{{replace(1.s; "fake(2.x) }}"; "0")}}');
    assert.deepEqual(e.functions, ['replace']);
    assert.deepEqual(e.refs, [{ moduleId: 1, path: 's' }]);
  });

  it('separates keywords from bare words (bare words are not strings in Make, corpus D-01)', () => {
    const e = one('{{if(1.b; emptystring; o)}}');
    assert.deepEqual(e.keywords, ['emptystring']);
    assert.deepEqual(e.bareWords, ['o']);
    assert.deepEqual(one('{{replace(1.s; /o/g; "0")}}').bareWords, []);
  });

  it('reports unterminated expressions', () => {
    assert.match(scanTemplate('{{upper(1.s}}').errors[0]?.message ?? '', /Unclosed/);
    assert.match(scanTemplate('{{"abc}}').errors[0]?.message ?? '', /Unterminated string/);
    assert.match(scanTemplate('text {{1.a').errors[0]?.message ?? '', /Missing closing/);
  });
});

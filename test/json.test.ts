import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JsonParseError, parseJson } from '../src/json/parse.ts';

const parse = (s: string, depth = 64) => parseJson(s, depth).value;

function parseError(s: string, depth = 64): JsonParseError {
  try {
    parseJson(s, depth);
  } catch (e) {
    if (e instanceof JsonParseError) return e;
    throw e;
  }
  assert.fail(`expected a parse error for ${s}`);
}

describe('parseJson', () => {
  it('parses the same values as JSON.parse', () => {
    const samples = ['{"a":[1,-2.5,3e2,true,false,null,"x\\n\\u00e9"]}', '[]', '{}', '"s"', '0', '  {"nested":{"deep":[[{}]]}}  '];
    for (const s of samples) assert.deepEqual(JSON.parse(JSON.stringify(parse(s))), JSON.parse(s));
  });

  it('rejects duplicate keys, which JSON.parse silently accepts', () => {
    const e = parseError('{\n  "id": 1,\n  "id": 2\n}');
    assert.equal(e.code, 'JSON_DUPLICATE_KEY');
    assert.equal(e.pointer, '/id');
    assert.deepEqual([e.loc.line, e.loc.column], [3, 3]);
  });

  it('reports line and column for syntax errors', () => {
    const e = parseError('{\n  "a": 1,\n}');
    assert.equal(e.code, 'JSON_SYNTAX');
    assert.equal(e.loc.line, 3);
  });

  it('enforces the nesting limit', () => {
    assert.equal(parseError('[[[[1]]]]', 3).code, 'JSON_TOO_DEEP');
    assert.doesNotThrow(() => parseJson('[[[1]]]', 3));
  });

  it('rejects trailing data, comments, single quotes and bare control characters', () => {
    assert.equal(parseError('{} x').code, 'JSON_SYNTAX');
    assert.equal(parseError('{/* c */}').code, 'JSON_SYNTAX');
    assert.equal(parseError("{'a':1}").code, 'JSON_SYNTAX');
    assert.equal(parseError('"a\tb"').code, 'JSON_CONTROL_CHAR');
  });

  it('records where every value starts', () => {
    const p = parseJson('{\n "flow": [\n  {"id": 1}\n ]\n}', 64);
    assert.deepEqual(p.locatePointer('/flow/0/id'), { line: 3, column: 10, offset: 22 });
    assert.equal(p.locatePointer('/nope'), undefined);
  });

  it('keeps __proto__ as an ordinary key', () => {
    const v = parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    assert.deepEqual(Object.keys(v), ['__proto__']);
  });

  it('turns big integers into doubles, as Make does (corpus C-16)', () => {
    assert.equal(parse('9007199254740993'), 9007199254740992);
  });
});

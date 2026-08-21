import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJson, extractText } from '../src/llm.js';

test('extractJson parses a plain JSON object', () => {
    const out = extractJson('{"character":{"hp_current":4}}');
    assert.deepEqual(out, { character: { hp_current: 4 } });
});

test('extractJson strips markdown fences', () => {
    const out = extractJson('```json\n{"a":1}\n```');
    assert.deepEqual(out, { a: 1 });
});

test('extractJson finds JSON inside prose', () => {
    const out = extractJson('Here you go:\n{"create":[{"key":["goblin"],"content":"Green skins."}]}\nThat is all.');
    assert.deepEqual(out, { create: [{ key: ['goblin'], content: 'Green skins.' }] });
});

test('extractJson finds a nested array value', () => {
    const out = extractJson('Result: [1, 2, 3] thanks');
    assert.deepEqual(out, [1, 2, 3]);
});

test('extractJson returns null for non-JSON', () => {
    assert.equal(extractJson('no json here'), null);
    assert.equal(extractJson(''), null);
    assert.equal(extractJson(null), null);
});

test('extractJson tolerates trailing commas gracefully', () => {
    // Trailing commas are invalid JSON; extraction must not return a wrong value.
    const out = extractJson('{"a":1,}');
    assert.equal(out, null);
});

test('extractText handles string and object shapes', () => {
    assert.equal(extractText('plain'), 'plain');
    assert.equal(extractText({ content: 'obj' }), 'obj');
    assert.equal(extractText({ choices: [{ message: { content: 'choice' } }] }), 'choice');
    assert.equal(extractText(null), '');
});

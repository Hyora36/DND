import test from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32, parseFormula, rollFormula, rollMany, evaluateAgainstDC, rollDie } from '../src/dice.js';

test('mulberry32 is deterministic for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    assert.deepEqual(seqA, seqB);
    assert.ok(seqA.every((v) => v >= 0 && v < 1));
});

test('parseFormula handles plain dice, modifiers, and keep modifiers', () => {
    const basic = parseFormula('2d6+3');
    assert.equal(basic.groups.length, 1);
    assert.equal(basic.groups[0].count, 2);
    assert.equal(basic.groups[0].sides, 6);
    assert.deepEqual(basic.modifiers, [{ value: 3 }]);

    const adv = parseFormula('2d20kh1');
    assert.equal(adv.groups[0].keep, 1);
    assert.equal(adv.groups[0].keepLowest, false);

    const dis = parseFormula('2d20kl1');
    assert.equal(dis.groups[0].keep, 1);
    assert.equal(dis.groups[0].keepLowest, true);

    const complex = parseFormula('1d20+2d4-1');
    assert.equal(complex.groups.length, 2);
    assert.deepEqual(complex.modifiers, [{ value: -1 }]);

    const bare = parseFormula('d6');
    assert.equal(bare.groups[0].count, 1);
});

test('parseFormula rejects garbage', () => {
    assert.throws(() => parseFormula(''));
    assert.throws(() => parseFormula('banana'));
    assert.throws(() => parseFormula('2d6++3'));
    assert.throws(() => parseFormula('2d6kh5'));
    assert.throws(() => parseFormula('d0'));
});

test('rollFormula respects ranges and totals', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 50; i++) {
        const r = rollFormula('2d6+3', rng);
        assert.ok(r.total >= 5 && r.total <= 15, `total ${r.total} out of range`);
        assert.equal(r.groups[0].rolls.length, 2);
    }
});

test('keep highest drops the lower die (advantage)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 50; i++) {
        const r = rollFormula('2d20kh1', rng);
        assert.equal(r.groups[0].kept.length, 1);
        const [highest] = [...r.groups[0].rolls].sort((a, b) => b - a);
        assert.equal(r.total, highest);
    }
});

test('keep lowest drops the higher die (disadvantage)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 50; i++) {
        const r = rollFormula('2d20kl1', rng);
        assert.equal(r.groups[0].kept.length, 1);
        const [lowest] = [...r.groups[0].rolls].sort((a, b) => a - b);
        assert.equal(r.total, lowest);
    }
});

test('rollMany produces independent results with a shared seed', () => {
    const results = rollMany('1d20', 5, 1234);
    assert.equal(results.length, 5);
    const again = rollMany('1d20', 5, 1234);
    assert.deepEqual(results, again);
});

test('evaluateAgainstDC works for gte and lte', () => {
    assert.deepEqual(evaluateAgainstDC({ total: 15 }, 12, 'gte'), { success: true, label: 'SUCCESS' });
    assert.deepEqual(evaluateAgainstDC({ total: 11 }, 12, 'gte'), { success: false, label: 'FAILURE' });
    assert.deepEqual(evaluateAgainstDC({ total: 35 }, 35, 'lte'), { success: true, label: 'HIT/SUCCESS' });
    assert.deepEqual(evaluateAgainstDC({ total: 36 }, 35, 'lte'), { success: false, label: 'MISS/FAILURE' });
    assert.equal(evaluateAgainstDC({ total: 10 }, NaN), null);
});

test('rollDie rejects invalid sides', () => {
    assert.throws(() => rollDie(0, Math.random));
    assert.throws(() => rollDie(1.5, Math.random));
});

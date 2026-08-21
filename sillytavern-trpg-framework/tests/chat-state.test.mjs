import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createEmptyState,
    normalizeState,
    buildStateMemo,
    applyStatePatch,
    stateDiffers,
    rollRandomCharacter,
    isCombatActive,
    FIELD_LABELS,
} from '../src/chat-state.js';
import { mulberry32 } from '../src/dice.js';

test('createEmptyState returns a valid default sheet', () => {
    const s = createEmptyState();
    assert.equal(s.character.level, 1);
    assert.equal(s.character.hp_current, 10);
    assert.deepEqual(s.inventory, []);
});

test('normalizeState clamps numbers and coerces lists', () => {
    const s = normalizeState({
        character: { name: 'Aria', level: -3, hp_current: 999, hp_max: 10, temp_hp: -5, xp: 12.7, gold: '5' },
        inventory: ['  Sword  ', '', 'Shield'],
        buffs: [{ name: 'Poisoned', duration: '2 rounds' }, { name: '' }, 'junk'],
    });
    assert.equal(s.character.level, 1);
    assert.equal(s.character.hp_current, 10); // clamped to hp_max
    assert.equal(s.character.temp_hp, 0);
    assert.equal(s.character.xp, 12);
    assert.equal(s.character.gold, 5);
    assert.deepEqual(s.inventory, ['Sword', 'Shield']);
    assert.deepEqual(s.buffs, [{ name: 'Poisoned', duration: '2 rounds' }]);
});

test('buildStateMemo renders a readable sheet', () => {
    const s = normalizeState({
        character: { name: 'Bram', race: 'Dwarf', class: 'Fighter', level: 2, hp_current: 14, hp_max: 18, gold: 50 },
        inventory: ['Axe', 'Rations (5)'],
        spells: [],
        buffs: [{ name: 'Blessed', duration: '1 hour' }],
        notes: ['Met the tavern keeper.'],
    });
    const memo = buildStateMemo(s);
    assert.ok(memo.includes('Name: Bram'));
    assert.ok(memo.includes('HP: 14/18'));
    assert.ok(memo.includes('Axe'));
    assert.ok(memo.includes('- Blessed [1 hour]'));
    assert.ok(memo.includes('Met the tavern keeper.'));
});

test('applyStatePatch merges deltas and keeps untouched fields', () => {
    const base = normalizeState({
        character: { name: 'Aria', level: 1, hp_current: 10, hp_max: 10 },
        inventory: ['Dagger'],
    });
    const patched = applyStatePatch(base, {
        character: { hp_current: 4 },
        inventory: ['Dagger', 'Torch'],
        lastDelta: '-6 HP, +Torch',
    });
    assert.equal(patched.character.hp_current, 4);
    assert.equal(patched.character.name, 'Aria'); // untouched
    assert.deepEqual(patched.inventory, ['Dagger', 'Torch']);
    assert.equal(patched.lastDelta, '-6 HP, +Torch');
    assert.ok(patched.updatedAt);
});

test('stateDiffers detects real changes only', () => {
    const a = createEmptyState();
    const b = normalizeState({ ...a, character: { ...a.character, hp_current: 7 } });
    assert.ok(stateDiffers(a, b));
    assert.ok(!stateDiffers(a, normalizeState(a)));
});

test('rollRandomCharacter is deterministic with a seeded rng', () => {
    const rng = mulberry32(2026);
    const c1 = rollRandomCharacter('fantasy', rng);
    const rng2 = mulberry32(2026);
    const c2 = rollRandomCharacter('fantasy', rng2);
    assert.deepEqual(c1, c2);
    assert.ok(c1.character.name);
    assert.ok(c1.character.level >= 1);
    assert.ok(c1.character.hp_max > 0);
    assert.ok(c1.inventory.length >= 3);
});

test('isCombatActive detects the [COMBAT] marker', () => {
    assert.equal(isCombatActive('... [COMBAT] ...'), true);
    assert.equal(isCombatActive('... combat rages ...'), false);
    assert.equal(isCombatActive(''), false);
});

test('buildStateMemo renders the [COMBAT] marker from meta.combat', () => {
    const s = normalizeState(createEmptyState());
    const normal = buildStateMemo(s);
    assert.ok(!normal.includes('[COMBAT]'));
    const fighting = buildStateMemo({ ...s, meta: { combat: true } });
    assert.ok(fighting.includes('[COMBAT]'));
});

test('FIELD_LABELS covers all character fields', () => {
    for (const key of Object.keys(createEmptyState().character)) {
        assert.ok(FIELD_LABELS[key], `missing label for ${key}`);
    }
});


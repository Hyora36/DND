/**
 * chat-state.js — TRPG Framework
 * Per-chat RPG state model: character sheet schema, the plain-text "State Memo"
 * that gets injected into prompts, JSON delta patching, and a random character
 * generator. Pure logic — no SillyTavern imports — so it is unit-testable.
 */

/** Stable keys rendered in the State Memo (also used by the auto-tracker). */
export const CHARACTER_FIELDS = [
    'name',
    'race',
    'class',
    'level',
    'hp_current',
    'hp_max',
    'temp_hp',
    'xp',
    'gold',
];

/** Field labels shown in the memo / UI. */
export const FIELD_LABELS = {
    name: 'Name',
    race: 'Race',
    class: 'Class',
    level: 'Level',
    hp_current: 'HP',
    hp_max: 'Max HP',
    temp_hp: 'Temp HP',
    xp: 'XP',
    gold: 'Gold',
};

export function createEmptyState() {
    return {
        character: {
            name: '',
            race: '',
            class: '',
            level: 1,
            hp_current: 10,
            hp_max: 10,
            temp_hp: 0,
            xp: 0,
            gold: 0,
        },
        inventory: [],   // string[] — one item per line
        spells: [],      // string[] — spell slots / prepared spells
        buffs: [],       // { name, duration? }[]
        notes: [],
        updatedAt: null,
        lastDelta: '',
        meta: {},
    };
}

/**
 * Normalize a raw (possibly partial / user-edited) state object into a valid
 * state shape. Unknown keys are preserved in meta.
 * @param {object} raw
 */
export function normalizeState(raw) {
    const base = createEmptyState();
    if (!raw || typeof raw !== 'object') return base;

    const out = { ...base, ...raw };
    out.character = { ...base.character, ...(raw.character && typeof raw.character === 'object' ? raw.character : {}) };

    for (const key of ['inventory', 'spells', 'notes']) {
        out[key] = Array.isArray(raw[key])
            ? raw[key].map((v) => String(v ?? '').trim()).filter(Boolean)
            : [];
    }
    if (Array.isArray(raw.buffs)) {
        out.buffs = raw.buffs
            .filter((b) => b && typeof b === 'object')
            .map((b) => ({ name: String(b.name ?? '').trim(), duration: b.duration != null ? String(b.duration) : '' }))
            .filter((b) => b.name);
    } else {
        out.buffs = [];
    }

    // Numeric coercion for the mechanical fields.
    const numbers = ['level', 'hp_current', 'hp_max', 'temp_hp', 'xp', 'gold'];
    for (const key of numbers) {
        const v = Number(out.character[key]);
        out.character[key] = Number.isFinite(v) ? v : base.character[key];
    }
    out.character.level = Math.max(1, Math.floor(out.character.level || 1));
    out.character.hp_max = Math.max(1, Math.floor(out.character.hp_max || 1));
    out.character.hp_current = Math.max(0, Math.floor(out.character.hp_current || 0));
    out.character.temp_hp = Math.max(0, Math.floor(out.character.temp_hp || 0));
    out.character.xp = Math.max(0, Math.floor(out.character.xp || 0));
    out.character.gold = Math.max(0, Math.floor(out.character.gold || 0));

    for (const key of ['name', 'race', 'class']) {
        out.character[key] = String(out.character[key] ?? '').trim();
    }
    out.character.hp_current = Math.min(out.character.hp_current, out.character.hp_max + out.character.temp_hp);

    return out;
}

/** Format a list of plain strings as memo bullet lines (empty list -> placeholder). */
function listBlock(items, emptyText = '(none)') {
    if (!items || items.length === 0) return `- ${emptyText}`;
    return items.map((i) => `- ${i}`).join('\n');
}

/** Format buffs (objects) as memo bullet lines. */
function buffsBlock(buffs) {
    if (!buffs || buffs.length === 0) return '- (none)';
    return buffs
        .map((b) => (b.duration ? `- ${b.name} [${b.duration}]` : `- ${b.name}`))
        .join('\n');
}

/**
 * Render the character sheet as a plain-text State Memo block.
 * This exact text (minus HTML) is injected into outgoing prompts.
 * @param {object} state
 */
export function buildStateMemo(state) {
    const s = normalizeState(state);
    const c = s.character;
    const lines = [];

    // Combat marker — powers the [COMBAT] tag used by rngQueueOnlyInCombat and
    // the panel's combat badge.
    if (s.meta?.combat) lines.push('[COMBAT]');

    lines.push('## CHARACTER SHEET');
    lines.push(`Name: ${c.name || '(unnamed)'}`);
    lines.push(`Race: ${c.race || '—'}  |  Class: ${c.class || '—'}  |  Level: ${c.level}`);
    lines.push(`HP: ${c.hp_current}/${c.hp_max}${c.temp_hp > 0 ? ` (+${c.temp_hp} temp)` : ''}`);
    lines.push(`XP: ${c.xp}  |  Gold: ${c.gold}`);
    lines.push('');
    lines.push('### Inventory');
    lines.push(listBlock(s.inventory));
    lines.push('');
    lines.push('### Spells');
    lines.push(listBlock(s.spells, '(no spells known)'));
    lines.push('');
    lines.push('### Buffs & Conditions');
    lines.push(buffsBlock(s.buffs));
    if (s.notes && s.notes.length > 0) {
        lines.push('');
        lines.push('### Notes');
        lines.push(listBlock(s.notes));
    }

    return lines.join('\n');
}

/**
 * Merge a delta patch (from the auto-tracker LLM pass or manual edits) into the
 * state. Patch shape mirrors the state shape; only provided keys change.
 * Handles full-list replacement semantics for lists.
 * @param {object} state
 * @param {object} patch
 */
export function applyStatePatch(state, patch) {
    if (!patch || typeof patch !== 'object') return normalizeState(state);
    const merged = JSON.parse(JSON.stringify(normalizeState(state)));

    if (patch.character && typeof patch.character === 'object') {
        merged.character = { ...merged.character, ...patch.character };
    }
    for (const key of ['inventory', 'spells', 'notes']) {
        if (Array.isArray(patch[key])) merged[key] = patch[key];
    }
    if (Array.isArray(patch.buffs)) merged.buffs = patch.buffs;

    if (patch.meta && typeof patch.meta === 'object') {
        merged.meta = { ...merged.meta, ...patch.meta };
    }
    merged.updatedAt = new Date().toISOString();
    merged.lastDelta = typeof patch.lastDelta === 'string' ? patch.lastDelta : '';

    return normalizeState(merged);
}

/** Detect whether a patch actually changes anything (to skip no-op saves). */
export function stateDiffers(a, b) {
    return JSON.stringify(normalizeState(a)) !== JSON.stringify(normalizeState(b));
}

// ── Random character generator (pure, seeded) ────────────────────────────────

export const NAME_POOLS = {
    fantasy: ['Aelric', 'Bram', 'Cedric', 'Doran', 'Eldrin', 'Fenwick', 'Gareth', 'Halia', 'Isolde', 'Jorah', 'Kaelen', 'Lyra', 'Mira', 'Nyx', 'Orin', 'Phaedra', 'Rowan', 'Sable', 'Tamsin', 'Ulric', 'Vesper', 'Wren', 'Xander', 'Ysolde', 'Zephyr'],
    modern: ['Alex', 'Bailey', 'Casey', 'Dana', 'Elliot', 'Frankie', 'Grayson', 'Harper', 'Ivy', 'Jordan', 'Kai', 'Logan', 'Mason', 'Nora', 'Owen', 'Piper', 'Quinn', 'Riley', 'Sawyer', 'Tatum', 'Uma', 'Vaughn', 'Willow', 'Xavi', 'Yara', 'Zane'],
    scifi: ['Adara', 'Bex', 'Cort', 'Dax', 'Echo', 'Fenn', 'Gryphon', 'Havoc', 'Iona', 'Jett', 'Kestrel', 'Liora', 'Marlow', 'Nyx', 'Orion', 'Pax', 'Quasar', 'Rhea', 'Sable', 'Talon', 'Ursa', 'Vega', 'Wren', 'Xanthe', 'Yuri', 'Zed'],
};

export const RACE_POOLS = {
    fantasy: ['Human', 'Elf', 'Dwarf', 'Halfling', 'Half-Orc', 'Tiefling', 'Dragonborn', 'Gnome', 'Aasimar'],
    modern: ['Human', 'Android', 'Mutant', 'Synth', 'Cyborg'],
    scifi: ['Human', 'Vexari', 'Korathi', 'Synthex', 'Aurelian', 'Cyber-Human', 'Drone Pilot'],
};

export const CLASS_POOLS = {
    fantasy: ['Fighter', 'Rogue', 'Wizard', 'Cleric', 'Ranger', 'Paladin', 'Bard', 'Druid', 'Sorcerer', 'Warlock', 'Monk', 'Barbarian'],
    modern: ['Detective', 'Doctor', 'Journalist', 'Engineer', 'Soldier', 'Hacker', 'Professor', 'Fixer'],
    scifi: ['Starfarer', 'Engineer', 'Psi-Op', 'Mercenary', 'Navigator', 'Medic', 'Hacker', 'Xeno-Biologist'],
};

const FANTASY_GEAR = ['Dagger', 'Shortsword', 'Leather Armor', 'Torch', 'Rope (50 ft)', 'Rations (5)', 'Backpack', 'Healing Potion', 'Longbow', 'Shield', 'Spellbook', 'Thieves\' Tools'];
const MODERN_GEAR = ['Smartphone', 'Pocket Knife', 'First Aid Kit', 'Notebook', 'Flashlight', 'Credit Card', 'Laptop', 'Handcuffs', 'Camera', 'Water Bottle'];
const SCIFI_GEAR = ['Plasma Cutter', 'Med-Kit', 'Data Slate', 'Omni-Tool', 'Stun Baton', 'Ration Packs', 'Vac Suit Patch Kit', 'Trail Beacon', 'Scanner Goggles'];

export const GENRES = ['fantasy', 'modern', 'scifi'];

/**
 * Generate a complete random character using a seeded RNG.
 * @param {string} [genre]
 * @param {() => number} [rng]
 */
export function rollRandomCharacter(genre = 'fantasy', rng = Math.random) {
    const g = GENRES.includes(genre) ? genre : 'fantasy';
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const rollStat = () => 8 + Math.floor(rng() * 11); // 8..18
    const level = 1 + Math.floor(rng() * 5); // 1..5

    const race = pick(RACE_POOLS[g]);
    const klass = pick(CLASS_POOLS[g]);
    const name = pick(NAME_POOLS[g]);
    const gearPool = g === 'fantasy' ? FANTASY_GEAR : (g === 'modern' ? MODERN_GEAR : SCIFI_GEAR);
    const gearCount = 3 + Math.floor(rng() * 3);
    const gear = [];
    for (let i = 0; i < gearCount; i++) gear.push(pick(gearPool));

    const hpMax = 8 + Math.floor(rng() * 8) + level; // crude hit-die approximation
    return normalizeState({
        character: {
            name,
            race,
            class: klass,
            level,
            hp_current: hpMax,
            hp_max: hpMax,
            temp_hp: 0,
            xp: 0,
            gold: 10 + Math.floor(rng() * 90),
        },
        inventory: gear,
        spells: g === 'fantasy' ? [`Cantrips (2)`, `Level 1 slots (${Math.max(1, Math.floor(level / 2))})`] : [],
        buffs: [],
        notes: [`Randomly generated ${g} character`, `Stats: STR ${rollStat()} DEX ${rollStat()} CON ${rollStat()} INT ${rollStat()} WIS ${rollStat()} CHA ${rollStat()}`],
    });
}

/** True while the memo carries the [COMBAT] marker (set by the tracker LLM). */
export function isCombatActive(memo) {
    return typeof memo === 'string' && /\[COMBAT\]/i.test(memo);
}


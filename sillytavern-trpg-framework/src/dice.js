/**
 * dice.js — TRPG Framework
 * Pure tabletop dice engine. No browser or SillyTavern dependencies, so it can
 * be unit-tested standalone and shared between the slash command, the function
 * tool, and the deterministic RNG queue.
 *
 * Supported formula grammar (case-insensitive):
 *   <expr>    := <term> (('+'|'-') <term>)*
 *   <term>    := <diceGroup> | <number>
 *   <diceGroup> := <count>? 'd' <sides> <keep>?
 *   <keep>    := 'kh' <count> | 'kl' <count>   (keep highest / keep lowest)
 *
 * Examples: "1d20", "2d6+3", "1d20+2d4-1", "3d6", "2d20kh1" (advantage),
 *           "2d20kl1" (disadvantage), "1d100", "d6", "4d6kh3".
 */

/**
 * Deterministic 32-bit PRNG (mulberry32). Returns a function yielding floats in
 * [0, 1). Used for the pre-seeded RNG queue so dice are reproducible.
 * @param {number} seed
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Roll a single die of the given side count using the provided RNG function.
 * @param {number} sides
 * @param {() => number} rng
 */
export function rollDie(sides, rng) {
    if (!Number.isInteger(sides) || sides < 1) throw new Error(`Invalid die sides: ${sides}`);
    return Math.floor(rng() * sides) + 1;
}

/**
 * Parse a dice formula into a structured description.
 * Throws a descriptive Error on malformed input.
 * @param {string} formula
 * @returns {{ groups: Array<{count:number,sides:number,keep:number|null,keepLowest:boolean}>, modifiers: Array<number> }}
 */
export function parseFormula(formula) {
    if (typeof formula !== 'string') throw new Error('Dice formula must be a string.');
    const cleaned = formula.replace(/\s+/g, '').toLowerCase();
    if (!cleaned) throw new Error('Empty dice formula.');

    // Split into + / - separated terms, keeping the operator sign.
    const tokens = cleaned.split(/([+-])/).filter(Boolean);
    if (tokens[0] === '+' || tokens[0] === '-') {
        throw new Error(`Formula cannot start with "${tokens[0]}".`);
    }

    const groups = [];
    const modifiers = [];
    let sign = 1;
    let lastWasOperator = false;

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok === '+' || tok === '-') {
            if (lastWasOperator || i === 0) throw new Error(`Unexpected operator "${tok}" in formula.`);
            sign = tok === '+' ? 1 : -1;
            lastWasOperator = true;
            continue;
        }
        lastWasOperator = false;

        const diceMatch = tok.match(/^(\d+)?d(\d+)(kh(\d+)|kl(\d+))?$/);
        if (diceMatch) {
            const count = diceMatch[1] ? parseInt(diceMatch[1], 10) : 1;
            const sides = parseInt(diceMatch[2], 10);
            const keepHigh = diceMatch[4] ? parseInt(diceMatch[4], 10) : null;
            const keepLow = diceMatch[5] ? parseInt(diceMatch[5], 10) : null;
            if (count < 1 || count > 1000) throw new Error(`Die count out of range in "${tok}".`);
            if (sides < 1 || sides > 100000) throw new Error(`Die sides out of range in "${tok}".`);
            const keep = keepHigh ?? keepLow;
            if (keep !== null && (keep < 1 || keep > count)) {
                throw new Error(`Keep count for "${tok}" must be between 1 and ${count}.`);
            }
            groups.push({
                count,
                sides,
                sign,
                keep,
                keepLowest: keepLow !== null,
            });
            sign = 1;
            continue;
        }

        if (/^\d+$/.test(tok)) {
            modifiers.push({ value: parseInt(tok, 10) * sign });
            sign = 1;
            continue;
        }

        throw new Error(`Unrecognized dice term "${tok}".`);
    }

    if (lastWasOperator) throw new Error('Formula ends with an operator.');
    if (groups.length === 0 && modifiers.length === 0) {
        throw new Error('Formula contains no dice or modifiers.');
    }
    return { groups, modifiers };
}

/**
 * Roll a formula and produce a full result object.
 * @param {string} formula
 * @param {() => number} [rng] defaults to Math.random
 * @returns {{ formula:string, total:number, groups:Array<object>, modifiers:Array<number>, breakdown:string }}
 */
export function rollFormula(formula, rng = Math.random) {
    const { groups, modifiers } = parseFormula(formula);
    const groupResults = groups.map((g) => {
        const rolls = [];
        for (let i = 0; i < g.count; i++) rolls.push(rollDie(g.sides, rng));
        let kept = rolls;
        if (g.keep !== null) {
            kept = [...rolls].sort((a, b) => g.keepLowest ? a - b : b - a).slice(0, g.keep);
        }
        const subtotal = kept.reduce((acc, r) => acc + r, 0) * g.sign;
        return {
            ...g,
            rolls,
            kept,
            subtotal,
            dropped: g.keep !== null ? rolls.length - kept.length : 0,
        };
    });

    const modifierTotal = modifiers.reduce((acc, m) => acc + m.value, 0);
    const total = groupResults.reduce((acc, g) => acc + g.subtotal, 0) + modifierTotal;

    // Human-readable breakdown, e.g. "2d6+3 = [4,2]+3 = 9"
    const parts = [];
    for (const g of groupResults) {
        const label = `${g.count}d${g.sides}${g.keep !== null ? (g.keepLowest ? 'kl' : 'kh') + g.keep : ''}`;
        const shown = g.keep !== null ? `[${g.kept.join(',')}]` : `[${g.rolls.join(',')}]`;
        parts.push(`${label}${shown}`);
    }
    for (const m of modifiers) {
        parts.push(`${m.value >= 0 ? '+' : ''}${m.value}`);
    }

    return {
        formula: formula.trim(),
        total,
        groups: groupResults,
        modifiers,
        breakdown: parts.join(' '),
    };
}

/**
 * Roll several independent copies of the same formula (used for the RNG queue).
 * @param {string} formula
 * @param {number} count
 * @param {number} [seed]
 */
export function rollMany(formula, count, seed = Date.now()) {
    const rng = mulberry32(seed);
    const results = [];
    for (let i = 0; i < count; i++) results.push(rollFormula(formula, rng));
    return results;
}

/**
 * Simple human-readable check summary: does this roll beat the DC?
 * @param {{total:number}} result
 * @param {number} dc
 * @param {'gte'|'lte'} [compare]
 */
export function evaluateAgainstDC(result, dc, compare = 'gte') {
    if (typeof dc !== 'number' || !Number.isFinite(dc)) return null;
    if (compare === 'lte') {
        return { success: result.total <= dc, label: result.total <= dc ? 'HIT/SUCCESS' : 'MISS/FAILURE' };
    }
    return { success: result.total >= dc, label: result.total >= dc ? 'SUCCESS' : 'FAILURE' };
}


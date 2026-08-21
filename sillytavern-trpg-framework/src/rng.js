/**
 * rng.js — TRPG Framework
 * Hybrid RNG system.
 *
 * 1. RNG Queue — a deterministic, pre-seeded list of dice results injected into
 *    every outgoing prompt. Cheap, smooth for combat sequences, reproducible.
 * 2. Function Tool — a roll_dice tool the narrator can call, which commits to a
 *    DC *before* seeing the result (anti-sycophancy).
 * 3. /roll slash command — for the player to roll dice in chat.
 */

import { mulberry32, rollFormula, evaluateAgainstDC, parseFormula } from './dice.js';
import { getSettings, saveSettings, getChatState, getActiveChatId } from './settings.js';
import { isCombatActive } from './chat-state.js';

export const RNG_QUEUE_BLOCK_OPEN = '<rng_queue>';
export const RNG_QUEUE_BLOCK_CLOSE = '</rng_queue>';

/**
 * Deterministic dice queue. The seed is stored in settings so consecutive
 * turns consume from a stable stream (until a new seed is generated).
 * @param {number} count
 * @param {boolean} d100
 * @returns {Array<{roll:number, formula:string}>}
 */
export function makeRngQueue(count, d100 = false) {
    const settings = getSettings();
    const seed = Number(settings.rngSeed) || 1;
    const rng = mulberry32(seed);
    const formula = d100 ? '1d100' : '1d20';
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push({ roll: rollFormula(formula, rng).total, formula });
    }
    // Rotate the seed so the next queue differs.
    settings.rngSeed = (seed + 0x9E3779B9) >>> 0;
    saveSettings(settings);
    return out;
}

/** Plain-text RNG queue block for prompt injection. */
export function buildRngQueueBlock() {
    const settings = getSettings();
    if (!settings.rngEnabled) return '';
    const parts = [];
    if (settings.rngQueueD20) {
        const queue = makeRngQueue(Math.max(1, Number(settings.rngQueueLength) || 5), false);
        parts.push(`${RNG_QUEUE_BLOCK_OPEN} d20 queue: ${queue.map((q) => q.roll).join(', ')} ${RNG_QUEUE_BLOCK_CLOSE}`);
    }
    if (settings.rngQueueD100) {
        const queue = makeRngQueue(30, true);
        parts.push(`${RNG_QUEUE_BLOCK_OPEN} d100 queue: ${queue.map((q) => q.roll).join(', ')} ${RNG_QUEUE_BLOCK_CLOSE}`);
    }
    return parts.join('\n');
}

/** Should the deterministic queue be injected for this turn? */
export function shouldInjectQueue() {
    const settings = getSettings();
    if (!settings.rngEnabled) return false;
    if (!settings.diceFunctionTool) return true;               // queue-only mode
    if (!settings.rngQueueOnlyInCombat) return true;           // always inject
    const chatId = getActiveChatId();
    const state = chatId ? getChatState(chatId) : null;
    return isCombatActive(state?.memo || '');
}

// ── /roll slash command ───────────────────────────────────────────────────────

/**
 * Register the /roll slash command (and alias /dice).
 * Uses the modern SlashCommand API; falls back to registerSlashCommand on
 * older builds.
 */
export function registerDiceSlashCommand() {
    const ctx = getContextSafe();
    if (!ctx) return;

    const roll = async (args, value) => {
        const quiet = String(args.quiet) === 'true';
        const formula = String(value || '').trim() || '1d20';
        let result;
        try {
            result = rollFormula(formula);
        } catch (error) {
            if (typeof toastr !== 'undefined') toastr.warning(String(error.message), 'Dice');
            return `Invalid dice formula "${formula}".`;
        }
        const line = `🎲 **${formula}** → ${result.total} (${result.breakdown})`;
        if (quiet) return '';
        return line;
    };

    const { SlashCommand, SlashCommandParser, ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } = ctx;
    if (SlashCommand?.fromProps && SlashCommandParser?.addCommandObject) {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'roll',
            aliases: ['dice', 'r'],
            callback: roll,
            helpString: 'Roll dice. Example: /roll 2d6+3, /roll 1d20, /roll 2d20kh1',
            returns: 'roll result',
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'quiet',
                    description: 'Do not display the result in chat',
                    isRequired: false,
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    defaultValue: 'false',
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'dice formula, e.g. 2d6',
                    isRequired: true,
                    typeList: [ARGUMENT_TYPE.STRING],
                }),
            ],
        }));
    } else if (typeof ctx.registerSlashCommand === 'function') {
        ctx.registerSlashCommand('roll', roll, ['dice', 'r'], 'Roll dice. Example: /roll 2d6+3');
    }
}

// ── roll_dice function tool ───────────────────────────────────────────────────

const DICE_TOOL_NAME = 'roll_dice';

/** Register the narrator's dice tool. Safe to call repeatedly (re-registers). */
export function registerDiceTool() {
    const ctx = getContextSafe();
    if (!ctx?.registerFunctionTool || !ctx.unregisterFunctionTool) return;
    unregisterDiceTool();

    ctx.registerFunctionTool({
        name: DICE_TOOL_NAME,
        displayName: 'Roll Dice (with DC)',
        description: 'Rolls dice using a formula (e.g. "1d20+3", "2d6", "1d100", "2d20kh1") and returns the numeric result. Use for skill checks, attacks and saves by declaring the DC BEFORE the roll. Pass compare "gte" for roll >= DC = SUCCESS (default for d20), or "lte" for percentage/existence checks where roll <= DC% = HIT (default for 1d100).',
        parameters: {
            type: 'object',
            properties: {
                who: { type: 'string', description: 'The name of the character rolling' },
                for: { type: 'string', description: 'What the roll is for, 1-3 words' },
                formula: { type: 'string', description: 'A single dice formula, e.g. "1d20+3", "2d6", "1d100", "2d20kh1". One formula per call.' },
                dc: { type: 'number', description: 'The target number. For compare gte: roll >= dc = SUCCESS. For compare lte: roll <= dc = HIT.' },
                compare: { type: 'string', description: 'Optional: "gte" (default) or "lte".' },
            },
            required: ['who', 'for', 'formula', 'dc'],
        },
        action: async (args) => diceToolAction(args),
        formatMessage: () => '',
    });
}

/** Remove the narrator's dice tool. */
export function unregisterDiceTool() {
    const ctx = getContextSafe();
    if (ctx?.unregisterFunctionTool) {
        try { ctx.unregisterFunctionTool(DICE_TOOL_NAME); } catch { /* not registered */ }
    }
}

async function diceToolAction(args) {
    const who = String(args?.who || 'the character').trim();
    const what = String(args?.for || 'check').trim();
    const formula = String(args?.formula || '1d20').trim();
    const dc = Number(args?.dc);
    const compare = String(args?.compare || '').toLowerCase() === 'lte' ? 'lte' : 'gte';

    let result;
    try {
        result = rollFormula(formula);
    } catch (error) {
        return `Invalid dice formula "${formula}": ${error.message}`;
    }

    let suffix = '';
    if (Number.isFinite(dc)) {
        const verdict = evaluateAgainstDC(result, dc, compare);
        if (verdict) suffix = ` (DC ${dc} ${compare} → **${verdict.label}**)`;
    }
    const rollsText = result.groups.map((g) => {
        const label = `${g.count}d${g.sides}${g.keep !== null ? (g.keepLowest ? 'kl' : 'kh') + g.keep : ''}`;
        const shown = g.keep !== null ? `[${g.kept.join(',')}]` : `[${g.rolls.join(',')}]`;
        return `${label}${shown}`;
    }).join(' ');
    return `🎲 ${who} rolls ${formula} for ${what}: **${result.total}** (${rollsText})${suffix}`;
}

/** Make sure the dice tool presence matches the settings toggle. */
export function syncDiceTool() {
    const settings = getSettings();
    if (settings.enabled && settings.rngEnabled && settings.diceFunctionTool) {
        registerDiceTool();
    } else {
        unregisterDiceTool();
    }
}

/** Validate a formula without rolling (used by tests/UI). */
export function isValidFormula(formula) {
    try {
        parseFormula(formula);
        return true;
    } catch {
        return false;
    }
}

function getContextSafe() {
    try {
        return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    } catch {
        return null;
    }
}



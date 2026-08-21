/**
 * tracker.js — TRPG Framework
 * RPG State Tracker: a quiet second-pass LLM call that reads the latest
 * assistant narrative, compares it to the current State Memo, and returns a
 * JSON delta patch (HP, inventory, XP, conditions, [COMBAT] flag, ...) which is
 * merged into the per-chat state. This is the "auto-tracking" brain.
 */

import { generate, extractJson } from './llm.js';
import {
    getSettings,
    getChatState,
    saveChatState,
    getActiveChatId,
} from './settings.js';
import { buildStateMemo, applyStatePatch, stateDiffers } from './chat-state.js';

/** System prompt used for the tracker pass (override via settings). */
export function buildTrackerSystemPrompt() {
    return `You are the State Tracker of a tabletop RPG campaign running inside SillyTavern.
Your only job is to keep the player's mechanical game state accurate and current based on
the latest story narrative. You NEVER write prose. You NEVER invent events. You only report
what the narrative explicitly establishes, plus the most conservative reasonable inference.

Rules:
- Update a field only when the narrative (or the previous memo) supports the change.
- HP decreases when damage is taken; increases when healing happens; never exceeds max HP.
- Add inventory items when loot is gained; remove them when spent/consumed.
- Track gold, XP and level-ups exactly as described.
- If combat is ongoing, include "meta.combat": true; when combat ends, "meta.combat": false.
- Keep spell slots, buffs/conditions and their remaining duration.
- Preserve all fields you do NOT change.

Respond with ONLY a single JSON object. Use this shape:
{
  "character": { "name": "...", "race": "...", "class": "...", "level": 1, "hp_current": 10, "hp_max": 10, "temp_hp": 0, "xp": 0, "gold": 0 },
  "inventory": ["item 1", "item 2"],
  "spells": ["spell slot line 1"],
  "buffs": [{ "name": "Poisoned", "duration": "2 rounds" }],
  "notes": ["freeform note"],
  "meta": { "combat": false },
  "lastDelta": "one-line summary of what changed, e.g. '-12 HP, +3 gold, added Shortsword'"
}
Include every list in FULL (lists are replaced, not merged). Omit nothing from the lists you keep.`;
}

/** Build the user prompt for a tracker run. */
export function buildTrackerUserPrompt(memo, narrative, lastUserText) {
    const parts = [];
    parts.push('### CURRENT STATE MEMO (source of truth, from previous turn)');
    parts.push(memo || '(empty — no character sheet yet; if the narrative establishes one, create it)');
    if (lastUserText) {
        parts.push('');
        parts.push('### LAST PLAYER ACTION');
        parts.push(lastUserText);
    }
    parts.push('');
    parts.push('### LATEST NARRATIVE TO PROCESS');
    parts.push(narrative || '(no narrative)');
    parts.push('');
    parts.push('Output the updated full state as a single JSON object. Nothing else.');
    return parts.join('\n');
}

/** Text of the most recent assistant (non-user, non-system) message. */
export function getLastAssistantText() {
    const ctx = getContextSafe();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return '';
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m) continue;
        const isUser = m.is_user || String(m.role || '').toLowerCase() === 'user';
        const isSystem = m.is_system || String(m.role || '').toLowerCase() === 'system';
        if (!isUser && !isSystem) {
            return String(m.mes || m.content || '');
        }
    }
    return '';
}

/** Text of the most recent user message (for context). */
export function getLastUserText() {
    const ctx = getContextSafe();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return '';
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m) continue;
        const isUser = m.is_user || String(m.role || '').toLowerCase() === 'user';
        if (isUser) return String(m.mes || m.content || '');
    }
    return '';
}

/**
 * Run one State Tracker pass over the latest assistant message.
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, changed:boolean, reason?:string, summary?:string}>}
 */
export async function runStateTrackerPass(opts = {}) {
    const settings = getSettings();
    const chatId = getActiveChatId();
    if (!chatId) return { ok: false, changed: false, reason: 'no_active_chat' };
    if (!settings.enabled || !settings.trackerEnabled) return { ok: false, changed: false, reason: 'tracker_disabled' };

    const state = getChatState(chatId);
    if (!state) return { ok: false, changed: false, reason: 'no_state' };

    // Throttle: run every N assistant turns unless forced.
    const runEvery = Math.max(1, Number(settings.trackerRunEvery) || 1);
    state.trackerTurnsSinceRun = Number(state.trackerTurnsSinceRun) || 0;
    if (!opts.force && state.trackerTurnsSinceRun < runEvery - 1) {
        state.trackerTurnsSinceRun += 1;
        saveChatState(chatId);
        return { ok: false, changed: false, reason: 'throttled', summary: `${state.trackerTurnsSinceRun}/${runEvery}` };
    }

    const narrative = getLastAssistantText();
    if (!narrative) return { ok: false, changed: false, reason: 'no_narrative' };

    const memo = state.memo || '';
    const userPrompt = buildTrackerUserPrompt(memo, narrative, getLastUserText());
    const systemPrompt = settings.trackerSystemPrompt?.trim() || buildTrackerSystemPrompt();

    let text;
    try {
        text = await generate(systemPrompt, userPrompt, {
            maxTokens: Number(settings.trackerMaxTokens) || 512,
        });
    } catch (error) {
        console.warn('[TRPG] State Tracker pass failed:', error);
        state.trackerTurnsSinceRun = 0;
        saveChatState(chatId);
        return { ok: false, changed: false, reason: 'llm_error', summary: String(error?.message || error) };
    }

    const patch = extractJson(text);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        console.warn('[TRPG] State Tracker returned unparseable output:', text.slice(0, 300));
        state.trackerTurnsSinceRun = 0;
        saveChatState(chatId);
        return { ok: false, changed: false, reason: 'parse_error' };
    }

    const before = state.memo;
    const sheet = applyStatePatch(state, patch);
    state.trackerTurnsSinceRun = 0;
    if (!before || stateDiffers(state, sheet)) {
        // Store in the canonical sheet shape (character at top level).
        state.character = sheet.character;
        state.inventory = sheet.inventory;
        state.spells = sheet.spells;
        state.buffs = sheet.buffs;
        state.notes = sheet.notes;
        state.meta = { ...(state.meta || {}), ...(sheet.meta || {}) };
        state.memo = buildStateMemo(sheet);
        state.updatedAt = new Date().toISOString();
        saveChatState(chatId);
        return { ok: true, changed: true, summary: patch.lastDelta || 'state updated' };
    }

    saveChatState(chatId);
    return { ok: true, changed: false, summary: patch.lastDelta || 'no change' };
}

function getContextSafe() {
    try {
        return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    } catch {
        return null;
    }
}



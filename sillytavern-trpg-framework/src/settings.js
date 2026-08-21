/**
 * settings.js — TRPG Framework
 * Extension settings access, persistence, and per-chat RPG state storage.
 *
 * Settings live in SillyTavern's extension_settings under the "trpg_framework"
 * key and are persisted with saveSettingsDebounced(). Per-chat campaign state
 * (character sheet + memo) lives in settings.chatStates[chatId] so switching
 * chats loads the right campaign without touching chat_metadata.
 */

export const EXTENSION_KEY = 'trpg_framework';
export const MEMO_PROMPT_NAME = 'trpg_framework_memo';
export const LORE_PROMPT_NAME = 'trpg_framework_lore';

export const DEFAULT_SETTINGS = Object.freeze({
    // Master switches
    enabled: true,
    debugMode: false,

    // State Tracker
    trackerEnabled: true,
    trackerRunEvery: 1,          // run the LLM state pass every N assistant turns
    trackerSystemPrompt: '',     // empty -> built-in prompt
    trackerMaxTokens: 512,

    // Prompt injection
    memoInjection: true,         // inject the State Memo into every outgoing prompt
    memoInjectionPosition: 1,    // ST extension_prompt_types: 1 = IN_CHAT, 2 = BEFORE_PROMPT, 0 = IN_PROMPT, -1 = NONE

    // Hybrid RNG
    rngEnabled: true,
    rngQueueD20: true,           // deterministic d20 queue injected per turn
    rngQueueD100: false,
    rngQueueLength: 5,
    diceFunctionTool: true,      // register the roll_dice tool for the narrator
    rngQueueOnlyInCombat: false, // inject queue only while [COMBAT] is active

    // Lorebook Agent
    lorebookEnabled: true,
    lorebookRunEvery: 4,         // run the lore pass every N assistant turns
    lorebookBookName: '',        // empty -> "<sanitized chat name>_lore"
    lorebookMaxTokens: 1024,

    // World Progression (lightweight, prompt-only)
    worldProgressionEnabled: false,
    worldTimeScale: 3, // in-world minutes that pass per real minute of play

    // Per-chat campaign state
    chatStates: {},
    rngSeed: Date.now() >>> 0,
});

/** Merge saved settings over defaults (deep enough for chatStates). */
export function getSettings() {
    const ctx = getContextSafe();
    const saved = ctx?.extensionSettings?.[EXTENSION_KEY] || {};
    const merged = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (saved[key] !== undefined) merged[key] = saved[key];
    }
    if (!merged.chatStates || typeof merged.chatStates !== 'object') merged.chatStates = {};
    return merged;
}

/**
 * Persist settings. Pass the (possibly mutated) settings object explicitly —
 * getSettings() returns a fresh merged copy, so mutations made on it must be
 * handed back here or they would be lost.
 * @param {object} [settings]
 */
export function saveSettings(settings) {
    const ctx = getContextSafe();
    if (!ctx) return;
    const merged = settings || getSettings();
    ctx.extensionSettings[EXTENSION_KEY] = merged;
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    else if (typeof ctx.saveSettings === 'function') ctx.saveSettings();
}

/** Patch a subset of settings and persist. */
export function updateSettings(patch) {
    const ctx = getContextSafe();
    if (!ctx) return getSettings();
    const current = getSettings();
    const merged = { ...current, ...patch, chatStates: current.chatStates };
    ctx.extensionSettings[EXTENSION_KEY] = merged;
    saveSettings(merged);
    return merged;
}

/** Current chat id, tolerating older ST builds. */
export function getActiveChatId() {
    const ctx = getContextSafe();
    return ctx?.chatId || ctx?.getCurrentChatId?.() || null;
}

/** Per-chat campaign state (memo + character sheet). */
export function getChatState(chatId = getActiveChatId()) {
    if (!chatId) return null;
    const s = getSettings();
    if (!s.chatStates[chatId]) {
        s.chatStates[chatId] = { memo: '', createdAt: new Date().toISOString() };
        saveSettings();
    }
    return s.chatStates[chatId];
}

/** Persist the current chat's state object. */
export function saveChatState(chatId = getActiveChatId()) {
    if (!chatId) return;
    const s = getSettings();
    if (s.chatStates[chatId]) saveSettings();
}

/** Remove the stored state for a chat (used when a chat is deleted). */
export function deleteChatState(chatId) {
    const ctx = getContextSafe();
    if (!ctx || !chatId) return;
    const s = getSettings();
    delete s.chatStates[chatId];
    ctx.extensionSettings[EXTENSION_KEY] = s;
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

function getContextSafe() {
    try {
        return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    } catch {
        return null;
    }
}





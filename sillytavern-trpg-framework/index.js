/**
 * index.js — TRPG Framework
 * SillyTavern third-party extension entry point.
 *
 * Registers:
 *  - the manifest generate_interceptor (global rpgTrackerInterceptor)
 *  - the /roll slash command and roll_dice function tool (Hybrid RNG)
 *  - the floating RPG panel + extension settings UI
 *  - background LLM passes: State Tracker + Lorebook Agent (after generation)
 */

import { DEFAULT_SETTINGS, EXTENSION_KEY, getSettings, getActiveChatId, deleteChatState } from './src/settings.js';
import { createPanel, createSettingsUI, onChatChanged, refreshAfterPass } from './src/ui.js';
import { registerDiceSlashCommand, syncDiceTool } from './src/rng.js';
import { rpgTrackerInterceptor, syncMemoPromptRegistration } from './src/interceptor.js';
import { runStateTrackerPass } from './src/tracker.js';
import { runLorebookAgentPass } from './src/lorebook.js';

// The manifest "generate_interceptor" field tells SillyTavern to call this
// global by name before prompts are combined.
globalThis.rpgTrackerInterceptor = rpgTrackerInterceptor;

jQuery(async () => {
    try {
        initializeSettings();
        registerDiceSlashCommand();
        syncDiceTool();
        createPanel();
        createSettingsUI();
        registerEventHandlers();
        syncMemoPromptRegistration();

        if (getSettings().debugMode) {
            console.log('[TRPG] TRPG Framework loaded.');
        }
    } catch (error) {
        console.error('[TRPG] Failed to initialize:', error);
    }
});

/** Seed default settings on first run. */
function initializeSettings() {
    const ctx = getContextSafe();
    if (!ctx) return;
    if (!ctx.extensionSettings[EXTENSION_KEY]) {
        ctx.extensionSettings[EXTENSION_KEY] = { ...DEFAULT_SETTINGS };
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    }
}

function registerEventHandlers() {
    const ctx = getContextSafe();
    if (!ctx?.eventSource || !ctx.event_types) return;
    const { eventSource, event_types } = ctx;

    // After the narrator finishes (or generation is stopped), run the
    // background maintenance passes sequentially. Both are internally
    // throttled, and each uses its own quiet generateRaw call.
    const onGenerationEnded = async () => {
        if (!getSettings().enabled) return;
        const chatId = getActiveChatId();
        if (!chatId) return;

        if (getSettings().trackerEnabled) {
            await runStateTrackerPass().catch(() => { });
            refreshAfterPass();
        }
        if (getSettings().lorebookEnabled) {
            await runLorebookAgentPass().catch(() => { });
        }
    };

    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationEnded);

    // Re-sync the extension prompt when the chat changes or a message is sent.
    eventSource.on(event_types.CHAT_CHANGED, () => onChatChanged());
    eventSource.on(event_types.MESSAGE_SENT, () => syncMemoPromptRegistration());
    eventSource.on(event_types.MESSAGE_RECEIVED, () => syncMemoPromptRegistration());

    // Drop per-chat state when a chat is deleted.
    if (typeof eventSource.on === 'function' && event_types.CHAT_DELETED) {
        eventSource.on(event_types.CHAT_DELETED, (chatId) => {
            if (chatId) deleteChatState(chatId);
        });
    }

    // Re-register the dice tool when settings are reloaded elsewhere.
    eventSource.on(event_types.SETTINGS_LOADED, () => {
        syncDiceTool();
        syncMemoPromptRegistration();
    });
}

function getContextSafe() {
    try {
        return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    } catch {
        return null;
    }
}


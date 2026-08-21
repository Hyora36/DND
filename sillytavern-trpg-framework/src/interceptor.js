/**
 * interceptor.js — TRPG Framework
 * The manifest generate_interceptor ("rpgTrackerInterceptor"). SillyTavern calls
 * the global function with the working chat array before prompts are combined.
 * We prepend the RNG queue + State Memo (+ optional world clock) to the current
 * user input so the narrator always sees mechanical truth before writing.
 */

import { buildRngQueueBlock, shouldInjectQueue } from './rng.js';
import { getSettings, getChatState, saveChatState, getActiveChatId, MEMO_PROMPT_NAME } from './settings.js';
import { isCombatActive } from './chat-state.js';

export const STATE_MEMO_PREAMBLE = '<state_memo>';
export const STATE_MEMO_CLOSE = '</state_memo>';

/**
 * Global interceptor assigned by index.js at boot.
 * Signature matches SillyTavern's generate_interceptor contract.
 */
export async function rpgTrackerInterceptor(chat, contextSize, abort, type) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        const msg = findCurrentUserMessage(chat);
        if (!msg) return;

        const core = buildCoreInjection(settings);
        if (!core) return;

        prependToMessage(msg, core);
    } catch (error) {
        console.warn('[TRPG] Interceptor error:', error);
    }
}

/** Find the last user message in the working chat array. */
function findCurrentUserMessage(chat) {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m) continue;
        const isUser = m.is_user || ['user', 'human', 'player'].includes(String(m.role || '').toLowerCase());
        if (isUser) return m;
    }
    return null;
}

/** Build the core injection text (RNG + clock + memo). */
export function buildCoreInjection(settings, state) {
    const parts = [];

    // 1. RNG queue (deterministic dice).
    if (shouldInjectQueue()) {
        const queue = buildRngQueueBlock();
        if (queue) parts.push(queue);
    }

    // 2. World clock (lightweight world progression).
    const clock = buildWorldClockInjection(settings, state);
    if (clock) parts.push(clock);

    // 3. State Memo — the source of mechanical truth.
    if (settings.memoInjection) {
        const chatId = getActiveChatId();
        const st = state || (chatId ? getChatState(chatId) : null);
        if (st?.memo) {
            parts.push(`${STATE_MEMO_PREAMBLE}\n${st.memo}\n${STATE_MEMO_CLOSE}`);
        }
    }

    return parts.join('\n\n');
}

/**
 * Lightweight world progression: an in-world clock that advances with real
 * play time. Stored per chat and injected as [TIME] Day N, HH:MM [/TIME].
 */
export function buildWorldClockInjection(settings, state) {
    if (!settings.worldProgressionEnabled) return '';
    const chatId = getActiveChatId();
    const st = state || (chatId ? getChatState(chatId) : null);
    if (!st) return '';

    const now = Date.now();
    const lastReal = Number(st.worldClockLastReal) || now;
    const elapsedMin = Math.max(0, Math.floor((now - lastReal) / 60000));
    const scale = Math.max(0.1, Number(settings.worldTimeScale) || 3);

    let inWorldMin = Number(st.worldClockMinutes) || 0;
    if (elapsedMin > 0) {
        // 1 real minute of play = worldTimeScale in-world minutes (default 3).
        inWorldMin += elapsedMin * scale;
        st.worldClockMinutes = inWorldMin;
        st.worldClockLastReal = now;
        saveChatState(chatId);
    }

    const day = Math.floor(inWorldMin / (24 * 60)) + 1;
    const hour = Math.floor((inWorldMin % (24 * 60)) / 60);
    const minute = Math.floor(inWorldMin % 60);
    const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return `[TIME] Day ${day}, ${clock}[/TIME]`;
}

/** Prepend text to a chat message (string or multimodal content). */
function prependToMessage(msg, text) {
    if (typeof msg.content === 'string') {
        msg.content = text + '\n' + msg.content;
    } else if (Array.isArray(msg.content)) {
        const nonText = msg.content.filter((p) => p && p.type !== 'text');
        msg.content = [{ type: 'text', text: text + '\n' }, ...nonText];
    } else if (typeof msg.mes === 'string') {
        msg.mes = text + '\n' + msg.mes;
    } else {
        msg.mes = text;
    }
}

/** Keep the optional extension prompt (setExtensionPrompt) in sync. */
export function syncMemoPromptRegistration() {
    const ctx = getContextSafe();
    if (typeof ctx?.setExtensionPrompt !== 'function') return;
    const settings = getSettings();
    const chatId = getActiveChatId();
    const state = chatId ? getChatState(chatId) : null;
    if (settings.enabled && settings.memoInjection && state?.memo) {
        const pos = Number(settings.memoInjectionPosition);
        const position = Number.isFinite(pos) ? pos : 1; // IN_CHAT by default
        ctx.setExtensionPrompt(MEMO_PROMPT_NAME, state.memo, position, 4);
    } else {
        ctx.setExtensionPrompt(MEMO_PROMPT_NAME, '', -1, 0); // NONE + empty
    }
}

/** True while the current chat memo marks combat as active (export for UI). */
export function combatActiveForChat() {
    const chatId = getActiveChatId();
    const state = chatId ? getChatState(chatId) : null;
    return isCombatActive(state?.memo || '');
}

function getContextSafe() {
    try {
        return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    } catch {
        return null;
    }
}


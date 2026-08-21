/**
 * lorebook.js — TRPG Framework
 * Lorebook Agent: a quiet LLM pass that reads recent campaign events and the
 * existing world-info entries, then creates / updates / prunes lorebook entries
 * so long-term memory survives summarization. Entries live in a dedicated book
 * (default "<chat name>_lore") and are activated by SillyTavern's native
 * keyword activation when the book is attached to the chat.
 */

import { generate, extractJson } from './llm.js';
import { getSettings, getChatState, saveChatState, getActiveChatId } from './settings.js';

/** World-info entry shape SillyTavern expects. */
export function buildLoreEntry(keywords, content, comment = '') {
    return {
        key: Array.isArray(keywords) ? keywords : [String(keywords)],
        keysecondary: [],
        comment: String(comment || keywords[0] || ''),
        content: String(content),
        constant: false,
        selective: false,
        order: 100,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: 4,
        caseSensitive: false,
        matchWholeWords: false,
        useGlobalScope: false,
        automationId: '',
        role: '',
    };
}

/** Sanitize a chat filename into a lorebook book name. */
export function sanitizeBookName(raw) {
    const cleaned = String(raw || '')
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return cleaned || 'campaign';
}

/** Book name for the current campaign lore. */
export function resolveBookName(chatId = getActiveChatId()) {
    const settings = getSettings();
    if (settings.lorebookBookName?.trim()) return settings.lorebookBookName.trim();
    const ctx = getContextSafe();
    const chatFileName = ctx?.chat?.length ? String(ctx.name1 || ctx.charId || '') : '';
    const base = sanitizeBookName(chatFileName || chatId || 'campaign');
    return `${base}_lore`;
}

/**
 * Load a world-info book (creating it on first use).
 * @returns {Promise<{bookName:string, book:object}|null>}
 */
export async function ensureLorebookBook(bookName = resolveBookName()) {
    const ctx = getContextSafe();
    if (!ctx) return null;
    try {
        let book = await ctx.loadWorldInfo(bookName);
        if (!book || !book.entries) {
            book = {
                entries: {},
                name: bookName,
                scan_depth: 4,
                token_budget: 400,
                recursive: false,
                extensions: {},
            };
            await ctx.saveWorldInfo(bookName, book);
            if (typeof ctx.updateWorldInfoList === 'function') {
                try { await ctx.updateWorldInfoList(); } catch { /* non-fatal */ }
            }
            if (typeof ctx.reloadWorldInfoEditor === 'function') {
                try { ctx.reloadWorldInfoEditor(bookName); } catch { /* non-fatal */ }
            }
        }
        return { bookName, book };
    } catch (error) {
        console.warn('[TRPG] Could not load/create lorebook:', error);
        return null;
    }
}

/**
 * Attach the lorebook book to the active chat (best effort, non-destructive).
 * Modern SillyTavern stores the chat-bound lorebook as chat_metadata.world_info
 * (a book-name string). If the chat already has a chat-bound lorebook we do NOT
 * override it — we tell the user to add ours as an additional book instead.
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function attachLorebookToChat(bookName = resolveBookName()) {
    const ctx = getContextSafe();
    if (!ctx) return { ok: false, message: 'No SillyTavern context available.' };

    // Some builds expose a helper; prefer it when present.
    if (typeof ctx.setWorldInfoBookActive === 'function') {
        try {
            await ctx.setWorldInfoBookActive(bookName);
            if (typeof ctx.saveChatConditional === 'function') await ctx.saveChatConditional();
            return { ok: true, message: `Lorebook "${bookName}" attached to this chat.` };
        } catch { /* fall through to metadata path */ }
    }

    try {
        const existing = ctx.chat_metadata?.world_info;
        if (existing && String(existing) !== bookName) {
            return {
                ok: false,
                message: `This chat already uses lorebook "${existing}". Add "${bookName}" as an additional book in the World Info panel instead.`,
            };
        }
        if (!ctx.chat_metadata) return { ok: false, message: 'Chat metadata is unavailable.' };
        ctx.chat_metadata.world_info = bookName;
        if (typeof ctx.saveChatConditional === 'function') await ctx.saveChatConditional();
        return { ok: true, message: `Lorebook "${bookName}" set as this chat's lorebook.` };
    } catch (error) {
        return { ok: false, message: `Could not attach automatically: ${error?.message || error}` };
    }
}

/** Load all entries of the lorebook book as an array. */
export async function listEntries(bookName = resolveBookName()) {
    const loaded = await ensureLorebookBook(bookName);
    if (!loaded) return [];
    return Object.entries(loaded.book.entries || {}).map(([uid, entry]) => ({ uid, ...entry }));
}

/**
 * Apply a lore patch produced by the agent LLM.
 * @param {Array<{uid?:string,key:string[],content:string,comment?:string}>} create
 * @param {Array<{uid:string,key?:string[],content?:string,comment?:string}>} update
 * @param {string[]} [deleteUids]
 * @returns {Promise<{created:number, updated:number, deleted:number}>}
 */
export async function applyLorePatch(create = [], update = [], deleteUids = []) {
    const loaded = await ensureLorebookBook();
    if (!loaded) return { created: 0, updated: 0, deleted: 0 };
    const { bookName, book } = loaded;
    const entries = book.entries || (book.entries = {});

    for (const spec of create || []) {
        if (!spec?.key?.length || !spec.content) continue;
        const uid = makeUid();
        entries[uid] = buildLoreEntry(spec.key, spec.content, spec.comment || spec.key[0]);
    }
    for (const spec of update || []) {
        if (!spec?.uid || !entries[spec.uid]) continue;
        const entry = entries[spec.uid];
        if (Array.isArray(spec.key) && spec.key.length) entry.key = spec.key;
        if (typeof spec.content === 'string' && spec.content.trim()) entry.content = spec.content;
        if (spec.comment) entry.comment = spec.comment;
    }
    for (const uid of deleteUids || []) {
        if (entries[uid]) delete entries[uid];
    }

    const ctx = getContextSafe();
    if (!ctx) return { created: 0, updated: 0, deleted: 0 };
    try {
        await ctx.saveWorldInfo(bookName, book);
        if (typeof ctx.reloadWorldInfoEditor === 'function') ctx.reloadWorldInfoEditor(bookName);
        return {
            created: (create || []).length,
            updated: (update || []).length,
            deleted: (deleteUids || []).length,
        };
    } catch (error) {
        console.warn('[TRPG] Failed to save lorebook:', error);
        return { created: 0, updated: 0, deleted: 0 };
    }
}

function makeUid() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `trpg_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Build the system prompt for the lorebook agent pass. */
export function buildLoreSystemPrompt() {
    return `You are the Lorebook Agent of a tabletop RPG campaign running in SillyTavern.
Your job is long-term memory: convert important campaign facts revealed in the latest
narrative into concise world-info entries so the narrator never forgets them, even after
summarization. You NEVER write prose. You NEVER invent facts.

Rules:
- Create an entry only for durable, referenced-again facts: locations, factions,
  NPCs, items, quests, established relationships, ongoing threats.
- Keep entries short (1-4 sentences each). Use keywords the narrator is likely to write.
- Update an existing entry when the story changes it; do not duplicate.
- Delete an entry only when the story permanently invalidates it (rare).
- Respond with ONLY a JSON object: {"create":[{"key":["kw1","kw2"],"content":"...","comment":"Short label"}],"update":[{"uid":"...","key":[...],"content":"...","comment":"..."}],"delete":["uid"]}
- Include only keys that actually changed in update; omit create/update/delete when empty.`;
}

/** Build the user prompt for a lorebook agent run. */
export function buildLoreUserPrompt(narrative, existingEntries, lookback = 12000) {
    const parts = [];
    parts.push('### LATEST NARRATIVE');
    parts.push(String(narrative || '').slice(0, lookback));
    if (existingEntries && existingEntries.length > 0) {
        parts.push('');
        parts.push('### EXISTING ENTRIES (uid | keywords | content)');
        for (const e of existingEntries.slice(-60)) {
            parts.push(`- ${e.uid} | ${(e.key || []).join(', ')} | ${String(e.content || '').slice(0, 300)}`);
        }
    }
    parts.push('');
    parts.push('Output the JSON patch. Nothing else.');
    return parts.join('\n');
}

/**
 * Run one Lorebook Agent pass.
 * @returns {Promise<{ok:boolean, reason?:string, summary?:string}>}
 */
export async function runLorebookAgentPass() {
    const settings = getSettings();
    const chatId = getActiveChatId();
    if (!chatId) return { ok: false, reason: 'no_active_chat' };
    if (!settings.enabled || !settings.lorebookEnabled) return { ok: false, reason: 'lorebook_disabled' };

    const state = getChatState(chatId);
    if (!state) return { ok: false, reason: 'no_state' };

    const runEvery = Math.max(1, Number(settings.lorebookRunEvery) || 4);
    state.loreTurnsSinceRun = Number(state.loreTurnsSinceRun) || 0;
    if (state.loreTurnsSinceRun < runEvery - 1) {
        state.loreTurnsSinceRun += 1;
        saveChatState(chatId);
        return { ok: false, reason: 'throttled' };
    }

    const narrative = getRecentNarrative(4000);
    if (!narrative) return { ok: false, reason: 'no_narrative' };

    const existing = await listEntries();
    const userPrompt = buildLoreUserPrompt(narrative, existing);
    let text;
    try {
        text = await generate(buildLoreSystemPrompt(), userPrompt, {
            maxTokens: Number(settings.lorebookMaxTokens) || 1024,
        });
    } catch (error) {
        console.warn('[TRPG] Lorebook Agent pass failed:', error);
        state.loreTurnsSinceRun = 0;
        saveChatState(chatId);
        return { ok: false, reason: 'llm_error', summary: String(error?.message || error) };
    }

    const patch = extractJson(text);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        state.loreTurnsSinceRun = 0;
        saveChatState(chatId);
        return { ok: false, reason: 'parse_error' };
    }

    const result = await applyLorePatch(patch.create, patch.update, patch.delete);
    state.loreTurnsSinceRun = 0;
    saveChatState(chatId);

    const total = result.created + result.updated + result.deleted;
    return {
        ok: true,
        summary: total === 0 ? 'no lore changes' : `+${result.created} created, ~${result.updated} updated, -${result.deleted} deleted`,
    };
}

/** Concatenate the last few assistant/user messages for agent context. */
function getRecentNarrative(limit = 4000) {
    const ctx = getContextSafe();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return '';
    const parts = [];
    let size = 0;
    for (let i = chat.length - 1; i >= 0 && size < limit; i--) {
        const m = chat[i];
        if (!m || m.is_system || String(m.role || '').toLowerCase() === 'system') continue;
        const text = String(m.mes || m.content || '');
        if (!text) continue;
        parts.unshift(`${m.is_user || String(m.role || '').toLowerCase() === 'user' ? '[Player]' : '[Narrator]'}: ${text}`);
        size += text.length;
    }
    return parts.join('\n\n').slice(-limit);
}

function getContextSafe() {
    try {
        return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    } catch {
        return null;
    }
}


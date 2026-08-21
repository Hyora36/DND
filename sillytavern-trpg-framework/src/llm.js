/**
 * llm.js — TRPG Framework
 * Thin wrapper around SillyTavern's generateRaw for background passes
 * (State Tracker, Lorebook Agent). Includes robust JSON extraction so models
 * that wrap their output in markdown fences or prose still parse.
 */

/** Default max tokens when the setting is unset. */
const DEFAULT_MAX_TOKENS = 768;

/**
 * Send a quiet generation through the active SillyTavern connection.
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {{maxTokens?:number, signal?:AbortSignal, jsonSchema?:object|null}} [opts]
 * @returns {Promise<string>} the raw text content
 */
export async function generate(systemPrompt, userPrompt, opts = {}) {
    const ctx = getContextSafe();
    if (!ctx) throw new Error('SillyTavern context unavailable.');

    if (typeof ctx.generateRaw !== 'function') {
        throw new Error('generateRaw is not available on this SillyTavern build.');
    }

    const options = {
        prompt: userPrompt,
        systemPrompt: systemPrompt,
        bypassAll: true,          // no chat history, no formatting cleanup
        trimNames: false,         // never strip "{{char}}:" prefixed JSON output
        signal: opts.signal || null,
    };
    if (opts.jsonSchema && typeof ctx.generateRawData === 'function') {
        options.jsonSchema = opts.jsonSchema;
    }
    const maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;
    if (maxTokens > 0) options.responseLength = maxTokens;

    const result = await ctx.generateRaw(options);
    return extractText(result);
}

/** Pull the string out of whatever generateRaw returned. */
export function extractText(result) {
    if (result == null) return '';
    if (typeof result === 'string') {
        // Sometimes generateRaw returns a serialized response object.
        try {
            const parsed = JSON.parse(result);
            if (parsed && typeof parsed === 'object') {
                return parsed.choices?.[0]?.message?.content
                    || parsed.choices?.[0]?.text
                    || parsed.message?.content
                    || parsed.content
                    || result;
            }
        } catch { /* not JSON — plain string */ }
        return result;
    }
    if (typeof result === 'object') {
        return result.content
            || result.message?.content
            || result.choices?.[0]?.message?.content
            || result.choices?.[0]?.text
            || result.text
            || '';
    }
    return String(result ?? '');
}

/**
 * Extract the first JSON value (object or array) from model output, tolerating
 * markdown code fences and surrounding prose. Returns null when not found.
 * @param {string} text
 */
export function extractJson(text) {
    if (!text) return null;
    let cleaned = String(text).trim();

    // Strip markdown fences.
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    // Direct parse first.
    try {
        return JSON.parse(cleaned);
    } catch { /* fall through */ }

    // Find the first balanced {...} or [...] region.
    const starts = [];
    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch === '{' || ch === '[') starts.push(i);
    }
    for (const start of starts) {
        const end = findBalancedEnd(cleaned, start);
        if (end < 0) continue;
        const candidate = cleaned.slice(start, end + 1);
        try {
            return JSON.parse(candidate);
        } catch { /* try next */ }
    }
    return null;
}

function findBalancedEnd(text, start) {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function getContextSafe() {
    try {
        return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    } catch {
        return null;
    }
}

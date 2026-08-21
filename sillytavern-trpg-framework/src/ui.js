/**
 * ui.js — TRPG Framework
 * SillyTavern UI: a floating RPG panel (character sheet + tools) and the
 * extension settings drawer. Uses jQuery, which SillyTavern provides globally.
 */

import { getSettings, saveSettings, getChatState, saveChatState, getActiveChatId, deleteChatState } from './settings.js';
import { createEmptyState, normalizeState, buildStateMemo, rollRandomCharacter, isCombatActive } from './chat-state.js';
import { runStateTrackerPass } from './tracker.js';
import { runLorebookAgentPass, resolveBookName, attachLorebookToChat } from './lorebook.js';
import { syncMemoPromptRegistration } from './interceptor.js';
import { syncDiceTool } from './rng.js';

export const PANEL_ID = 'trpg-framework-panel';
export const WAND_BUTTON_ID = 'trpg-framework-wand';

let panelVisible = true;
let rawMode = false;

// ── Main panel ────────────────────────────────────────────────────────────────

/** Create the floating RPG panel and the wand toggle button. */
export function createPanel() {
    const body = document.body;
    if (!body || document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.classList.add('trpg-panel');
    panel.innerHTML = panelTemplate();
    body.appendChild(panel);

    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('input', onPanelInput);
    panel.addEventListener('change', onPanelChange);

    const saved = localStorage.getItem('trpg_framework_panel_visible');
    if (saved === 'false') togglePanel(false);
    if (panelVisible) panel.classList.add('trpg-visible');

    createWandButton();
    refreshPanel();
}

function panelTemplate() {
    return `
    <div class="trpg-panel-header">
        <span class="trpg-panel-title"><i class="fa-solid fa-dice-d20"></i> TRPG Framework</span>
        <span class="trpg-panel-status" id="trpg-status"></span>
        <button class="trpg-btn trpg-btn-icon" id="trpg-collapse" title="Collapse / expand"><i class="fa-solid fa-chevron-down"></i></button>
        <button class="trpg-btn trpg-btn-icon" id="trpg-close" title="Hide panel"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="trpg-panel-body" id="trpg-panel-body">
        <div class="trpg-row trpg-combat-badge" id="trpg-combat-badge" style="display:none">⚔ COMBAT ACTIVE</div>

        <div class="trpg-fields">
            <label>Name <input id="trpg-name" type="text" placeholder="Hero"></label>
            <label>Race <input id="trpg-race" type="text" placeholder="Human"></label>
            <label>Class <input id="trpg-class" type="text" placeholder="Fighter"></label>
            <label>Level <input id="trpg-level" type="number" min="1" value="1"></label>
            <label>HP <span class="trpg-hp-wrap"><input id="trpg-hp-current" type="number" min="0"> / <input id="trpg-hp-max" type="number" min="1"></span></label>
            <label>Temp HP <input id="trpg-temp-hp" type="number" min="0" value="0"></label>
            <label>XP <input id="trpg-xp" type="number" min="0" value="0"></label>
            <label>Gold <input id="trpg-gold" type="number" min="0" value="0"></label>
        </div>

        <div class="trpg-hp-bar"><div class="trpg-hp-bar-fill" id="trpg-hp-bar-fill"></div></div>

        <div class="trpg-lists">
            <label>Inventory <span class="trpg-hint">(one item per line)</span>
                <textarea id="trpg-inventory" rows="3" placeholder="Dagger&#10;Backpack&#10;Healing Potion"></textarea>
            </label>
            <label>Spells / Slots <span class="trpg-hint">(one line per entry)</span>
                <textarea id="trpg-spells" rows="2" placeholder="Cantrips (2)&#10;Level 1 slots (2)"></textarea>
            </label>
            <label>Buffs &amp; Conditions <span class="trpg-hint">(Name [duration] per line)</span>
                <textarea id="trpg-buffs" rows="2" placeholder="Poisoned [2 rounds]&#10;Blessed [1 hour]"></textarea>
            </label>
            <label>Notes
                <textarea id="trpg-notes" rows="2" placeholder="Adventure notes..."></textarea>
            </label>
        </div>

        <details class="trpg-memo">
            <summary>State Memo preview (injected into prompts)</summary>
            <pre id="trpg-memo-preview"></pre>
        </details>

        <div class="trpg-actions">
            <select id="trpg-genre">
                <option value="fantasy">Fantasy</option>
                <option value="modern">Modern</option>
                <option value="scifi">Sci-Fi</option>
            </select>
            <button class="trpg-btn" id="trpg-roll-char" title="Generate a random character"><i class="fa-solid fa-shuffle"></i> Random Character</button>
            <button class="trpg-btn" id="trpg-track-now" title="Run the State Tracker LLM pass now"><i class="fa-solid fa-wand-magic-sparkles"></i> Auto-Track Now</button>
            <button class="trpg-btn" id="trpg-lore-now" title="Run the Lorebook Agent LLM pass now"><i class="fa-solid fa-book"></i> Lorebook Agent</button>
            <button class="trpg-btn" id="trpg-lore-attach" title="Attach the lorebook to this chat"><i class="fa-solid fa-link"></i> Attach Lore</button>
        </div>
        <div class="trpg-actions">
            <button class="trpg-btn" id="trpg-raw-toggle" title="Edit the state as raw JSON"><i class="fa-solid fa-code"></i> Raw View</button>
            <button class="trpg-btn" id="trpg-export" title="Copy state JSON to clipboard"><i class="fa-solid fa-file-export"></i> Export</button>
            <button class="trpg-btn" id="trpg-import" title="Paste state JSON"><i class="fa-solid fa-file-import"></i> Import</button>
            <button class="trpg-btn trpg-btn-danger" id="trpg-reset" title="Reset this chat's character sheet"><i class="fa-solid fa-rotate-left"></i> Reset</button>
        </div>
        <textarea id="trpg-raw" class="trpg-raw" style="display:none" rows="8" spellcheck="false"></textarea>
        <div class="trpg-log" id="trpg-log"></div>
    </div>`;
}

function createWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(WAND_BUTTON_ID)) return;
    const btn = document.createElement('div');
    btn.id = WAND_BUTTON_ID;
    btn.classList.add('list-group-item', 'flex-container', 'flexGap5');
    btn.innerHTML = '<div class="fa-solid fa-dice-d20 extensionsMenuExtensionButton"></div><span>TRPG Framework</span>';
    btn.addEventListener('click', () => togglePanel(!panelVisible));
    menu.appendChild(btn);
}

export function togglePanel(show) {
    panelVisible = show ?? !panelVisible;
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.toggle('trpg-visible', panelVisible);
    localStorage.setItem('trpg_framework_panel_visible', String(panelVisible));
    if (panelVisible) refreshPanel();
}

/** (Re)build the panel fields from the current chat state. */
export function refreshPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const chatId = getActiveChatId();
    const state = chatId ? getChatState(chatId) : null;
    if (!state) return;
    const s = state.character ? normalizeState(state) : normalizeState(deriveFromMemo(state.memo));

    setValue('trpg-name', s.character.name);
    setValue('trpg-race', s.character.race);
    setValue('trpg-class', s.character.class);
    setValue('trpg-level', s.character.level);
    setValue('trpg-hp-current', s.character.hp_current);
    setValue('trpg-hp-max', s.character.hp_max);
    setValue('trpg-temp-hp', s.character.temp_hp);
    setValue('trpg-xp', s.character.xp);
    setValue('trpg-gold', s.character.gold);
    setValue('trpg-inventory', (s.inventory || []).join('\n'));
    setValue('trpg-spells', (s.spells || []).join('\n'));
    setValue('trpg-buffs', (s.buffs || []).map((b) => (b.duration ? `${b.name} [${b.duration}]` : b.name)).join('\n'));
    setValue('trpg-notes', (s.notes || []).join('\n'));
    setValue('trpg-raw', JSON.stringify({ character: s.character, inventory: s.inventory, spells: s.spells, buffs: s.buffs, notes: s.notes }, null, 2));

    // HP bar
    const pct = s.character.hp_max > 0 ? Math.max(0, Math.min(100, (s.character.hp_current / s.character.hp_max) * 100)) : 0;
    const fill = document.getElementById('trpg-hp-bar-fill');
    if (fill) {
        fill.style.width = `${pct}%`;
        fill.classList.toggle('trpg-low', pct <= 25);
    }

    // Combat badge + status line
    const badge = document.getElementById('trpg-combat-badge');
    const combat = isCombatActive(state.memo || '');
    if (badge) badge.style.display = combat ? 'block' : 'none';
    const status = document.getElementById('trpg-status');
    if (status) {
        const updated = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : 'never';
        status.textContent = `updated ${updated}`;
    }
    const memo = document.getElementById('trpg-memo-preview');
    if (memo) memo.textContent = state.memo || '(empty — roll a character or run Auto-Track)';

    const raw = document.getElementById('trpg-raw');
    if (raw) raw.style.display = rawMode ? 'block' : 'none';
}

/** Collect panel inputs into a normalized state object and persist it. */
export function collectPanelState() {
    const chatId = getActiveChatId();
    const state = chatId ? getChatState(chatId) : null;
    if (!state) return null;

    const num = (id, fallback) => {
        const v = Number(getValue(id));
        return Number.isFinite(v) ? v : fallback;
    };
    const lines = (id) => getValue(id).split('\n').map((l) => l.trim()).filter(Boolean);

    const sheet = {
        character: {
            name: getValue('trpg-name'),
            race: getValue('trpg-race'),
            class: getValue('trpg-class'),
            level: num('trpg-level', 1),
            hp_current: num('trpg-hp-current', 0),
            hp_max: num('trpg-hp-max', 1),
            temp_hp: num('trpg-temp-hp', 0),
            xp: num('trpg-xp', 0),
            gold: num('trpg-gold', 0),
        },
        inventory: lines('trpg-inventory'),
        spells: lines('trpg-spells'),
        buffs: lines('trpg-buffs').map((line) => {
            const m = line.match(/^(.*?)\s*\[(.*)\]$/);
            return m ? { name: m[1].trim(), duration: m[2].trim() } : { name: line, duration: '' };
        }),
        notes: lines('trpg-notes'),
    };
    const normalized = normalizeState(sheet);
    state.character = normalized.character;
    state.inventory = normalized.inventory;
    state.spells = normalized.spells;
    state.buffs = normalized.buffs;
    state.notes = normalized.notes;
    state.memo = buildStateMemo({ ...normalized, meta: state.meta || {} });
    state.updatedAt = new Date().toISOString();
    saveChatState(chatId);
    refreshPanel();
    syncMemoPromptRegistration();
    return state;
}

/** Best-effort: rebuild a state object from an existing memo text. */
function deriveFromMemo(memo) {
    const s = createEmptyState();
    if (!memo) return s;
    const text = String(memo);
    const grab = (label) => {
        const m = text.match(new RegExp(`${label}:\\s*(.+)`));
        return m ? m[1].trim() : '';
    };
    s.character.name = grab('Name');
    s.character.race = grab('Race')?.split('|')[0].trim();
    s.character.class = grab('Class');
    s.character.level = parseInt(grab('Level'), 10) || 1;
    const hpMatch = text.match(/HP:\s*(\d+)\s*\/\s*(\d+)/);
    if (hpMatch) { s.character.hp_current = parseInt(hpMatch[1], 10) || 0; s.character.hp_max = parseInt(hpMatch[2], 10) || 1; }
    const xpMatch = text.match(/XP:\s*(\d+)/);
    if (xpMatch) s.character.xp = parseInt(xpMatch[1], 10) || 0;
    const goldMatch = text.match(/Gold:\s*(\d+)/);
    if (goldMatch) s.character.gold = parseInt(goldMatch[1], 10) || 0;
    s.inventory = text.match(/### Inventory\n([\s\S]*?)(?=\n### |$)/)?.[1]?.split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean) || [];
    s.spells = text.match(/### Spells\n([\s\S]*?)(?=\n### |$)/)?.[1]?.split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean) || [];
    return s;
}

// ── Event handling ────────────────────────────────────────────────────────────

function onPanelClick(event) {
    const id = event.target?.closest('button')?.id;
    if (!id) return;
    switch (id) {
        case 'trpg-collapse': {
            const body = document.getElementById('trpg-panel-body');
            if (body) body.classList.toggle('trpg-collapsed');
            break;
        }
        case 'trpg-close':
            togglePanel(false);
            break;
        case 'trpg-roll-char': {
            const genre = getValue('trpg-genre') || 'fantasy';
            const state = getChatState(getActiveChatId());
            if (!state) break;
            const sheet = rollRandomCharacter(genre);
            state.character = sheet.character;
            state.inventory = sheet.inventory;
            state.spells = sheet.spells;
            state.buffs = sheet.buffs;
            state.notes = sheet.notes;
            state.memo = buildStateMemo({ ...sheet, meta: state.meta || {} });
            state.updatedAt = new Date().toISOString();
            saveChatState(getActiveChatId());
            refreshPanel();
            syncMemoPromptRegistration();
            log('🎲 Random character generated.');
            break;
        }
        case 'trpg-track-now': {
            log('⏳ Running State Tracker…');
            runStateTrackerPass({ force: true }).then((res) => {
                log(res.ok ? (res.changed ? `✅ ${res.summary}` : `ℹ️ ${res.summary || 'no change'}`) : `⚠️ ${res.reason}${res.summary ? ': ' + res.summary : ''}`);
                refreshPanel();
            });
            break;
        }
        case 'trpg-lore-now': {
            log('⏳ Running Lorebook Agent…');
            runLorebookAgentPass().then((res) => {
                log(res.ok ? `✅ ${res.summary || 'lore pass complete'}` : `⚠️ ${res.reason}${res.summary ? ': ' + res.summary : ''}`);
            });
            break;
        }
        case 'trpg-lore-attach': {
            const bookName = resolveBookName();
            attachLorebookToChat(bookName).then((res) => {
                log(res?.ok ? `🔗 ${res.message}` : `⚠️ ${res?.message || 'Could not attach the lorebook.'}`);
            });
            break;
        }
        case 'trpg-raw-toggle':
            rawMode = !rawMode;
            refreshPanel();
            break;
        case 'trpg-export': {
            const chatId = getActiveChatId();
            const state = chatId ? getChatState(chatId) : null;
            if (!state) break;
            const json = JSON.stringify({ character: state.character, inventory: state.inventory, spells: state.spells, buffs: state.buffs, notes: state.notes }, null, 2);
            if (navigator.clipboard?.writeText) navigator.clipboard.writeText(json);
            log('📋 State JSON copied to clipboard.');
            break;
        }
        case 'trpg-import': {
            const raw = getValue('trpg-raw');
            try {
                const parsed = JSON.parse(raw);
                const chatId = getActiveChatId();
                const state = chatId ? getChatState(chatId) : null;
                if (!state) break;
                const sheet = normalizeState({ character: parsed.character, inventory: parsed.inventory, spells: parsed.spells, buffs: parsed.buffs, notes: parsed.notes });
                state.character = sheet.character;
                state.inventory = sheet.inventory;
                state.spells = sheet.spells;
                state.buffs = sheet.buffs;
                state.notes = sheet.notes;
                state.memo = buildStateMemo({ ...sheet, meta: state.meta || {} });
                state.updatedAt = new Date().toISOString();
                saveChatState(chatId);
                refreshPanel();
                syncMemoPromptRegistration();
                log('✅ State imported.');
            } catch {
                log('❌ Invalid JSON — nothing imported.');
            }
            break;
        }
        case 'trpg-reset': {
            const chatId = getActiveChatId();
            if (!chatId) break;
            deleteChatState(chatId);
            log('♻️ Sheet reset for this chat.');
            refreshPanel();
            break;
        }
    }
}

function onPanelInput(event) {
    const id = event.target?.id;
    if (!id) return;
    // Debounce heavy work; persist on change (see onPanelChange) but also
    // update the raw view live.
    if (id === 'trpg-raw') return;
    scheduleCollect();
}

function onPanelChange(event) {
    if (event.target?.id === 'trpg-raw') return;
    scheduleCollect();
}

let collectTimer = null;
function scheduleCollect() {
    if (collectTimer) clearTimeout(collectTimer);
    collectTimer = setTimeout(() => {
        collectPanelState();
        refreshPanel();
    }, 300);
}

function log(msg) {
    const el = document.getElementById('trpg-log');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('trpg-log-new');
    void el.offsetWidth; // restart fade
    el.classList.add('trpg-log-new');
}

// ── Settings UI ───────────────────────────────────────────────────────────────

/** Append the settings block into SillyTavern's extension settings drawer. */
export function createSettingsUI() {
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('trpg-settings-block')) return;

    const block = document.createElement('div');
    block.id = 'trpg-settings-block';
    block.classList.add('trpg-settings');
    block.innerHTML = `
        <div class="trpg-settings-title"><i class="fa-solid fa-dice-d20"></i> TRPG Framework</div>

        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-enabled"><span>Enable TRPG Framework</span></label>
        </div>
        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-debug"><span>Debug logging</span></label>
        </div>

        <div class="trpg-settings-section">State Tracker</div>
        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-tracker-enabled"><span>Auto-track state after each assistant reply (second LLM pass)</span></label>
        </div>
        <div class="trpg-setting-row">
            <label>Run every <input type="number" id="trpg-set-tracker-every" min="1" max="10" style="width:60px"> assistant turns</label>
        </div>
        <div class="trpg-setting-row">
            <label>Tracker max tokens <input type="number" id="trpg-set-tracker-tokens" min="128" max="4096" style="width:80px"></label>
        </div>

        <div class="trpg-settings-section">Prompt Injection</div>
        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-memo"><span>Inject State Memo into every outgoing prompt</span></label>
        </div>
        <div class="trpg-setting-row">
            <label>Memo position
                <select id="trpg-set-memo-position" style="width:auto">
                    <option value="1">In chat</option>
                    <option value="2">At top of prompt</option>
                    <option value="0">In prompt (Author's Note area)</option>
                    <option value="-1">None</option>
                </select>
            </label>
        </div>

        <div class="trpg-settings-section">Hybrid RNG</div>
        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-rng"><span>Enable RNG system</span></label>
        </div>
        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-rng-d20"><span>Inject deterministic d20 queue per turn</span></label>
        </div>
        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-rng-d100"><span>Also inject d100 queue (30 rolls)</span></label>
        </div>
        <div class="trpg-setting-row">
            <label>Queue length <input type="number" id="trpg-set-rng-length" min="1" max="20" style="width:60px"></label>
        </div>
        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-rng-tool"><span>Register roll_dice tool for the narrator</span></label>
        </div>
        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-rng-combat"><span>Inject queue only while combat is active</span></label>
        </div>

        <div class="trpg-settings-section">Lorebook Agent</div>
        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-lore-enabled"><span>Enable Lorebook Agent (long-term memory)</span></label>
        </div>
        <div class="trpg-setting-row">
            <label>Run every <input type="number" id="trpg-set-lore-every" min="1" max="20" style="width:60px"> assistant turns</label>
        </div>
        <div class="trpg-setting-row">
            <label>Lorebook book name <input type="text" id="trpg-set-lore-book" placeholder="(auto: <chat>_lore)" style="width:220px"></label>
        </div>
        <div class="trpg-setting-row">
            <label>Lore max tokens <input type="number" id="trpg-set-lore-tokens" min="128" max="8192" style="width:80px"></label>
        </div>

        <div class="trpg-settings-section">World Clock</div>
        <div class="trpg-setting-row">
            <label class="checkbox_label"><input type="checkbox" id="trpg-set-wp-enabled"><span>Enable in-world clock ([TIME] injection)</span></label>
        </div>
        <div class="trpg-setting-row">
            <label>In-world minutes per real minute <input type="number" id="trpg-set-wp-scale" min="1" max="1440" style="width:80px"></label>
        </div>
    `;
    container.appendChild(block);

    block.addEventListener('change', onSettingsChange);
    block.addEventListener('input', onSettingsChange);
    syncSettingsUI();
}

/** Push current settings into the settings UI controls. */
export function syncSettingsUI() {
    const s = getSettings();
    setChecked('trpg-set-enabled', s.enabled);
    setChecked('trpg-set-debug', s.debugMode);
    setChecked('trpg-set-tracker-enabled', s.trackerEnabled);
    setValue('trpg-set-tracker-every', s.trackerRunEvery);
    setValue('trpg-set-tracker-tokens', s.trackerMaxTokens);
    setChecked('trpg-set-memo', s.memoInjection);
    setValue('trpg-set-memo-position', s.memoInjectionPosition);
    setChecked('trpg-set-rng', s.rngEnabled);
    setChecked('trpg-set-rng-d20', s.rngQueueD20);
    setChecked('trpg-set-rng-d100', s.rngQueueD100);
    setValue('trpg-set-rng-length', s.rngQueueLength);
    setChecked('trpg-set-rng-tool', s.diceFunctionTool);
    setChecked('trpg-set-rng-combat', s.rngQueueOnlyInCombat);
    setChecked('trpg-set-lore-enabled', s.lorebookEnabled);
    setValue('trpg-set-lore-every', s.lorebookRunEvery);
    setValue('trpg-set-lore-book', s.lorebookBookName || '');
    setValue('trpg-set-lore-tokens', s.lorebookMaxTokens);
    setChecked('trpg-set-wp-enabled', s.worldProgressionEnabled);
    setValue('trpg-set-wp-scale', s.worldTimeScale);
}

function onSettingsChange(event) {
    const id = event.target?.id;
    if (!id || !id.startsWith('trpg-set-')) return;
    const settings = getSettings();
    switch (id) {
        case 'trpg-set-enabled': settings.enabled = isChecked(id); break;
        case 'trpg-set-debug': settings.debugMode = isChecked(id); break;
        case 'trpg-set-tracker-enabled': settings.trackerEnabled = isChecked(id); break;
        case 'trpg-set-tracker-every': settings.trackerRunEvery = clampInt(id, 1, 10, 1); break;
        case 'trpg-set-tracker-tokens': settings.trackerMaxTokens = clampInt(id, 128, 4096, 512); break;
        case 'trpg-set-memo': settings.memoInjection = isChecked(id); break;
        case 'trpg-set-memo-position': {
            const v = parseInt(getValue(id), 10);
            settings.memoInjectionPosition = Number.isFinite(v) ? Math.max(-1, Math.min(2, v)) : 1;
            break;
        }
        case 'trpg-set-rng': settings.rngEnabled = isChecked(id); break;
        case 'trpg-set-rng-d20': settings.rngQueueD20 = isChecked(id); break;
        case 'trpg-set-rng-d100': settings.rngQueueD100 = isChecked(id); break;
        case 'trpg-set-rng-length': settings.rngQueueLength = clampInt(id, 1, 20, 5); break;
        case 'trpg-set-rng-tool': settings.diceFunctionTool = isChecked(id); break;
        case 'trpg-set-rng-combat': settings.rngQueueOnlyInCombat = isChecked(id); break;
        case 'trpg-set-lore-enabled': settings.lorebookEnabled = isChecked(id); break;
        case 'trpg-set-lore-every': settings.lorebookRunEvery = clampInt(id, 1, 20, 4); break;
        case 'trpg-set-lore-book': settings.lorebookBookName = getValue(id).trim(); break;
        case 'trpg-set-lore-tokens': settings.lorebookMaxTokens = clampInt(id, 128, 8192, 1024); break;
        case 'trpg-set-wp-enabled': settings.worldProgressionEnabled = isChecked(id); break;
        case 'trpg-set-wp-scale': settings.worldTimeScale = clampInt(id, 1, 1440, 3); break;
        default: return;
    }
    saveSettings(settings);
    syncDiceTool();
    syncMemoPromptRegistration();
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value ?? '';
}
function getValue(id) {
    return document.getElementById(id)?.value ?? '';
}
function setChecked(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = !!value;
}
function isChecked(id) {
    return !!document.getElementById(id)?.checked;
}
function clampInt(id, min, max, fallback) {
    const v = parseInt(getValue(id), 10);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
}

/** Run after chat switches: reload panel + memo registration. */
export function onChatChanged() {
    refreshPanel();
    syncMemoPromptRegistration();
}

/** Expose refresh for external code (e.g. after LLM passes). */
export function refreshAfterPass() {
    refreshPanel();
    syncMemoPromptRegistration();
}









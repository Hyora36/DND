import test from 'node:test';
import assert from 'node:assert/strict';

// ── SillyTavern stub ─────────────────────────────────────────────────────────
// Enough of the SillyTavern context API for module-load + wiring smoke tests.
const registered = {
    slashCommands: [],
    functionTools: [],
    extensionPrompts: [],
};

const eventHandlers = {};
const fakeChat = [
    { is_user: true, mes: 'I open the rusty door.', role: 'user' },
    { is_user: false, mes: 'The door creaks open. A goblin lunges at you with a rusty knife!', role: 'assistant' },
];

const fakeContext = {
    chatId: 'smoke-chat',
    chat: fakeChat,
    extensionSettings: {},
    saveSettingsDebounced() { this.saveCalled = true; },
    saveSettings() { this.saveCalled = true; },
    setExtensionPrompt(name, text, position, depth) {
        registered.extensionPrompts.push({ name, text, position, depth });
    },
    registerSlashCommand(name, cb, aliases, help) {
        registered.slashCommands.push({ name, cb, aliases, help });
    },
    // Modern slash-command API (verifies the primary registration path).
    SlashCommand: { fromProps: (props) => ({ ...props }) },
    SlashCommandParser: { addCommandObject: (cmd) => registered.slashCommands.push(cmd) },
    SlashCommandArgument: { fromProps: (props) => ({ ...props }) },
    SlashCommandNamedArgument: { fromProps: (props) => ({ ...props }) },
    ARGUMENT_TYPE: { BOOLEAN: 'boolean', STRING: 'string' },
    registerFunctionTool(spec) { registered.functionTools.push(spec); },
    unregisterFunctionTool(name) {
        registered.functionTools = registered.functionTools.filter((t) => t.name !== name);
    },
    getWorldInfoNames: async () => [],
    loadWorldInfo: async () => null,
    saveWorldInfo: async () => undefined,
    reloadWorldInfoEditor() {},
    eventSource: { on(name, fn) { eventHandlers[name] = fn; } },
    event_types: {
        GENERATION_ENDED: 'generation_ended',
        GENERATION_STOPPED: 'generation_stopped',
        CHAT_CHANGED: 'chat_changed',
        MESSAGE_SENT: 'message_sent',
        MESSAGE_RECEIVED: 'message_received',
        CHAT_DELETED: 'chat_deleted',
        SETTINGS_LOADED: 'settings_loaded',
    },
};

globalThis.SillyTavern = {
    getContext: () => fakeContext,
};

test('all modules load with a stubbed SillyTavern context', async () => {
    const settings = await import('../src/settings.js');
    const chatState = await import('../src/chat-state.js');
    const dice = await import('../src/dice.js');
    const llm = await import('../src/llm.js');
    const rng = await import('../src/rng.js');
    const tracker = await import('../src/tracker.js');
    const lorebook = await import('../src/lorebook.js');
    const interceptor = await import('../src/interceptor.js');

    assert.ok(settings.getSettings().enabled === true);
    assert.ok(chatState.createEmptyState().character.level === 1);
    assert.ok(typeof dice.rollFormula('1d20').total === 'number');
    assert.ok(typeof llm.extractJson('{"a":1}').a === 'number');
    assert.ok(rng.isValidFormula('2d6+3'));
    assert.ok(typeof tracker.buildTrackerUserPrompt('m', 'n') === 'string');
    assert.ok(lorebook.sanitizeBookName('my chat #1') === 'my_chat_1');
    assert.ok(typeof interceptor.buildCoreInjection === 'function');
});

test('interceptor injects memo + rng into the current user message', async () => {
    const settings = await import('../src/settings.js');
    const chatState = await import('../src/chat-state.js');
    const interceptor = await import('../src/interceptor.js');

    // Seed a per-chat state with a memo.
    const state = settings.getChatState('smoke-chat');
    state.memo = chatState.buildStateMemo(chatState.normalizeState({
        character: { name: 'Aria', hp_current: 7, hp_max: 10 },
        inventory: ['Dagger'],
    }));

    const chat = [
        { is_user: true, mes: 'hello', role: 'user' },
    ];
    await interceptor.rpgTrackerInterceptor(chat, 4096, null, 'regular');
    const injected = chat[0].mes;
    assert.ok(injected.includes('<state_memo>'));
    assert.ok(injected.includes('Name: Aria'));
    assert.ok(injected.includes('hello'), 'original user text preserved');
});

test('slash command and dice tool registration are wired', async () => {
    const rng = await import('../src/rng.js');
    rng.registerDiceSlashCommand();
    rng.syncDiceTool();

    assert.ok(registered.slashCommands.some((s) => s.name === 'roll' || s.aliases?.includes('roll')));
    assert.ok(registered.functionTools.some((t) => t.name === 'roll_dice'));
});

test('extension prompt registration is called', async () => {
    const interceptor = await import('../src/interceptor.js');
    interceptor.syncMemoPromptRegistration();
    const calls = registered.extensionPrompts.filter((p) => p.name === 'trpg_framework_memo');
    assert.ok(calls.length >= 1);
});



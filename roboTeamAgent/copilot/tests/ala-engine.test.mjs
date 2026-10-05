import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAlaCommand } from '../../server/ala-command.mjs';
import { createAlaEngine } from '../src/lib/execution/alaEngine.mjs';
import { ConversationSessionStore } from '../src/lib/storage/conversationSessionStore.mjs';
import { HUMAN_REPORT_INSTRUCTIONS, INITIAL_SKILL_INSTRUCTIONS } from '../src/lib/prompts.mjs';

const childEntry = fileURLToPath(new URL('./fixtures/ala-engine-child.mjs', import.meta.url));

async function loadAlaConfigModule() {
    const root = path.dirname(path.dirname(await fs.realpath(resolveAlaCommand())));
    return import(pathToFileURL(path.join(root, 'src', 'config.mjs')).href);
}

test('queued native input permits another final event and returns the last execution result', async (t) => {
    const h = await harness(t);
    const events = [];
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'QUEUED_FOLLOWUP',
        onEvent: (event) => events.push(event) });
    assert.equal(events.filter((event) => event.type === 'coding-agent-final').length, 2);
    assert.equal(JSON.parse(result.outputText).prompt.includes('QUEUED_FOLLOWUP'), true);
});

test('the workspace root itself is a valid robot working directory', async (t) => {
    const h = await harness(t, {}, { workspaceAtRoot: true });
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'ROOT_WORKSPACE' });
    const output = JSON.parse(result.outputText);
    assert.equal(output.prompt.includes('ROOT_WORKSPACE'), true);
    assert.equal(output.resumed, false);
});
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

async function harness(t, interactions = {}, { workspaceAtRoot = false, execution = {}, webchatLogsBase = '' } = {}) {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'achilles-engine-'));
    const oldRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceAtRoot ? workingDir : path.dirname(workingDir);
    t.after(() => { if (oldRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = oldRoot; });
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    let records = [{ name: 'bash', description: 'Run commands', skillDir: workingDir, enabled: true }];
    // Each harness has its own robot home holding the ALA config.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'achilles-engine-home-'));
    const oldHome = process.env.ACHILLES_ALA_HOME;
    process.env.ACHILLES_ALA_HOME = home;
    t.after(() => { if (oldHome === undefined) delete process.env.ACHILLES_ALA_HOME; else process.env.ACHILLES_ALA_HOME = oldHome; });
    const alaConfig = await loadAlaConfigModule();
    const configFile = path.join(home, '.ala', 'config.json');
    const setModels = (models) => alaConfig.saveConfig(configFile, { codingAgent: 'codex', models, efforts: {} });
    await setModels({ codex: 'native-first' });
    const catalog = { async refresh() { return { skills: records.map((record) => ({ ...record })),
        taskRepositories: records.filter((record) => record.enabled).map((record) => record.skillDir) }; } };
    const installation = {
        entryPath: childEntry, loadConfig: alaConfig.loadConfig, saveConfig: alaConfig.saveConfig,
        async discoverCodingAgents() { return [{ name: 'codex', binary: process.execPath, available: true }]; },
    };
    const engine = createAlaEngine({ workingDir, sessionStore: store, skillCatalog: catalog, installation,
        execution, webchatLogsBase,
        settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'ask-for-approval' },
        interactions: { cancelTurn() {}, resolve() {}, ...interactions } });
    t.after(async () => { await engine.close(); await fs.rm(workingDir, { recursive: true, force: true }); await fs.rm(home, { recursive: true, force: true }); });
    return { workingDir, engine, store, installation, sessionId: session.sessionId, home, configFile,
        setSkills: (next) => { records = next; }, setModels };
}

test('a competing turn is rejected before placeholders, while native approval is waiting', { timeout: 15000 }, async (t) => {
    const requested = deferred();
    const answer = deferred();
    const h = await harness(t, { request() { requested.resolve(); return answer.promise; } });
    const first = h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'APPROVAL' });
    await requested.promise;
    const before = h.store.loadSession(h.sessionId);
    await assert.rejects(h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Competing prompt' }), /busy|running|lease|held/i);
    assert.deepEqual(h.store.loadSession(h.sessionId), before);
    answer.resolve('deny');
    const result = await first;
    assert.equal(JSON.parse(result.outputText).choice, 'deny');
    assert.equal(result.session.messages.filter((message) => message.role === 'assistant').length, 1);
    assert.equal(result.session.messages.at(-1).status, 'completed');
});

test('stderr final and stdout produce one persisted answer; live selection is prepared for the next turn', async (t) => {
    const originalSecret = process.env.PLOINKY_AGENT_SECRET;
    process.env.PLOINKY_AGENT_SECRET = 'parent-only-credential';
    t.after(() => {
        if (originalSecret === undefined) delete process.env.PLOINKY_AGENT_SECRET;
        else process.env.PLOINKY_AGENT_SECRET = originalSecret;
    });
    const h = await harness(t);
    const events = [];
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'PRIVATE_USER_PROMPT',
        context: { invocationToken: 'secret-token-for-test', rawText: 'Original UI request' }, onEvent: (event) => events.push(event) });
    const output = JSON.parse(result.outputText);
    assert.equal(output.privatePrompt, true);
    assert.equal(output.credential, null);
    assert.equal(output.model, 'native-first');
    assert.equal(output.modelOverride, null);
    assert.equal(output.ca, null);
    assert.equal(result.session.messages[0].text, 'Original UI request');
    assert.equal(result.session.messages[1].text, result.outputText);
    // Progress is transient: it is emitted as events but never persisted on the message.
    assert.deepEqual(result.session.messages[1].progress, []);
    assert.ok(events.some((event) => event.type === 'progress' && /Connecting to robot/.test(event.reason || '')));
    assert.ok(events.some((event) => event.type === 'progress' && event.reason === 'Starting ALA'));
    assert.ok(events.some((event) => event.type === 'coding-agent-message' && event.message === 'Visible progress'));
    assert.equal(events.filter((event) => event.type === 'coding-agent-final').length, 1);
    assert.equal(JSON.stringify(events).includes('secret-token-for-test'), false);
    assert.equal(JSON.stringify(result.session).includes('secret-token-for-test'), false);
    h.setSkills([{ name: 'bash', skillDir: h.workingDir, enabled: false }]);
    await h.setModels({});
    const next = JSON.parse((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Second' })).outputText);
    assert.equal(next.resumed, true);
    assert.equal(next.model, null);
    assert.equal(next.repositories, '');
    assert.deepEqual(next.config.models, {});
    assert.equal(next.prompt.includes('PRIVATE_USER_PROMPT'), false);
});

test('native metadata mismatch and missing continuation preserve the conversation byte-for-byte', async (t) => {
    const h = await harness(t);
    await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'First' });
    const transcript = path.join(h.workingDir, '.roboteam', '.ala', 'sessions', `${h.sessionId}.jsonl`);
    const original = await fs.readFile(transcript, 'utf8');
    const before = await fs.readFile(h.store.sessionPath(h.sessionId), 'utf8');
    await fs.appendFile(transcript, `${JSON.stringify({ seq: 999, type: 'continuation', agent: 'opencode', continuation: { sessionId: 'other' } })}\n`);
    await assert.rejects(h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Do not append' }), /mismatch/);
    assert.equal(await fs.readFile(h.store.sessionPath(h.sessionId), 'utf8'), before);
    await fs.writeFile(transcript, original);
    await fs.rm(transcript);
    await assert.rejects(h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Do not replace' }), /transcript is missing/);
    assert.equal(await fs.readFile(h.store.sessionPath(h.sessionId), 'utf8'), before);
});

test('UI history is never replayed and subsequent turns resume the native conversation', async (t) => {
    const h = await harness(t);
    const command = await h.store.beginCommand({ sessionId: h.sessionId, text: '/history' });
    await h.store.completeCommand(h.sessionId, command.assistantMessageId, 'EXCLUDED_COMMAND_RESULT');
    const previous = await h.store.beginTurn({ sessionId: h.sessionId, text: 'LEGACY_MARKER' });
    await h.store.completeTurn(h.sessionId, previous.assistantMessageId, 'Legacy reply');
    const first = JSON.parse((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Now' })).outputText);
    assert.ok(first.prompt.includes(INITIAL_SKILL_INSTRUCTIONS));
    assert.ok(first.prompt.includes(HUMAN_REPORT_INSTRUCTIONS));
    assert.ok(first.prompt.endsWith('\n\nNow'));
    assert.equal(first.prompt.includes('EXCLUDED_COMMAND_RESULT'), false);
    const second = JSON.parse((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Again' })).outputText);
    // The resumed native session already holds the system instructions.
    assert.equal(second.prompt, 'Again');
    assert.equal(second.resumed, true);
});

test('cancelling one owned child interrupts only its turn and releases its execution lease', { timeout: 15000 }, async (t) => {
    const requested = deferred();
    const h = await harness(t, { request(_event, { signal }) {
        requested.resolve();
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
    } });
    const other = await h.store.createSession();
    const controller = new AbortController();
    const first = h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'APPROVAL', signal: controller.signal });
    const rejected = assert.rejects(first, (error) => error.exitCode === 130);
    await requested.promise;
    const second = h.engine.executeTurn({ sessionId: other.sessionId, prompt: 'Unaffected session' });
    controller.abort();
    await rejected;
    assert.equal(h.store.loadSession(h.sessionId).messages.at(-1).status, 'interrupted');
    assert.equal((await second).session.messages.at(-1).status, 'completed');
    assert.equal((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Resume after interruption' })).session.messages.at(-1).status, 'completed');
});

for (const [prompt, expected] of [['MALFORMED', /Malformed mandatory ALA event JSON/], ['NONZERO', /ALA execution failed \(7\)/]]) {
    test(`${prompt} native failure is not a successful assistant answer`, { timeout: 15000 }, async (t) => {
        const h = await harness(t);
        await assert.rejects(h.engine.executeTurn({ sessionId: h.sessionId, prompt }), expected);
        assert.equal(h.store.loadSession(h.sessionId).messages.at(-1).status, 'failed');
    });
}

test('coding provider names remain ordinary prompts without removed launcher routing', async (t) => {
    const h = await harness(t);
    h.setSkills([
        { name: 'bash', skillDir: h.workingDir, enabled: true },
    ]);
    const delegated = JSON.parse((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Ask codex to review this project' })).outputText);
    assert.ok(delegated.prompt.endsWith('\n\nAsk codex to review this project'));
    const mentioned = JSON.parse((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'What is Codex?' })).outputText);
    assert.equal(mentioned.prompt, 'What is Codex?');
});


test('the prompt carries no workflow catalog; robots list workflows through a skill', async t => {
    const h = await harness(t);
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Review the report' });
    const output = JSON.parse(result.outputText);
    assert.match(output.prompt, /Review the report/);
    assert.doesNotMatch(output.prompt, /Available workflow types|catalog data/);
    assert.doesNotMatch(output.prompt, /You cannot run tasks yourself/);
});

test('explicit skill selection stays in the caller prompt without ALA skill options', async t => {
    const h = await harness(t);
    const output = JSON.parse((await h.engine.executeTurn({ sessionId: h.sessionId,
        prompt: 'Inspect the project', skillName: 'bash' })).outputText);
    assert.match(output.prompt, /Inspect the project/);
    assert.match(output.prompt, /Use the selected skill at \.agents\/skills\/bash\/SKILL\.md/);
    assert.equal(output.skill, null);
    await assert.rejects(h.engine.executeTurn({ sessionId: h.sessionId,
        prompt: 'Inspect', skillName: 'missing' }), /missing or disabled/);
});

test('model and effort persist in the native ALA config and survive continuation and reset', async (t) => {
    const api = await loadAlaConfigModule();
    const h = await harness(t);
    await h.engine.setModel({ sessionId: h.sessionId, backend: 'codex', model: 'native-new', effort: 'high' });
    const events = [];
    const first = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'First', onEvent: (event) => events.push(event) });
    assert.equal(events.find((event) => event.type === 'coding-agent-selected').effort, 'high');
    const file = path.join(first.session.engine.home, '.ala/config.json');
    assert.equal((await api.loadConfig(file)).efforts.codex, 'high');
    const output = JSON.parse(first.outputText);
    assert.equal(output.config.models.codex, 'native-new');
    assert.equal(output.config.efforts.codex, 'high');
    const next = JSON.parse((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Second' })).outputText);
    assert.equal(next.resumed, true);
    assert.equal(next.config.efforts.codex, 'high');
    await h.engine.setModel({ sessionId: h.sessionId, backend: 'codex', model: null });
    const reset = JSON.parse((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Third' })).outputText);
    assert.equal(reset.config.models.codex, undefined);
    assert.equal(reset.config.efforts.codex, undefined);
});


test('caller system instructions open the session once; resumed turns carry only the user message', async t => {
    const h = await harness(t, {}, { execution: { systemPrompt: 'Generate a directed task graph.' } });
    const first = JSON.parse((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'First request' })).outputText);
    assert.ok(first.prompt.startsWith('Generate a directed task graph.'));
    assert.ok(first.prompt.endsWith('First request'));
    const second = JSON.parse((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Second request' })).outputText);
    assert.equal(second.prompt, 'Second request');
    const transcript = h.store.loadSession(h.sessionId).messages.filter((message) => message.role === 'user').map((message) => message.text);
    assert.deepEqual(transcript, ['First request', 'Second request']);
    await assert.rejects(fs.stat(path.join(h.workingDir, '.roboteam', 'turns')), { code: 'ENOENT' });
});

test('a webchat turn links the coding-agent output ALA recorded for it', async (t) => {
    const h = await harness(t, {}, { webchatLogsBase: '/base-agent-additional-server/roboTeamAgent/3001/webchat-logs' });
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Thinking', context: { sourceTabId: 'tab-a' } });
    const answer = result.session.messages.at(-1);
    assert.match(answer.text,
        /\[View Thinking\]\(\/base-agent-additional-server\/roboTeamAgent\/3001\/webchat-logs\/[a-f0-9-]{36}\/[a-f0-9-]{36}\)/);
    const { turn, ala } = h.store.turnForMessage(h.sessionId, answer.id);
    assert.equal(turn.turnId, result.turnId);
    assert.deepEqual(ala.messages.map((entry) => entry.text), ['Visible progress']);
    assert.equal(ala.user, 'Thinking');
    await assert.rejects(fs.stat(path.join(h.workingDir, '.roboteam', 'logs')), { code: 'ENOENT' });
});

test('a non-webchat turn keeps only the answer without a log link', async (t) => {
    const h = await harness(t, {}, { webchatLogsBase: '/base-agent-additional-server/roboTeamAgent/3001/webchat-logs' });
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'No tab' });
    assert.equal(result.session.messages.at(-1).text.includes('View Thinking'), false);
    assert.equal(result.session.messages.at(-1).text, result.outputText);
});

test('workflow human-input channel is mounted explicitly into the native sandbox', async t => {
    const h = await harness(t);
    const previous = process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY;
    process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY = h.workingDir;
    t.after(() => {
        if (previous === undefined) delete process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY;
        else process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY = previous;
    });
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Check workflow callback mount' });
    assert.ok(JSON.parse(result.outputText).folders.some(folder => folder.source === h.workingDir && folder.alias === 'roboflow-human-input'));
});

test('an explicit task agent and model are passed to ALA; otherwise ALA reads them from the robot config', async t => {
    const plain = await harness(t);
    const fromConfig = JSON.parse((await plain.engine.executeTurn({ sessionId: plain.sessionId, prompt: 'Config' })).outputText);
    assert.deepEqual([fromConfig.ca, fromConfig.modelOverride, fromConfig.model], [null, null, 'native-first']);
    const task = await harness(t, {}, { execution: { backend: 'codex', model: 'task-model' } });
    const explicit = JSON.parse((await task.engine.executeTurn({ sessionId: task.sessionId, prompt: 'Task' })).outputText);
    assert.deepEqual([explicit.ca, explicit.modelOverride, explicit.model], ['codex', 'task-model', 'task-model']);
    assert.deepEqual(await task.engine.getModel({ sessionId: task.sessionId }), { backend: 'codex', model: 'task-model', effort: null });
});

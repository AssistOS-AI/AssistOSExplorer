import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RobotStore } from '../../server/robot-store.mjs';
import { RobotSkillsets } from '../../server/robot-skillsets.mjs';
import { resolveAlaInstallation } from '../src/lib/alaInstallation.mjs';
import { ConversationSessionStore, buildConversationInitialHistory } from '../src/lib/conversationSessionStore.mjs';
import { createRobotSkillCatalog } from '../src/lib/robotSkillCatalog.mjs';
import { REPLSession } from '../src/repl/REPLSession.mjs';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robot-repl-skills-')));
    const workingDir = path.join(root, 'workspace');
    await fs.mkdir(workingDir);
    const store = new RobotStore({ dataDir: path.join(root, 'private') });
    const robot = await store.create({ name: 'terminal-test' });
    const privateRoot = path.join(store.robotPath(robot.id), 'copilot');
    await fs.mkdir(privateRoot);
    const savedEnv = {};
    for (const [key, value] of Object.entries({ ROBOTEAM_COPILOT_ROOT: privateRoot, PLOINKY_WORKSPACE_ROOT: workingDir })) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
    }
    t.after(async () => {
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await fs.rm(root, { recursive: true, force: true });
    });
    const { discoverTaskSkills } = await resolveAlaInstallation();
    const skillsets = new RobotSkillsets({ robotStore: store, workspaceRoot: workingDir, scopeRoot: workingDir, discoverSkills: discoverTaskSkills });
    const sessionStore = new ConversationSessionStore({ workingDir });
    const first = await sessionStore.createSession();
    const second = await sessionStore.createSession();
    for (const session of [first, second]) await skillsets.policies.ensure(robot, session.sessionId, { input: { skillSets: ['workspace'] } });
    const descriptor = path.join(workingDir, '.agents/skills/local/SKILL.md');
    await fs.mkdir(path.dirname(descriptor), { recursive: true });
    const writeSkill = (body) => fs.writeFile(descriptor, `---\nname: local\ndescription: Local ${body}\n---\n${body}\n`);
    await writeSkill('original');
    const catalog = createRobotSkillCatalog({ context: { robot, store, skillsets }, sessionStore, workingDir, initialSessionId: first.sessionId });
    const nativeCalls = [];
    const engine = {
        async executeTurn(input) {
            nativeCalls.push(input);
            const snapshot = await catalog.refresh(input.sessionId, { execution: true });
            try {
                assert.ok(snapshot.skills.some((skill) => skill.name === input.skillName));
                const turn = await sessionStore.beginTurn({ sessionId: input.sessionId, text: input.context.rawText || input.prompt });
                const session = await sessionStore.completeTurn(input.sessionId, turn.assistantMessageId, 'Native result');
                return { session, outputText: 'Native result' };
            } finally { await snapshot.release(); }
        },
    };
    const history = [];
    const repl = new REPLSession(engine, { workingDir, sessionStore, skillCatalog: catalog,
        initialSession: first, renderMarkdown: false, historyManager: { add: async (input) => history.push(input) } });
    // Exercise the real terminal command dispatcher without raw stdin or spinner interaction.
    repl.nlProcessor.run = (operation) => operation({ signal: new AbortController().signal,
        controls: { suspendInput() {} }, spinner: { stop() {} }, onEvent() {} });
    const output = [], errors = [];
    t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
    await repl._activateConversation(first);
    const policy = (session = first) => skillsets.policies.read(robot.id, session.sessionId);
    return { root, workingDir, privateRoot, robot, skillsets, sessionStore, first, second, catalog, descriptor,
        writeSkill, nativeCalls, history, repl, output, errors, policy };
}

test('terminal /skills use, pin and live update the authoritative policy and preserve command history', async (t) => {
    const f = await fixture(t);
    await f.repl._handleSlashCommand('/skills use none');
    assert.deepEqual((await f.policy()).selectors.skillSets, []);
    assert.deepEqual((await f.policy(f.second)).selectors.skillSets, ['workspace']);
    assert.equal(f.repl.skillCatalog.getSkill('local'), undefined);
    await f.repl._handleSlashCommand('/skills use workspace');
    assert.equal(f.repl.skillCatalog.getSkill('local').enabled, true);
    await f.repl._handleSlashCommand('/exec local inspect');
    assert.equal(f.nativeCalls.length, 1);
    assert.equal(f.nativeCalls[0].sessionId, f.first.sessionId);
    assert.equal(f.nativeCalls[0].prompt, 'inspect');
    const revision = f.sessionStore.loadSession(f.first.sessionId).skillExecution.revision;
    await f.repl._handleSlashCommand('/skills pin');
    assert.equal((await f.policy()).mode, 'pinned');
    assert.equal((await f.policy()).pinnedCatalog.revision, revision);
    await f.writeSkill('changed');
    await f.repl._handleSlashCommand('/read local');
    assert.match(f.output.at(-1), /original/);
    await f.repl._handleSlashCommand('/skills live');
    assert.equal((await f.policy()).mode, 'live');
    await f.repl._handleSlashCommand('/read local');
    assert.match(f.output.at(-1), /changed/);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.history, ['/skills use none', '/skills use workspace', '/exec local inspect', '/skills pin', '/read local', '/skills live', '/read local']);
    const session = f.sessionStore.loadSession(f.first.sessionId);
    assert.deepEqual(buildConversationInitialHistory(session), [
        { role: 'user', message: '/exec local inspect' }, { role: 'assistant', message: 'Native result' },
    ]);
    assert.equal(session.messages.filter((message) => message.role === 'user').length, f.history.length);
    assert.equal(f.sessionStore.loadSession(f.second.sessionId).messages.length, 0);
});

test('terminal session resume and new bind listing, reads, reload, completion and native execution to the selected conversation', async (t) => {
    const f = await fixture(t);
    await f.repl._handleSlashCommand('/skills use none');
    const firstCatalog = f.repl.skillCatalog;
    await f.repl._handleSlashCommand(`/session resume ${f.second.sessionId}`);
    assert.equal(f.repl.currentConversation.sessionId, f.second.sessionId);
    assert.equal(f.repl.skillCatalog.getSkill('local').enabled, true);
    assert.equal(f.repl.quickCommands.getAllSkills().find((skill) => skill.name === 'local').enabled, true);
    assert.equal(f.repl.inputPrompt.getAllSkills().find((skill) => skill.name === 'local').enabled, true);
    await f.writeSkill('after-switch');
    await f.repl._handleSlashCommand('/reload');
    assert.match(f.repl.skillCatalog.getSkill('local').description, /after-switch/);
    assert.match(firstCatalog.getSkills().find((skill) => skill.name === 'local').description, /original/);
    await f.repl._handleSlashCommand('/list skills');
    assert.match(f.output.at(-1), /local \[anthropic\] — Local after-switch/);
    await f.repl._handleSlashCommand('/read local');
    assert.match(f.output.at(-1), /after-switch/);
    await f.repl._handleSlashCommand('/exec local second');
    assert.equal(f.nativeCalls[0].sessionId, f.second.sessionId);
    await f.repl._handleSlashCommand(`/session resume ${f.first.sessionId}`);
    assert.equal(f.repl.skillCatalog.getSkill('local'), undefined);
    await f.repl._handleSlashCommand('/read local');
    assert.match(f.output.at(-1), /missing, disabled or ambiguous/);
    assert.deepEqual((await f.policy()).selectors.skillSets, []);
    await f.repl._handleSlashCommand('/session new');
    const third = f.repl.currentConversation;
    assert.notEqual(third.sessionId, f.first.sessionId);
    assert.notEqual(third.sessionId, f.second.sessionId);
    assert.equal(f.repl.skillCatalog.getSkill('local'), undefined);
    await f.repl._handleSlashCommand('/skills use workspace');
    assert.deepEqual((await f.policy(third)).selectors.skillSets, ['workspace']);
    assert.deepEqual((await f.policy()).selectors.skillSets, []);
});

test('terminal rejects old skill and directory toggles without changing selection or shared disabled names', async (t) => {
    const f = await fixture(t);
    const before = await f.policy();
    for (const command of ['/skill disable local', '/skill enable local', '/skills disable .agents', '/skills enable .agents']) {
        await f.repl._handleSlashCommand(command);
    }
    assert.deepEqual(await f.policy(), before);
    assert.equal(f.repl.skillCatalog.getSkill('local').enabled, true);
    assert.deepEqual(f.history, []);
    assert.equal(f.errors.length, 4);
    assert.match(f.errors[0], /Use \/skills use/);
    const settings = JSON.parse(await fs.readFile(path.join(f.privateRoot, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.disabledSkills || [], []);
    const session = f.sessionStore.loadSession(f.first.sessionId);
    assert.equal(session.messages.filter((message) => message.role === 'assistant' && message.status === 'failed').length, 4);
    assert.deepEqual(buildConversationInitialHistory(session), []);
});

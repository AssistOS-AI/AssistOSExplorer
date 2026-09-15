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

test('removed terminal commands do not change configured skills or execute a model', async (t) => {
    const f = await fixture(t);
    const before = await f.policy();
    for (const command of ['/skills use none', '/skills pin', '/skill disable local', '/read local', '/list skills', '/list repos', '/reload', '/raw', '/add repo https://example.test/repo', '/remove skill local', '/update repos']) {
        await f.repl._handleSlashCommand(command);
    }
    assert.deepEqual(await f.policy(), before);
    assert.deepEqual(f.nativeCalls, []);
    assert.deepEqual(f.history, []);
    assert.equal(f.repl.markdownEnabled, false);
    assert.equal(f.repl.skillCatalog.getSkill('local').enabled, true);
    assert.equal(await fs.readFile(f.descriptor, 'utf8').then((text) => text.includes('original')), true);
    for (const alias of ['reload', 'list', 'ls', 'list all', 'ls -a']) {
        assert.equal(f.repl.quickCommands.isQuickCommand(alias), false);
        assert.deepEqual(f.repl.quickCommands.execute(alias), { handled: false });
    }
});

test('terminal session selection still refreshes configured skills and supports explicit execution', async (t) => {
    const f = await fixture(t);
    await f.repl._handleSlashCommand('/session resume ' + f.second.sessionId);
    assert.equal(f.repl.currentConversation.sessionId, f.second.sessionId);
    await f.writeSkill('after-switch');
    await f.repl._handleSlashCommand('/exec local inspect');
    assert.equal(f.nativeCalls[0].sessionId, f.second.sessionId);
    assert.equal(f.nativeCalls[0].prompt, 'inspect');
    assert.match(f.repl.skillCatalog.getSkill('local').description, /after-switch/);
    assert.deepEqual(buildConversationInitialHistory(f.sessionStore.loadSession(f.second.sessionId)), [
        { role: 'user', message: '/exec local inspect' }, { role: 'assistant', message: 'Native result' },
    ]);
    assert.deepEqual(f.errors, []);
});

test('terminal list robots uses the supplied workspace catalog without ALA', async (t) => {
    const f = await fixture(t);
    f.repl.slashHandler.listRobots = async () => [{ name: 'default', specialization: 'Copilot' }];
    await f.repl._handleSlashCommand('/list robots');
    assert.match(f.output.at(-1), /default · Copilot/);
    assert.deepEqual(f.nativeCalls, []);
    assert.deepEqual(f.errors, []);
});

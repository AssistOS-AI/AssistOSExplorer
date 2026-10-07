import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { skillCatalogRequest } from '../server/skill-catalog-api.mjs';
import { installLiveSkills } from '../server/live-skill-install.mjs';
import { DEFAULT_ROBOT_ID, OTHER_ROBOT_ID, SECOND_IDENTITY, SKILL_IDENTITY, createConversationSkillsFixture } from './helpers/conversation-skills-fixture.mjs';

// The module under test is imported inside each test so that a missing module
// fails one named test instead of the whole file.
const load = () => import('../server/conversation-skills-api.mjs');
const MISMATCH = 'This conversation uses another robot. Open it with that robot, or create a new session.';

async function setup(t, { spy = false } = {}) {
    const api = await load();
    const f = await createConversationSkillsFixture();
    t.after(() => f.close());
    const { sessionId } = await f.addSession();
    const calls = [];
    const catalogRequest = async ({ skillsets, robot, ...rest }) => {
        assert.equal(skillsets, f.skillsets);
        calls.push(structuredClone({ robot: robot.id, ...rest }));
        return skillCatalogRequest({ skillsets, robot, ...rest });
    };
    const context = { robotStore: f.robotStore, skillsets: f.skillsets, ...(spy ? { catalogRequest } : {}) };
    const read = (id = sessionId, robotId = DEFAULT_ROBOT_ID) => api.readConversationSkills(context, { robotId, sessionId: id });
    const set = (body, id = sessionId, robotId = DEFAULT_ROBOT_ID) => api.setConversationSkill(context, { robotId, sessionId: id, body });
    return { ...f, ...api, sessionId, calls, context, read, set };
}

const row = (catalog, identity) => catalog.skills.find(skill => skill.identity === identity);
const defaultsFiles = async (f, robotId = DEFAULT_ROBOT_ID) => (await f.policyFiles(robotId)).filter(name => name.startsWith('defaults-'));

test('the path matcher takes exactly the two-segment conversation skills API path', async () => {
    const { matchConversationSkillsPath } = await load();
    const sid = crypto.randomUUID();
    assert.deepEqual(matchConversationSkillsPath(`/api/robots/default-abc123/conversations/${sid}/skills`), { robotId: 'default-abc123', sessionId: sid });
    for (const pathname of ['/api/robots/default-abc123/conversations/skills', `/api/robots/default-abc123/conversations/${sid}`,
        `/api/robots/default-abc123/conversations/${sid}/skills/`, `/api/robots/default-abc123/conversations/${sid}/skills/x`,
        `/api/robots/a/b/conversations/${sid}/skills`, `/api/robots//conversations/${sid}/skills`, `/api/robots/default-abc123/skillsets`]) {
        assert.equal(matchConversationSkillsPath(pathname), null, pathname);
    }
});

test('reading a conversation passes only its session id to the catalog and lists its selection', async t => {
    const f = await setup(t, { spy: true });
    const catalog = await f.read();
    assert.deepEqual(f.calls, [{ robot: DEFAULT_ROBOT_ID, input: { sessionId: f.sessionId } }]);
    assert.equal(catalog.scope, 'conversation');
    assert.equal(catalog.sessionId, f.sessionId);
    assert.equal(catalog.robot, 'default');
    assert.equal(catalog.cwd, f.project);
    assert.equal(row(catalog, SKILL_IDENTITY).state, 'available');
    assert.equal(row(catalog, SKILL_IDENTITY).enabled, false);
    assert.equal(row(catalog, 'required/human-report').readOnly || row(catalog, 'required/human-report').required, true);
    assert.deepEqual(await defaultsFiles(f), []);
});

test('a toggle sends the three-field body with the session id and never a directory', async t => {
    const f = await setup(t, { spy: true });
    const { policyVersion } = await f.read();
    const changed = await f.set({ identity: SKILL_IDENTITY, enabled: true, policyVersion });
    assert.deepEqual(f.calls[1], { robot: DEFAULT_ROBOT_ID, mutate: true,
        input: { sessionId: f.sessionId, identity: SKILL_IDENTITY, enabled: true, policyVersion } });
    assert.equal(changed.policyVersion, policyVersion + 1);
    assert.equal(row(changed, SKILL_IDENTITY).enabled, true);
    assert.ok(changed.policy.selectors.skills.includes(SKILL_IDENTITY));
    const reread = await f.read();
    assert.equal(row(reread, SKILL_IDENTITY).enabled, true);
    assert.equal(reread.policyVersion, policyVersion + 1);
    assert.ok(await f.policyFile(DEFAULT_ROBOT_ID, f.sessionId));
    assert.deepEqual(await defaultsFiles(f), []);
});

test('malformed ids are rejected before any lookup and well-formed unknown ids are not found', async t => {
    const f = await setup(t, { spy: true });
    for (const robotId of ['', 'Default', 'ab', 'x'.repeat(65), '../x', 'default abc']) {
        await assert.rejects(f.read(f.sessionId, robotId), { statusCode: 400, message: 'invalid robot id' }, robotId);
    }
    for (const id of ['', 'not-a-uuid', f.sessionId.toUpperCase(), `${f.sessionId}0`, '../etc/passwd']) {
        await assert.rejects(f.read(id), { statusCode: 400, message: 'invalid conversation id' }, id);
    }
    assert.deepEqual(f.calls, []);
    await assert.rejects(f.read(f.sessionId, 'missing-abc123'), { statusCode: 404, message: 'robot not found' });
    await assert.rejects(f.read(crypto.randomUUID()), { statusCode: 404, message: 'Conversation is unavailable in registered projects' });
    await assert.rejects(f.read(f.sessionId, OTHER_ROBOT_ID), { statusCode: 409, message: MISMATCH });
    await assert.rejects(f.set({ identity: SKILL_IDENTITY, enabled: true, policyVersion: 1 }, f.sessionId, OTHER_ROBOT_ID),
        { statusCode: 409, message: MISMATCH });
    assert.deepEqual(await f.policyFiles(OTHER_ROBOT_ID), []);
    assert.deepEqual(await f.policyFiles(DEFAULT_ROBOT_ID).then(names => names.filter(name => name.startsWith('defaults-'))), []);
});

test('a conversation present in two registered folders is a 409, not a server failure', async t => {
    const f = await setup(t);
    const second = path.join(f.workspaceRoot, 'second');
    await fs.mkdir(path.join(second, '.roboteam', 'sessions'), { recursive: true });
    const { registerProject } = await import('../server/project-storage.mjs');
    registerProject({ dataDir: f.dataDir, workspaceRoot: f.workspaceRoot }, second);
    await fs.copyFile(path.join(f.project, '.roboteam', 'sessions', `${f.sessionId}.json`), path.join(second, '.roboteam', 'sessions', `${f.sessionId}.json`));
    await assert.rejects(f.read(), { statusCode: 409, message: /multiple folders/ });
    await assert.rejects(f.set({ identity: SKILL_IDENTITY, enabled: true, policyVersion: 1 }), { statusCode: 409, message: /multiple folders/ });
});

test('boundary: a stale or malformed policyVersion and an unavailable identity leave the policy file untouched', async t => {
    const f = await setup(t);
    const first = await f.set({ identity: SKILL_IDENTITY, enabled: true, policyVersion: (await f.read()).policyVersion });
    const file = f.policyFile(DEFAULT_ROBOT_ID, f.sessionId);
    const before = await f.digest(file);
    for (const policyVersion of [2 ** 53, -1, '1', 1.5, null, undefined, Number.NaN]) {
        await assert.rejects(f.set({ identity: SKILL_IDENTITY, enabled: false, policyVersion }), { statusCode: 400 }, String(policyVersion));
    }
    for (const identity of ['', 5, null, undefined]) {
        await assert.rejects(f.set({ identity, enabled: false, policyVersion: first.policyVersion }), { statusCode: 400 }, String(identity));
    }
    await assert.rejects(f.set({ identity: '技能/名字', enabled: false, policyVersion: first.policyVersion }),
        { statusCode: 400, message: 'skill identity is unavailable' });
    await assert.rejects(f.set({ identity: 'required/human-report', enabled: false, policyVersion: first.policyVersion }),
        { statusCode: 400, message: 'Required skills are read-only' });
    assert.equal(await f.digest(file), before);
    assert.equal((await f.read()).policyVersion, first.policyVersion);
});

test('error injection: the body must be exactly identity, enabled and policyVersion', async t => {
    const f = await setup(t);
    const { policyVersion } = await f.read();
    const good = { identity: SKILL_IDENTITY, enabled: true, policyVersion };
    await assert.rejects(f.set({ ...good, dir: '/tmp' }), { statusCode: 400, message: 'unexpected field: dir' });
    await assert.rejects(f.set({ ...good, sessionId: crypto.randomUUID() }), { statusCode: 400, message: 'unexpected field: sessionId' });
    await assert.rejects(f.set(JSON.parse('{"identity":"a/b","enabled":true,"policyVersion":1,"__proto__":{}}')), { statusCode: 400, message: 'unexpected field: __proto__' });
    for (const body of [{ identity: SKILL_IDENTITY, enabled: true }, { enabled: true, policyVersion }, {}]) {
        await assert.rejects(f.set(body), { statusCode: 400, message: 'identity, enabled and policyVersion are required' });
    }
    for (const body of [null, [], 'text', 5]) await assert.rejects(f.set(body), { statusCode: 400 });
    await assert.rejects(f.set({ ...good, enabled: 'true' }), { statusCode: 400, message: 'enabled must be a boolean' });
    await assert.rejects(f.set({ ...good, enabled: 1 }), { statusCode: 400, message: 'enabled must be a boolean' });
    assert.deepEqual(await f.policyFiles(DEFAULT_ROBOT_ID), []);
});

test('idempotency: replaying a successful toggle is a 409 and changes neither version nor file bytes', async t => {
    const f = await setup(t);
    const body = { identity: SKILL_IDENTITY, enabled: true, policyVersion: (await f.read()).policyVersion };
    const first = await f.set(body);
    const file = f.policyFile(DEFAULT_ROBOT_ID, f.sessionId);
    const bytes = await fs.readFile(file);
    await assert.rejects(f.set(body), { statusCode: 409, message: 'skill policy changed; reload before updating' });
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.equal((await f.read()).policyVersion, first.policyVersion);
});

test('concurrency: two toggles with the same version produce one success and one 409', async t => {
    const f = await setup(t);
    const { policyVersion } = await f.read();
    const results = await Promise.allSettled([SKILL_IDENTITY, SECOND_IDENTITY]
        .map(identity => f.set({ identity, enabled: true, policyVersion })));
    assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409);
    assert.equal((await f.read()).policyVersion, policyVersion + 1);
    assert.deepEqual(await defaultsFiles(f), []);
});

test('toggling one conversation does not change a sibling conversation or the robot defaults', async t => {
    const f = await setup(t);
    const sibling = await f.addSession();
    const siblingBefore = await f.read(sibling.sessionId);
    await f.set({ identity: SKILL_IDENTITY, enabled: true, policyVersion: (await f.read()).policyVersion });
    assert.equal(row(await f.read(sibling.sessionId), SKILL_IDENTITY).enabled, siblingBefore.skills.find(skill => skill.identity === SKILL_IDENTITY).enabled);
    assert.deepEqual(await f.policyFiles(DEFAULT_ROBOT_ID), [`${f.sessionId}.json`]);
});

test('the next execution installs exactly the skills the page enabled', async t => {
    const f = await setup(t);
    const robot = await f.robotStore.get(DEFAULT_ROBOT_ID);
    const cwd = path.join(f.project, 'run');
    await fs.mkdir(cwd);
    const links = path.join(cwd, '.agents', 'skills');
    // A fake repository client that creates the symbolic links it is asked to publish.
    const repositories = [{ name: 'DocumentationSkills', source: path.join(f.workspaceRoot, 'DocumentationSkills'), origin: 'workspace' },
        { name: 'ProjectSkills', source: f.repository, origin: 'workspace' },
        { name: 'AchillesCLI', source: path.resolve(fileURLToPath(new URL('../..', import.meta.url))), origin: 'workspace' }];
    const client = {
        listRepositories: async () => repositories,
        install: async ({ repos }) => {
            await fs.mkdir(links, { recursive: true });
            for (const entry of repos) await fs.symlink(path.join(repositories.find(repo => repo.name === entry.repoName).source, entry.sourcePath), entry.destination).catch(error => { if (error.code !== 'EEXIST') throw error; });
            return { conflicts: [] };
        },
        remove: async paths => { for (const destination of paths) await fs.rm(destination, { force: true }); return { conflicts: [] }; },
    };
    const installed = async () => (await fs.readdir(links).catch(() => [])).sort();
    const { policyVersion } = await f.read();
    await f.set({ identity: SKILL_IDENTITY, enabled: true, policyVersion });
    const on = await installLiveSkills({ service: f.skillsets, robot, policyId: f.sessionId, cwd, client });
    assert.ok(on.entries.some(entry => entry.identity === SKILL_IDENTITY));
    assert.ok((await installed()).includes('probe-skill'));
    assert.equal((await installed()).includes('report-task-blocked'), false);
    const workflow = await installLiveSkills({ service: f.skillsets, robot, policyId: f.sessionId, cwd, client, workflowExecution: true });
    const failure = workflow.entries.find(entry => entry.name === 'report-task-blocked');
    assert.ok(failure?.required && failure.readOnly && failure.executionOnly);
    await fs.access(path.join(failure.sourcePath, 'scripts/run.mjs'));
    assert.equal((await installed()).includes('report-task-blocked'), false);
    assert.equal((await f.read()).skills.some(entry => entry.identity === 'required/report-task-blocked'), false);
    assert.equal((await installed()).includes('second-skill'), false);
    // Reconcile an owned link left by the earlier globally installed version.
    const obsolete = path.join(links, 'report-task-blocked');
    await fs.symlink(failure.sourcePath, obsolete);
    const stateFile = path.join(cwd, '.agents', '.roboteam-links.json');
    const installedRecords = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    installedRecords.push({ repoName: 'AchillesCLI', destination: obsolete, sourcePath: 'roboTeamAgent/copilot/src/skills/report-task-blocked', linkTarget: failure.sourcePath });
    await fs.writeFile(stateFile, JSON.stringify(installedRecords));
    await f.set({ identity: SKILL_IDENTITY, enabled: false, policyVersion: policyVersion + 1 });
    const off = await installLiveSkills({ service: f.skillsets, robot, policyId: f.sessionId, cwd, client });
    assert.equal(off.entries.some(entry => entry.identity === SKILL_IDENTITY), false);
    assert.equal((await installed()).includes('probe-skill'), false);
    assert.equal((await installed()).includes('report-task-blocked'), false);
});

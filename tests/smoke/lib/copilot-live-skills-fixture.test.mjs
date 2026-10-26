import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createLiveSkillsFixture, liveSkillSources, liveSkillsHash, liveSkillsPrompt, policyEvidence, validateLiveSkillsTurn } from './copilot-live-skills.mjs';
import { readLiveSkillsSnapshot } from './copilot-live-skills-runtime.mjs';
import { createOwnedLiveSkillsFixture, liveSkillsPhasePlan, defaultRobotEvidence, assertLiveSkillsLivePreflight, liveSkillsOwnedLaunchURL, assertCodexDelegationLiveBlocked, LIVE_SKILLS_RELEASE_VERIFIER } from './copilot-live-skills-fixture.mjs';
import { operateLiveSkillsFixture } from './copilot-live-skills-fixture-runtime.mjs';
import { withLiveSkillsProjection } from './copilot-live-skills-test-fixture.mjs';

async function harness(t) {
    assert.ok(process.env.SET2_ACHILLES_SOURCE && process.env.SET2_PLOINKY_SOURCE && process.env.SET2_ALA_COMMAND);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'set2 owned ü ')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = `${root}/AchillesIDE`, codeRoot = `${repository}/roboTeamAgent`, dataRoot = `${root}/_data`;
    fs.mkdirSync(repository);
    fs.cpSync(`${process.env.SET2_ACHILLES_SOURCE}/roboTeamAgent`, codeRoot, { recursive: true,
        filter: from => !from.split(path.sep).some(part => ['node_modules', '.git'].includes(part)) });
    const alaSource = path.dirname(path.dirname(fs.realpathSync(process.env.SET2_ALA_COMMAND))), alaRoot = `${root}/AdvancedLanguageAgent`;
    for (const file of ['package.json', 'bin/ala.mjs', 'src/transcript.mjs']) {
        fs.mkdirSync(path.dirname(`${alaRoot}/${file}`), { recursive: true }); fs.copyFileSync(`${alaSource}/${file}`, `${alaRoot}/${file}`);
    }
    const expectedAla = { root: alaRoot, command: `${alaRoot}/bin/ala.mjs`, hashes: Object.fromEntries(['package.json', 'bin/ala.mjs', 'src/transcript.mjs']
        .map(file => [file, liveSkillsHash(fs.readFileSync(`${alaRoot}/${file}`))])) };
    process.env.PLOINKY_WORKSPACE_ROOT = root; process.env.ACHILLES_ALA_COMMAND = expectedAla.command;
    const module = relative => import(pathToFileURL(`${codeRoot}/${relative}`).href);
    const { RobotSkillsets, publicRepositories } = await module('server/robot-skillsets.mjs');
    const { skillCatalogRequest } = await module('server/skill-catalog-api.mjs');
    const { installLiveSkills } = await module('server/live-skill-install.mjs');
    const { alaSkillMountArguments } = await module('copilot/src/lib/execution/alaSkillMounts.mjs');
    const { registerProject } = await module('server/project-storage.mjs');
    const { createTranscriptRecorder } = await import(pathToFileURL(`${alaSource}/src/transcript-recorder.mjs`).href);
    const { installRepositoryLinks, removeRepositoryLinks } = await import(pathToFileURL(`${process.env.SET2_PLOINKY_SOURCE}/cli/utils/repositoryInstall.mjs`).href);
    const { listWorkspaceSkillRepositories } = await import(pathToFileURL(`${process.env.SET2_PLOINKY_SOURCE}/cli/utils/skillRepositorySource.js`).href);
    const descriptors = new Map();
    const fsApi = { ...fs, openSync(file, flags) { const fd = fs.openSync(file, flags); descriptors.set(fd, file); return fd; },
        closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
        realpathSync(file) { if (process.platform !== 'linux' && /^\/proc\/self\/fd\/\d+$/.test(file)) return fs.realpathSync(descriptors.get(Number(path.basename(file)))); return fs.realpathSync(file); } };
    const fixture = createLiveSkillsFixture(root), robots = new Map(), mutations = [], calls = [];
    const defaultRobot = { schema: 'roboteam-robot-v1', id: 'existing-default', name: 'default', codingAgents: ['opencode'], skillsets: [] };
    robots.set(defaultRobot.id, defaultRobot);
    const robotPath = id => `${dataRoot}/robots/${id}`;
    const save = robot => { robots.set(robot.id, robot); fs.mkdirSync(robotPath(robot.id), { recursive: true }); fs.writeFileSync(`${robotPath(robot.id)}/metadata.json`, JSON.stringify(robot)); };
    save(defaultRobot);
    const store = { dataDir: dataRoot, robotPath, get: async id => robots.get(id) || null,
        async withRobot(id, callback) { assert.notEqual(id, defaultRobot.id); mutations.push(id); return callback(robots.get(id), async robot => save(robot)); } };
    const docs = `${root}/DocumentationSkills`; fs.mkdirSync(`${docs}/.git`, { recursive: true }); fs.mkdirSync(`${docs}/skills/human-report`, { recursive: true });
    fs.writeFileSync(`${docs}/skills/human-report/SKILL.md`, '---\nname: human-report\ndescription: Summarize the result.\n---\nReport the requested result.\n');
    const listRepositories = async () => listWorkspaceSkillRepositories({ workspaceRoot: root }).map(repo => ({ ...repo, kind: 'skills' }));
    const client = { listRepositories, prepareRepository: async () => assert.fail('Fixture tests must never install/download repositories.'),
        install: async input => installRepositoryLinks(input, { workspaceRoot: root, resolveRepository: name => fs.existsSync(`${root}/${name}`) ? { source: `${root}/${name}` } : null }),
        remove: async paths => removeRepositoryLinks(paths, { workspaceRoot: root }) };
    const service = new RobotSkillsets({ robotStore: store, workspaceRoot: root, alaCommand: expectedAla.command, repositoriesClient: client });
    const publicRobot = robot => ({ id: robot.id, name: robot.name, codingAgents: robot.codingAgents, repositories: publicRepositories(robot), skillsets: [], skillRepositories: [] });
    const api = async input => {
        calls.push(input);
        if (input.path === 'api/robots' && !input.method) return { status: 200, payload: { canAdmin: true, robots: [...robots.values()].map(publicRobot) } };
        if (input.path === 'api/robots' && input.method === 'POST') {
            const robot = { schema: 'roboteam-robot-v1', id: 'owned-codex-robot', ...input.body, skillsets: [] };
            save(robot); fs.mkdirSync(`${robotPath(robot.id)}/home`); return { status: 201, payload: { robot: publicRobot(robot) } };
        }
        if (input.path === `api/robots/${fixture.robotId}/skillsets`) {
            if (input.method === 'POST') await service.add(fixture.robotId, input.body);
            else await service.remove(fixture.robotId, input.body.name);
            return { status: 200, payload: { ok: true } };
        }
        if (input.path === 'api/control' && input.body.operation === 'robot-delete') {
            assert.equal(input.body.robotId, fixture.robotId); robots.delete(fixture.robotId); fs.rmSync(robotPath(fixture.robotId), { recursive: true });
            return { status: 200, payload: { ok: true } };
        }
        assert.fail(`Unexpected fixture API ${input.path}`);
    };
    const fsTool = async (tool, input) => {
        const file = `${root}/${input.path}`;
        if (tool === 'create_directory') { fs.mkdirSync(file, { recursive: true }); return { rawText: `Successfully created directory ${input.path}` }; }
        if (tool === 'write_file') { fs.writeFileSync(file, input.content); return { rawText: `Successfully wrote to ${input.path}` }; }
        if (tool === 'read_file') return { rawText: fs.readFileSync(file, 'utf8') };
        assert.fail(tool);
    };
    const contractFiles = ['server/robot-skillsets.mjs', 'copilot/src/lib/storage/conversationSessionStore.mjs', 'copilot/src/lib/execution/alaTranscript.mjs'];
    const contractHashes = Object.fromEntries(contractFiles.map(file => [file, liveSkillsHash(fs.readFileSync(`${codeRoot}/${file}`))]));
    const operate = async action => { let result; await operateLiveSkillsFixture({ action, fixture, workspaceRoot: root, expectedRepository: repository, contractHashes },
        { codeRoot, dataRoot, service, fsApi, emit: value => { result = value; } }); return result; };
    const makeController = overrides => createOwnedLiveSkillsFixture({ fixture, workspaceRoot: root, api, listRepositories, fsTool, operate, ...overrides });
    const controller = makeController();
    const inventory = id => skillCatalogRequest({ skillsets: service, robot: robots.get(fixture.robotId), input: id ? { sessionId: id } : {} });
    const defaultEvidence = async () => defaultRobotEvidence(publicRobot(defaultRobot), await skillCatalogRequest({ skillsets: service, robot: defaultRobot }));
    return { root, repository, codeRoot, dataRoot, fixture, controller, service, robots, store, mutations, calls, client, inventory, defaultEvidence,
        registerProject, installLiveSkills, alaSkillMountArguments, createTranscriptRecorder, expectedAla, contractFiles, operate, fsApi, makeController };
}

// The complete C5 environment the route-A parent hands to the runner (scripts/codex-test-auth.mjs, CODEX_TEST_AUTH_GATE=c5).
const C5_ENV = Object.freeze({ SMOKE_COPILOT_LIVE_SKILLS: '1', CODEX_TEST_AUTH_GATE: 'c5', CODEX_TEST_AUTH_SOURCE: 'owner',
    SMOKE_RUN_ID: '0f2b6c1e-8a4d-4c3b-9e5f-7a1b2c3d4e5f', CODEX_TEST_AUTH_ROOT: '/state/assistos-codex-test-auth', SMOKE_ARTIFACT_DIR: '/evidence/c5',
    SMOKE_WORKSPACE_ROOT: '/work/box', SMOKE_RELEASE_MANIFEST: '/evidence/manifest.json', SMOKE_ALA_COMMAND: '/work/box/AdvancedLanguageAgent/bin/ala.mjs',
    SMOKE_DEPLOYMENT_MODE: 'box', SMOKE_PLOINKY_BOX_CONTAINER: 'ploinky-box-fake', SMOKE_BOX_BASE_URL: 'http://127.0.0.1:8097',
    SMOKE_COPILOT_RELEASE_VERIFIER: LIVE_SKILLS_RELEASE_VERIFIER });

test('step4 deployed spec uses owned registration before conversation setup and runs the route-A preflight with its environment', () => {
    const source = fs.readFileSync(new URL('../specs/06-copilot-live-skills.spec.mjs', import.meta.url), 'utf8');
    assert.ok(source.includes('evidence.ownership = await owned.setup()'), 'Spec still uses an unregistered workspace source.');
    assert.ok(source.includes('liveSkillsOwnedLaunchURL'), 'Spec still launches the existing default robot.');
    assert.match(source, /test\.beforeAll\(\(\) => assertLiveSkillsLivePreflight\(process\.env\)\)/);
    assert.doesNotMatch(source, /verifyCopilot421Bundle/, 'Spec 06 must not fall back to the 421 verifier.');
    // The lifecycle order: begin, recovery, derive, marker, setup, qualify, inject, then the first turn.
    const order = ['lifecycle.begin(', 'lifecycle.recover(', 'lifecycle.derive()', 'lifecycle.mark(fixture)', 'evidence.ownership = await owned.setup()',
        'lifecycle.qualify(robot()', 'lifecycle.inject(robot())', 'await turn(phases[0], 0)'].map(needle => source.indexOf(needle));
    assert.ok(order.every(index => index >= 0) && order.every((index, at) => at === 0 || index > order[at - 1]), `lifecycle order ${order}`);
    // G2 in the finally block: settle (copy check, removal, CLI exit), then the owned cleanup, then finish.
    const settle = source.indexOf('settled = await lifecycle.settle(robot())'), cleanup = source.indexOf('await lifecycle.cleanup(owned)'),
        finish = source.indexOf('evidence.credential = await lifecycle.finish()');
    assert.ok(settle > 0 && settle < cleanup && cleanup < finish);
    assert.ok(source.indexOf('await lifecycle.beforeTurn(robot(), index)') < source.indexOf("evidence.currentPhase = { label, stage: 'baseline'"));
    assert.ok(source.indexOf('lifecycle.beforeSubmit()') < source.indexOf("await copilot.locator('#send').click()"));
});

test('the C5 preflight refuses an empty environment, naming SMOKE_COPILOT_LIVE_SKILLS, and returns the run identity for a complete one', () => {
    assert.throws(() => assertLiveSkillsLivePreflight({}), /SMOKE_COPILOT_LIVE_SKILLS/);
    assert.deepEqual(assertLiveSkillsLivePreflight(C5_ENV), { runId: C5_ENV.SMOKE_RUN_ID, gate: 'c5', route: 'owner' });
    assert.ok(Object.isFrozen(assertLiveSkillsLivePreflight(C5_ENV)));
    assert.throws(() => assertLiveSkillsLivePreflight({ ...C5_ENV, CODEX_TEST_AUTH_SOURCE: 'stream' }), /route-mismatch/);
});

// Each of the nine prerequisites, removed or broken alone, is refused with a message naming it and no value.
const PREREQUISITES = [
    ['SMOKE_COPILOT_LIVE_SKILLS', undefined], ['SMOKE_COPILOT_LIVE_SKILLS', '0'],
    ['CODEX_TEST_AUTH_GATE', undefined], ['CODEX_TEST_AUTH_GATE', 'c2'],
    ['CODEX_TEST_AUTH_SOURCE', undefined],
    ['SMOKE_RUN_ID', undefined], ['SMOKE_RUN_ID', 'codex-auth-20261026T120000Z-1'], ['SMOKE_RUN_ID', '0F2B6C1E-8A4D-4C3B-9E5F-7A1B2C3D4E5F'],
    ['CODEX_TEST_AUTH_ROOT', undefined], ['CODEX_TEST_AUTH_ROOT', 'relative/root'], ['SMOKE_ARTIFACT_DIR', undefined], ['SMOKE_ARTIFACT_DIR', '/evidence/../c5'],
    ['SMOKE_WORKSPACE_ROOT', undefined], ['SMOKE_RELEASE_MANIFEST', undefined], ['SMOKE_ALA_COMMAND', undefined], ['SMOKE_ALA_COMMAND', 'ala.mjs'],
    ['SMOKE_DEPLOYMENT_MODE', undefined], ['SMOKE_DEPLOYMENT_MODE', 'local'], ['SMOKE_PLOINKY_BOX_CONTAINER', undefined], ['SMOKE_BOX_BASE_URL', undefined],
    ['SMOKE_SOURCE_VERIFICATION', 'local-snapshot'],
    ['CODEX_TEST_AUTH_OWNER_AUTH', 'relative/auth.json'],
    ['SMOKE_COPILOT_RELEASE_VERIFIER', undefined],
    ['SMOKE_COPILOT_RELEASE_VERIFIER', LIVE_SKILLS_RELEASE_VERIFIER.replace('verifyExplorerReleaseBundle.mjs', 'verifyCopilot421Bundle.mjs')],
    ['SMOKE_COPILOT_RELEASE_VERIFIER', '/elsewhere/tests/release/verifyExplorerReleaseBundle.mjs'],
];
for (const [name, value] of PREREQUISITES) {
    test(`the C5 preflight refuses ${name}=${value === undefined ? '(unset)' : JSON.stringify(value)} and names it`, () => {
        const env = { ...C5_ENV };
        if (value === undefined) delete env[name]; else env[name] = value;
        assert.throws(() => assertLiveSkillsLivePreflight(env), error => error.message.includes(name)
            && !Object.values(C5_ENV).some(secret => secret.length > 8 && error.message.includes(secret)));
    });
}

test('the C5 preflight accepts an unset or release source verification and an absolute owner override', () => {
    for (const extra of [{ SMOKE_SOURCE_VERIFICATION: 'release' }, { SMOKE_SOURCE_VERIFICATION: '' }, { CODEX_TEST_AUTH_OWNER_AUTH: '/synthetic/auth.json' }]) {
        assert.equal(assertLiveSkillsLivePreflight({ ...C5_ENV, ...extra }).gate, 'c5', JSON.stringify(extra));
    }
});

test('C4 stays blocked even for the complete C5 environment', () => {
    assert.throws(() => assertCodexDelegationLiveBlocked(), /phase6.*independently verified B\+C/);
    assert.equal(assertLiveSkillsLivePreflight(C5_ENV).gate, 'c5');
});

// The recovery mode of remove-folders (a crashed C5 run): offline, with a fake /proc and fake /data, and no robot left.
function recoveryCase(t, { robotId = null } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c5 recovery ü ')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = createLiveSkillsFixture(root, { runId: '0f2b6c1e-8a4d-4c3b-9e5f-7a1b2c3d4e5f' });
    fixture.robotId = robotId;
    const repository = `${root}/AchillesIDE`, codeRoot = `${repository}/roboTeamAgent`, dataRoot = `${root}/_data`, procRoot = `${root}/_proc`;
    for (const directory of [`${codeRoot}/server`, `${dataRoot}/robots`, procRoot]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(`${codeRoot}/server/one.mjs`, 'export const one = 1;\n');
    const contractHashes = { 'server/one.mjs': liveSkillsHash(fs.readFileSync(`${codeRoot}/server/one.mjs`)) };
    const ownership = { version: 1, runId: fixture.runId, workspace: fixture.workspace, repositoryRoot: fixture.repositoryRoot, robotName: fixture.robotName };
    for (const folder of [fixture.repositoryRoot, fixture.workspace]) {
        fs.mkdirSync(folder);
        fs.writeFileSync(`${folder}/.set2-live-fixture_codex.json`, JSON.stringify(ownership) + '\n');
    }
    // An unfinished turn record, as a crash mid-turn leaves it.
    const sessionId = randomUUID();
    fs.mkdirSync(`${fixture.workspace}/.roboteam/sessions/${sessionId}`, { recursive: true });
    fs.writeFileSync(`${fixture.workspace}/.roboteam/sessions/${sessionId}/config.json`, JSON.stringify({ version: 2, sessionId, cwd: fixture.workspace,
        skillExecution: { active: true }, turns: [{ status: 'pending' }] }));
    const descriptors = new Map();
    const fsApi = { ...fs, openSync(file, flags) { const fd = fs.openSync(file, flags); descriptors.set(fd, file); return fd; },
        closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
        realpathSync(file) { if (process.platform !== 'linux' && /^\/proc\/self\/fd\/\d+$/.test(file)) return fs.realpathSync(descriptors.get(Number(path.basename(file)))); return fs.realpathSync(file); } };
    const addProcess = (pid, cwd, args = ['node', 'x.mjs']) => {
        fs.mkdirSync(`${procRoot}/${pid}`);
        fs.symlinkSync(cwd, `${procRoot}/${pid}/cwd`);
        fs.writeFileSync(`${procRoot}/${pid}/cmdline`, `${args.join('\0')}\0`);
    };
    const run = (extra = {}) => operateLiveSkillsFixture({ action: 'remove-folders', recovery: true, fixture, workspaceRoot: root, expectedRepository: repository, contractHashes, ...extra },
        { codeRoot, dataRoot, procRoot, fsApi, emit: () => {} });
    return { root, fixture, dataRoot, procRoot, addProcess, run };
}

test('recovery-mode remove-folders refuses while a process cwd is under the fixture, and succeeds with no processes and an unfinished turn', async t => {
    const c = recoveryCase(t);
    c.addProcess(41, `${c.fixture.workspace}/.roboteam`);
    await assert.rejects(c.run(), /still uses the owned folders/);
    assert.ok(fs.existsSync(c.fixture.workspace) && fs.existsSync(c.fixture.repositoryRoot), 'nothing is removed on a refusal');
    fs.rmSync(`${c.procRoot}/41`, { recursive: true });
    // A command line that names the robot storage or a root by `--flag=<path>` is refused as well.
    c.addProcess(42, '/', ['node', '/code/server/robot-cli.mjs', `--cwd=${c.fixture.repositoryRoot}`]);
    await assert.rejects(c.run(), /still uses the owned folders/);
    fs.rmSync(`${c.procRoot}/42`, { recursive: true });
    c.addProcess(43, '/');
    await c.run();
    assert.equal(fs.existsSync(c.fixture.workspace), false);
    assert.equal(fs.existsSync(c.fixture.repositoryRoot), false);
    // Absent roots are skipped, so a second recovery is a no-op.
    await c.run();
});

test('recovery-mode remove-folders refuses while the owned robot exists, and refuses a present root without its ownership marker', async t => {
    const named = recoveryCase(t);
    fs.mkdirSync(`${named.dataRoot}/robots/other-id-0001`);
    fs.writeFileSync(`${named.dataRoot}/robots/other-id-0001/metadata.json`, JSON.stringify({ name: named.fixture.robotName }));
    await assert.rejects(named.run(), /Delete the owned robot before recovering its folders/);
    const byId = recoveryCase(t, { robotId: 'owned-robot-0001' });
    fs.mkdirSync(`${byId.dataRoot}/robots/owned-robot-0001`);
    fs.writeFileSync(`${byId.dataRoot}/robots/owned-robot-0001/metadata.json`, '{}');
    await assert.rejects(byId.run(), /Delete the owned robot before recovering its folders/);
    const unmarked = recoveryCase(t);
    fs.rmSync(`${unmarked.fixture.workspace}/.set2-live-fixture_codex.json`);
    await assert.rejects(unmarked.run());
    assert.ok(fs.existsSync(unmarked.fixture.workspace) && fs.existsSync(unmarked.fixture.repositoryRoot), 'a root without its marker is never removed');
    // Only remove-folders has a recovery mode.
    await assert.rejects(unmarked.run({ action: 'remove-links' }), /Only remove-folders has a recovery mode/);
});

test('owned setup discovers a real Git source, registers only a new Codex robot and seeds whole-source defaults', async t => {
    const h = await harness(t), before = await h.defaultEvidence();
    const proof = await h.controller.setup();
    assert.equal(proof.robotId, h.fixture.robotId);
    assert.deepEqual((await h.inventory()).policy.selectors, { skillSets: [h.fixture.repositoryName], skills: [] });
    assert.equal(spawnSync('git', ['-C', h.fixture.repositoryRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).status, 128, 'Fixture repository must stay uncommitted.');
    assert.deepEqual(await h.defaultEvidence(), before);
    assert.ok(h.mutations.length > 0 && h.mutations.every(id => id === h.fixture.robotId));
    await assert.rejects(h.operate('seed-defaults'), /existing owned robot policy/);
    assert.ok(new URL(liveSkillsOwnedLaunchURL('http://localhost:8080', h.fixture)).searchParams.get('robot') === h.fixture.robotName);
    await h.controller.cleanup({ quiescent: true });
    assert.equal(h.controller.state.cleanup, 'passed'); assert.equal(fs.existsSync(h.fixture.workspace), false);
    assert.deepEqual(await h.defaultEvidence(), before);
});

test('seven offline phases use real current policies, Ploinky links, helper receipts and one synthetic ALA continuation', async t => {
    const h = await harness(t), defaultBefore = await h.defaultEvidence(); await h.controller.setup();
    h.registerProject({ dataDir: h.dataRoot, workspaceRoot: h.root }, h.fixture.workspace);
    const robot = h.robots.get(h.fixture.robotId), sessionId = randomUUID(), untouchedId = randomUUID();
    for (const id of [untouchedId, sessionId]) await h.service.policies.ensure(robot, id);
    const ownedDefaults = policyEvidence(await h.inventory(), null, h.fixture.robotName);
    const untouched = await h.service.policies.read(robot.id, untouchedId);
    const metadata = { version: 2, sessionId, cwd: h.fixture.workspace, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turns: [],
        skillPolicyRef: sessionId, engine: { type: 'ala', version: 1, sessionId, home: `${h.dataRoot}/robots/${robot.id}/home`, cwd: h.fixture.workspace, backend: 'codex', robotId: robot.id } };
    const sessions = `${h.fixture.workspace}/.roboteam/sessions`;
    for (const id of [untouchedId, sessionId]) fs.mkdirSync(`${sessions}/${id}`, { recursive: true });
    fs.writeFileSync(`${sessions}/${untouchedId}/config.json`, JSON.stringify({ version: 2, sessionId: untouchedId, cwd: h.fixture.workspace,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turns: [], skillPolicyRef: untouchedId }));
    const untouchedEvidence = policyEvidence(await h.inventory(untouchedId), untouchedId, h.fixture.robotName);
    const file = `${sessions}/${sessionId}/config.json`, transcriptFile = `${h.fixture.workspace}/.roboteam/.ala/sessions/${sessionId}.jsonl`;
    fs.mkdirSync(path.dirname(transcriptFile), { recursive: true }); let seq = 1;
    fs.writeFileSync(transcriptFile, JSON.stringify({ seq, type: 'session', id: sessionId, at: new Date().toISOString() }) + '\n');
    const append = (type, fields) => fs.appendFileSync(transcriptFile, JSON.stringify({ seq: ++seq, type, at: new Date().toISOString(), ...fields }) + '\n');
    append('continuation', { agent: 'codex', continuation: { threadId: 'one-owned-codex-thread' } });
    const phases = liveSkillsPhasePlan(h.fixture), proofs = [], priorIds = [], priorReceipts = {}; let identity, revision;
    const installationService = Object.create(h.service);
    installationService.live = { resolve: async (...args) => {
        const inventory = await h.service.live.resolve(...args);
        return { ...inventory, entries: [...inventory.entries].sort((a, b) => b.name.localeCompare(a.name)) };
    } };
    for (const phase of phases) {
        const before = Object.fromEntries([h.fixture.control, h.fixture.probe].filter(skill => fs.existsSync(`${h.fixture.repositoryRoot}/skills/${skill.name}`))
            .map(skill => [skill.name, Object.fromEntries(['SKILL.md', 'receipt.mjs'].map(name => [name, liveSkillsHash(fs.readFileSync(`${h.fixture.repositoryRoot}/skills/${skill.name}/${name}`))]))]));
        if (phase.label === 'descriptor edit') { h.fixture.probe.descriptorMarker = randomUUID(); await h.controller.writeSource(`${h.fixture.repositoryName}/skills/${h.fixture.probe.name}/SKILL.md`, liveSkillSources(h.fixture, h.fixture.probe, h.root).descriptor); }
        if (phase.label === 'helper-only edit') { h.fixture.probe.helperMarker = randomUUID(); await h.controller.writeSource(`${h.fixture.repositoryName}/skills/${h.fixture.probe.name}/receipt.mjs`, liveSkillSources(h.fixture, h.fixture.probe, h.root).helper); }
        if (phase.label === 'new skill') await h.controller.installSkill(h.fixture.added);
        if (['disabled probe', 're-enabled probe'].includes(phase.label)) {
            const current = await h.service.policies.read(robot.id, sessionId);
            const changed = await h.service.setEnabled(robot, sessionId, current.policyVersion, `${h.fixture.repositoryName}/${h.fixture.probe.name}`, phase.label === 're-enabled probe', h.fixture.workspace);
            assert.ok(changed.policyVersion > current.policyVersion);
            assert.equal(changed.policy.excludedSkills.includes(`${h.fixture.repositoryName}/${h.fixture.probe.name}`), phase.label === 'disabled probe');
        }
        if (phase.label === 'deleted probe') fs.rmSync(`${h.fixture.repositoryRoot}/skills/${h.fixture.probe.name}`, { recursive: true });
        if (['descriptor edit', 'helper-only edit'].includes(phase.label)) {
            const unchangedFile = phase.label === 'descriptor edit' ? 'receipt.mjs' : 'SKILL.md';
            assert.equal(liveSkillsHash(fs.readFileSync(`${h.fixture.repositoryRoot}/skills/${h.fixture.probe.name}/${unchangedFile}`)), before[h.fixture.probe.name][unchangedFile]);
            for (const name of ['SKILL.md', 'receipt.mjs']) assert.equal(liveSkillsHash(fs.readFileSync(`${h.fixture.repositoryRoot}/skills/${h.fixture.control.name}/${name}`)), before[h.fixture.control.name][name]);
        }
        const startedAt = Date.now() - 1, challenge = randomUUID(), turnId = randomUUID();
        const execution = await h.installLiveSkills({ service: installationService, robot, policyId: sessionId, sessionId, cwd: h.fixture.workspace, client: h.client });
        const { release, ...record } = execution; await release(); metadata.skillExecution = { ...record, active: false };
        const turn = { turnId, userMessageId: randomUUID(), assistantMessageId: randomUUID(), timestamp: new Date().toISOString(), status: 'completed', tasks: [] };
        turn.thinkingUrl = `/base-agent-additional-server/roboTeamAgent/3001/webchat-logs/${sessionId}/${turn.assistantMessageId}`; metadata.turns.push(turn);
        const recorder = h.createTranscriptRecorder({ append }, turnId); recorder.user(liveSkillsPrompt({ phase: challenge, selected: phase.selected }));
        await withLiveSkillsProjection({ fixture: h.fixture, workspaceRoot: h.root, sessionId, execution, alaSkillMountArguments: h.alaSkillMountArguments }, async () => {
          for (const skill of phase.selected) {
            const helper = `${h.fixture.workspace}/.agents/skills/${skill.name}/receipt.mjs`;
            assert.ok(fs.lstatSync(path.dirname(helper)).isSymbolicLink());
            const child = spawnSync(process.execPath, [helper, challenge], { cwd: h.fixture.workspace, env: process.env, encoding: 'utf8', timeout: 10_000 });
            assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), skill.helperMarker);
          }
        });
        assert.equal(fs.lstatSync(`${h.fixture.workspace}/.agents/skills`, { throwIfNoEntry: false }), undefined);
        assert.equal(fs.lstatSync(`${h.fixture.workspace}/.agents/.roboteam-links.json`, { throwIfNoEntry: false }), undefined);
        recorder.observe({ type: 'agentlib-tool', tool: 'PRIVATE_TOOL_SENTINEL', reason: 'PRIVATE_REASON_SENTINEL' });
        await recorder.finish({ result: phase.selected.flatMap(skill => [skill.descriptorMarker, skill.helperMarker]).join('\n'), status: 'completed' });
        fs.writeFileSync(file, JSON.stringify(metadata));
        let snapshot; await readLiveSkillsSnapshot({ sessionId, folder: h.fixture.folder, skillNames: [h.fixture.control.name, h.fixture.probe.name, h.fixture.added.name],
            robotId: robot.id, robotName: robot.name, repositoryName: h.fixture.repositoryName, repositoryRoot: h.fixture.repositoryRoot,
            contractFiles: h.contractFiles, expectedRepository: h.repository, workspaceRoot: h.root, expectedAla: h.expectedAla },
        { codeRoot: h.codeRoot, dataRoot: h.dataRoot, fsApi: h.fsApi, emit: value => { snapshot = value; } });
        assert.deepEqual(snapshot.catalog.links.map(link => link.name), execution.entries.filter(entry => !entry.executionOnly).map(entry => entry.name));
        assert.equal(liveSkillsHash(snapshot.catalog.links), execution.revision);
        assert.ok(Object.values(snapshot.liveLinks).every(link => link.destination.startsWith(execution.skillsDirectory + '/')));
        const inventory = await h.inventory(sessionId), proof = validateLiveSkillsTurn({ snapshot, inventory, fixture: h.fixture, workspaceRoot: h.root,
            sessionId, phase: challenge, ...phase, baselineIds: priorIds, priorTurnIds: proofs.map(proof => proof.turnId), nativeIdentity: identity,
            expectedPolicy: policyEvidence(inventory, sessionId, h.fixture.robotName), priorRevision: revision,
            priorReceiptNames: Object.keys(priorReceipts), priorReceiptHashes: priorReceipts, startedAt, finishedAt: Date.now() + 1 });
        assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_(TOOL|REASON)_SENTINEL/);
        proofs.push(proof); identity = proof.identity; revision = proof.revision; priorIds.push(proof.messageId);
        Object.assign(priorReceipts, Object.fromEntries(Object.entries(snapshot.receipts).map(([name, receipt]) => [name, liveSkillsHash(receipt)])));
        assert.deepEqual(policyEvidence(await h.inventory(), null, h.fixture.robotName), ownedDefaults);
        assert.deepEqual(await h.service.policies.read(robot.id, untouchedId), untouched);
        assert.deepEqual(policyEvidence(await h.inventory(untouchedId), untouchedId, h.fixture.robotName), untouchedEvidence); assert.deepEqual(await h.defaultEvidence(), defaultBefore);
    }
    assert.equal(proofs.length, 7); assert.equal(new Set(proofs.map(proof => proof.turnId)).size, 7);
    assert.equal(Object.keys(priorReceipts).length, 12);
    await h.controller.cleanup({ quiescent: true });
});

for (const [name, replace] of Object.entries({
    'a different local source': h => [{ name: h.fixture.repositoryName, source: `${h.root}/decoy`, origin: 'workspace', kind: 'skills' }],
    'an inventory-only remote source': h => [{ name: h.fixture.repositoryName, source: h.fixture.repositoryRoot, origin: 'remote', kind: 'skills' }],
    'duplicate source identities': h => Array(2).fill({ name: h.fixture.repositoryName, source: h.fixture.repositoryRoot, origin: 'workspace', kind: 'skills' }),
})) test(`owned setup refuses ${name} before robot creation`, async t => {
    const h = await harness(t), before = await h.defaultEvidence();
    const controller = h.makeController({ listRepositories: async () => replace(h) });
    await assert.rejects(controller.setup());
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
    assert.deepEqual(await h.defaultEvidence(), before);
    await controller.cleanup({ quiescent: true });
});

test('owned defaults seed refuses another robot identity/backend and existing owned policy', async t => {
    const h = await harness(t); await h.controller.setup();
    const robot = h.robots.get(h.fixture.robotId);
    robot.codingAgents = ['opencode']; await assert.rejects(h.operate('seed-defaults'), /Codex-only/); robot.codingAgents = ['codex'];
    robot.name = 'default'; await assert.rejects(h.operate('seed-defaults')); robot.name = h.fixture.robotName;
    await assert.rejects(h.operate('seed-defaults'), /existing owned robot policy/);
    await assert.rejects(h.controller.cleanup({ quiescent: false }), /native quiescence/);
    assert.equal(h.controller.state.cleanup, 'failed'); assert.ok(fs.existsSync(h.fixture.workspace));
    await h.controller.cleanup({ quiescent: true });
    await h.controller.cleanup({ quiescent: true });
});

test('ambiguous fixture preparation retains ownership and fails cleanup', async t => {
    const h = await harness(t);
    const controller = h.makeController({ operate: async action => { if (action === 'prepare') throw new Error('uncertain preparation'); assert.fail(action); } });
    await assert.rejects(controller.setup(), /uncertain preparation/);
    await assert.rejects(controller.cleanup({ quiescent: true }), /preparation outcome is ambiguous/);
    assert.equal(controller.state.cleanup, 'failed');
});

test('owned cleanup refuses active or pending session metadata before removing links or robot registration', async t => {
    const h = await harness(t); await h.controller.setup();
    const directory = `${h.fixture.workspace}/.roboteam/sessions`; fs.mkdirSync(directory, { recursive: true });
    const sessionId = randomUUID(); fs.mkdirSync(`${directory}/${sessionId}`);
    const file = `${directory}/${sessionId}/config.json`;
    const metadata = { version: 2, sessionId, cwd: h.fixture.workspace };
    fs.writeFileSync(file, JSON.stringify({ ...metadata, skillExecution: { active: true }, turns: [{ status: 'pending' }] }));
    await assert.rejects(h.controller.cleanup({ quiescent: true }), /active execution/);
    assert.equal(h.controller.state.cleanup, 'failed'); assert.ok(h.robots.has(h.fixture.robotId));
    assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 0);
    fs.writeFileSync(file, JSON.stringify({ ...metadata, turns: [{ status: 'pending' }] }));
    await assert.rejects(h.controller.cleanup({ quiescent: true }), /unfinished native turns/);
    fs.writeFileSync(file, JSON.stringify({ ...metadata, turns: [{ status: 'completed' }] }));
    await h.controller.cleanup({ quiescent: true });
});

for (const corruption of ['active-later-session', 'pending-later-session', 'retargeted', 'foreign-directory', 'foreign-robot']) {
    test(`session-private cleanup rejects ${corruption} before deleting any admitted directory`, async t => {
        const h = await harness(t); await h.controller.setup();
        const robot = h.robots.get(h.fixture.robotId), ids = [randomUUID(), randomUUID()].sort(), records = [];
        for (const sessionId of ids) {
            await h.service.policies.ensure(robot, sessionId);
            const execution = await h.installLiveSkills({ service: h.service, robot, policyId: sessionId, sessionId, cwd: h.fixture.workspace, client: h.client });
            const { release, ...record } = execution; await release();
            const metadata = { version: 2, sessionId, cwd: h.fixture.workspace, turns: [], engine: { robotId: robot.id }, skillExecution: { ...record, active: false } };
            const file = `${h.fixture.workspace}/.roboteam/sessions/${sessionId}/config.json`;
            fs.writeFileSync(file, JSON.stringify(metadata)); records.push({ file, metadata });
        }
        const later = records[1], original = structuredClone(later.metadata);
        if (corruption === 'active-later-session') later.metadata.skillExecution.active = true;
        if (corruption === 'pending-later-session') later.metadata.turns = [{ status: 'pending' }];
        if (corruption === 'foreign-directory') later.metadata.skillExecution.skillsDirectory = `${h.root}/foreign`;
        if (corruption === 'foreign-robot') later.metadata.engine.robotId = 'foreign-robot';
        const link = `${original.skillExecution.skillsDirectory}/${original.skillExecution.entries.find(entry => !entry.executionOnly).name}`;
        const target = fs.readlinkSync(link);
        if (corruption === 'retargeted') { fs.unlinkSync(link); fs.symlinkSync(h.root, link); }
        fs.writeFileSync(later.file, JSON.stringify(later.metadata));
        await assert.rejects(h.operate('remove-links'));
        for (const entry of records) assert.ok(fs.lstatSync(entry.metadata === later.metadata ? original.skillExecution.skillsDirectory : entry.metadata.skillExecution.skillsDirectory).isDirectory());
        assert.ok(h.robots.has(robot.id));
        if (corruption === 'retargeted') { fs.unlinkSync(link); fs.symlinkSync(target, link); }
        fs.writeFileSync(later.file, JSON.stringify(original));
        await h.operate('remove-links'); await h.operate('remove-links');
        for (const entry of records) assert.equal(fs.existsSync(path.dirname(entry.file) + '/skills'), false);
        await h.controller.cleanup({ quiescent: true });
        await h.controller.cleanup({ quiescent: true });
    });
}

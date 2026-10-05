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
import { createOwnedLiveSkillsFixture, liveSkillsPhasePlan, defaultRobotEvidence, assertLiveSkillsLivePreflight, liveSkillsOwnedLaunchURL } from './copilot-live-skills-fixture.mjs';
import { operateLiveSkillsFixture } from './copilot-live-skills-fixture-runtime.mjs';

async function harness(t) {
    assert.ok(process.env.SET2_ACHILLES_SOURCE && process.env.SET2_PLOINKY_SOURCE && process.env.SET2_ALA_COMMAND);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'set2 owned ü ')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = `${root}/AchillesCLI`, codeRoot = `${repository}/roboTeamAgent`, dataRoot = `${root}/_data`;
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
        { codeRoot, dataRoot, service, emit: value => { result = value; } }); return result; };
    const makeController = overrides => createOwnedLiveSkillsFixture({ fixture, workspaceRoot: root, api, listRepositories, fsTool, operate, ...overrides });
    const controller = makeController();
    const inventory = id => skillCatalogRequest({ skillsets: service, robot: robots.get(fixture.robotId), input: id ? { sessionId: id } : {} });
    const defaultEvidence = async () => defaultRobotEvidence(publicRobot(defaultRobot), await skillCatalogRequest({ skillsets: service, robot: defaultRobot }));
    return { root, repository, codeRoot, dataRoot, fixture, controller, service, robots, store, mutations, calls, client, inventory, defaultEvidence,
        registerProject, installLiveSkills, createTranscriptRecorder, expectedAla, contractFiles, operate, fsApi, makeController };
}

test('step4 deployed spec uses owned registration before conversation setup and refuses reserved live execution', () => {
    const source = fs.readFileSync(new URL('../specs/06-copilot-live-skills.spec.mjs', import.meta.url), 'utf8');
    assert.ok(source.includes('evidence.ownership = await owned.setup()'), 'Spec still uses an unregistered workspace source.');
    assert.ok(source.includes('liveSkillsOwnedLaunchURL'), 'Spec still launches the existing default robot.');
    assert.match(source, /test\.beforeAll\(\(\) => assertLiveSkillsLivePreflight\(\)\)/);
    assert.throws(assertLiveSkillsLivePreflight, /phase6.*independently verified B\+C/);
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
    const sessions = `${h.fixture.workspace}/.roboteam/sessions`; fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(`${sessions}/${untouchedId}.json`, JSON.stringify({ version: 2, sessionId: untouchedId, cwd: h.fixture.workspace,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turns: [], skillPolicyRef: untouchedId }));
    const untouchedEvidence = policyEvidence(await h.inventory(untouchedId), untouchedId, h.fixture.robotName);
    const file = `${sessions}/${sessionId}.json`, transcriptFile = `${h.fixture.workspace}/.roboteam/.ala/sessions/${sessionId}.jsonl`;
    fs.mkdirSync(path.dirname(transcriptFile), { recursive: true }); let seq = 1;
    fs.writeFileSync(transcriptFile, JSON.stringify({ seq, type: 'session', id: sessionId, at: new Date().toISOString() }) + '\n');
    const append = (type, fields) => fs.appendFileSync(transcriptFile, JSON.stringify({ seq: ++seq, type, at: new Date().toISOString(), ...fields }) + '\n');
    append('continuation', { agent: 'codex', continuation: { threadId: 'one-owned-codex-thread' } });
    const phases = liveSkillsPhasePlan(h.fixture), proofs = [], priorIds = [], priorReceipts = {}; let identity, revision;
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
        const execution = await h.installLiveSkills({ service: h.service, robot, policyId: sessionId, cwd: h.fixture.workspace, client: h.client });
        const { release, ...record } = execution; await release(); metadata.skillExecution = { ...record, active: false };
        const turn = { turnId, userMessageId: randomUUID(), assistantMessageId: randomUUID(), timestamp: new Date().toISOString(), status: 'completed', tasks: [] };
        turn.thinkingUrl = `/base-agent-additional-server/roboTeamAgent/3001/webchat-logs/${sessionId}/${turn.assistantMessageId}`; metadata.turns.push(turn);
        const recorder = h.createTranscriptRecorder({ append }, turnId); recorder.user(liveSkillsPrompt({ phase: challenge, selected: phase.selected }));
        for (const skill of phase.selected) {
            const helper = `${h.fixture.workspace}/.agents/skills/${skill.name}/receipt.mjs`;
            assert.ok(fs.lstatSync(path.dirname(helper)).isSymbolicLink());
            const child = spawnSync(process.execPath, [helper, challenge], { cwd: h.fixture.workspace, env: process.env, encoding: 'utf8', timeout: 10_000 });
            assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), skill.helperMarker);
        }
        recorder.observe({ type: 'agentlib-tool', tool: 'PRIVATE_TOOL_SENTINEL', reason: 'PRIVATE_REASON_SENTINEL' });
        await recorder.finish({ result: phase.selected.flatMap(skill => [skill.descriptorMarker, skill.helperMarker]).join('\n'), status: 'completed' });
        fs.writeFileSync(file, JSON.stringify(metadata));
        let snapshot; await readLiveSkillsSnapshot({ sessionId, folder: h.fixture.folder, skillNames: [h.fixture.control.name, h.fixture.probe.name, h.fixture.added.name],
            robotId: robot.id, robotName: robot.name, repositoryName: h.fixture.repositoryName, repositoryRoot: h.fixture.repositoryRoot,
            contractFiles: h.contractFiles, expectedRepository: h.repository, workspaceRoot: h.root, expectedAla: h.expectedAla },
        { codeRoot: h.codeRoot, dataRoot: h.dataRoot, fsApi: h.fsApi, emit: value => { snapshot = value; } });
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
    const file = `${directory}/${randomUUID()}.json`;
    fs.writeFileSync(file, JSON.stringify({ skillExecution: { active: true }, turns: [{ status: 'pending' }] }));
    await assert.rejects(h.controller.cleanup({ quiescent: true }), /active execution/);
    assert.equal(h.controller.state.cleanup, 'failed'); assert.ok(h.robots.has(h.fixture.robotId));
    assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 0);
    fs.writeFileSync(file, JSON.stringify({ skillExecution: { active: false }, turns: [{ status: 'pending' }] }));
    await assert.rejects(h.controller.cleanup({ quiescent: true }), /unfinished native turns/);
    fs.writeFileSync(file, JSON.stringify({ skillExecution: { active: false }, turns: [{ status: 'completed' }] }));
    await h.controller.cleanup({ quiescent: true });
});

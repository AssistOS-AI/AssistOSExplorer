import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { liveSkillsHash } from './copilot-live-skills.mjs';
import { createWorkflowDelegationFixture, delegationWorkflow, delegationObjective, delegationPrompt, delegationSkillSources, validateWorkflowDelegation, C4_WORKER_MARKER } from './copilot-workflow-delegation.mjs';
import { readDelegationSnapshot, delegationContractFiles, delegationProgram } from './copilot-workflow-delegation-runtime.mjs';

async function harness(t) {
    assert.ok(process.env.SET2_ACHILLES_SOURCE && process.env.SET2_PLOINKY_SOURCE && process.env.SET2_ALA_COMMAND);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4 workflow ü ')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = `${root}/AchillesCLI`, codeRoot = `${repository}/roboTeamAgent`, dataRoot = `${root}/_data`;
    fs.mkdirSync(repository); fs.cpSync(`${process.env.SET2_ACHILLES_SOURCE}/roboTeamAgent`, codeRoot, { recursive: true,
        filter: from => !from.split(path.sep).some(part => ['node_modules', '.git'].includes(part)) });
    const alaSource = path.dirname(path.dirname(fs.realpathSync(process.env.SET2_ALA_COMMAND))), alaRoot = `${root}/AdvancedLanguageAgent`;
    for (const file of ['package.json', 'bin/ala.mjs', 'src/transcript.mjs']) { fs.mkdirSync(path.dirname(`${alaRoot}/${file}`), { recursive: true }); fs.copyFileSync(`${alaSource}/${file}`, `${alaRoot}/${file}`); }
    const expectedAla = { root: alaRoot, command: `${alaRoot}/bin/ala.mjs`, hashes: Object.fromEntries(['package.json', 'bin/ala.mjs', 'src/transcript.mjs'].map(file => [file, liveSkillsHash(fs.readFileSync(`${alaRoot}/${file}`))])) };
    process.env.PLOINKY_WORKSPACE_ROOT = root; process.env.ACHILLES_ALA_COMMAND = expectedAla.command; delete process.env.PLOINKY_SKILL_SCOPE;
    const module = file => import(pathToFileURL(`${codeRoot}/${file}`).href);
    const { RobotSkillsets } = await module('server/robot-skillsets.mjs');
    const { RoboFlowService } = await module('server/roboflow/roboflow-service.mjs');
    const { RoboFlowDatabase } = await module('server/roboflow/database.mjs');
    const { registerProject, saveTaskExecution } = await module('server/project-storage.mjs');
    const { installLiveSkills } = await module('server/live-skill-install.mjs');
    const { buildTaskPrompt } = await module('copilot/src/lib/prompts.mjs');
    const { action } = await module('copilot/src/skills/launch-workflow/scripts/action.mjs');
    const { __testables: backgroundTaskContract } = await module('copilot/src/lib/webchat/webchatBackgroundTasks.mjs');
    const { installRepositoryLinks, removeRepositoryLinks } = await import(pathToFileURL(`${process.env.SET2_PLOINKY_SOURCE}/cli/utils/repositoryInstall.mjs`).href);
    const { createTranscriptRecorder } = await import(pathToFileURL(`${alaSource}/src/transcript-recorder.mjs`).href);
    const fixture = createWorkflowDelegationFixture(root); fixture.robotId = 'owned-c4-worker';
    fs.mkdirSync(`${fixture.repositoryRoot}/skills/${fixture.skillName}`, { recursive: true }); fs.mkdirSync(fixture.workspace);
    const source = delegationSkillSources(fixture); fs.writeFileSync(`${fixture.repositoryRoot}/skills/${fixture.skillName}/SKILL.md`, source.descriptor); fs.writeFileSync(`${fixture.repositoryRoot}/skills/${fixture.skillName}/receipt.mjs`, source.helper);
    const docs = `${root}/DocumentationSkills`; fs.mkdirSync(`${docs}/skills/human-report`, { recursive: true }); fs.writeFileSync(`${docs}/skills/human-report/SKILL.md`, '---\nname: human-report\ndescription: Summarize the result.\n---\nReport the requested result.\n');
    const robots = [{ schema: 'roboteam-robot-v1', id: 'existing-front', name: 'default', codingAgents: ['opencode'], skillsets: [] },
        { schema: 'roboteam-robot-v1', id: fixture.robotId, name: fixture.robotName, codingAgents: ['codex'], skillsets: [{ name: fixture.repositoryName, source: fixture.repositoryRoot, generation: randomUUID(),
            skills: [{ name: fixture.skillName, description: 'owned proof', directory: `skills/${fixture.skillName}` }], definitions: [] }] }];
    for (const robot of robots) { fs.mkdirSync(`${dataRoot}/robots/${robot.id}/home`, { recursive: true }); fs.writeFileSync(`${dataRoot}/robots/${robot.id}/metadata.json`, JSON.stringify(robot)); }
    const marker = { version: 1, kind: 'set2-c4-worker', runId: fixture.runId, robotId: fixture.robotId, robotName: fixture.robotName, proofNonce: fixture.proofNonce };
    const workerHome = `${dataRoot}/robots/${fixture.robotId}/home`; fs.writeFileSync(`${workerHome}/${C4_WORKER_MARKER}`, JSON.stringify(marker));
    const robotStore = { dataDir: dataRoot, robotPath: id => `${dataRoot}/robots/${id}`, get: async id => robots.find(robot => robot.id === id),
        getByName: async name => robots.find(robot => robot.name === name), list: async () => robots,
        withRobot: async (id, callback) => callback(robots.find(robot => robot.id === id), async () => {}) };
    const repositories = [{ name: fixture.repositoryName, source: fixture.repositoryRoot, origin: 'workspace', kind: 'skills' }, { name: 'DocumentationSkills', source: docs, origin: 'workspace', kind: 'skills' }];
    const client = { listRepositories: async () => repositories, prepareRepository: async () => assert.fail('No repository preparation.'),
        install: async input => installRepositoryLinks(input, { workspaceRoot: root, resolveRepository: name => repositories.find(repo => repo.name === name) }),
        remove: async paths => removeRepositoryLinks(paths, { workspaceRoot: root }) };
    const skillsets = new RobotSkillsets({ robotStore, workspaceRoot: root, repositoriesClient: client, alaCommand: expectedAla.command });
    const database = new RoboFlowDatabase(`${dataRoot}/roboflow/roboflow.sqlite`); t.after(() => database.close());
    let dispatched;
    const runtimeManager = { workspaceRoot: root, skillsets, resolveCwd: async folder => { assert.equal(folder, fixture.workspace); return folder; },
        async startTask(robot, type, request) { dispatched = { robot, type, request }; return { taskId: request.runtimeTaskId }; }, stopTask: async () => assert.fail('No native stop.') };
    const service = new RoboFlowService({ robotStore, runtimeManager, skillsets, database, workspaceRoot: root });
    const workflow = await service.createWorkflow(delegationWorkflow(fixture)); assert.deepEqual(workflow.coverage.tasks[0].matchingRobotIds, [fixture.robotId]);
    registerProject({ dataDir: dataRoot, workspaceRoot: root }, fixture.workspace);
    const frontSessionId = randomUUID(), frontTurnId = randomUUID(), assistantId = randomUUID();
    const sessionDir = `${fixture.workspace}/.roboteam/sessions`; fs.mkdirSync(sessionDir, { recursive: true });
    const frontMetadata = { version: 2, sessionId: frontSessionId, cwd: fixture.workspace, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turns: [] };
    fs.writeFileSync(`${sessionDir}/${frontSessionId}.json`, JSON.stringify(frontMetadata));
    const descriptors = new Map(), fsApi = { ...fs, openSync(file, flags) { const fd = fs.openSync(file, flags); descriptors.set(fd, file); return fd; }, closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
        realpathSync(file) { if (process.platform !== 'linux' && /^\/proc\/self\/fd\/\d+$/.test(file)) return fs.realpathSync(descriptors.get(Number(path.basename(file)))); return fs.realpathSync(file); } };
    const contractFiles = delegationContractFiles(repository), contractHashes = Object.fromEntries(contractFiles.map(file => [file, liveSkillsHash(fs.readFileSync(`${codeRoot}/${file}`))]));
    const capture = async baselineFiles => { let value; await readDelegationSnapshot({ fixture, workspaceRoot: root, frontSessionId, frontRobotId: robots[0].id, expectedRepository: repository,
        contractFiles, contractHashes, expectedAla, markerFile: C4_WORKER_MARKER, baselineFiles }, { codeRoot, dataRoot, fsApi, emit: result => { value = result; } }); return value; };
    const baseline = await capture(); const startedAt = Date.now() - 1;
    const rawTools = [];
    const launchReply = await action({ promptText: JSON.stringify({ action: 'start', workflowTypeId: fixture.workflowId, objective: delegationObjective(fixture), folder: fixture.workspace }),
        workingDir: fixture.workspace, agentClient: { async callToolWithoutWait(tool, input) { rawTools.push({ tool, input }); assert.equal(tool, 'roboflow_start_flow'); return service.startFlow(input); } } });
    assert.match(launchReply, /workflow started/); assert.equal(rawTools.length, 1); assert.ok(dispatched);
    const flow = (await service.store.list())[0], instance = flow.instances[0];
    const runtime = { taskId: instance.runtimeTaskId, robotId: fixture.robotId, type: dispatched.type, state: 'running', request: dispatched.request,
        alaSessionId: dispatched.request.alaSessionId, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), result: '', logTail: '' };
    saveTaskExecution({ dataDir: dataRoot, workspaceRoot: root }, runtime);
    const snapshotExecution = await installLiveSkills({ service: skillsets, robot: dispatched.robot, policyId: runtime.alaSessionId, cwd: fixture.workspace, client });
    const { release, ...execution } = snapshotExecution; await release();
    const childTurnId = randomUUID(), childMetadata = { version: 2, sessionId: runtime.alaSessionId, cwd: fixture.workspace, skillPolicyRef: runtime.alaSessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        engine: { type: 'ala', version: 1, sessionId: runtime.alaSessionId, home: workerHome, cwd: fixture.workspace, robotId: fixture.robotId, backend: 'codex' },
        skillExecution: { ...execution, active: false }, turns: [{ turnId: childTurnId, userMessageId: randomUUID(), assistantMessageId: randomUUID(), timestamp: new Date().toISOString(), status: 'completed', tasks: [] }] };
    const childFile = `${sessionDir}/${runtime.alaSessionId}.json`; fs.writeFileSync(childFile, JSON.stringify(childMetadata));
    const helper = `${fixture.workspace}/.agents/skills/${fixture.skillName}/receipt.mjs`;
    const executionResult = spawnSync(process.execPath, [helper], { cwd: fixture.workspace, env: { ...process.env, HOME: workerHome }, encoding: 'utf8', timeout: 10_000 }); assert.equal(executionResult.status, 0, executionResult.stderr);
    const final = executionResult.stdout.trimEnd();
    function transcript(id, turnId, user, finalText, agent, continuationId, at) {
        const filename = `${fixture.workspace}/.roboteam/.ala/sessions/${id}.jsonl`; fs.mkdirSync(path.dirname(filename), { recursive: true });
        let seq = 1; fs.writeFileSync(filename, JSON.stringify({ seq, type: 'session', id, at }) + '\n');
        const append = (type, fields) => fs.appendFileSync(filename, JSON.stringify({ seq: ++seq, type, at: type === 'user' ? at : new Date().toISOString(), ...fields }) + '\n');
        const recorder = createTranscriptRecorder({ append }, turnId); recorder.user(user); recorder.observe({ type: 'agentlib-tool', tool: 'PRIVATE_TOOL_SENTINEL', reason: 'PRIVATE_REASON_SENTINEL' });
        const continuation = agent === 'opencode' ? { sessionId: continuationId } : { threadId: continuationId };
        return recorder.finish({ result: finalText, status: 'completed' }).then(() => append('continuation', { agent, continuation: { ...continuation, hidden: 'PRIVATE_CONTINUATION_SENTINEL' } }));
    }
    await transcript(runtime.alaSessionId, childTurnId, buildTaskPrompt(runtime.request), final, 'codex', 'c4-child-thread', new Date(startedAt).toISOString());
    runtime.state = 'completed'; runtime.result = final; runtime.completedAt = new Date().toISOString(); saveTaskExecution({ dataDir: dataRoot, workspaceRoot: root }, runtime);
    service.onRuntimeTaskEvent({ kind: 'progress', taskId: runtime.taskId, chunk: final, outputKind: 'assistant', outputComplete: true });
    await service.chains.get(flow.id);
    service.onRuntimeTaskEvent({ kind: 'terminal', taskId: runtime.taskId, state: 'completed', result: final }); await service.chains.get(flow.id);
    const remoteTaskId = randomUUID(), taskId = backgroundTaskContract.localTaskId('roboTeamAgent', remoteTaskId), task = { version: 1, id: taskId, targetAgent: 'roboTeamAgent', toolName: 'roboflow_start_flow', remoteTaskId,
        sessionId: frontSessionId, assistantMessageId: assistantId, turnId: frontTurnId, description: backgroundTaskContract.describeTask('roboTeamAgent', 'roboflow_start_flow', rawTools[0].input), status: 'finished', remoteStatus: 'completed',
        createdAt: new Date(startedAt).toISOString(), updatedAt: new Date().toISOString(), details: { url: `/base-agent-additional-server/roboTeamAgent/3001/flows?flowId=${flow.id}`, label: 'Open workflow page' },
        finalOutputOffset: 0, finalOutputLength: final.length, turn: 1 };
    const taskRoot = `${fixture.workspace}/.roboteam/tasks/${taskId}`; fs.mkdirSync(taskRoot); fs.writeFileSync(`${taskRoot}/task.json`, JSON.stringify(task)); fs.mkdirSync(`${taskRoot}/logs`); fs.writeFileSync(`${taskRoot}/logs/output.log`, final);
    frontMetadata.engine = { type: 'ala', version: 1, sessionId: frontSessionId, cwd: fixture.workspace, home: `${dataRoot}/robots/existing-front/home`, backend: 'opencode', robotId: 'existing-front' };
    frontMetadata.skillExecution = { active: false, live: true };
    frontMetadata.turns = [{ turnId: frontTurnId, userMessageId: randomUUID(), assistantMessageId: assistantId, timestamp: new Date(startedAt).toISOString(), status: 'completed', tasks: [taskId] }];
    fs.writeFileSync(`${sessionDir}/${frontSessionId}.json`, JSON.stringify(frontMetadata));
    await transcript(frontSessionId, frontTurnId, delegationPrompt(fixture), launchReply, 'opencode', 'c4-front-session', new Date(startedAt).toISOString());
    const snapshot = await capture(baseline.userFiles);
    const input = { snapshot, fixture, baseline, frontRobotId: 'existing-front', frontBackend: 'opencode', startedAt, finishedAt: Date.now() + 1 };
    return { root, fixture, source, baseline, snapshot, input, service, robots, helper, workerHome, rawTools, runtime, capture };
}

test('C4 old delegation wiring cannot satisfy the current launch-workflow contract', () => {
    const source = fs.readFileSync(new URL('../specs/06-copilot-codex-delegation.spec.mjs', import.meta.url), 'utf8');
    assert.ok(source.includes('validateWorkflowDelegation'), 'The deployed spec still accepts retired agent dispatch/file-only evidence.');
    assert.match(source, /assertLiveSkillsLivePreflight/);
});

test('C4 current launch-workflow, matching service, synthetic child ALA and real helper prove delegated file ownership', async t => {
    const c = await harness(t), proof = validateWorkflowDelegation(c.input);
    assert.equal(proof.child.backend, 'codex'); assert.equal(proof.front.backend, 'opencode');
    assert.equal(c.rawTools[0].input.objective, delegationObjective(c.fixture));
    assert.doesNotMatch(JSON.stringify(c.snapshot), /PRIVATE_(TOOL|REASON|CONTINUATION)_SENTINEL/);
    assert.equal(c.snapshot.tasks[0].description, 'roboTeamAgent.roboflow_start_flow');
    assert.ok(!c.snapshot.tasks[0].description.includes(c.fixture.filename));
});

const corruptions = {
    'duplicate matching worker': c => { c.input.snapshot.matchingRobotIds.push('other-worker'); },
    'wrong worker backend': c => { c.input.snapshot.worker.codingAgents = ['opencode']; },
    'wrong child native backend': c => { c.input.snapshot.child.native.agent = 'opencode'; },
    'wrong child robot': c => { c.input.snapshot.child.session.engine.robotId = 'existing-front'; },
    'wrong native home': c => { c.input.snapshot.child.session.engine.home += '-other'; },
    'wrong task cwd': c => { c.input.snapshot.child.runtime.request.cwd += '-other'; },
    'foreign workflow folder': c => { c.input.snapshot.flow.folder += '-other'; },
    'different stored objective': c => { c.input.snapshot.flow.objective += ' altered'; },
    'foreign runtime context': c => { c.input.snapshot.child.runtime.request.task = '{}'; },
    'unjoined front turn': c => { c.input.snapshot.tasks[0].turnId = randomUUID(); },
    'wrong detail flow': c => { c.input.snapshot.tasks[0].details.url += 'f'; },
    'duplicate task card': c => { c.input.snapshot.tasks.push({ ...c.input.snapshot.tasks[0], id: `task_${'b'.repeat(24)}` }); },
    'another child phase': c => { c.input.snapshot.flow.instances.push({ ...c.input.snapshot.flow.instances[0] }); },
    'direct front-file receipt': c => { c.input.snapshot.receipt.robotId = 'existing-front'; },
    'fabricated file-only success': c => { c.input.snapshot.child = null; c.input.snapshot.receipt = null; },
    'unrelated user file change': c => { c.input.snapshot.userChanges.push('unrelated.txt'); },
    'missing newline': c => { c.input.snapshot.fileContent = c.fixture.marker; },
    'source-only answer leaked into request': c => { c.input.snapshot.front.session.messages[0].text += c.fixture.proofNonce; },
    'missing front session identity': c => { c.input.snapshot.front.native.continuation = {}; },
    'Codex-shaped OpenCode front': c => { c.input.snapshot.front.native.continuation = { threadId: 'wrong-shape' }; },
    'extra private front continuation': c => { c.input.snapshot.front.native.continuation.private = 'private'; },
    'extra helper bookkeeping file': c => { c.input.snapshot.receiptFiles.push('foreign.json'); },
    'private child prompt projection': c => { c.input.snapshot.child.session.messages.find(message => message.role === 'user').text = 'private prompt'; },
    'unmatched child prompt': c => { c.input.snapshot.child.session.messages.find(message => message.role === 'user').userMatchesTask = false; },
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`C4 rejects ${name}`, async t => {
    const c = await harness(t); corrupt(c); assert.throws(() => validateWorkflowDelegation(c.input));
});

test('C4 helper refuses execution from the front home and refuses copied/replayed helpers', async t => {
    const c = await harness(t);
    const frontHome = `${c.root}/_data/robots/existing-front/home`;
    const wrongHome = spawnSync(process.execPath, [c.helper], { cwd: c.fixture.workspace, env: { ...process.env, HOME: frontHome }, encoding: 'utf8' });
    assert.notEqual(wrongHome.status, 0); assert.match(wrongHome.stderr, /ENOENT/);
    const copy = `${c.fixture.workspace}/copy.mjs`; fs.copyFileSync(`${c.fixture.repositoryRoot}/skills/${c.fixture.skillName}/receipt.mjs`, copy);
    assert.notEqual(spawnSync(process.execPath, [copy], { cwd: c.fixture.workspace, env: { ...process.env, HOME: c.workerHome } }).status, 0);
    assert.notEqual(spawnSync(process.execPath, [c.helper], { cwd: c.fixture.workspace, env: { ...process.env, HOME: c.workerHome } }).status, 0);
});

test('C4 reader treats missing child session publication as incomplete evidence and never file-only success', async t => {
    const c = await harness(t), child = `${c.fixture.workspace}/.roboteam/sessions/${c.runtime.alaSessionId}.json`;
    fs.renameSync(child, `${child}.saved`);
    const incomplete = await c.capture(c.baseline.userFiles); assert.equal(incomplete.child, null);
    assert.throws(() => validateWorkflowDelegation({ ...c.input, snapshot: incomplete }));
    fs.renameSync(`${child}.saved`, child);
});

test('C4 reader refuses changed source before evaluating it or reading proof state', async t => {
    const c = await harness(t), source = `${c.root}/AchillesCLI/roboTeamAgent/server/robot-store.mjs`, sentinel = `${c.root}/evaluated_codex.json`;
    fs.appendFileSync(source, `\nimport { writeFileSync as c4Sentinel } from 'node:fs'; c4Sentinel(${JSON.stringify(sentinel)}, '{}');\n`);
    await assert.rejects(c.capture(c.baseline.userFiles), /Delegation source differs/);
    assert.equal(fs.existsSync(sentinel), false);
});

test('C4 serialized snapshot arguments retain canonical paths without an ambient helper binding', t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4-program-'))); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = `${directory}/program.mjs`; fs.writeFileSync(file, delegationProgram(readDelegationSnapshot, { workspaceRoot: "/srv/it's $HOME `x` ü" }));
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(file, 'utf8'), /const readLiveSkillsCodeHashes = /);
});

test('C4 fixture defines one workflow and worker without starting a flow or seeding worker defaults', async () => {
    const { createWorkflowDelegationController } = await import('./copilot-workflow-delegation-fixture.mjs');
    const fixture = createWorkflowDelegationFixture('/srv/c4-workspace'), calls = [], files = new Map(), workflows = [];
    const robots = [{ id: 'existing-default', name: 'default', codingAgents: ['opencode'], repositories: [] }];
    const reader = { prepare: async () => {}, markWorker: async () => ({ marked: true, robotId: fixture.robotId, markerSha256: 'a'.repeat(64) }),
        removeLinks: async () => {}, removeFolders: async () => {} };
    const api = async input => {
        calls.push(input);
        if (input.path === 'api/robots' && !input.method) return { status: 200, payload: { canAdmin: true, robots } };
        if (input.path === 'api/roboflow/workflows' && !input.method) return { status: 200, payload: { workflows } };
        if (input.path === 'api/robots' && input.method === 'POST') { const robot = { id: 'owned-only', ...input.body, repositories: [] }; robots.push(robot); return { status: 201, payload: { robot } }; }
        if (input.path === `api/robots/${fixture.robotId}/skillsets`) {
            robots[1].repositories = input.method === 'POST' ? [{ id: input.body.name, source: input.body.source }] : [];
            return { status: 200, payload: { ok: true } };
        }
        if (input.path === 'api/roboflow/workflows' && input.method === 'POST') { const workflow = { ...input.body, coverage: { tasks: [{ taskId: 'proof', matchingRobotIds: [fixture.robotId] }] } }; workflows.push(workflow); return { status: 201, payload: { workflow } }; }
        if (input.method === 'DELETE' && input.path === `api/roboflow/workflows/${fixture.workflowId}`) { workflows.length = 0; return { status: 200, payload: { deleted: true } }; }
        if (input.path === 'api/control' && input.body.operation === 'robot-delete') { robots.splice(1); return { status: 200, payload: { ok: true } }; }
        assert.fail(`Unexpected operation ${input.path}`);
    };
    const fsTool = async (tool, input) => {
        if (tool === 'create_directory') return { rawText: 'Successfully created directory owned' };
        if (tool === 'write_file') { files.set(input.path, input.content); return { rawText: 'Successfully wrote to owned' }; }
        return { rawText: files.get(input.path) };
    };
    const controller = createWorkflowDelegationController({ fixture, workspaceRoot: '/srv/c4-workspace', api, fsTool, reader,
        listRepositories: async () => [{ name: fixture.repositoryName, source: fixture.repositoryRoot, origin: 'workspace', kind: 'skills' }, { name: 'DocumentationSkills', origin: 'workspace' }] });
    const original = JSON.stringify(robots[0]);
    await controller.setup();
    assert.equal(calls.filter(call => call.method === 'POST' && call.path === 'api/roboflow/workflows').length, 1);
    assert.ok(!calls.some(call => /\/flows(?:\/|$)|defaults|coding-agents/.test(call.path)));
    assert.equal(JSON.stringify(robots[0]), original);
    await assert.rejects(controller.cleanup({ quiescent: false }), /native quiescence/);
    await controller.cleanup({ quiescent: true, observedFlows: [] });
    assert.equal(JSON.stringify(robots[0]), original); assert.equal(controller.state.cleanup, 'passed');
});

test('C4 review R1 helper works with empty read-only native .roboteam mask', t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4-mask-')));
    t.after(() => { fs.chmodSync(`${root}/work/.roboteam`, 0o700); fs.rmSync(root, { recursive: true, force: true }); });
    const fixture = createWorkflowDelegationFixture(root); fixture.robotId = 'owned-mask-worker';
    fixture.workspace = `${root}/work`;
    fs.mkdirSync(`${fixture.repositoryRoot}/skills/${fixture.skillName}`, { recursive: true });
    fs.mkdirSync(`${fixture.workspace}/.agents/skills`, { recursive: true });
    fs.mkdirSync(`${fixture.workspace}/.roboteam`, { mode: 0o555 });
    const home = `${root}/worker-home`; fs.mkdirSync(home);
    fs.writeFileSync(`${home}/${C4_WORKER_MARKER}`, JSON.stringify({ version: 1, kind: 'set2-c4-worker',
        runId: fixture.runId, robotId: fixture.robotId, robotName: fixture.robotName, proofNonce: fixture.proofNonce }));
    const source = delegationSkillSources(fixture);
    fs.writeFileSync(`${fixture.repositoryRoot}/skills/${fixture.skillName}/receipt.mjs`, source.helper);
    fs.symlinkSync(`${fixture.repositoryRoot}/skills/${fixture.skillName}`, `${fixture.workspace}/.agents/skills/${fixture.skillName}`);
    const mask = fs.lstatSync(`${fixture.workspace}/.roboteam`);
    const result = spawnSync(process.execPath, [`${fixture.workspace}/.agents/skills/${fixture.skillName}/receipt.mjs`],
        { cwd: fixture.workspace, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(`${fixture.workspace}/.roboteam`), []);
    const after = fs.lstatSync(`${fixture.workspace}/.roboteam`);
    assert.equal(after.ino, mask.ino); assert.equal(after.mode, mask.mode);
    assert.equal(fs.readFileSync(`${fixture.workspace}/${fixture.filename}`, 'utf8'), `${fixture.marker}\n`);
});

for (const [backend, continuation] of Object.entries({
    opencode: { sessionId: 'ses_c4_front_actual' },
    pi: { sessionId: 'pi-c4-front-actual', sessionFile: '/owned-front-home/pi/session.jsonl' },
})) test(`C4 review R2 accepts actual ${backend} frontend continuation`, async t => {
    const c = await harness(t), id = c.snapshot.front.session.sessionId;
    const transcriptFile = `${c.fixture.workspace}/.roboteam/.ala/sessions/${id}.jsonl`;
    const records = fs.readFileSync(transcriptFile, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const record = records.find(row => row.type === 'continuation'); record.agent = backend; record.continuation = continuation;
    fs.writeFileSync(transcriptFile, records.map(row => JSON.stringify(row)).join('\n') + '\n');
    const metadataFile = `${c.fixture.workspace}/.roboteam/sessions/${id}.json`;
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')); metadata.engine.backend = backend;
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    const snapshot = await c.capture(c.baseline.userFiles);
    const proof = validateWorkflowDelegation({ ...c.input, snapshot, frontBackend: backend });
    assert.equal(proof.front.backend, backend);
    assert.equal(snapshot.front.native.continuation.sessionId, continuation.sessionId);
    assert.equal(proof.child.backend, 'codex');
    if (backend === 'pi') {
        const invalid = structuredClone(snapshot); delete invalid.front.native.continuation.sessionFile;
        assert.throws(() => validateWorkflowDelegation({ ...c.input, snapshot: invalid, frontBackend: backend }));
    }
});

test('C4 review R3 child system prompt never leaves composed snapshot', async t => {
    const c = await harness(t), id = c.runtime.alaSessionId;
    const sentinel = 'PRIVATE_C4_CHILD_SYSTEM_PROMPT_SENTINEL';
    const file = `${c.fixture.workspace}/.roboteam/tasks/${id}/executions/${c.runtime.taskId}.json`;
    const runtime = JSON.parse(fs.readFileSync(file, 'utf8')); runtime.request.systemPrompt = sentinel;
    fs.writeFileSync(file, JSON.stringify(runtime));
    const { buildTaskPrompt } = await import(pathToFileURL(`${c.root}/AchillesCLI/roboTeamAgent/copilot/src/lib/prompts.mjs`).href);
    const transcriptFile = `${c.fixture.workspace}/.roboteam/.ala/sessions/${id}.jsonl`;
    const records = fs.readFileSync(transcriptFile, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const user = records.find(row => row.type === 'user'); user.text = buildTaskPrompt(runtime.request);
    assert.ok(user.text.includes(sentinel));
    fs.writeFileSync(transcriptFile, records.map(row => JSON.stringify(row)).join('\n') + '\n');
    const snapshot = await c.capture(c.baseline.userFiles);
    assert.equal(snapshot.child.native.turns[0].userMatchesTask, true);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(sentinel));
    assert.equal(validateWorkflowDelegation({ ...c.input, snapshot }).status, 'completed');
});

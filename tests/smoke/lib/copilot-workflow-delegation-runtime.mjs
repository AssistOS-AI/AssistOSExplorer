import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLiveSkillsRuntimeReader, readLiveSkillsCodeHashes, validateLiveSkillsRuntimeBinding, liveSkillsProtectedSources, normalizeLiveSkillsImageId } from './copilot-live-skills-runtime.mjs';
import { liveSkillsHash } from './copilot-live-skills.mjs';
import { inspectBoxWorkspace } from './box-workspace.mjs';
import { validateWorkspaceSourceMount } from './live-box.mjs';
import { requireMount, rejectShadows } from './local-snapshot-bindings.mjs';

export function delegationProgram(fn, args) {
    return `const readLiveSkillsCodeHashes = ${readLiveSkillsCodeHashes.toString()};\n(${fn.toString()})(${JSON.stringify(args)}).catch(() => { console.error('Invalid bounded delegation evidence'); process.exitCode = 1; });\n`;
}

export function delegationContractFiles(repository, fsApi = fs) {
    const root = path.join(repository, 'roboTeamAgent'), files = [];
    const visit = directory => {
        assert.equal(fsApi.realpathSync(directory), directory);
        for (const entry of fsApi.readdirSync(directory, { withFileTypes: true })) {
            if (['node_modules', '.git'].includes(entry.name)) continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.name.endsWith('.mjs')) { assert.ok(entry.isFile()); files.push(path.relative(root, file)); }
        }
    };
    visit(root);
    assert.ok(files.length > 0);
    return files.sort();
}

export async function readDelegationSnapshot({ fixture, workspaceRoot, frontSessionId, frontRobotId, expectedRepository, contractFiles, contractHashes, expectedAla, markerFile,
    baselineFiles = null, writeWorkerMarker = false }, { dataRoot = '/data', codeRoot = '/code', fsApi, emit = value => console.log(JSON.stringify(value)) } = {}) {
    const assert = (await import('node:assert/strict')).default;
    const fs = fsApi || await import('node:fs');
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const { createHash } = await import('node:crypto');
    const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
    assert.equal(fs.realpathSync(workspaceRoot), workspaceRoot); assert.equal(fixture.workspace, `${workspaceRoot}/${fixture.folder}`);
    assert.equal(fixture.repositoryRoot, `${workspaceRoot}/${fixture.repositoryName}`);
    assert.equal(fs.realpathSync(fixture.workspace), fixture.workspace); assert.equal(fs.realpathSync(fixture.repositoryRoot), fixture.repositoryRoot);
    assert.match(fixture.robotId, /^[a-z0-9][a-z0-9-]{2,63}$/);
    const codeHashes = await readLiveSkillsCodeHashes({ expectedRepository, contractFiles }, { codeRoot, fsApi });
    assert.deepEqual(codeHashes, contractHashes, 'Delegation source differs from the selected checkout.');
    function bytes(file, root, limit = 4 * 1024 * 1024) {
        assert.ok(file.startsWith(`${root}/`)); assert.equal(fs.realpathSync(file), file, 'Delegation record must remain canonical.');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const before = fs.fstatSync(fd); assert.ok(before.isFile() && before.nlink === 1 && before.size <= limit);
            const value = fs.readFileSync(fd), after = fs.fstatSync(fd);
            assert.ok(before.size === value.length && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
            return value;
        } finally { fs.closeSync(fd); }
    }
    const json = (file, root) => JSON.parse(bytes(file, root));
    const workerRoot = `${dataRoot}/robots/${fixture.robotId}`; assert.equal(fs.realpathSync(workerRoot), workerRoot);
    const worker = json(`${workerRoot}/metadata.json`, workerRoot);
    assert.equal(worker.id, fixture.robotId); assert.equal(worker.name, fixture.robotName); assert.deepEqual(worker.codingAgents, ['codex']);
    const registered = (worker.skillsets || []).filter(repo => repo.name === fixture.repositoryName);
    assert.equal(registered.length, 1); assert.equal(registered[0].source, fixture.repositoryRoot);
    const home = `${workerRoot}/home`; assert.equal(fs.realpathSync(home), home);
    const marker = { version: 1, kind: 'set2-c4-worker', runId: fixture.runId, robotId: fixture.robotId, robotName: fixture.robotName, proofNonce: fixture.proofNonce };
    assert.equal(markerFile, '.set2-c4-worker_codex.json');
    if (writeWorkerMarker) {
        fs.writeFileSync(`${home}/${markerFile}`, JSON.stringify(marker) + '\n', { flag: 'wx', mode: 0o600 });
        return emit({ marked: true, robotId: fixture.robotId, markerSha256: hash(marker) });
    }
    assert.deepEqual(json(`${home}/${markerFile}`, workerRoot), marker);
    const robotRecords = fs.readdirSync(`${dataRoot}/robots`, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .map(entry => json(`${dataRoot}/robots/${entry.name}/metadata.json`, `${dataRoot}/robots/${entry.name}`));
    const { matchRobot } = await import(pathToFileURL(`${codeRoot}/server/roboflow/skill-matching.mjs`).href);
    const { WorkflowRegistry } = await import(pathToFileURL(`${codeRoot}/server/roboflow/workflow-registry.mjs`).href);
    const { TaskFlowStore } = await import(pathToFileURL(`${codeRoot}/server/roboflow/task-flow-store.mjs`).href);
    const { DatabaseSync } = await import('node:sqlite');
    const databaseFile = `${dataRoot}/roboflow/roboflow.sqlite`; assert.equal(fs.realpathSync(databaseFile), databaseFile);
    assert.ok(fs.lstatSync(databaseFile).isFile());
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    let workflow, flows;
    try {
        db.exec('BEGIN');
        workflow = new WorkflowRegistry({ database: { db, file: databaseFile } }).getSync(fixture.workflowId);
        const store = new TaskFlowStore({ database: { db, file: databaseFile } });
        flows = db.prepare('SELECT id FROM workflow_runs').all().map(row => store.getSync(row.id))
            .filter(flow => flow.workflowTypeId === fixture.workflowId || flow.folder === fixture.workspace);
        db.exec('COMMIT');
    } finally { db.close(); }
    assert.ok(workflow); const matchingRobotIds = robotRecords.filter(robot => matchRobot(robot, workflow.tasks[0])).map(robot => robot.id).sort();
    for (const file of ['package.json', 'bin/ala.mjs', 'src/transcript.mjs']) assert.equal(hash(bytes(`${expectedAla.root}/${file}`, expectedAla.root)), expectedAla.hashes[file]);
    const { resolveAlaCommand } = await import(pathToFileURL(`${codeRoot}/server/ala-command.mjs`).href);
    assert.equal(fs.realpathSync(process.env.ACHILLES_ALA_COMMAND || resolveAlaCommand()), expectedAla.command);
    const { ConversationSessionStore } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/storage/conversationSessionStore.mjs`).href);
    const { alaTranscript, alaSessionsRoot } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/execution/alaTranscript.mjs`).href);
    const { readWorkspaceTasks, readTaskLog } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/tasks/workspaceTasks.mjs`).href);
    const { buildTaskPrompt } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/prompts.mjs`).href);
    const { __testables: taskContract } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/webchat/webchatBackgroundTasks.mjs`).href);
    const { workflowIdForTask } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/webchat/webchatWorkflowStatus.mjs`).href);
    function session(id, rawTask = null) {
        assert.match(id, /^[a-f0-9-]{36}$/);
        const metadata = json(`${fixture.workspace}/.roboteam/sessions/${id}.json`, fixture.workspace);
        const composed = new ConversationSessionStore({ workingDir: fixture.workspace }).loadSession(id);
        let native;
        try { native = alaTranscript.readSessionSync(alaSessionsRoot(fixture.workspace), id); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        return { session: { sessionId: composed.sessionId, cwd: composed.cwd, engine: composed.engine, skillPolicyRef: composed.skillPolicyRef,
            skillExecution: composed.skillExecution, messages: composed.messages.filter(message => ['user', 'assistant'].includes(message.role))
                .map(({ id, role, text, turnId, status }) => ({ id, role, turnId, status,
                    ...(rawTask && role === 'user' ? { userMatchesTask: text === buildTaskPrompt(rawTask) } : { text }) })) },
            turns: metadata.turns.map(({ turnId, assistantMessageId, tasks, thinkingUrl }) => ({ turnId, assistantMessageId, tasks, thinkingUrl })),
            native: native ? { id: native.id, agent: native.agent, continuation: native.agent === 'codex' ? { threadId: native.continuation?.threadId }
                    : native.agent === 'opencode' ? { sessionId: native.continuation?.sessionId }
                    : native.agent === 'pi' ? { sessionId: native.continuation?.sessionId, sessionFile: native.continuation?.sessionFile } : {},
                turns: native.turns.map(({ turnId, final, status, startedAt, endedAt, user }) => ({ turnId, final, status, startedAt, endedAt,
                    ...(rawTask ? { userMatchesTask: user === buildTaskPrompt(rawTask) } : { user }) })) } : null };
    }
    const front = session(frontSessionId);
    assert.equal(front.session.cwd, fixture.workspace);
    if (front.session.engine) { assert.equal(front.session.engine.robotId, frontRobotId); assert.equal(front.session.engine.home, `${dataRoot}/robots/${frontRobotId}/home`); }
    const tasks = readWorkspaceTasks(fixture.workspace);
    let flow = null, child = null, receipt = null, selectedLink = null, receiptFiles = [];
    const referenced = tasks.filter(task => workflowIdForTask(task));
    if (referenced.length === 1) flow = flows.find(flow => flow.id === workflowIdForTask(referenced[0])) || null;
    if (flow && flow.folder === fixture.workspace && flow.instances.length === 1 && flow.instances[0].robotId === fixture.robotId) {
        const instance = flow.instances[0], tasksRoot = `${fixture.workspace}/.roboteam/tasks`;
        const matches = fs.readdirSync(tasksRoot).filter(id => /^[a-f0-9-]{36}$/.test(id))
            .filter(id => fs.lstatSync(`${tasksRoot}/${id}/task.json`, { throwIfNoEntry: false }))
            .map(id => ({ id, record: json(`${tasksRoot}/${id}/task.json`, fixture.workspace) }))
            .filter(({ record }) => record.robotId === fixture.robotId && record.request?.runtimeTaskId === instance.runtimeTaskId && record.request?.workflowRunId === flow.id);
        if (matches.length && fs.lstatSync(`${fixture.workspace}/.roboteam/sessions/${matches[0].id}.json`, { throwIfNoEntry: false })
            && fs.lstatSync(`${tasksRoot}/${matches[0].id}/executions/${instance.runtimeTaskId}.json`, { throwIfNoEntry: false })) {
            assert.equal(matches.length, 1);
            const definition = matches[0].record;
            const runtime = json(`${tasksRoot}/${matches[0].id}/executions/${instance.runtimeTaskId}.json`, fixture.workspace);
            assert.equal(runtime.alaSessionId, definition.id);
            const request = runtime.request;
            child = { runtime: { taskId: runtime.taskId, robotId: runtime.robotId, type: runtime.type, state: runtime.state,
                alaSessionId: runtime.alaSessionId, result: runtime.result, request: { cwd: request.cwd, task: request.task, ca: request.ca,
                    workflowRunId: request.workflowRunId, runtimeTaskId: request.runtimeTaskId, requiredWorkflowSkillsets: request.requiredWorkflowSkillsets,
                    skillPolicyRef: request.skillPolicyRef } }, ...session(definition.id, request) };
            const resultFile = `${fixture.workspace}/.roboteam/roboflow/${flow.id}/${instance.id}.result`;
            if (fs.existsSync(resultFile) && instance.latestResult) {
                const resultBytes = bytes(resultFile, fixture.workspace), { start, end } = instance.latestResult;
                assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= resultBytes.length);
                instance.finalResponse = resultBytes.subarray(start, end).toString('utf8');
            }
            flow.result = instance.finalResponse || '';
            const receiptRoot = `${fixture.workspace}/.set2-c4-proof`;
            if (fs.existsSync(receiptRoot)) {
                assert.equal(fs.realpathSync(receiptRoot), receiptRoot);
                assert.ok(fs.lstatSync(receiptRoot).isDirectory() && !fs.lstatSync(receiptRoot).isSymbolicLink());
                receiptFiles = fs.readdirSync(receiptRoot).sort();
                const receiptFile = `${receiptRoot}/${fixture.runId}_codex.json`;
                if (fs.existsSync(receiptFile)) receipt = json(receiptFile, fixture.workspace);
            }
            const link = `${fixture.workspace}/.agents/skills/${fixture.skillName}`;
            if (fs.existsSync(link)) {
                assert.ok(fs.lstatSync(link).isSymbolicLink()); assert.equal(fs.realpathSync(link), `${fixture.repositoryRoot}/skills/${fixture.skillName}`);
                const installed = json(`${fixture.workspace}/.agents/.roboteam-links.json`, fixture.workspace);
                assert.ok(Array.isArray(installed));
                const selected = installed.filter(entry => entry.destination === link); assert.equal(selected.length, 1);
                assert.equal(selected[0].repoName, fixture.repositoryName); assert.equal(selected[0].sourcePath, `skills/${fixture.skillName}`);
                assert.equal(fs.readlinkSync(link), selected[0].linkTarget);
                selectedLink = { source: fs.realpathSync(link), revision: hash(installed), destination: link, linkTarget: selected[0].linkTarget,
                    helperSha256: hash(bytes(`${fixture.repositoryRoot}/skills/${fixture.skillName}/receipt.mjs`, fixture.repositoryRoot)) };
            }
        }
    }
    for (const task of tasks) {
        assert.equal(task.id, taskContract.localTaskId(task.targetAgent, task.remoteTaskId), 'Background task handle differs from its current remote identity.');
        const log = readTaskLog(fixture.workspace, task.id).text;
        task.logContainsMarker = log.includes(fixture.marker);
        task.finalMatchesChild = Boolean(child?.native?.turns.length === 1 && task.finalOutputOffset !== null && task.finalOutputLength > 0
            && log.slice(task.finalOutputOffset, task.finalOutputOffset + task.finalOutputLength) === child.native.turns[0].final.trim());
    }
    const userFiles = {};
    const visit = (folder, relative = '') => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            if (!relative && ['.roboteam', '.agents', '.claude', '.set2-c4-proof'].includes(entry.name)) continue;
            const key = relative ? `${relative}/${entry.name}` : entry.name, filename = `${folder}/${entry.name}`;
            assert.ok(!entry.isSymbolicLink(), 'Unexpected user-file symlink.');
            if (entry.isDirectory()) { userFiles[key] = { type: 'directory' }; visit(filename, key); }
            else userFiles[key] = { type: 'file', sha256: hash(bytes(filename, fixture.workspace)) };
        }
    };
    visit(fixture.workspace);
    const userChanges = baselineFiles ? [...new Set([...Object.keys(userFiles), ...Object.keys(baselineFiles)])].filter(key => hash(userFiles[key] || null) !== hash(baselineFiles[key] || null)).sort() : [];
    const proofFile = `${fixture.workspace}/${fixture.filename}`;
    const fileContent = fs.existsSync(proofFile) ? bytes(proofFile, fixture.workspace, 4096).toString('utf8') : null;
    assert.deepEqual(await readLiveSkillsCodeHashes({ expectedRepository, contractFiles }, { codeRoot, fsApi }), codeHashes);
    for (const file of ['package.json', 'bin/ala.mjs', 'src/transcript.mjs']) assert.equal(hash(bytes(`${expectedAla.root}/${file}`, expectedAla.root)), expectedAla.hashes[file]);
    // Runtime logs, intermediate ALA output and tools stay inside the reader. Only final text and bounded identities leave it.
    emit({ workspace: fixture.workspace, workerRoot, worker: { id: worker.id, name: worker.name, codingAgents: worker.codingAgents },
        workflow, matchingRobotIds, front, tasks: tasks.map(({ id, targetAgent, remoteTaskId, toolName, sessionId, assistantMessageId, turnId, status, remoteStatus, description, details, finalMatchesChild, logContainsMarker }) =>
            ({ id, targetAgent, toolName, sessionId, assistantMessageId, turnId, status, remoteStatus, description, details, finalMatchesChild, logContainsMarker })),
        flows: flows.map(({ id, workflowTypeId, folder, status }) => ({ id, workflowTypeId, folder, status })),
        flow: flow ? { id: flow.id, workflowTypeId: flow.workflowTypeId, workflowName: flow.workflowName, folder: flow.folder,
            objective: flow.objective, status: flow.status, graph: flow.graph, result: flow.result,
            instances: flow.instances.map(({ id, taskId, state, executionType, robotId, robotName, runtimeTaskId, startedAt, endedAt, finalResponse }) =>
                ({ id, taskId, state, executionType, robotId, robotName, runtimeTaskId, startedAt, endedAt, finalResponse })) } : null, child, receipt, receiptFiles, selectedLink, userFiles, userChanges, fileContent, codeHashes,
        capturedAt: new Date().toISOString() });
}

function podman(args, input = '') {
    return new Promise((resolve, reject) => {
        const child = spawn('podman', args, { stdio: ['pipe', 'pipe', 'pipe'] }), chunks = [];
        let size = 0; const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
        child.stdout.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) child.kill('SIGKILL'); else chunks.push(chunk); }); child.stderr.resume();
        child.on('error', () => { clearTimeout(timer); reject(new Error('Bounded delegation evidence collection could not start.')); });
        child.on('close', code => { clearTimeout(timer); if (code !== 0 || size > 8 * 1024 * 1024) return reject(new Error('Bounded delegation evidence collection failed.')); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid delegation evidence JSON.')); } });
        child.stdin.on('error', () => {}); child.stdin.end(input);
    });
}

export async function createWorkflowDelegationReader({ env = process.env, baseURL, verifierPath }, { createGuard = createLiveSkillsRuntimeReader, runCommand = podman, fsApi = fs } = {}) {
    const guard = await createGuard({ env, baseURL, verifierPath });
    const root = guard.workspaceRoot, repository = fsApi.realpathSync(guard.release.repositories.achillesCLI.repositoryPath);
    const contractFiles = delegationContractFiles(repository, fsApi);
    const contractHashes = Object.fromEntries(contractFiles.map(file => [file, liveSkillsHash(fsApi.readFileSync(`${repository}/roboTeamAgent/${file}`))]));
    const initial = await guard.finish(), box = guard.release.liveBox.box, expectedAla = initial.alaBinding;
    const agentLibRelative = guard.release.agentLib?.mode && guard.release.agentLib.mode !== 'image' ? guard.release.agentLib.sourceRelativePath : null;
    const agentLibAlias = agentLibRelative && agentLibRelative !== 'image' ? path.posix.join(root, agentLibRelative) : null;
    async function binding(fixture) {
        const checked = await guard.finish(); assert.deepEqual(checked.runtime, initial.runtime);
        const [outer] = await runCommand(['inspect', box.containerId]);
        assert.equal(outer.Id, box.containerId); assert.equal(outer.State.Running, true);
        assert.equal(new Date(outer.State.StartedAt).toISOString(), new Date(box.startedAt).toISOString());
        assert.equal(normalizeLiveSkillsImageId(outer.Image), normalizeLiveSkillsImageId(box.imageId)); assert.equal(inspectBoxWorkspace(outer).source, root);
        validateWorkspaceSourceMount(outer.Mounts, root, { realpathSync: fsApi.realpathSync });
        const allowed = outer.Mounts.filter(mount => mount.Destination === root);
        if (agentLibAlias && outer.Mounts.some(mount => mount.Destination === agentLibAlias)) allowed.push(requireMount(outer.Mounts, agentLibAlias, agentLibAlias, { readOnly: true, lexical: true, subject: 'Delegation' }));
        rejectShadows(outer.Mounts, [...liveSkillsProtectedSources(checked.runtime, repository, root), expectedAla.root, fixture.workspace, fixture.repositoryRoot], allowed, { subject: 'Delegation' });
        validateLiveSkillsRuntimeBinding(checked.runtime, repository, { workspaceRoot: root, fixtureWorkspace: fixture.workspace, fixtureRepository: fixture.repositoryRoot, alaSource: expectedAla.root, fsApi });
        return checked.runtime;
    }
    async function capture(args) {
        const runtime = await binding(args.fixture);
        const snapshot = await runCommand(['exec', '-i', '--user', 'podman', box.containerId, 'podman', 'exec', '-i', runtime.containerId,
            'node', '--input-type=module', '-'], delegationProgram(readDelegationSnapshot, { ...args, workspaceRoot: root, expectedRepository: repository, contractFiles, contractHashes, expectedAla, markerFile: '.set2-c4-worker_codex.json' }));
        if (!args.writeWorkerMarker) { assert.equal(snapshot.workspace, args.fixture.workspace); assert.deepEqual(snapshot.codeHashes, contractHashes); }
        return snapshot;
    }
    return { workspaceRoot: root, release: guard.release, prepare: fixture => guard.fixtureOperation('prepare', fixture),
        removeLinks: fixture => guard.fixtureOperation('remove-links', fixture), removeFolders: fixture => guard.fixtureOperation('remove-folders', fixture),
        markWorker: fixture => capture({ fixture, writeWorkerMarker: true }), capture,
        finish: async () => ({ ...await guard.finish(), delegationContractHashes: contractHashes }) };
}

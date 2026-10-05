import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLiveSkillsFixture, liveSkillsHash, UUID } from './copilot-live-skills.mjs';

export const C4_WORKER_MARKER = '.set2-c4-worker_codex.json';
export const C4_RECEIPT_DIRECTORY = '.set2-c4-proof';
export const C4_FLOW = /^flow_[0-9a-f]{24}$/;
export const C4_TASK = /^task_[0-9a-f]{24}$/;

export function createWorkflowDelegationFixture(workspaceRoot) {
    const fixture = createLiveSkillsFixture(workspaceRoot);
    return { ...fixture, kind: 'workflow-delegation', workflowId: `set2-c4-${fixture.runId}`, skillName: fixture.control.name,
        filename: `c4-proof-${fixture.runId}_codex.txt`, marker: `CODEX_DELEGATION_OK_${fixture.runId}`, proofNonce: randomUUID(),
        requirement: `${fixture.repositoryRoot}/${fixture.control.name}` };
}

export function delegationObjective(fixture) {
    return `In the current project directory create exactly ${fixture.filename} whose complete contents are ${fixture.marker} followed by one newline. Modify no other user files. Verify the file and report ${fixture.marker}.`;
}

export function delegationPrompt(fixture) {
    return `Use the current launch-workflow skill to start exactly one saved workflow with workflowTypeId ${fixture.workflowId} in ${fixture.workspace}. Pass this objective verbatim: ${delegationObjective(fixture)} Do not perform the file task yourself. Let the workflow choose its worker and execution mode. Do not start another workflow or invoke a robot directly.`;
}

export function delegationWorkflow(fixture) {
    return { id: fixture.workflowId, name: `C4 ${fixture.runId}`, description: 'Run-owned terminal file proof.', entryTaskId: 'proof',
        tasks: [{ id: 'proof', name: 'Write and verify the requested file', executionType: 'terminal', skillsets: [fixture.requirement],
            prompt: 'Use the required skill and its installed receipt.mjs helper exactly once. Only that helper writes the requested file and its runtime receipt. Report its output, including the fresh source proof value. Do not create the file or receipt yourself.' }],
        edges: [], layout: { proof: { x: 60, y: 60 } } };
}

export function delegationSkillSources(fixture) {
    assert.match(fixture.robotId || '', /^[a-z0-9][a-z0-9-]{2,63}$/);
    const descriptor = `---\nname: ${fixture.skillName}\ndescription: Execute the run-owned terminal workflow file proof.\n---\n\nFor the workflow's exact objective, execute Node.js through the installed live link ${fixture.workspace}/.agents/skills/${fixture.skillName}/receipt.mjs once, with no arguments. The helper verifies this worker's home marker and installed source, writes the requested file and its exclusive runtime receipt, and prints the verified marker and fresh source proof value. Report its output. Never create or alter the proof file or receipt yourself.\n`;
    const helper = `import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport { createHash } from 'node:crypto';\nimport { fileURLToPath } from 'node:url';\nassert.equal(process.argv.length, 2);\nconst hash = value => createHash('sha256').update(value).digest('hex');\nconst cwd = fs.realpathSync(process.cwd());\nassert.equal(cwd, ${JSON.stringify(fixture.workspace)});\nconst homeMarker = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ${JSON.stringify(C4_WORKER_MARKER)}), 'utf8'));\nassert.deepEqual(homeMarker, ${JSON.stringify({ version: 1, kind: 'set2-c4-worker', runId: fixture.runId, robotId: fixture.robotId, robotName: fixture.robotName, proofNonce: fixture.proofNonce })});\nconst invokedPath = path.resolve(process.argv[1]);\nconst resolvedSource = fileURLToPath(import.meta.url);\nassert.equal(invokedPath, path.join(cwd, '.agents', 'skills', ${JSON.stringify(fixture.skillName)}, 'receipt.mjs'));\nassert.equal(fs.realpathSync(invokedPath), resolvedSource);\nassert.equal(resolvedSource, ${JSON.stringify(`${fixture.repositoryRoot}/skills/${fixture.skillName}/receipt.mjs`)});\nconst content = ${JSON.stringify(`${fixture.marker}\n`)};\nconst receiptRoot = path.join(cwd, ${JSON.stringify(C4_RECEIPT_DIRECTORY)});\nassert.equal(fs.existsSync(receiptRoot), false, 'Exclusive proof directory is required');\nfs.mkdirSync(receiptRoot, { mode: 0o700 });\nassert.equal(fs.realpathSync(receiptRoot), receiptRoot);\nconst receiptPath = path.join(receiptRoot, ${JSON.stringify(`${fixture.runId}_codex.json`)});\nassert.equal(fs.existsSync(receiptPath), false);\nfs.writeFileSync(path.join(cwd, ${JSON.stringify(fixture.filename)}), content, { flag: 'wx', mode: 0o600 });\nconst receipt = { version: 2, kind: 'set2-c4-helper', runId: homeMarker.runId, robotId: homeMarker.robotId, cwd, invokedPath, resolvedSource, helperSha256: hash(fs.readFileSync(resolvedSource)), fileSha256: hash(content), proofNonce: homeMarker.proofNonce, createdAt: new Date().toISOString(), pid: process.pid };\nfs.writeFileSync(receiptPath, JSON.stringify(receipt) + '\\n', { flag: 'wx', mode: 0o600 });\nconsole.log(${JSON.stringify(fixture.marker)});\nconsole.log(homeMarker.proofNonce);\n`;
    return { descriptor, helper, descriptorSha256: liveSkillsHash(descriptor), helperSha256: liveSkillsHash(helper) };
}

function graphDefinition(graph) {
    const { id, name, description, entryTaskId, tasks, edges, layout } = graph;
    return { id, name, description, entryTaskId, tasks, edges, layout };
}

export function validateFrontContinuation(backend, continuation) {
    const keys = backend === 'codex' ? ['threadId'] : backend === 'opencode' ? ['sessionId'] : backend === 'pi' ? ['sessionFile', 'sessionId'] : [];
    assert.ok(keys.length > 0 && continuation && typeof continuation === 'object');
    assert.deepEqual(Object.keys(continuation).sort(), keys);
    for (const key of keys) assert.ok(typeof continuation[key] === 'string' && continuation[key].length > 0 && continuation[key].length <= (key === 'sessionFile' ? 4096 : 1024));
    return Object.fromEntries(keys.map(key => [key, continuation[key]]));
}

export function validateWorkflowDelegation({ snapshot, fixture, baseline, frontRobotId, frontBackend, startedAt, finishedAt }) {
    assert.ok(['codex', 'opencode', 'pi'].includes(frontBackend), 'Record the selected front backend explicitly.');
    assert.equal(snapshot.workspace, fixture.workspace);
    assert.equal(snapshot.worker.id, fixture.robotId); assert.equal(snapshot.worker.name, fixture.robotName);
    assert.deepEqual(snapshot.worker.codingAgents, ['codex']);
    assert.deepEqual(snapshot.matchingRobotIds, [fixture.robotId], 'Exactly one canonical matching worker is required.');
    assert.deepEqual(graphDefinition(snapshot.workflow), delegationWorkflow(fixture));
    const front = snapshot.front;
    assert.equal(front.session.sessionId, baseline.front.session.sessionId);
    assert.equal(front.session.cwd, fixture.workspace); assert.equal(front.session.engine.robotId, frontRobotId);
    assert.equal(front.session.engine.backend, frontBackend); assert.equal(front.native.agent, frontBackend);
    assert.equal(front.native.id, front.session.sessionId);
    const frontContinuation = validateFrontContinuation(frontBackend, front.native.continuation);
    const assistants = front.session.messages.filter(message => message.role === 'assistant' && !baseline.front.session.messages.some(old => old.id === message.id));
    assert.equal(assistants.length, 1); const assistant = assistants[0]; assert.equal(assistant.status, 'completed');
    const user = front.session.messages.filter(message => message.role === 'user' && message.turnId === assistant.turnId);
    assert.equal(user.length, 1); assert.equal(user[0].text, delegationPrompt(fixture));
    const refs = front.turns.filter(turn => turn.turnId === assistant.turnId);
    assert.equal(refs.length, 1); assert.equal(refs[0].assistantMessageId, assistant.id);
    const frontTurns = front.native.turns.filter(turn => turn.turnId === assistant.turnId);
    assert.equal(frontTurns.length, 1); assert.equal(frontTurns[0].status, 'completed');
    assert.equal(frontTurns[0].user, delegationPrompt(fixture));
    const thinking = refs[0].thinkingUrl || '';
    if (thinking) assert.equal(thinking, `/base-agent-additional-server/roboTeamAgent/3001/webchat-logs/${front.session.sessionId}/${assistant.id}`);
    assert.equal(assistant.text, frontTurns[0].final + (thinking ? `\n\n[View Thinking](${thinking})` : ''));
    assert.equal(front.session.skillExecution.active, false);
    const tasks = snapshot.tasks.filter(task => !baseline.tasks.some(old => old.id === task.id));
    assert.equal(tasks.length, 1, 'One UI objective must create exactly one background task.'); const task = tasks[0];
    assert.deepEqual(refs[0].tasks, [task.id]); assert.equal(task.sessionId, front.session.sessionId);
    assert.equal(task.assistantMessageId, assistant.id); assert.equal(task.turnId, assistant.turnId);
    assert.equal(task.targetAgent, 'roboTeamAgent'); assert.equal(task.toolName, 'roboflow_start_flow');
    assert.equal(task.status, 'finished'); assert.equal(task.remoteStatus, 'completed');
    const url = new URL(task.details.url, 'http://localhost');
    assert.equal(url.pathname, '/base-agent-additional-server/roboTeamAgent/3001/flows');
    assert.equal(url.searchParams.get('flowId'), snapshot.flow.id); assert.match(snapshot.flow.id, C4_FLOW);
    assert.equal(task.details.url, `${url.pathname}?flowId=${snapshot.flow.id}`);
    assert.equal(task.finalMatchesChild, true); assert.equal(task.logContainsMarker, true);
    const flows = snapshot.flows.filter(flow => !baseline.flows.some(old => old.id === flow.id));
    assert.equal(flows.length, 1); assert.equal(flows[0].id, snapshot.flow.id);
    const flow = snapshot.flow; assert.equal(flow.workflowTypeId, fixture.workflowId); assert.equal(flow.folder, fixture.workspace);
    assert.equal(flow.objective, delegationObjective(fixture)); assert.equal(flow.status, 'completed');
    assert.deepEqual(graphDefinition(flow.graph), delegationWorkflow(fixture)); assert.equal(flow.instances.length, 1);
    const instance = flow.instances[0]; assert.equal(instance.taskId, 'proof'); assert.equal(instance.state, 'completed');
    assert.equal(instance.executionType, 'terminal'); assert.equal(instance.robotId, fixture.robotId); assert.equal(instance.robotName, fixture.robotName);
    const child = snapshot.child; assert.ok(child, 'A file alone does not prove native delegation.');
    assert.equal(child.runtime.taskId, instance.runtimeTaskId); assert.equal(child.runtime.robotId, fixture.robotId);
    assert.equal(child.runtime.type, 'simple'); assert.equal(child.runtime.state, 'completed');
    assert.equal(child.runtime.request.cwd, fixture.workspace); assert.equal(child.runtime.request.workflowRunId, flow.id);
    const context = JSON.parse(child.runtime.request.task);
    assert.equal(context.objective, delegationObjective(fixture)); assert.equal(context.currentTaskId, 'proof');
    assert.deepEqual(graphDefinition(context.graph), delegationWorkflow(fixture)); assert.deepEqual(context.previousFinalResponses, []);
    assert.deepEqual(child.runtime.request.requiredWorkflowSkillsets, [fixture.requirement]);
    assert.equal(child.session.sessionId, child.runtime.alaSessionId); assert.equal(child.session.skillPolicyRef, child.session.sessionId);
    assert.equal(child.session.engine.robotId, fixture.robotId); assert.equal(child.session.engine.backend, 'codex');
    assert.equal(child.session.engine.home, `${snapshot.workerRoot}/home`); assert.equal(child.session.engine.cwd, fixture.workspace);
    assert.equal(child.native.id, child.session.sessionId); assert.equal(child.native.agent, 'codex'); assert.ok(child.native.continuation.threadId);
    assert.equal(child.native.turns.length, 1); const turn = child.native.turns[0]; assert.equal(turn.status, 'completed');
    assert.equal(turn.userMatchesTask, true); assert.ok(turn.final.includes(fixture.marker) && turn.final.includes(fixture.proofNonce));
    const childUsers = child.session.messages.filter(message => message.role === 'user' && message.turnId === turn.turnId);
    assert.equal(childUsers.length, 1); assert.equal(childUsers[0].userMatchesTask, true);
    assert.equal(Object.hasOwn(childUsers[0], 'text'), false, 'Private child prompt text must stay inside the reader.');
    assert.equal(child.runtime.result, turn.final); assert.equal(instance.finalResponse, turn.final); assert.equal(flow.result, turn.final);
    assert.equal(child.session.skillExecution.live, true); assert.equal(child.session.skillExecution.active, false);
    assert.ok(child.session.skillExecution.entries.some(entry => entry.identity === `${fixture.repositoryName}/${fixture.skillName}` && entry.sourcePath === `${fixture.repositoryRoot}/skills/${fixture.skillName}`));
    const receipt = snapshot.receipt; assert.ok(receipt, 'Child helper receipt is mandatory.');
    assert.equal(receipt.version, 2); assert.equal(receipt.kind, 'set2-c4-helper');
    assert.deepEqual(snapshot.receiptFiles, [`${fixture.runId}_codex.json`]);
    assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 0);
    for (const [key, expected] of Object.entries({ runId: fixture.runId, robotId: fixture.robotId, cwd: fixture.workspace, invokedPath: `${fixture.workspace}/.agents/skills/${fixture.skillName}/receipt.mjs`,
        resolvedSource: `${fixture.repositoryRoot}/skills/${fixture.skillName}/receipt.mjs`, helperSha256: delegationSkillSources(fixture).helperSha256,
        fileSha256: liveSkillsHash(`${fixture.marker}\n`), proofNonce: fixture.proofNonce })) assert.equal(receipt[key], expected, `Child receipt ${key} differs.`);
    assert.ok(Date.parse(receipt.createdAt) >= Date.parse(turn.startedAt) && Date.parse(receipt.createdAt) <= Date.parse(turn.endedAt));
    assert.ok(Date.parse(turn.startedAt) >= startedAt && Date.parse(turn.endedAt) <= finishedAt);
    assert.equal(snapshot.fileContent, `${fixture.marker}\n`); assert.deepEqual(snapshot.userChanges, [fixture.filename]);
    assert.equal(snapshot.selectedLink.source, `${fixture.repositoryRoot}/skills/${fixture.skillName}`);
    assert.equal(snapshot.selectedLink.helperSha256, receipt.helperSha256);
    assert.equal(snapshot.selectedLink.revision, child.session.skillExecution.revision);
    assert.equal(snapshot.selectedLink.destination, `${fixture.workspace}/.agents/skills/${fixture.skillName}`);
    return { taskId: task.id, flowId: flow.id, instanceId: instance.id, runtimeTaskId: instance.runtimeTaskId,
        front: { robotId: frontRobotId, backend: frontBackend, sessionId: front.session.sessionId, turnId: assistant.turnId, continuation: frontContinuation },
        child: { robotId: fixture.robotId, backend: 'codex', sessionId: child.session.sessionId, turnId: turn.turnId, threadId: child.native.continuation.threadId },
        fileSha256: receipt.fileSha256, helperSha256: receipt.helperSha256, receiptSha256: liveSkillsHash(receipt), status: 'completed' };
}

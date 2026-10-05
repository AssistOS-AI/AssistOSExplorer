import assert from 'node:assert/strict';
import { delegationWorkflow, delegationSkillSources } from './copilot-workflow-delegation.mjs';

// Setup only creates definitions/resources. The objective reaches start-flow solely through Copilot UI.
export function createWorkflowDelegationController({ fixture, workspaceRoot, api, listRepositories, fsTool, reader }) {
    const state = { prepareAttempted: false, prepared: false, creationAttempted: false, workerCreated: false, registered: false,
        workflowAttempted: false, workflowCreated: false, markerWritten: false, cleanup: 'pending' };
    const request = async (input, status) => {
        const reply = await api(input); assert.equal(reply.status, status, `Delegation fixture API ${input.method || 'GET'} ${input.path} failed.`); return reply.payload;
    };
    const robots = async () => (await request({ path: 'api/robots' }, 200)).robots;
    async function worker() {
        const matches = (await robots()).filter(robot => robot.id === fixture.robotId);
        assert.equal(matches.length, 1); assert.equal(matches[0].name, fixture.robotName); assert.deepEqual(matches[0].codingAgents, ['codex']);
        return matches[0];
    }
    async function write(relative, content) {
        assert.ok(relative.startsWith(`${fixture.repositoryName}/skills/${fixture.skillName}/`));
        assert.ok(['SKILL.md', 'receipt.mjs'].includes(relative.split('/').at(-1)));
        assert.match((await fsTool('write_file', { path: relative, content })).rawText || '', /^Successfully wrote to /);
        assert.equal((await fsTool('read_file', { path: relative })).rawText, content);
    }
    return {
        state, robots, worker,
        async setup() {
            assert.equal(fixture.robotId, null); assert.equal(fixture.workspace, `${workspaceRoot}/${fixture.folder}`);
            const initial = await request({ path: 'api/robots' }, 200); assert.equal(initial.canAdmin, true);
            assert.ok(!initial.robots.some(robot => robot.name === fixture.robotName), 'Refuse an existing worker name.');
            const existing = await request({ path: 'api/roboflow/workflows' }, 200);
            assert.ok(!existing.workflows.some(workflow => workflow.id === fixture.workflowId), 'Refuse an existing workflow ID.');
            state.prepareAttempted = true; await reader.prepare(fixture); state.prepared = true;
            state.creationAttempted = true;
            const created = await request({ method: 'POST', path: 'api/robots', body: { name: fixture.robotName, codingAgents: ['codex'] } }, 201);
            assert.equal(created.robot?.name, fixture.robotName); assert.deepEqual(created.robot.codingAgents, ['codex']);
            assert.match(created.robot.id || '', /^[a-z0-9][a-z0-9-]{2,63}$/); fixture.robotId = created.robot.id; state.workerCreated = true;
            const sources = delegationSkillSources(fixture), relative = `${fixture.repositoryName}/skills/${fixture.skillName}`;
            assert.match((await fsTool('create_directory', { path: relative })).rawText || '', /^Successfully created directory /);
            await write(`${relative}/SKILL.md`, sources.descriptor); await write(`${relative}/receipt.mjs`, sources.helper);
            const catalog = await listRepositories(), selected = catalog.filter(repo => repo.name === fixture.repositoryName);
            assert.equal(selected.length, 1); assert.equal(selected[0].source, fixture.repositoryRoot);
            assert.equal(selected[0].origin, 'workspace'); assert.equal(selected[0].kind, 'skills');
            assert.ok(catalog.some(repo => repo.name === 'DocumentationSkills' && repo.origin !== 'remote'), 'Required DocumentationSkills must already be local.');
            await request({ method: 'POST', path: `api/robots/${fixture.robotId}/skillsets`, body: { name: fixture.repositoryName, source: fixture.repositoryRoot } }, 200);
            state.registered = true;
            const marked = await reader.markWorker(fixture); assert.equal(marked.robotId, fixture.robotId); assert.equal(marked.marked, true); state.markerWritten = true;
            state.workflowAttempted = true;
            const response = await request({ method: 'POST', path: 'api/roboflow/workflows', body: delegationWorkflow(fixture) }, 201);
            assert.equal(response.workflow.id, fixture.workflowId); state.workflowCreated = true;
            assert.deepEqual(response.workflow.coverage.tasks, [{ taskId: 'proof', matchingRobotIds: [fixture.robotId] }], 'Exactly one canonical worker must match.');
            await worker();
            return { runId: fixture.runId, workerId: fixture.robotId, workerName: fixture.robotName, repositoryName: fixture.repositoryName,
                source: fixture.repositoryRoot, workspace: fixture.workspace, workflowId: fixture.workflowId, requirement: fixture.requirement,
                descriptorSha256: sources.descriptorSha256, helperSha256: sources.helperSha256, markerSha256: marked.markerSha256 };
        },
        async cleanup({ observedFlows = [], quiescent }) {
            if (state.cleanup === 'passed') return;
            state.cleanup = 'failed'; assert.equal(quiescent, true, 'Delegation cleanup requires proved native quiescence.');
            assert.ok(!state.prepareAttempted || state.prepared, 'Preparation outcome is ambiguous; retain ownership.');
            assert.ok(!state.creationAttempted || state.workerCreated, 'Worker creation outcome is ambiguous; retain ownership.');
            assert.ok(!state.workflowAttempted || state.workflowCreated, 'Workflow creation outcome is ambiguous; retain ownership.');
            for (const flow of observedFlows) {
                assert.ok(flow.workflowTypeId === fixture.workflowId || flow.folder === fixture.workspace, 'Refuse unrelated flow cleanup.');
                assert.ok(['completed', 'failed', 'paused', 'terminated'].includes(flow.status), 'A workflow is still active.');
            }
            if (state.workflowCreated) {
                const current = await request({ path: 'api/roboflow/workflows' }, 200);
                const matches = current.workflows.filter(workflow => workflow.id === fixture.workflowId); assert.equal(matches.length, 1);
                assert.deepEqual(matches[0].tasks, delegationWorkflow(fixture).tasks); assert.deepEqual(matches[0].edges, []);
                const deleted = await request({ method: 'DELETE', path: `api/roboflow/workflows/${fixture.workflowId}` }, 200);
                assert.equal(deleted.deleted, true); state.workflowCreated = false;
            }
            if (state.workerCreated) {
                const robot = await worker(); const registered = robot.repositories.filter(repo => repo.id === fixture.repositoryName);
                assert.ok(registered.length <= 1);
                if (registered.length) {
                    assert.equal(registered[0].source, fixture.repositoryRoot);
                    await reader.removeLinks(fixture);
                    await request({ method: 'DELETE', path: `api/robots/${fixture.robotId}/skillsets`, body: { name: fixture.repositoryName } }, 200); state.registered = false;
                } else assert.equal(state.registered, false, 'Owned registration disappeared unexpectedly.');
                await request({ method: 'POST', path: 'api/control', body: { operation: 'robot-delete', robotId: fixture.robotId } }, 200);
                assert.ok(!(await robots()).some(robot => robot.id === fixture.robotId)); state.workerCreated = false;
            }
            if (state.prepared) { await reader.removeFolders(fixture); state.prepared = false; }
            state.cleanup = 'passed';
        },
    };
}

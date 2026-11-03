import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateLiveSkillsRuntimeBinding } from './copilot-live-skills-runtime.mjs';

function binding(agentName = 'roboWorkAgent') {
    const root = '/fixture', repository = `${root}/AchillesIDE`, source = `${repository}/${agentName}`;
    const objectId = randomUUID(), payloadPath = `${root}/.ploinky/deps/store/objects/${objectId}/payload`;
    const dependency = { schema: 1, mode: 'store', family: 'container', runtimeKey: 'container-linux-x64-glibc-node22',
        imageId: 'a'.repeat(64), inputKey: 'b'.repeat(64), generationId: 'c'.repeat(64), objectId,
        payloadPath, nodeModulesPath: `${payloadPath}/node_modules` };
    const bind = (Source, Destination, RW) => ({ Type: 'bind', Source, Destination, RW });
    const runtime = { key: 'owned-runtime', containerId: 'd'.repeat(64), instanceId: randomUUID(), enableGeneration: randomUUID(),
        startedAt: '2026-11-01T00:00:00Z', imageId: 'a'.repeat(64), dependencies: dependency, mounts: [
            bind(root, root, true), bind(`${root}/.data/${agentName === 'roboWorkAgent' ? '.private/' : ''}${agentName}`, '/data', true),
            bind(source, source, true), bind(source, '/code', false),
            bind(`${root}/.ploinky/container-runtime/owned-runtime/Agent-1-2`, '/Agent', false),
            bind('/opt/ploinky-agentlib', '/opt/ploinky-agentlib', false),
            bind(dependency.nodeModulesPath, '/code/node_modules', false), bind(dependency.nodeModulesPath, dependency.nodeModulesPath, false),
        ] };
    return { root, repository, runtime, dependency };
}

test('RoboWork evidence requires its private data and source mounts; a RoboTeam container fails', () => {
    const work = binding(), team = binding('roboTeamAgent');
    const options = { workspaceRoot: work.root, agentName: 'roboWorkAgent' };
    assert.equal(validateLiveSkillsRuntimeBinding(work.runtime, work.repository, options), work.runtime);
    assert.throws(() => validateLiveSkillsRuntimeBinding(team.runtime, team.repository, options));
    assert.throws(() => validateLiveSkillsRuntimeBinding(work.runtime, work.repository, { workspaceRoot: work.root }));
    assert.equal(validateLiveSkillsRuntimeBinding(team.runtime, team.repository, { workspaceRoot: team.root }), team.runtime);
});

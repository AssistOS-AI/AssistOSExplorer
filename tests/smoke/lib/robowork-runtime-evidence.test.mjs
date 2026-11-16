import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateLiveSkillsRuntimeBinding, liveSkillsProtectedSources } from './copilot-live-skills-runtime.mjs';

function binding(agentName = 'roboWorkAgent') {
    const root = '/fixture', repository = `${root}/AchillesIDE`, source = `${repository}/${agentName}`;
    const objectId = randomUUID(), payloadPath = `${root}/.ploinky/deps/store/objects/${objectId}/payload`;
    const dependency = { schema: 1, mode: 'store', family: 'container', runtimeKey: 'container-linux-x64-glibc-node22',
        imageId: 'a'.repeat(64), inputKey: 'b'.repeat(64), generationId: 'c'.repeat(64), objectId,
        payloadPath, nodeModulesPath: `${payloadPath}/node_modules` };
    const bind = (Source, Destination, RW) => ({ Type: 'bind', Source, Destination, RW });
    const runtime = { key: 'owned-runtime', containerId: 'd'.repeat(64), instanceId: randomUUID(), enableGeneration: randomUUID(),
        startedAt: '2026-11-01T00:00:00Z', imageId: 'a'.repeat(64), dependencies: dependency, mounts: [
            bind(root, root, true), bind(`${root}/.data/agents/${agentName}`, agentName === 'roboWorkAgent' ? '/root' : '/data', true),
            bind(source, source, true), bind(source, '/code', false),
            bind(`${root}/.ploinky/container-runtime/owned-runtime/Agent-1-2`, '/Agent', false),
            bind('/opt/ploinky-agentlib', '/opt/ploinky-agentlib', false),
            bind(dependency.nodeModulesPath, '/code/node_modules', false), bind(dependency.nodeModulesPath, dependency.nodeModulesPath, false),
        ] };
    if (agentName === 'roboWorkAgent') runtime.mounts.push(bind(`${root}/.data/robots`, '/robots', true));
    return { root, repository, runtime, dependency };
}

test('RoboWork evidence requires its home, robots and source mounts; a RoboTeam container fails', () => {
    const work = binding(), team = binding('roboTeamAgent');
    const options = { workspaceRoot: work.root, agentName: 'roboWorkAgent' };
    assert.equal(validateLiveSkillsRuntimeBinding(work.runtime, work.repository, options), work.runtime);
    assert.throws(() => validateLiveSkillsRuntimeBinding(team.runtime, team.repository, options));
    assert.throws(() => validateLiveSkillsRuntimeBinding(work.runtime, work.repository, { workspaceRoot: work.root }));
    assert.equal(validateLiveSkillsRuntimeBinding(team.runtime, team.repository, { workspaceRoot: team.root }), team.runtime);
});

for (const destination of ['/root', '/robots']) {
    for (const scenario of ['missing', 'foreign', 'read-only', 'duplicate', 'shadow']) {
        test(`RoboWork evidence rejects ${scenario} ${destination} storage`, () => {
            const { root, repository, runtime } = binding();
            const mount = runtime.mounts.find(item => item.Destination === destination);
            if (scenario === 'missing') runtime.mounts = runtime.mounts.filter(item => item !== mount);
            if (scenario === 'foreign') mount.Source = `${root}/.data/other`;
            if (scenario === 'read-only') mount.RW = false;
            if (scenario === 'duplicate') runtime.mounts.push({ ...mount });
            if (scenario === 'shadow') runtime.mounts.push({ ...mount, Destination: `${destination}/nested` });
            assert.throws(() => validateLiveSkillsRuntimeBinding(runtime, repository, { workspaceRoot: root, agentName: 'roboWorkAgent' }));
        });
    }
}

test('RoboWork outer evidence protects both home and robot storage sources', () => {
    const { root, repository, runtime } = binding();
    const sources = liveSkillsProtectedSources(runtime, repository, root, 'roboWorkAgent');
    assert.ok(sources.includes(`${root}/.data/agents/roboWorkAgent`));
    assert.ok(sources.includes(`${root}/.data/robots`));
});

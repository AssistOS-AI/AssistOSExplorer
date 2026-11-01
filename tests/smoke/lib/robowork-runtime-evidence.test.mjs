import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readRegistryAndRuntime, validateLiveSkillsRuntimeBinding, liveSkillsProtectedSources, program } from './copilot-live-skills-runtime.mjs';

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

test('RoboWork evidence retains exact dependency, generation, source, write and shadow fences', () => {
    const { root, repository, runtime } = binding();
    for (const mutate of [
        value => { value.mounts.find(mount => mount.Destination === '/data').Source = `${root}/.data/roboWorkAgent`; },
        value => { value.mounts.find(mount => mount.Destination === '/data').RW = false; },
        value => { value.mounts.find(mount => mount.Destination === '/code').Source = `${root}/Other/roboWorkAgent`; },
        value => { value.mounts.find(mount => mount.Destination === '/code').RW = true; },
        value => { value.dependencies.generationId = 'invalid'; },
        value => { value.dependencies.imageId = 'f'.repeat(64); },
        value => { value.mounts.push({ Type: 'bind', Source: '/foreign', Destination: '/data/runs', RW: true }); },
        value => { value.containerId = 'short'; },
    ]) {
        const changed = structuredClone(runtime); mutate(changed);
        assert.throws(() => validateLiveSkillsRuntimeBinding(changed, repository, { workspaceRoot: root, agentName: 'roboWorkAgent' }));
    }
    assert.throws(() => validateLiveSkillsRuntimeBinding(runtime, repository, { workspaceRoot: root, agentName: 'anotherAgent' }));
    const sources = liveSkillsProtectedSources(runtime, repository, root, 'roboWorkAgent');
    assert.ok(sources.includes(`${root}/.data/.private/roboWorkAgent`));
    assert.ok(sources.includes(`${repository}/roboWorkAgent`));
    assert.ok(!sources.includes(`${repository}/roboTeamAgent`));
});

test('serialized registry reader selects exact RoboWork identity and rejects a wrong owner or container', t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'robowork-reader-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { runtime, dependency } = binding();
    const row = { type: 'agent', repoName: 'AchillesIDE', agentName: 'roboWorkAgent', runtime: 'podman',
        containerId: runtime.containerId, instanceId: runtime.instanceId, enableGeneration: runtime.enableGeneration };
    const dataModule = source => `data:text/javascript,${encodeURIComponent(source)}`;
    const capture = (selected = row, inspectedId = row.containerId) => {
        const inspected = [{ Id: inspectedId, State: { Running: true, StartedAt: runtime.startedAt }, Image: runtime.imageId, Mounts: runtime.mounts }];
        const validated = { valid: true, payloadPath: dependency.payloadPath, generationId: dependency.generationId,
            manifest: { contract: { runtime: { family: dependency.family, key: dependency.runtimeKey }, toolchain: { imageId: dependency.imageId } } } };
        const modules = {
            '/opt/ploinky/cli/utils/agentRegistrySnapshot.js': `export function readAgentRegistrySnapshot(){return ${JSON.stringify({ [runtime.key]: selected })};}`,
            '/opt/ploinky/cli/utils/dependencies/store/runtimeDependencies.mjs': `export function admittedDependencyRecord(){return ${JSON.stringify(dependency)};}`,
            '/opt/ploinky/cli/utils/dependencies/store/objectStore.mjs': `export function createCacheStore(){return {validateObject(){return ${JSON.stringify(validated)};}};}`,
            'node:child_process': `export function execFileSync(){return ${JSON.stringify(JSON.stringify(inspected))};}`,
        };
        let source = program(readRegistryAndRuntime, { workspaceRoot: directory, agentName: 'roboWorkAgent' });
        for (const [specifier, body] of Object.entries(modules)) source = source.replace(`'${specifier}'`, JSON.stringify(dataModule(body)));
        return spawnSync(process.execPath, ['--input-type=module', '-'], { input: source, encoding: 'utf8', timeout: 8000 });
    };
    const valid = capture(); assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).containerId, row.containerId);
    const wrongOwner = capture({ ...row, agentName: 'roboTeamAgent' }); assert.equal(wrongOwner.status, 1); assert.equal(wrongOwner.stdout, '');
    const wrongContainer = capture(row, 'e'.repeat(64)); assert.equal(wrongContainer.status, 1); assert.equal(wrongContainer.stdout, '');
});

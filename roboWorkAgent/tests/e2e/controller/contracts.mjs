import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const SENTINEL = 'ROBOWORK_CONTROLLER_PROBE_V1';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function validateConfig(config) {
    assert.ok(config && typeof config === 'object');
    for (const key of ['fixture', 'workspace', 'ploinkyRoot']) {
        assert.equal(typeof config[key], 'string');
        assert.ok(path.isAbsolute(config[key]) && path.normalize(config[key]) === config[key] && config[key] !== '/');
    }
    assert.match(config.ploinkyRevision || '', /^[a-f0-9]{40}$/u);
    for (const id of [config.box?.id, config.rt, config.rw]) assert.match(id || '', /^[a-f0-9]{64}$/u);
    assert.equal(new Set([config.box.id, config.rt, config.rw]).size, 3);
    assert.match(config.box.image || '', /^sha256:[a-f0-9]{64}$/u);
    assert.ok(config.box.startedAt && !Number.isNaN(Date.parse(config.box.startedAt)));
    assert.ok(['podman', 'docker'].includes(config.engine));
    assert.ok(Array.isArray(config.sources) && config.sources.length === 3);
    assert.deepEqual(config.sources.map(row => row.role).sort(), ['ala', 'rt', 'rw']);
    for (const source of config.sources) {
        assert.match(source.revision || '', /^[a-f0-9]{40}$/u);
        assert.ok(path.isAbsolute(source.root || '') && path.isAbsolute(source.runtimePath || ''));
        assert.equal(source.subdir, { rt: 'roboTeamAgent', rw: 'roboWorkAgent', ala: '' }[source.role]);
        if (source.role !== 'ala') assert.equal(source.runtimePath, '/code');
    }
    for (const id of [config.attacker, config.victim]) assert.match(id || '', /^[a-z0-9][a-z0-9-]{2,63}$/u);
    assert.notEqual(config.attacker, config.victim);
    return config;
}

export function assertBox(config, inspection) {
    assert.equal(inspection?.Id || inspection?.ID, config.box.id, 'Wrong Box ID.');
    assert.equal(inspection.Image, config.box.image, 'Wrong Box image.');
    assert.equal(inspection.State?.StartedAt, config.box.startedAt, 'Wrong Box generation.');
    assert.equal(inspection.State?.Running, true, 'Box is not running.');
    assert.ok(inspection.Mounts?.some(mount => mount.Type === 'bind' && mount.Source === config.fixture
        && mount.Destination === config.workspace), 'Box does not bind the exact selected fixture.');
}

export function selectAgent(registry, id, agentName) {
    const rows = Object.entries(registry).filter(([, row]) => row.type === 'agent' && row.agentName === agentName);
    assert.equal(rows.length, 1, 'Missing or ambiguous selected agent.');
    assert.equal(rows[0][1].containerId, id, 'Registry does not name the selected immutable container.');
    assert.equal(rows[0][1].repoName, 'AchillesIDE');
    return rows[0];
}

export function assertNoAgentExec(manifests) {
    assert.ok(Array.isArray(manifests) && manifests.length > 0, 'Enabled manifest inventory is empty.');
    for (const row of manifests) {
        assert.ok(row.name && row.manifest && typeof row.manifest === 'object', 'Missing enabled manifest.');
        assert.ok(!row.manifest.routerAccess?.agentExec, `Enabled agent requests agentExec: ${row.name}`);
    }
    return { count: manifests.length, manifestHash: sha256(JSON.stringify(manifests)) };
}

export function assertVictimUnchanged(before, after) {
    assert.match(before?.markerHash || '', /^[a-f0-9]{64}$/u);
    assert.match(before?.treeHash || '', /^[a-f0-9]{64}$/u);
    assert.ok(before.entries > 0);
    assert.deepEqual(after, before, 'Victim tree bytes, links or modes changed.');
}

export function assertRefused(result, expectedCode) {
    assert.equal(result?.ok, false, 'Protected grant unexpectedly succeeded.');
    assert.equal(result.code, expectedCode, 'Request failed for a different reason.');
}

export function assertDeleted(result) {
    assert.equal(result?.ok, true, 'Dedicated robot deletion or cleanup failed.');
    assert.equal(result.result?.deleted, true, 'Dedicated robot deletion or cleanup was not confirmed.');
}

export function assertDualHome(stats) {
    assert.equal(stats.length, 2);
    for (const stat of stats) assert.ok(stat.directory && Number.isSafeInteger(stat.ino) && stat.ino > 0);
    assert.equal(stats[0].dev, stats[1].dev);
    assert.equal(stats[0].ino, stats[1].ino, 'GUI home aliases are different inodes.');
}

export function pending(scenario, reason, evidence = {}) {
    throw Object.assign(new Error(reason), { code: 'ACCEPTANCE_PENDING', scenario, evidence });
}

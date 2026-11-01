import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const SENTINEL = 'ROBOWORK_CONTROLLER_PROBE_V1';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function validateConfig(config) {
    const fields = (value, allowed) => {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        assert.ok(Object.keys(value).every(key => allowed.includes(key)), 'Config accepts identities and private input paths only.');
    };
    fields(config, ['engine', 'fixture', 'workspace', 'ploinkyRoot', 'ploinkyRevision', 'box', 'rt', 'rw', 'attacker', 'victim', 'sources', 'explorer']);
    fields(config.box, ['id', 'image', 'startedAt']);
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
        fields(source, ['role', 'root', 'revision', 'subdir', 'runtimePath']);
        assert.match(source.revision || '', /^[a-f0-9]{40}$/u);
        assert.ok(path.isAbsolute(source.root || '') && path.isAbsolute(source.runtimePath || ''));
        assert.equal(source.subdir, { rt: 'roboTeamAgent', rw: 'roboWorkAgent', ala: '' }[source.role]);
        if (source.role !== 'ala') assert.equal(source.runtimePath, '/code');
        assert.ok(!source.root.includes('/.ploinky/repos/'), 'Use original source checkouts.');
    }
    if (config.explorer !== undefined) {
        fields(config.explorer, ['origin', 'storageState']);
        assert.equal(typeof config.explorer.origin, 'string');
        assert.ok(path.isAbsolute(config.explorer.storageState || ''), 'Authentication requires a private file path.');
    }
    for (const id of [config.attacker, config.victim]) assert.match(id || '', /^[a-z0-9][a-z0-9-]{2,63}$/u);
    assert.notEqual(config.attacker, config.victim);
    return structuredClone(config);
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

export function assertEmptyPrivateListing(entries) {
    assert.ok(Array.isArray(entries), 'Private listing did not return an array.');
    assert.deepEqual(entries, [], 'Private store is visible through Explorer.');
}

export function assertBrowserOrigin(origin, inspection) {
    const url = new URL(origin);
    assert.ok(['http:', 'https:'].includes(url.protocol));
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Controller API origin must be local to the selected Box host.');
    assert.equal(url.origin, origin, 'API origin must contain only scheme, host and port.');
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    assert.ok(Object.values(inspection.NetworkSettings?.Ports || {}).flat().some(binding => binding?.HostPort === port),
        'API origin is not a published port of the exact selected Box.');
    return url;
}

export function decodeMcpResult(body) {
    assert.ok(body && !body.error && body.result && body.result.isError !== true, 'Explorer MCP tool failed.');
    const result = body.result;
    const json = result.content?.find(block => block.type === 'json');
    if (json) return json.json;
    const text = result.content?.find(block => block.type === 'text');
    assert.equal(typeof text?.text, 'string', 'Explorer MCP returned no decodable result.');
    return JSON.parse(text.text);
}

export function normalizeMcpOutcome(result, transportError = null) {
    const failed = transportError !== null || !result || typeof result !== 'object'
        || result.isError === true || result.ok === false || typeof result.error === 'string';
    const texts = transportError ? [transportError.message] : (result?.content || []).filter(block => block.type === 'text').map(block => block.text);
    let code = result?.code || transportError?.code;
    if (failed) for (const text of texts) {
        const match = /^(?:MCP error -?[0-9]+:\s*)?(\{[^\n]+\})\s*$/u.exec(String(text));
        if (!match) continue;
        try {
            const envelope = JSON.parse(match[1]);
            if (typeof envelope.error === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(envelope.code || '')) code = envelope.code;
        } catch { /* A malformed diagnostic is not typed refusal evidence. */ }
    }
    return { ok: !failed, code: code || (failed ? 'MCP_UNCLASSIFIED_FAILURE' : undefined),
        result: transportError ? { diagnostic: transportError.message } : result };
}

export function assertNoMarker(value, markerHash, markerLength) {
    assert.match(markerHash || '', /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(markerLength) && markerLength > 0 && markerLength <= 4096);
    function inspect(item) {
        if (typeof item === 'string') {
            const candidates = [Buffer.from(item)];
            if (item.length > 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item)) {
                candidates.push(Buffer.from(item, 'base64'));
            }
            for (const bytes of candidates) for (let offset = 0; offset + markerLength <= bytes.length; offset++) {
                assert.notEqual(sha256(bytes.subarray(offset, offset + markerLength)), markerHash, 'Victim marker leaked in tool output.');
            }
        } else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { inspect(key); inspect(child); }
    }
    inspect(value);
}

export function assertDualHome(stats) {
    assert.equal(stats.length, 2);
    for (const stat of stats) assert.ok(stat.directory && Number.isSafeInteger(stat.dev) && stat.dev >= 0
        && Number.isSafeInteger(stat.ino) && stat.ino > 0);
    assert.equal(stats[0].dev, stats[1].dev);
    assert.equal(stats[0].ino, stats[1].ino, 'GUI home aliases are different inodes.');
}

export function pending(scenario, reason, evidence = {}) {
    throw Object.assign(new Error(reason), { code: 'ACCEPTANCE_PENDING', scenario, evidence });
}

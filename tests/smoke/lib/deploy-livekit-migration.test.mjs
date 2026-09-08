import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-skills-explorer.yml'), 'utf8');
const marker = /^          # BEGIN LiveKit repository migration\n([\s\S]*?)^          # END LiveKit repository migration$/gm;
const migrations = [...workflow.matchAll(marker)];
assert.equal(migrations.length, 1, 'expected one bounded migration before source update');
const migration = migrations[0][1].replace(/^ {10}/gm, '');
const retiredRepo = ['webmeet', 'Infra'].join('');
const oldContainers = ['old_livekit_one', 'old_livekit_two'];

// This fixture exercises the workflow at its CLI boundary. Actual Ploinky lifecycle
// semantics are verified separately against its source with process launches blocked.
function fixture(t, { installed = true, registered = true, cold = false } = {}) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-livekit-migration-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const state = path.join(workspace, '.ploinky');
    const writeJson = (name, value) => {
        fs.mkdirSync(path.dirname(path.join(state, name)), { recursive: true });
        fs.writeFileSync(path.join(state, name), JSON.stringify(value));
    };
    const readJson = (name) => JSON.parse(fs.readFileSync(path.join(state, name), 'utf8'));
    const current = { type: 'agent', repoName: 'AchillesIDE', agentName: 'liveKitServerAgent', alias: 'liveKitServerAgent' };
    const registry = cold ? {} : { current_livekit: current };
    if (registered && !cold) {
        for (const name of oldContainers) registry[name] = { type: 'agent', repoName: retiredRepo, agentName: 'liveKitServerAgent' };
    }
    writeJson('agents.json', registry);
    writeJson('containers.json', Object.keys(registry));
    writeJson('enabled_repos.json', cold ? [] : [retiredRepo, 'AchillesIDE']);
    writeJson('repo_sources.json', { [retiredRepo]: { url: 'https://example.invalid/retired.git' } });
    if (!cold) {
        writeJson('repos/AchillesIDE/liveKitServerAgent/manifest.json', { container: 'retained-image' });
        if (installed) writeJson(`repos/${retiredRepo}/liveKitServerAgent/manifest.json`, { container: 'retained-image' });
    }
    const dataFile = path.join(workspace, '.data/liveKitServerAgent/recordings/retained.txt');
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, 'retained recording');
    const cli = path.join(workspace, 'ploinky-fixture');
    fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = path.join(process.env.PLOINKY_WORKSPACE_ROOT, '.ploinky');
const read = (name) => JSON.parse(fs.readFileSync(path.join(state, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(state, name), JSON.stringify(value));
const args = process.argv.slice(2);
const action = args.slice(0, 2).join(' ');
fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (process.env.MIGRATION_FAIL === action) { console.error('injected lifecycle failure: ' + action); process.exit(9); }
if (process.env.MIGRATION_NOOP === action) process.exit(0);
const retiredRepo = ${JSON.stringify(retiredRepo)};
if (action === 'disable agent') {
    const registry = read('agents.json');
    const selected = registry[args[2]] ? [args[2], registry[args[2]]] : Object.entries(registry).find(([, record]) => record.alias === args[2]);
    if (!selected) process.exit(0);
    const [key, record] = selected;
    if (record.repoName !== retiredRepo) throw new Error('migration selected unrelated owner');
    delete registry[key];
    write('agents.json', registry);
    if (process.env.MIGRATION_FAIL_AFTER_REGISTRY === '1') { console.error('engine refused removal after registry write'); process.exit(9); }
    write('containers.json', read('containers.json').filter((name) => name !== args[2]));
} else if (action === 'disable repo') {
    if (args[2] !== retiredRepo) throw new Error('unexpected repo');
    write('enabled_repos.json', read('enabled_repos.json').filter((name) => name !== args[2]));
} else if (action === 'uninstall repo') {
    if (args[2] !== retiredRepo) throw new Error('unexpected repo');
    const registry = read('agents.json');
    for (const [key, record] of Object.entries(registry)) if (record.repoName === args[2]) delete registry[key];
    write('agents.json', registry);
    fs.rmSync(path.join(state, 'repos', args[2]), { recursive: true });
} else if (args[0] === 'update') {
    fs.rmSync(path.join(state, 'repos', retiredRepo, 'liveKitServerAgent'), { recursive: true, force: true });
} else if (args[0] === 'start') {
    for (const record of Object.values(read('agents.json'))) {
        if (record.type !== 'agent') continue;
        const manifest = path.join(state, 'repos', record.repoName, record.agentName, 'manifest.json');
        if (!fs.existsSync(manifest)) throw new Error("Agent '" + record.repoName + '/' + record.agentName + "' not found");
    }
    console.log('extra-agent preflight passed');
} else throw new Error('unexpected command: ' + args.join(' '));
`, { mode: 0o755 });
    const runtimeRoot = path.join(workspace, 'runtime');
    fs.mkdirSync(path.join(runtimeRoot, 'ploinky-box'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'ploinky-box/supervisor.mjs'), `
export function createBoxSupervisor() {
    let inspections = 0;
    return { inspectBoxStatus() {
        inspections += 1;
        return {
            identity: { workspaceRoot: process.env.MIGRATION_WRONG_WORKSPACE ? '/wrong/workspace' : process.cwd() },
            state: process.env.MIGRATION_BOX_STATE || 'running-initialized',
            ownership: { state: process.env.MIGRATION_BOX_OWNER || 'owned', engine: { name: 'podman' },
                handles: { container: { id: process.env.MIGRATION_BOX_CHANGED && inspections > 1 ? 'b'.repeat(64) : 'a'.repeat(64) } } },
        };
    } };
}
`);
    fs.writeFileSync(path.join(runtimeRoot, 'ploinky-box/process.mjs'), 'export const buildEngineProcessEnvironment = () => process.env;\n');
    fs.writeFileSync(path.join(workspace, 'podman'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'container' && args[1] === 'exec') {
    if (args.slice(2, 6).join(' ') !== '--user podman --workdir /workspace' || args[6] !== 'a'.repeat(64) || args[7] !== '/usr/local/bin/node' || args[8] !== '-e') throw new Error('probe did not bind exact Box namespace');
    if (process.env.MIGRATION_OUTER_STATUS) process.exit(Number(process.env.MIGRATION_OUTER_STATUS));
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, args.slice(8), { encoding: 'utf8', env: { ...process.env, NESTED_BOX_PROBE: '1' } });
    if (process.env.MIGRATION_BAD_ACK === 'empty') process.exit(0);
    if (process.env.MIGRATION_BAD_ACK === 'nonce') { process.stdout.write(JSON.stringify({ nonce: 'wrong', absent: [] })); process.exit(0); }
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
}
if (args[0] !== 'container' || args[1] !== 'exists' || args.length !== 3) throw new Error('unexpected engine operation');
if (process.env.NESTED_BOX_PROBE !== '1') throw new Error('host absence cannot prove nested runtime absence');
const state = path.join(process.env.PLOINKY_WORKSPACE_ROOT, '.ploinky');
fs.appendFileSync(path.join(state, 'inspections.jsonl'), JSON.stringify(args) + '\\n');
if (process.env.MIGRATION_INSPECTION_STATUS) process.exit(Number(process.env.MIGRATION_INSPECTION_STATUS));
const containers = JSON.parse(fs.readFileSync(path.join(state, 'containers.json'), 'utf8'));
process.exit(containers.includes(args[2]) ? 0 : 1);
`, { mode: 0o755 });
    const run = (script = migration, env = {}) => spawnSync('bash', ['-euo', 'pipefail', '-c', `${script}\n"$PLOINKY" update\n"$PLOINKY" start explorer`], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${workspace}${path.delimiter}${process.env.PATH}`, WORK_DIR: workspace, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_DIR: runtimeRoot, PLOINKY: cli, PLOINKY_MASTER_KEY: 'fixture-only', ...env },
    });
    return {
        run, writeJson, readJson, current,
        calls: () => fs.existsSync(path.join(state, 'calls.jsonl'))
            ? fs.readFileSync(path.join(state, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
            : [],
        assertData: () => assert.equal(fs.readFileSync(dataFile, 'utf8'), 'retained recording'),
        installed: () => fs.existsSync(path.join(state, 'repos', retiredRepo)),
        pending: () => fs.existsSync(path.join(state, 'livekit-repository-migration.json')),
    };
}

test('LiveKit migration runs before installation, managed source sync, update and start', () => {
    const position = migrations[0].index;
    for (const next of ['echo "[deploy] Installing Ploinky repos...', 'sync_managed_repos\n', '"$PLOINKY" update', '"$PLOINKY" start AchillesIDE/explorer']) {
        assert.ok(workflow.indexOf(next) > position, `${next} must follow migration`);
    }
    assert.doesNotMatch(migration, /\|\|\s*true|delete\s+registry|rm\s+-|podman\s+(?:rm|stop)|"\$PLOINKY"\s+(?:install|enable|start)/);
});

test('a persisted stopped LiveKit owner breaks preflight after source update without migration', (t) => {
    const state = fixture(t);
    const result = state.run('');
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`Agent '${retiredRepo}/liveKitServerAgent' not found`));
    state.assertData();
});

test('migration removes every exact old owner before update and preserves the unrelated alias and data', (t) => {
    const state = fixture(t);
    const result = state.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /extra-agent preflight passed/);
    assert.deepEqual(state.calls(), [
        ...oldContainers.map((name) => ['disable', 'agent', name]),
        ['disable', 'repo', retiredRepo], ['uninstall', 'repo', retiredRepo], ['update'], ['start', 'explorer'],
    ]);
    assert.deepEqual(state.readJson('agents.json'), { current_livekit: state.current });
    assert.deepEqual(state.readJson('enabled_repos.json'), ['AchillesIDE']);
    assert.equal(state.installed(), false);
    assert.equal(state.pending(), false);
    state.assertData();
    const repeated = state.run();
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(state.calls().slice(-3), [['disable', 'repo', retiredRepo], ['update'], ['start', 'explorer']]);
    state.assertData();
});

for (const [name, options] of [
    ['already absent source with stale owners', { installed: false }],
    ['installed repository with no old owner', { registered: false }],
    ['cold workspace without repositories', { cold: true }],
]) {
    test(`migration handles ${name}`, (t) => {
        const state = fixture(t, options);
        const result = state.run();
        assert.equal(result.status, 0, result.stderr);
        assert.equal(state.installed(), false);
        state.assertData();
    });
}

for (const action of ['disable agent', 'disable repo', 'uninstall repo']) {
    test(`migration stops before source update when ${action} fails`, (t) => {
        const state = fixture(t);
        const result = state.run(migration, { MIGRATION_FAIL: action });
        assert.equal(result.status, 9);
        assert.match(result.stderr, /injected lifecycle failure/);
        assert.equal(state.calls().some(([command]) => ['update', 'start'].includes(command)), false);
        assert.equal(state.installed(), true);
        assert.equal(state.pending(), true);
        state.assertData();
    });
}

for (const action of ['disable repo', 'uninstall repo']) {
    test(`migration rejects retained registration after a successful but ineffective ${action}`, (t) => {
        const state = fixture(t);
        const result = state.run(migration, { MIGRATION_NOOP: action });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Retired LiveKit registration remains/);
        assert.equal(state.calls().some(([command]) => ['update', 'start'].includes(command)), false);
        assert.equal(state.pending(), true);
        state.assertData();
    });
}

test('migration rejects malformed state and unsafe container identities before lifecycle mutation', (t) => {
    const state = fixture(t);
    for (const registry of [[], null, { 'unsafe/target': { type: 'agent', repoName: retiredRepo, agentName: 'liveKitServerAgent' } }]) {
        state.writeJson('agents.json', registry);
        const result = state.run();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Invalid workspace agent registry|Invalid retired LiveKit container identity/);
        assert.deepEqual(state.calls(), []);
    }
    state.assertData();
});

test('failed runtime removal keeps captured owners across retries until physical absence is proven', (t) => {
    const state = fixture(t);
    const first = state.run(migration, { MIGRATION_FAIL_AFTER_REGISTRY: '1' });
    assert.equal(first.status, 9);
    assert.equal(state.readJson('agents.json')[oldContainers[0]], undefined);
    assert.ok(state.readJson('containers.json').includes(oldContainers[0]));
    assert.deepEqual(state.readJson('livekit-repository-migration.json'), oldContainers);
    const unrelated = { type: 'agent', repoName: 'AchillesIDE', agentName: 'liveKitServerAgent', alias: oldContainers[0] };
    state.writeJson('agents.json', { ...state.readJson('agents.json'), unrelated_alias: unrelated });
    const retry = state.run();
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /Could not prove retired runtimes absent in their owning Box/);
    assert.equal(state.calls().filter((args) => args.join(' ') === `disable agent ${oldContainers[0]}`).length, 1, 'pending-only keys must never be disabled through alias fallback');
    assert.equal(state.calls().some(([command]) => ['uninstall', 'update', 'start'].includes(command)), false);
    assert.equal(state.installed(), true);
    assert.equal(state.pending(), true);
    state.assertData();
    // Model supported shutdown recovery; the workflow itself never removes an
    // orphan directly and must retain its exact target until inspection succeeds.
    state.writeJson('containers.json', ['current_livekit']);
    const recovered = state.run();
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(state.pending(), false);
    assert.equal(state.installed(), false);
    assert.deepEqual(state.readJson('agents.json'), { current_livekit: state.current, unrelated_alias: unrelated });
    state.assertData();
});

test('migration captures other retired repository agents before uninstall can remove their registry rows', (t) => {
    const state = fixture(t);
    const registry = state.readJson('agents.json');
    registry.retired_legacy = { type: 'agent', repoName: retiredRepo, agentName: 'legacy' };
    state.writeJson('agents.json', registry);
    state.writeJson('containers.json', Object.keys(registry));
    const result = state.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(state.calls().some((args) => args.join(' ') === 'disable agent retired_legacy'));
    assert.deepEqual(state.readJson('containers.json'), ['current_livekit']);
    state.assertData();
});

for (const status of ['0', '125']) {
    test(`migration blocks source retirement when runtime inspection returns ${status}`, (t) => {
        const state = fixture(t);
        const result = state.run(migration, { MIGRATION_INSPECTION_STATUS: status });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Could not prove/);
        assert.equal(state.calls().some(([command]) => ['uninstall', 'update', 'start'].includes(command)), false);
        assert.equal(state.pending(), true);
        state.assertData();
    });
}

test('migration rejects malformed pending owner evidence before lifecycle mutation', (t) => {
    const state = fixture(t);
    for (const pending of [{}, ['../unsafe'], [null]]) {
        state.writeJson('livekit-repository-migration.json', pending);
        const result = state.run();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Invalid pending LiveKit migration|Invalid retired LiveKit container identity/);
        assert.deepEqual(state.calls(), []);
    }
    state.assertData();
});

for (const [name, env] of [
    ['unavailable owning Box', { MIGRATION_BOX_STATE: 'unknown' }],
    ['stopped owning Box', { MIGRATION_BOX_STATE: 'stopped' }],
    ['foreign ownership', { MIGRATION_BOX_OWNER: 'foreign' }],
    ['wrong workspace', { MIGRATION_WRONG_WORKSPACE: '1' }],
    ['changed Box identity', { MIGRATION_BOX_CHANGED: '1' }],
    ['failed outer exec with status one', { MIGRATION_OUTER_STATUS: '1' }],
    ['successful exec with no acknowledgement', { MIGRATION_BAD_ACK: 'empty' }],
    ['wrong acknowledgement nonce', { MIGRATION_BAD_ACK: 'nonce' }],
]) {
    test(`migration refuses source retirement after ${name}`, (t) => {
        const state = fixture(t);
        const result = state.run(migration, env);
        assert.notEqual(result.status, 0, result.stdout);
        assert.equal(state.calls().some(([command]) => ['uninstall', 'update', 'start'].includes(command)), false);
        assert.equal(state.installed(), true);
        assert.equal(state.pending(), true);
        state.assertData();
    });
}

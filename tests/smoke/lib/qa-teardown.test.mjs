import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as teardown from '../../../.github/scripts/qa-teardown.mjs';
import * as privileged from '../../../.github/scripts/qa-teardown-privileged.mjs';
import * as rollback from '../../../.github/scripts/rollback-explorer-qa.mjs';

const ADMIN_FILE = fileURLToPath(new URL('../../../.github/scripts/qa-teardown.mjs', import.meta.url));
const PRIVILEGED_FILE = fileURLToPath(new URL('../../../.github/scripts/qa-teardown-privileged.mjs', import.meta.url));
const QUIESCE_FILE = fileURLToPath(new URL('../../../.github/scripts/quiesce-explorer-qa.mjs', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));
const BOX = teardown.QA_SCOPE.box;
const HASH = teardown.QA_SCOPE.hash;
const QA_LABELS = Object.freeze({ 'io.assistos.ploinky-box.path-hash': HASH, 'io.assistos.ploinky-box.role': 'box' });
const EXACT = 'e'.repeat(64), NEW_EXACT = 'd'.repeat(64), LEGACY = '1'.repeat(64), SOUL = '5'.repeat(64), OTHER = '6'.repeat(64);
const BOX_IMAGE = 'a'.repeat(64), SOUL_IMAGE = 'b'.repeat(64), FOREIGN_IMAGE = 'c'.repeat(64), NEW_IMAGE = '9'.repeat(64);
const DISPATCH = `main@${'f'.repeat(40)}`;
const uid = process.getuid();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exists = file => { try { fs.lstatSync(file); return true; } catch { return false; } };

// The retargeted durable list of deploy-qa-preservation.test.mjs:50-58, plus the observed QA layout.
const PRESERVATION_DURABLE = Object.freeze(['.data/dpu-data/blobs/one', '.data/umamiAgent/postgres/PG_VERSION',
    '.data/umamiAgent/postgres/pg_wal/one', '.data/soul-gateway/data.sqlite-wal',
    '.data/roboTeamAgent/robots/default/copilot/sessions/one.json',
    '.data/userPersistoAgent/persisto/.userpersisto.snapshot.json',
    'project/notes.txt', 'project/.agents/skills/local/SKILL.md', '.agents/skills/root/SKILL.md',
    '.ploinky/master-key', '.ploinky/.secrets', '.ploinky/passwords.enc',
    '.ploinky/ploinky_subject_identity_ed25519_v1.enc', '.ploinky/profile', '.ploinky/code/local.mjs',
    '.ploinky/skills/authored/SKILL.md', '.ploinky/servers.json',
    '.ploinky/ploinky_history', '.ploinky/operator-notes.md',
    '.ploinky/data/custom-store/authored.txt']);
const OBSERVED_DURABLE = Object.freeze(['testN2/chapter-1.md', 'WebMeet/rooms/room.json', 'test1.backlog', '.env',
    '.ploinky/data/master-key', '.ploinky/data/.secrets', '.ploinky/data/passwords.enc',
    '.ploinky/data/ploinky_subject_identity_ed25519_v1.enc', '.ploinky/edge-desired.json']);
const RETIRED = Object.freeze(['.ploinky/master-key', '.ploinky/.secrets', '.ploinky/ploinky_subject_identity_ed25519_v1.enc']);
// The three regenerated repository maps (deploy-qa-preservation.test.mjs:59) and the runtime state.
const REGENERATED = Object.freeze(['.ploinky/repo_sources.json', '.ploinky/enabled_repos.json',
    '.ploinky/unregistered_agent_repos.json', '.ploinky/agents.json', '.ploinky/running/old.pid',
    '.ploinky/run/edge-topology/current.json', '.ploinky/routing.json', '.ploinky/logs/router.log',
    '.ploinky/repos/AchillesIDE/explorer/manifest.json', '.ploinky/box/images/overlay/layer',
    '.ploinky/box/dependencies/cache', '.ploinky/agentlib/mirror.git/HEAD', '.ploinky/deps/one',
    '.ploinky/container-runtime/state', '.ploinky/graph-skill-scope.json',
    '.ploinky/data/edge-routing/active.json', '.ploinky/data/edge-publication/current.json',
    '.ploinky/data/router-security/compiled/generation.json',
    '.runtime/ploinky/old-source', 'AdvancedLanguageAgent/old-source',
    '.ploinky/.explorer-qa-cloudflare-credentials.json', '.ploinky/.explorer-qa-edge-desired.json']);
const POLICY = Object.freeze({ 'policy-state.json': '{"policy":"live"}\n', 'sessions-revocations.json': '{"revoked":["s1"]}\n',
    'policy-audit.log': 'audit\n', 'policy-audit-archive/2026-10.log': 'archived\n' });
const POLICY_DIR = '.ploinky/data/router-security';

function fixture(t, prefix = 'qa-teardown-', { cleanup = true } = {}) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    // Root fixtures register their own single sudo cleanup instead (N2).
    if (cleanup) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const paths = { workspace: path.join(base, 'explorerQaWorkspace'), state: path.join(base, '.qa-deployment-state'),
        backups: path.join(base, '.qa-deployment-backups') };
    const scope = { ...teardown.QA_SCOPE, ...paths, lock: path.join(base, '.qa-deployment-operation.lock') };
    const at = relative => path.join(paths.workspace, relative);
    const write = (relative, value = `original:${relative}`) => {
        fs.mkdirSync(path.dirname(at(relative)), { recursive: true });
        fs.writeFileSync(at(relative), value);
    };
    const read = relative => fs.readFileSync(at(relative), 'utf8');
    return { base, paths, scope, at, write, read };
}

function durableList({ retired = true } = {}) {
    return [...PRESERVATION_DURABLE, ...OBSERVED_DURABLE].filter(name => retired || !RETIRED.includes(name));
}

/** The observed QA layout with the preservation durable list, runtime state, policy and a Ploinky code link. */
function observedLayout(f, { retired = true } = {}) {
    fs.mkdirSync(f.paths.workspace, { mode: 0o755 });
    for (const name of durableList({ retired })) f.write(name);
    for (const name of REGENERATED) f.write(name);
    for (const [name, value] of Object.entries(POLICY)) f.write(`${POLICY_DIR}/${name}`, value);
    fs.symlinkSync('../repos/AchillesIDE/explorer', f.at('.ploinky/code/explorer'));
}

function contentListing(top) {
    const rows = [];
    const visit = relative => {
        const file = relative ? path.join(top, relative) : top;
        let stat;
        try { stat = fs.lstatSync(file); } catch { return; }
        if (stat.isSymbolicLink()) rows.push({ path: relative || '.', type: 'symlink', target: fs.readlinkSync(file) });
        else if (stat.isDirectory()) {
            rows.push({ path: relative || '.', type: 'directory' });
            for (const name of fs.readdirSync(file).sort()) visit(relative ? `${relative}/${name}` : name);
        } else rows.push({ path: relative || '.', type: 'file', sha256: sha(fs.readFileSync(file)) });
    };
    visit('');
    return JSON.stringify(rows);
}

function leafSet(top) {
    const rows = [];
    const visit = relative => {
        const file = relative ? path.join(top, relative) : top;
        const stat = fs.lstatSync(file);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
            for (const name of fs.readdirSync(file)) visit(relative ? `${relative}/${name}` : name);
        } else rows.push(relative);
    };
    if (exists(top)) visit('');
    return rows.sort();
}

const exactBox = (running = true, extra = {}) => ({ engine: 'podman', id: EXACT, name: BOX, running, image: BOX_IMAGE,
    labels: { ...QA_LABELS }, ...extra });
const legacyBox = (running = false, name = `${BOX}-rollback-redeploy-Ab123456`) => ({ engine: 'podman', id: LEGACY, name,
    running, image: BOX_IMAGE, labels: { ...QA_LABELS } });
const soulBox = (image = SOUL_IMAGE) => ({ engine: 'podman', id: SOUL, name: 'soul-gateway', running: true, image, labels: {} });
const boxImage = () => ({ engine: 'podman', id: BOX_IMAGE, tags: ['docker.io/assistos/ploinky-box:latest'],
    digests: [`docker.io/assistos/ploinky-box@sha256:${'7'.repeat(64)}`], size: 1414184938 });
const soulImage = () => ({ engine: 'podman', id: SOUL_IMAGE, tags: ['docker.io/assistos/soul:latest'], digests: [], size: 1000 });

function failOnce(predicate) {
    let fired = false;
    return (...args) => {
        if (fired || !predicate(...args)) return false;
        fired = true;
        return true;
    };
}
const injected = () => Object.assign(new Error('injected failure'), { code: 'QA_TEST_INJECTED' });

/** A stub engine pair and the in-process privileged program on the fixture paths. */
function engine(f, options = {}) {
    const state = {
        containers: structuredClone(options.containers ?? [exactBox(), soulBox()]),
        images: structuredClone(options.images ?? [boxImage(), soulImage()]),
        volumes: structuredClone(options.volumes ?? []),
        calls: [], logs: [], lock: options.lock ?? true, fail: options.fail ?? null, hooks: options.hooks ?? {},
        quiesce: options.quiesce ?? (() => ({ version: 1, kind: 'qa-quiesce', result: 'passed', phase: 'complete', stopped: [] })),
        preflight: options.preflight ?? (() => ({ version: 1, kind: 'qa-quiesce', result: 'preflight-passed', phase: 'preflight', stopped: [] })),
        privilegedUnavailable: false,
    };
    const step = (name, ...args) => {
        state.calls.push([name, ...args]);
        if (state.fail && state.fail(name, args, state)) throw injected();
    };
    const adapters = {
        assertHost() { state.calls.push(['host']); },
        getuid: () => uid,
        now() { step('now'); return '2026-10-21T12:00:00.000Z'; },
        log: line => state.logs.push(line),
        lockHeld() { state.calls.push(['lock']); return state.lock; },
        freeBytes: () => 31472467968,
        containers() { step('containers'); return structuredClone(state.containers); },
        volumes() { step('volumes'); return structuredClone(state.volumes); },
        images() { step('images'); return structuredClone(state.images); },
        async quiesce(item, { preflightOnly }) {
            step('quiesce', item.id, preflightOnly);
            return preflightOnly ? state.preflight() : state.quiesce();
        },
        stopContainer(engineName, id) {
            step('stop', engineName, id);
            state.containers.find(item => item.engine === engineName && item.id === id).running = false;
        },
        removeContainer(engineName, id) {
            step('rm', engineName, id);
            state.containers = state.containers.filter(item => !(item.engine === engineName && item.id === id));
        },
        untagImage(engineName, id) {
            step('untag', engineName, id);
            state.images.find(item => item.engine === engineName && item.id === id).tags = [];
        },
        removeImage(engineName, id) {
            step('image-rm', engineName, id);
            state.images = state.images.filter(item => !(item.engine === engineName && item.id === id));
        },
        removeVolume(engineName, name) {
            step('volume-rm', engineName, name);
            state.volumes = state.volumes.filter(item => !(item.engine === engineName && item.name === name));
        },
        runPrivileged(args) {
            step('privileged', ...args);
            if (state.privilegedUnavailable) return { status: 1, error: false, stdout: '' };
            return privileged.runPrivilegedArgv(args, { paths: f.paths, getuid: () => 0, hooks: state.hooks });
        },
    };
    return { adapters, state };
}

const cli = (f, eng, argv) => teardown.run(argv, eng.adapters, f.scope);
const mutations = eng => eng.state.calls.filter(([name]) => ['quiesce', 'stop', 'rm', 'untag', 'image-rm', 'volume-rm'].includes(name));

function writeMarker(f, value = { version: 1, operation: 'rebuild', createdAt: '2026-10-20T00:00:00.000Z', dispatch: DISPATCH }) {
    fs.mkdirSync(f.paths.state, { recursive: true, mode: 0o700 });
    fs.chmodSync(f.paths.state, 0o700);
    fs.writeFileSync(path.join(f.paths.state, teardown.MARKER_NAME), JSON.stringify(value) + '\n', { mode: 0o600 });
}
function writeStash(f, value = '{"policy":"stashed"}\n') {
    fs.mkdirSync(path.join(f.paths.state, teardown.STASH_NAME), { recursive: true, mode: 0o700 });
    fs.chmodSync(f.paths.state, 0o700);
    fs.writeFileSync(path.join(f.paths.state, teardown.STASH_NAME, 'policy-state.json'), value);
}
const readMarker = f => {
    const file = path.join(f.paths.state, teardown.MARKER_NAME);
    return exists(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};
const stashPresent = f => exists(path.join(f.paths.state, teardown.STASH_NAME));

/** Route, plan, mark and execute as the deploy Reconcile runs them (contract 5 r2); `select` stands for a rebuild. */
async function deployTeardown(f, eng) {
    const routed = await cli(f, eng, ['route', '--lock-held']);
    if (routed.status !== 0) return { routed };
    const teardownScope = routed.output.route === 'fresh' ? 'fresh' : 'rebuild';
    const plan = await cli(f, eng, ['plan', '--scope', teardownScope, '--mode', 'keep-data', '--lock-held']);
    if (plan.status !== 0) return { routed, plan };
    const mark = await cli(f, eng, ['mark', '--operation', teardownScope === 'fresh' ? 'update' : 'rebuild',
        '--dispatch', DISPATCH, '--lock-held']);
    assert.equal(mark.status, 0, JSON.stringify(mark.output));
    const execute = await cli(f, eng, ['execute', '--scope', teardownScope, '--mode', 'keep-data',
        '--quiesce', routed.output.marker ? 'warn' : 'fatal', '--plan-digest', plan.output.digest, '--lock-held']);
    return { routed, plan, mark, execute };
}

/** The unchanged deploy tail, reduced to what touches teardown state: a new Box, fresh policy, restore, complete. */
async function deployTail(f, eng, { stopAfter = null } = {}) {
    f.write('.runtime/ploinky/fresh', 'fresh runtime');
    eng.state.containers.push({ engine: 'podman', id: NEW_EXACT, name: BOX, running: true, image: NEW_IMAGE, labels: { ...QA_LABELS } });
    eng.state.images.push({ engine: 'podman', id: NEW_IMAGE, tags: ['docker.io/assistos/ploinky-box:latest'], digests: [], size: 1414184938 });
    if (stopAfter === 'prepare') return null;
    f.write(`${POLICY_DIR}/policy-state.json`, '{"policy":"fresh"}\n');
    if (stopAfter === 'edge-init') return null;
    const restored = await cli(f, eng, ['stash-restore', '--lock-held']);
    if (stopAfter === 'restore' || restored.status !== 0) return restored;
    return cli(f, eng, ['complete', '--lock-held']);
}

/** Exactly K plus the fresh runtime and the restored policy; no stash and no marker. */
function assertConverged(f, { retired = false, policy = POLICY } = {}) {
    const expected = [...durableList({ retired }), '.runtime/ploinky/fresh',
        ...Object.keys(policy).map(name => `${POLICY_DIR}/${name}`)].sort();
    assert.deepEqual(leafSet(f.paths.workspace), expected);
    for (const name of durableList({ retired })) assert.equal(f.read(name), `original:${name}`, name);
    for (const [name, value] of Object.entries(policy)) assert.equal(f.read(`${POLICY_DIR}/${name}`), value, name);
    assert.equal(stashPresent(f), false);
    assert.equal(readMarker(f), null);
    assert.deepEqual(fs.readdirSync(f.paths.state), []);
}

function newDeployEngine(f, eng) {
    // The next deploy sees the same engines, with the injected failure cleared.
    eng.state.fail = null;
    eng.state.hooks = {};
    eng.state.quiesce = () => ({ version: 1, kind: 'qa-quiesce', result: 'passed', phase: 'complete', stopped: [] });
    return eng;
}

async function runToCompletion(f, eng, expectedRoute) {
    newDeployEngine(f, eng);
    const run = await deployTeardown(f, eng);
    assert.equal(run.routed.output.route, expectedRoute, JSON.stringify(run.routed.output));
    assert.equal(run.execute.status, 0, JSON.stringify(run.execute.output));
    const done = await deployTail(f, eng);
    assert.equal(done.status, 0, JSON.stringify(done.output));
    return run;
}

// ---------------------------------------------------------------------------
// Contract literals
// ---------------------------------------------------------------------------

test('the admin module copies QA_SCOPE and the quiesce timeout of rollback-explorer-qa.mjs and imports only node: built-ins', () => {
    for (const key of ['workspace', 'backups', 'lock', 'box', 'hash']) assert.equal(teardown.QA_SCOPE[key], rollback.QA_SCOPE[key], key);
    assert.equal(teardown.QA_SCOPE.state, '/home/admin/.qa-deployment-state');
    assert.equal(teardown.QUIESCE_EXEC_TIMEOUT_MS, rollback.QUIESCE_EXEC_TIMEOUT_MS);
    for (const file of [ADMIN_FILE, PRIVILEGED_FILE]) {
        const imports = [...fs.readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
        assert.ok(imports.length > 0);
        assert.deepEqual(imports.filter(name => !name.startsWith('node:')), [], file);
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\bimport\(/, file);
    }
});

test('both teardown modules hold the same literal identity list as rollback-explorer-qa.mjs AUTH_FILES at the base', () => {
    // rollback-explorer-qa.mjs:35-38 at 916078b2.
    const base = ['.env', '.ploinky/data/master-key', '.ploinky/master-key', '.ploinky/data/.secrets', '.ploinky/.secrets',
        '.ploinky/data/passwords.enc', '.ploinky/passwords.enc', '.ploinky/data/ploinky_subject_identity_ed25519_v1.enc',
        '.ploinky/ploinky_subject_identity_ed25519_v1.enc'];
    assert.deepEqual([...teardown.AUTH_FILES], base);
    assert.deepEqual([...privileged.AUTH_FILES], base);
    assert.equal(teardown.MARKER_NAME, privileged.MARKER_NAME);
    assert.equal(teardown.STASH_NAME, privileged.STASH_NAME);
});

test('D1: the keep rules are the deploy preservation rules of the base workflow', t => {
    // deploy-explorer-qa.yml:1994, :1999-2001 and :2015 at 916078b2 (`// BEGIN QA durable workspace preservation`).
    const regenerated = ['.ploinky', '.runtime', 'AdvancedLanguageAgent'];
    const runtimeEntries = ['agents.json', 'routing.json', 'running', 'run', 'logs', 'box', 'deps', 'repos', 'agentlib',
        'container-runtime', 'graph-skill-scope.json', 'data', 'enabled_repos.json', 'repo_sources.json', 'unregistered_agent_repos.json'];
    const graphData = ['edge-routing', 'edge-publication', 'router-security'];
    assert.deepEqual([...privileged.REGENERATED_TOP], regenerated);
    assert.deepEqual([...privileged.RUNTIME_ENTRIES], runtimeEntries);
    assert.deepEqual([...privileged.GENERATED_DATA].sort(), [...graphData].sort());
    assert.deepEqual([...privileged.POLICY_ENTRIES], ['policy-state.json', 'sessions-revocations.json', 'policy-audit.log', 'policy-audit-archive']);
    // When the base commit is in this clone, the literals are compared with its workflow text too.
    const shown = spawnSync('git', ['-C', REPOSITORY, 'show', '916078b2:.github/workflows/deploy-explorer-qa.yml'], { encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024 });
    if (shown.status !== 0) {
        t.diagnostic('base commit 916078b2 is not in this clone; compared against the recorded literals only');
        return;
    }
    const block = shown.stdout.slice(shown.stdout.indexOf('// BEGIN QA durable workspace preservation'),
        shown.stdout.indexOf('// END QA durable workspace preservation'));
    const set = name => JSON.parse(block.match(new RegExp(`const ${name} = new Set\\((\\[[\\s\\S]*?\\])\\)`))[1].replace(/'/g, '"'));
    assert.deepEqual(set('regenerated'), regenerated);
    assert.deepEqual(set('runtimeEntries'), runtimeEntries);
    assert.match(block, /\['edge-publication', 'edge-routing', 'router-security'\]\.includes\(name\)/);
});

test('the ported legacy-backup classifier keeps the lists of the retired privileged backup helper at 916078b2', () => {
    assert.deepEqual([...privileged.BACKUP_INNER_ENTRIES.completion], ['helpers', 'prior-containers.txt', 'rollback-authority.json',
        'preservation.json', 'workspace', 'quiesce.log', 'quiesce-source.mjs', 'lock-ready.json', 'lock-released.json',
        'lock-release', 'lock.log', 'lock-source.txt', 'policy-restoration.json', 'restored-selections.json']);
    assert.deepEqual(privileged.BACKUP_INNER_ENTRIES.rollbackMarkers.map(String),
        ['rollback-result.json', '/^rollback-result\\.json\\.[a-f0-9]{16}$/', 'failed-workspace']);
    assert.deepEqual([...privileged.PRUNABLE_CLASSES], ['complete-redeploy', 'no-workspace']);
    assert.deepEqual([...privileged.RETAINED_CLASSES], ['rollback-attempted', 'unrecognized-entry', 'stop-attempted-unpreserved',
        'incomplete-redeploy']);
});

test('production commands never force a removal and the privileged program runs as root from stdin', () => {
    const admin = fs.readFileSync(ADMIN_FILE, 'utf8');
    assert.doesNotMatch(admin, /'-f'|'--force'|'-v'|'--volumes'/);
    assert.match(admin, /\['container', 'rm', id\]/);
    assert.match(admin, /\['image', 'untag', id\]/);
    assert.match(admin, /\['image', 'rm', id\]/);
    assert.match(admin, /\['container', 'stop', '--time', '30', id\]/);
    assert.match(admin, /spawn\('sudo', \['-n', '\/usr\/bin\/node', '--input-type=module', '-', \.\.\.args\]/);
    const source = fs.readFileSync(PRIVILEGED_FILE, 'utf8');
    assert.doesNotMatch(source, /readdirSync\([^)]*recursive|import\.meta\.dirname|Object\.groupBy|fs\.cpSync|globSync/);
    assert.deepEqual(privileged.QA_TEARDOWN_PATHS, { workspace: '/home/admin/explorerQaWorkspace',
        state: '/home/admin/.qa-deployment-state', backups: '/home/admin/.qa-deployment-backups' });
});

// ---------------------------------------------------------------------------
// CLI shapes
// ---------------------------------------------------------------------------

test('the admin CLI prints one JSON line and exits 1 for usage and host refusals without touching an engine', () => {
    const runCli = args => spawnSync(process.execPath, [ADMIN_FILE, ...args], { encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PATH: '/nonexistent' } });
    const usage = runCli(['route']);
    assert.equal(usage.status, 1);
    assert.deepEqual(usage.stdout.split('\n').filter(Boolean).map(JSON.parse), [{ result: 'refused', code: 'QA_TEARDOWN_USAGE_INVALID' }]);
    const unknown = runCli(['rollback']);
    assert.equal(unknown.status, 1);
    assert.deepEqual(JSON.parse(unknown.stdout), { result: 'failed', code: 'QA_TEARDOWN_USAGE_INVALID' });
    if (process.platform !== 'linux') {
        const host = runCli(['route', '--lock-held']);
        assert.equal(host.status, 1);
        assert.deepEqual(JSON.parse(host.stdout), { result: 'refused', code: 'QA_HOST_INVALID' });
    }
});

test('parseArguments accepts exactly the documented command shapes', () => {
    const digest = `sha256:${'0'.repeat(64)}`;
    assert.equal(teardown.parseArguments(['route', '--lock-held']).command, 'route');
    assert.equal(teardown.parseArguments(['plan', '--scope', 'rebuild', '--mode', 'keep-data']).lockHeld, false);
    assert.equal(teardown.parseArguments(['plan', '--scope', 'destroy', '--mode', 'delete-data', '--lock-held']).lockHeld, true);
    assert.equal(teardown.parseArguments(['mark', '--operation', 'rebuild', '--dispatch', DISPATCH, '--lock-held']).operation, 'rebuild');
    assert.equal(teardown.parseArguments(['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', digest, '--lock-held']).planDigest, digest);
    for (const argv of [['complete', '--lock-held'], ['stash-restore', '--lock-held'], ['stash-clear', '--lock-held'], ['protected-snapshot']]) {
        assert.equal(teardown.parseArguments(argv).command, argv[0]);
    }
    for (const argv of [['route'], ['route', '--lock-held', '--lock-held'], ['plan', '--scope', 'rebuild', '--mode', 'delete-data'],
        ['plan', '--scope', 'other', '--mode', 'keep-data'], ['execute', '--scope', 'rebuild', '--mode', 'keep-data', '--quiesce', 'fatal',
            '--lock-held'], ['mark', '--operation', 'rebuild', '--lock-held'], ['complete'], ['protected-snapshot', '--lock-held'],
        ['execute', '--scope', 'rebuild', '--mode', 'keep-data', '--quiesce', '--plan-digest', digest, '--lock-held']]) {
        assert.throws(() => teardown.parseArguments(argv), { code: 'QA_TEARDOWN_USAGE_INVALID' }, JSON.stringify(argv));
    }
});

test('execute enforces the D2 quiesce modes for each scope before any engine call', async t => {
    const f = fixture(t);
    const digest = `sha256:${'0'.repeat(64)}`;
    for (const [scopeName, mode, quiesce] of [['destroy', 'keep-data', 'warn'], ['destroy', 'keep-data', 'skip'],
        ['destroy', 'delete-data', 'fatal'], ['rebuild', 'delete-data', 'skip'], ['fresh', 'delete-data', 'skip']]) {
        const eng = engine(f);
        const result = await cli(f, eng, ['execute', '--scope', scopeName, '--mode', mode, '--quiesce', quiesce, '--plan-digest', digest, '--lock-held']);
        assert.equal(result.status, 1);
        assert.equal(result.output.code, 'QA_TEARDOWN_USAGE_INVALID');
        assert.deepEqual(eng.state.calls, []);
    }
});

test('the privileged program loads from stdin, prints one JSON line and refuses usage and non-root runs', { skip: uid === 0 ? 'runs as root' : false }, () => {
    const source = fs.readFileSync(PRIVILEGED_FILE, 'utf8');
    const runStdin = args => spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, encoding: 'utf8', timeout: 30_000 });
    const usage = runStdin(['plan-workspace', '--scope', 'rebuild', '--owner', String(uid)]);
    assert.equal(usage.status, 1);
    assert.deepEqual(JSON.parse(usage.stdout), { result: 'failed', code: 'QA_TEARDOWN_USAGE_INVALID' });
    const notRoot = runStdin(['plan-workspace', '--scope', 'destroy', '--mode', 'keep-data', '--owner', String(uid)]);
    assert.equal(notRoot.status, 1);
    assert.deepEqual(notRoot.stdout.split('\n').filter(Boolean).map(JSON.parse), [{ result: 'failed', code: 'QA_TEARDOWN_ROOT_REQUIRED' }]);
    const asFile = spawnSync(process.execPath, [PRIVILEGED_FILE, 'delete-data', '--owner', String(uid)], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(asFile.status, 1);
    assert.deepEqual(JSON.parse(asFile.stdout), { result: 'failed', code: 'QA_TEARDOWN_ROOT_REQUIRED' });
    for (const argv of [['plan-workspace', '--scope', 'rebuild', '--mode', 'delete-data', '--owner', '1000'], ['delete-data'],
        ['reduce-workspace', '--scope', 'rebuild', '--plan-digest', 'sha256:bad', '--owner', '1000'], ['stash-policy', '--owner', '0']]) {
        const parsed = (() => { try { return privileged.parsePrivilegedArguments(argv); } catch (error) { return error.code; } })();
        if (typeof parsed === 'string') assert.equal(parsed, 'QA_TEARDOWN_USAGE_INVALID');
        else assert.throws(() => privileged.privilegedOperation(parsed.operation, { ...parsed.options, paths: privileged.QA_TEARDOWN_PATHS }),
            { code: 'QA_TEARDOWN_USAGE_INVALID' });
    }
});

// ---------------------------------------------------------------------------
// Route (contract 3 r2)
// ---------------------------------------------------------------------------

async function route(f, options = {}) {
    const eng = engine(f, options);
    return { eng, result: await cli(f, eng, ['route', '--lock-held']) };
}

test('route R1, R1b and R2: no workspace', async t => {
    const f = fixture(t);
    let { result } = await route(f, { containers: [soulBox()] });
    assert.deepEqual(result, { status: 0, output: { result: 'routed', route: 'fresh', reason: 'workspace-absent', marker: null,
        stash: false, exact: null, legacy: [] } });
    writeMarker(f);
    ({ result } = await route(f, { containers: [] }));
    assert.equal(result.output.route, 'fresh');
    assert.deepEqual(result.output.marker, { operation: 'rebuild' });
    writeStash(f);
    ({ result } = await route(f, { containers: [] }));
    assert.deepEqual(result, { status: 1, output: { result: 'refused', code: 'QA_ROUTE_STASH_WITHOUT_WORKSPACE' } });
    fs.unlinkSync(path.join(f.paths.state, teardown.MARKER_NAME));
    ({ result } = await route(f, { containers: [] }));
    assert.equal(result.output.code, 'QA_ROUTE_STASH_WITHOUT_WORKSPACE');
    fs.rmSync(f.paths.state, { recursive: true });
    for (const containers of [[exactBox(false)], [exactBox(true)], [legacyBox(false)]]) {
        ({ result } = await route(f, { containers }));
        assert.deepEqual(result, { status: 1, output: { result: 'refused', code: 'QA_ROUTE_CONTAINERS_WITHOUT_WORKSPACE' } });
    }
});

test('route R3 to R6 and R10 with a real workspace', async t => {
    const f = fixture(t);
    fs.mkdirSync(f.paths.workspace);
    let { result } = await route(f, { containers: [soulBox()] });
    assert.equal(result.output.route, 'fresh');
    assert.equal(result.output.reason, 'workspace-without-box');
    ({ result } = await route(f, { containers: [legacyBox(false)] }));
    assert.equal(result.output.route, 'fresh');
    assert.deepEqual(result.output.legacy, [{ engine: 'podman', id: LEGACY, name: `${BOX}-rollback-redeploy-Ab123456` }]);
    ({ result } = await route(f, { containers: [exactBox(true), legacyBox(false), soulBox()] }));
    assert.deepEqual(result.output, { result: 'routed', route: 'select', reason: 'exact-box-running', marker: null, stash: false,
        exact: { engine: 'podman', id: EXACT, running: true }, legacy: [{ engine: 'podman', id: LEGACY, name: `${BOX}-rollback-redeploy-Ab123456` }] });
    ({ result } = await route(f, { containers: [exactBox(false)] }));
    assert.equal(result.output.route, 'rebuild');
    assert.equal(result.output.reason, 'exact-box-stopped');
    assert.deepEqual(result.output.exact, { engine: 'podman', id: EXACT, running: false });
    // R10: a stash without a marker.
    writeStash(f);
    ({ result } = await route(f, { containers: [exactBox(true)] }));
    assert.deepEqual(result, { status: 1, output: { result: 'refused', code: 'QA_ROUTE_STALE_POLICY_STASH' } });
    ({ result } = await route(f, { containers: [] }));
    assert.equal(result.output.code, 'QA_ROUTE_STALE_POLICY_STASH');
    writeMarker(f, { version: 1, operation: 'destroy-keep', createdAt: '2026-10-21T00:00:00Z', dispatch: null });
    ({ result } = await route(f, { containers: [] }));
    assert.deepEqual(result.output, { result: 'routed', route: 'fresh', reason: 'workspace-without-box',
        marker: { operation: 'destroy-keep' }, stash: true, exact: null, legacy: [] });
    ({ result } = await route(f, { containers: [exactBox(true)] }));
    assert.equal(result.output.route, 'rebuild');
    assert.equal(result.output.reason, 'install-marker-present');
    ({ result } = await route(f, { containers: [exactBox(false)] }));
    assert.equal(result.output.route, 'rebuild');
});

test('route R7, R8 and R9 refuse', async t => {
    const f = fixture(t);
    fs.mkdirSync(f.paths.workspace);
    const cases = [
        [[exactBox(true), legacyBox(true)], [], 'QA_ROUTE_LEGACY_BOX_RUNNING'],
        [[exactBox(true), { ...legacyBox(false), name: `${BOX}-other`, id: OTHER }], [], 'QA_ROUTE_UNKNOWN_QA_CONTAINER'],
        [[{ ...soulBox(), name: 'helper', labels: { 'io.assistos.ploinky-box.path-hash': HASH } }], [], 'QA_ROUTE_UNKNOWN_QA_CONTAINER'],
        [[exactBox(true, { labels: { 'io.assistos.ploinky-box.path-hash': 'ffffffffffff', 'io.assistos.ploinky-box.role': 'box' } })], [], 'QA_ROUTE_IDENTITY_CONFLICT'],
        [[exactBox(true, { labels: {} })], [], 'QA_ROUTE_IDENTITY_CONFLICT'],
        [[{ ...soulBox(), name: `${BOX}-rollback-redeploy-Zz123456` }], [], 'QA_ROUTE_IDENTITY_CONFLICT'],
        [[exactBox(true), exactBox(false, { engine: 'docker' })], [], 'QA_ROUTE_EXACT_AMBIGUOUS'],
        [[exactBox(true)], [{ engine: 'podman', name: `${BOX}-workspace`, labels: {} }], 'QA_ROUTE_QA_VOLUME'],
        [[exactBox(true)], [{ engine: 'podman', name: 'data', labels: { 'io.assistos.ploinky-box.path-hash': HASH } }], 'QA_ROUTE_QA_VOLUME'],
    ];
    for (const [containers, volumes, code] of cases) {
        const { result } = await route(f, { containers, volumes });
        assert.deepEqual(result, { status: 1, output: { result: 'refused', code } }, code);
    }
    // R9
    let { result } = await route(f, { fail: name => name === 'containers' });
    assert.deepEqual(result.output, { result: 'refused', code: 'QA_ROUTE_ENGINE_PROBE_FAILED' });
    ({ result } = await route(f, { fail: name => name === 'volumes' }));
    assert.equal(result.output.code, 'QA_ROUTE_ENGINE_PROBE_FAILED');
    // R8
    fs.rmdirSync(f.paths.workspace);
    fs.writeFileSync(f.paths.workspace, 'file');
    ({ result } = await route(f));
    assert.equal(result.output.code, 'QA_ROUTE_WORKSPACE_INVALID');
    fs.unlinkSync(f.paths.workspace);
    fs.mkdirSync(path.join(f.base, 'elsewhere'));
    fs.symlinkSync(path.join(f.base, 'elsewhere'), f.paths.workspace);
    ({ result } = await route(f));
    assert.equal(result.output.code, 'QA_ROUTE_WORKSPACE_INVALID');
    fs.unlinkSync(f.paths.workspace);
    fs.mkdirSync(f.paths.workspace);
    // A malformed marker or state directory refuses.
    writeMarker(f, { version: 1, operation: 'resume', createdAt: '2026-10-21T00:00:00Z', dispatch: null });
    ({ result } = await route(f));
    assert.equal(result.output.code, 'QA_ROUTE_MARKER_INVALID');
    fs.chmodSync(f.paths.state, 0o755);
    ({ result } = await route(f));
    assert.equal(result.output.code, 'QA_ROUTE_STATE_INVALID');
});

// ---------------------------------------------------------------------------
// Keep-set (AC10 r2), refusals (AC11 r2) and the mount guard (AC30 unit)
// ---------------------------------------------------------------------------

test('AC10 r2: a keep-data destroy reduces the observed layout to exactly K and parks the policy', async t => {
    const f = fixture(t);
    observedLayout(f);
    const sentinel = path.join(f.base, 'sentinel');
    fs.mkdirSync(sentinel);
    fs.writeFileSync(path.join(sentinel, 'keep.txt'), 'outside');
    fs.symlinkSync(sentinel, f.at('.ploinky/skills/explorer'));
    const before = privileged.planWorkspace({ paths: f.paths, owner: uid, scope: 'destroy', mode: 'keep-data' });
    const topInodes = Object.fromEntries(fs.readdirSync(f.paths.workspace).filter(name => !['.runtime', 'AdvancedLanguageAgent'].includes(name))
        .map(name => [name, fs.lstatSync(f.at(name)).ino]));
    const eng = engine(f, { containers: [exactBox(true), soulBox()] });
    const plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    assert.equal(plan.status, 0, JSON.stringify(plan.output));
    assert.deepEqual(plan.output.workspace.keep.top.sort(), ['.agents', '.data', '.env', '.ploinky', 'WebMeet', 'project', 'test1.backlog', 'testN2']);
    const result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.status, 0, JSON.stringify(result.output));
    assert.equal(result.output.result, 'torn-down');
    for (const name of durableList()) assert.equal(f.read(name), `original:${name}`, name);
    for (const name of [...REGENERATED, '.ploinky/code/explorer', '.ploinky/skills/explorer', '.ploinky/running', '.ploinky/run',
        '.runtime', 'AdvancedLanguageAgent', POLICY_DIR, '.ploinky/data/edge-routing', '.ploinky/data/edge-publication']) {
        assert.equal(exists(f.at(name)), false, name);
    }
    assert.equal(fs.readFileSync(path.join(sentinel, 'keep.txt'), 'utf8'), 'outside');
    for (const [name, value] of Object.entries(POLICY)) {
        assert.equal(fs.readFileSync(path.join(f.paths.state, teardown.STASH_NAME, name), 'utf8'), value, name);
    }
    assert.equal(exists(path.join(f.paths.state, teardown.STASH_NAME, 'compiled')), false);
    assert.deepEqual(readMarker(f), { version: 1, operation: 'destroy-keep', createdAt: '2026-10-21T12:00:00.000Z', dispatch: null,
        images: [{ engine: 'podman', id: BOX_IMAGE }] });
    // The recursive {path,type,ino,size} listing of K and the identity are unchanged, and so are the top-level inodes.
    const after = privileged.planWorkspace({ paths: f.paths, owner: uid, scope: 'destroy', mode: 'keep-data' });
    assert.deepEqual(after.keepListing, before.keepListing);
    assert.equal(after.keep.digest, before.keep.digest);
    assert.deepEqual(after.identity, before.identity);
    assert.deepEqual(after.delete, []);
    // .env, the four .ploinky/data files and the four legacy .ploinky files of the observed layout.
    assert.deepEqual(after.identity.map(item => item.relative), [...teardown.AUTH_FILES]);
    for (const [name, ino] of Object.entries(topInodes)) assert.equal(fs.lstatSync(f.at(name)).ino, ino, name);
    assert.deepEqual(result.output.workspace.identity, before.identity);
    assert.deepEqual(result.output.removedContainers, [{ engine: 'podman', id: EXACT, name: BOX }]);
    assert.equal(result.output.stash, 'created');
    // A second reduction plans and deletes nothing.
    const second = privileged.runPrivilegedArgv(['reduce-workspace', '--scope', 'destroy', '--plan-digest', after.digest,
        '--owner', String(uid)], { paths: f.paths, getuid: () => 0 });
    assert.equal(second.status, 0, second.stdout);
    assert.deepEqual(JSON.parse(second.stdout).deleted, []);
});

test('AC10 r2: a rebuild refuses the retired identity and otherwise reduces exactly as a destroy', async t => {
    const retired = fixture(t);
    observedLayout(retired);
    const listing = contentListing(retired.base);
    let eng = engine(retired);
    const refused = await cli(retired, eng, ['plan', '--scope', 'rebuild', '--mode', 'keep-data', '--lock-held']);
    assert.equal(refused.status, 1);
    assert.equal(refused.output.result, 'refused');
    assert.equal(refused.output.code, 'QA_TEARDOWN_RETIRED_IDENTITY');
    assert.deepEqual(refused.output.privileged.retired, [...RETIRED]);
    assert.equal(contentListing(retired.base), listing);
    assert.deepEqual(mutations(eng), []);

    const results = {};
    for (const scopeName of ['rebuild', 'destroy']) {
        const f = fixture(t);
        observedLayout(f, { retired: false });
        eng = engine(f);
        if (scopeName === 'rebuild') {
            const run = await deployTeardown(f, eng);
            assert.equal(run.execute.status, 0, JSON.stringify(run.execute.output));
        } else {
            const plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
            const run = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
                '--plan-digest', plan.output.digest, '--lock-held']);
            assert.equal(run.status, 0, JSON.stringify(run.output));
        }
        results[scopeName] = { leaves: leafSet(f.paths.workspace), stash: leafSet(path.join(f.paths.state, teardown.STASH_NAME)) };
    }
    assert.deepEqual(results.rebuild, results.destroy);
    assert.deepEqual(results.rebuild.leaves, durableList({ retired: false }).sort());
});

function refusalFixture(t, setup) {
    const f = fixture(t);
    fs.mkdirSync(f.paths.workspace);
    f.write('.data/userPersistoAgent/db');
    f.write('.ploinky/data/master-key');
    f.write('.ploinky/agents.json');
    f.write('.runtime/ploinky/source');
    f.write('AdvancedLanguageAgent/source');
    f.write('testN2/doc.md');
    setup(f);
    return f;
}

test('AC11 r2: every refusal exits with its code and changes nothing', async t => {
    const elsewhere = f => { const target = path.join(f.base, 'elsewhere'); fs.mkdirSync(target, { recursive: true }); return target; };
    const cases = [
        ['QA_TEARDOWN_RETIRED_IDENTITY', 'rebuild', f => f.write('.ploinky/master-key')],
        ['QA_TEARDOWN_RETIRED_IDENTITY', 'fresh', f => f.write('.ploinky/.secrets')],
        ['QA_TEARDOWN_KEY_MISSING', 'destroy', f => fs.unlinkSync(f.at('.ploinky/data/master-key'))],
        ['QA_TEARDOWN_UNSAFE_PATH', 'destroy', f => { fs.rmSync(f.at('.ploinky'), { recursive: true }); fs.symlinkSync(elsewhere(f), f.at('.ploinky')); }],
        ['QA_TEARDOWN_UNSAFE_PATH', 'destroy', f => { fs.rmSync(f.at('.data'), { recursive: true }); fs.symlinkSync(elsewhere(f), f.at('.data')); }],
        ['QA_TEARDOWN_UNSAFE_PATH', 'destroy', f => { fs.rmSync(f.at('.runtime'), { recursive: true }); fs.writeFileSync(f.at('.runtime'), 'file'); }],
        ['QA_TEARDOWN_UNSAFE_PATH', 'rebuild', f => fs.symlinkSync(elsewhere(f), f.at('.ploinky/skills'))],
        ['QA_TEARDOWN_UNSAFE_PATH', 'destroy', f => fs.writeFileSync(f.at('.ploinky/code'), 'file')],
        ['QA_TEARDOWN_UNSAFE_PATH', 'destroy', f => fs.linkSync(f.at('.ploinky/data/master-key'), path.join(f.base, 'hard-link'))],
        ['QA_TEARDOWN_UNSAFE_PATH', 'destroy', f => fs.symlinkSync(f.at('testN2/doc.md'), f.at('.env'))],
        ['QA_TEARDOWN_UNSAFE_PATH', 'destroy', f => {
            fs.renameSync(f.at('.ploinky/data'), path.join(f.base, 'data'));
            fs.symlinkSync(path.join(f.base, 'data'), f.at('.ploinky/data'));
        }],
        ['QA_TEARDOWN_UNSAFE_PATH', 'destroy', f => {
            fs.renameSync(f.paths.workspace, path.join(f.base, 'real-workspace'));
            fs.symlinkSync(path.join(f.base, 'real-workspace'), f.paths.workspace);
        }],
    ];
    for (const [code, scopeName, setup] of cases) {
        const f = refusalFixture(t, setup);
        const listing = contentListing(f.base);
        for (const argv of [['plan-workspace', '--scope', scopeName, '--mode', 'keep-data', '--owner', String(uid)],
            ['reduce-workspace', '--scope', scopeName, '--plan-digest', `sha256:${'0'.repeat(64)}`, '--owner', String(uid)]]) {
            const result = privileged.runPrivilegedArgv(argv, { paths: f.paths, getuid: () => 0 });
            assert.equal(result.status, 1, `${code} ${argv[0]}`);
            assert.equal(JSON.parse(result.stdout).code, code, `${code} ${argv[0]} ${result.stdout}`);
        }
        const eng = engine(f, { containers: [exactBox(true)] });
        const plan = await cli(f, eng, ['plan', '--scope', scopeName === 'fresh' ? 'fresh' : scopeName, '--mode', 'keep-data', '--lock-held']);
        assert.equal(plan.status, 1);
        assert.equal(plan.output.code, scopeName === 'fresh' ? 'QA_TEARDOWN_EXACT_BOX_PRESENT' : code);
        assert.equal(contentListing(f.base), listing, code);
        assert.deepEqual(mutations(eng), []);
    }
});

test('AC30 unit: a mount at or under the workspace, a deletion target or the backups root refuses in both modes', async t => {
    const mountedAt = (f, relative) => ({ mountPoints: () => ['/', path.join(f.paths.workspace, relative)] });
    for (const relative of ['.ploinky/box/images', '.runtime', '.data/umamiAgent', '']) {
        for (const mode of ['keep-data', 'delete-data']) {
            const f = fixture(t);
            observedLayout(f);
            const listing = contentListing(f.base);
            const hooks = relative ? mountedAt(f, relative) : { mountPoints: () => ['/', f.paths.workspace] };
            const plan = privileged.runPrivilegedArgv(['plan-workspace', '--scope', 'destroy', '--mode', mode, '--owner', String(uid)],
                { paths: f.paths, getuid: () => 0, hooks });
            assert.equal(JSON.parse(plan.stdout).code, 'QA_TEARDOWN_MOUNT_INSIDE', `${relative} ${mode}`);
            const operation = mode === 'delete-data' ? ['delete-data', '--owner', String(uid)]
                : ['reduce-workspace', '--scope', 'destroy', '--plan-digest', `sha256:${'0'.repeat(64)}`, '--owner', String(uid)];
            const run = privileged.runPrivilegedArgv(operation, { paths: f.paths, getuid: () => 0, hooks });
            assert.equal(run.status, 1);
            assert.equal(JSON.parse(run.stdout).code, 'QA_TEARDOWN_MOUNT_INSIDE');
            assert.equal(contentListing(f.base), listing, `${relative} ${mode}`);
        }
    }
    // A deletion target on another device is refused as well (st_dev differs from the workspace's).
    const f = fixture(t);
    observedLayout(f);
    const listing = contentListing(f.base);
    const other = f.at('.ploinky/box/images/overlay');
    const hooks = { lstat: (file, stat) => file.startsWith(other) ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1n }) : stat };
    const result = privileged.runPrivilegedArgv(['plan-workspace', '--scope', 'destroy', '--mode', 'keep-data', '--owner', String(uid)],
        { paths: f.paths, getuid: () => 0, hooks });
    assert.equal(JSON.parse(result.stdout).code, 'QA_TEARDOWN_MOUNT_INSIDE');
    assert.equal(contentListing(f.base), listing);
    // The backups root and one of its entries.
    for (const point of ['', 'redeploy-Aaaaaaa1']) {
        const g = fixture(t);
        legacyBackups(g);
        const before = contentListing(g.base);
        const mount = point ? path.join(g.paths.backups, point) : g.paths.backups;
        const run = privileged.runPrivilegedArgv(['remove-legacy-backups', '--owner', String(uid)],
            { paths: g.paths, getuid: () => 0, hooks: { mountPoints: () => ['/', mount] } });
        assert.equal(JSON.parse(run.stdout).code, 'QA_TEARDOWN_MOUNT_INSIDE', point || 'root');
        assert.equal(contentListing(g.base), before);
    }
    assert.deepEqual(privileged.parseMountPoints('36 35 98:0 /mnt1 /mnt\\040with\\040space rw - ext3 /dev/root rw\n'), ['/mnt with space']);
});

// ---------------------------------------------------------------------------
// Stash lifecycle (AC12 r2)
// ---------------------------------------------------------------------------

test('AC12 r2: the stash is a verified copy, never overwritten, restored once and removed', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    fs.mkdirSync(f.paths.state, { mode: 0o700 });
    // A leftover temporary copy of an interrupted stash is discarded.
    fs.mkdirSync(path.join(f.paths.state, 'router-security.tmp-12345'));
    fs.writeFileSync(path.join(f.paths.state, 'router-security.tmp-12345/partial'), 'x');
    let result = privileged.privilegedOperation('stash-policy', { paths: f.paths, owner: uid });
    assert.deepEqual(result, { result: 'stashed', copied: [...privileged.POLICY_ENTRIES], discarded: ['router-security.tmp-12345'] });
    const stash = path.join(f.paths.state, teardown.STASH_NAME);
    for (const name of privileged.POLICY_ENTRIES) {
        assert.equal(spawnSync('diff', ['-qr', '--', f.at(`${POLICY_DIR}/${name}`), path.join(stash, name)]).status, 0, name);
    }
    assert.equal(exists(path.join(stash, 'compiled')), false);
    // While it exists, the stash is never overwritten, even when the live policy differs.
    f.write(`${POLICY_DIR}/policy-state.json`, '{"policy":"changed"}\n');
    result = privileged.privilegedOperation('stash-policy', { paths: f.paths, owner: uid });
    assert.equal(result.result, 'stash-kept');
    assert.equal(fs.readFileSync(path.join(stash, 'policy-state.json'), 'utf8'), POLICY['policy-state.json']);
    // Restore: the fresh policy exists; the stash is copied over it, proven and removed, and a .removing leftover goes.
    fs.rmSync(f.at(POLICY_DIR), { recursive: true });
    f.write(`${POLICY_DIR}/policy-state.json`, '{"policy":"fresh"}\n');
    f.write(`${POLICY_DIR}/policy-audit-archive/fresh.log`, 'fresh\n');
    fs.mkdirSync(path.join(f.paths.state, 'router-security.removing-777'));
    const eng = engine(f, { containers: [exactBox(true)] });
    writeMarker(f);
    const complete = await cli(f, eng, ['complete', '--lock-held']);
    assert.deepEqual(complete, { status: 1, output: { result: 'failed', code: 'QA_TEARDOWN_STASH_NOT_RESTORED' } });
    const restored = await cli(f, eng, ['stash-restore', '--lock-held']);
    assert.equal(restored.status, 0, JSON.stringify(restored.output));
    assert.deepEqual(restored.output, { result: 'restored', copied: [...privileged.POLICY_ENTRIES],
        discarded: ['router-security.removing-777'], stashRemoved: true });
    for (const [name, value] of Object.entries(POLICY)) assert.equal(f.read(`${POLICY_DIR}/${name}`), value, name);
    assert.equal(exists(f.at(`${POLICY_DIR}/policy-audit-archive/fresh.log`)), false);
    assert.deepEqual(fs.readdirSync(f.paths.state), [teardown.MARKER_NAME]);
    // No stash: nothing is copied, and the fresh policy stays.
    const none = await cli(f, eng, ['stash-restore', '--lock-held']);
    assert.deepEqual(none.output, { result: 'no-stash', copied: [], discarded: [], stashRemoved: false });
    const completed = await cli(f, eng, ['complete', '--lock-held']);
    assert.deepEqual(completed.output, { result: 'completed', marker: { operation: 'rebuild' }, exact: { engine: 'podman', id: EXACT, running: true } });
    assert.deepEqual(fs.readdirSync(f.paths.state), []);
    // stash-clear removes a stash that is no longer wanted.
    writeStash(f);
    const cleared = await cli(f, eng, ['stash-clear', '--lock-held']);
    assert.deepEqual(cleared.output, { result: 'cleared', removed: true, discarded: [] });
    assert.equal(stashPresent(f), false);
});

test('the reduction refuses to delete a live policy that is not parked', t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const listing = contentListing(f.base);
    const plan = privileged.planWorkspace({ paths: f.paths, owner: uid, scope: 'rebuild', mode: 'keep-data' });
    assert.equal(plan.stash, 'create');
    const result = privileged.runPrivilegedArgv(['reduce-workspace', '--scope', 'rebuild', '--plan-digest', plan.digest,
        '--owner', String(uid)], { paths: f.paths, getuid: () => 0 });
    assert.equal(JSON.parse(result.stdout).code, 'QA_TEARDOWN_STASH_REQUIRED');
    assert.equal(contentListing(f.base), listing);
    // A changed workspace no longer matches the digest.
    fs.mkdirSync(f.paths.state, { mode: 0o700 });
    privileged.privilegedOperation('stash-policy', { paths: f.paths, owner: uid });
    const fresh = privileged.planWorkspace({ paths: f.paths, owner: uid, scope: 'rebuild', mode: 'keep-data' });
    f.write('testN2/new.md', 'new');
    const changed = privileged.runPrivilegedArgv(['reduce-workspace', '--scope', 'rebuild', '--plan-digest', fresh.digest,
        '--owner', String(uid)], { paths: f.paths, getuid: () => 0 });
    assert.equal(JSON.parse(changed.stdout).code, 'QA_TEARDOWN_PLAN_CHANGED');
    assert.equal(exists(f.at('.runtime')), true);
});

// ---------------------------------------------------------------------------
// Containers and images (AC14 r2)
// ---------------------------------------------------------------------------

test('AC14 r2: quiesce, stop and rm in order; untag then rm only the removed QA containers\' unshared images', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const foreign = { engine: 'podman', id: FOREIGN_IMAGE, tags: ['docker.io/assistos/ploinky-box:2026-09'], digests: [], size: 5 };
    const eng = engine(f, { containers: [exactBox(true), legacyBox(false), soulBox()], images: [boxImage(), soulImage(), foreign] });
    const run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 0, JSON.stringify(run.execute.output));
    assert.deepEqual(mutations(eng), [['quiesce', EXACT, false], ['stop', 'podman', EXACT], ['rm', 'podman', EXACT],
        ['rm', 'podman', LEGACY], ['untag', 'podman', BOX_IMAGE], ['image-rm', 'podman', BOX_IMAGE]]);
    assert.deepEqual(run.execute.output.removedContainers.map(item => item.id), [EXACT, LEGACY]);
    assert.deepEqual(run.execute.output.removedImages, [{ engine: 'podman', id: BOX_IMAGE, tags: ['docker.io/assistos/ploinky-box:latest'] }]);
    assert.deepEqual(run.execute.output.retainedImages, [{ engine: 'podman', id: FOREIGN_IMAGE, tags: ['docker.io/assistos/ploinky-box:2026-09'],
        reason: 'foreign-ploinky-box-image-retained' }]);
    assert.deepEqual(eng.state.containers.map(item => item.id), [SOUL]);
    assert.deepEqual(eng.state.images.map(item => item.id).sort(), [SOUL_IMAGE, FOREIGN_IMAGE].sort());
    assert.equal(run.plan.output.capacity.pullBytes, 1414184938);
    assert.equal(run.plan.output.capacity.imageReclaimableBytes, 1414184938);
    assert.equal(run.plan.output.capacity.requiredBytes, teardown.MINIMUM_FREE_BYTES + 1414184938);
    assert.ok(run.plan.output.capacity.workspaceReclaimableBytes > 0);
    assert.equal(run.plan.output.capacity.reclaimableBytes,
        run.plan.output.capacity.workspaceReclaimableBytes + run.plan.output.capacity.imageReclaimableBytes);
});

test('AC14 r2: an image shared with a non-QA container is retained in use and the run succeeds', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const eng = engine(f, { containers: [exactBox(true), soulBox(BOX_IMAGE)], images: [boxImage()] });
    const run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 0, JSON.stringify(run.execute.output));
    assert.deepEqual(run.execute.output.retainedImages, [{ engine: 'podman', id: BOX_IMAGE,
        tags: ['docker.io/assistos/ploinky-box:latest'], reason: 'retained-in-use' }]);
    assert.deepEqual(run.execute.output.removedImages, []);
    assert.equal(mutations(eng).some(([name]) => name === 'untag' || name === 'image-rm'), false);
    assert.equal(run.plan.output.capacity.imageReclaimableBytes, 0);
});

test('AC14 r2: refusals for a running legacy Box, a foreign label, an unknown QA container and a QA volume change nothing', async t => {
    const cases = [
        ['rebuild', [exactBox(true), legacyBox(true)], [], 'QA_TEARDOWN_LEGACY_BOX_RUNNING'],
        ['destroy', [exactBox(true, { labels: { 'io.assistos.ploinky-box.path-hash': 'ffffffffffff', 'io.assistos.ploinky-box.role': 'box' } })], [],
            'QA_TEARDOWN_IDENTITY_CONFLICT'],
        ['rebuild', [exactBox(true), { ...soulBox(), id: OTHER, labels: { 'io.assistos.ploinky-box.path-hash': HASH } }], [],
            'QA_TEARDOWN_UNKNOWN_QA_CONTAINER'],
        ['rebuild', [exactBox(true)], [{ engine: 'podman', name: `${BOX}-workspace`, labels: { 'io.assistos.ploinky-box.path-hash': HASH } }],
            'QA_TEARDOWN_QA_VOLUME'],
        ['destroy', [exactBox(true)], [{ engine: 'podman', name: `${BOX}-workspace`, labels: {} }], 'QA_TEARDOWN_QA_VOLUME'],
        ['rebuild', [soulBox()], [], 'QA_TEARDOWN_EXACT_BOX_REQUIRED'],
        ['fresh', [exactBox(false)], [], 'QA_TEARDOWN_EXACT_BOX_PRESENT'],
    ];
    for (const [scopeName, containers, volumes, code] of cases) {
        const f = fixture(t);
        observedLayout(f, { retired: false });
        const listing = contentListing(f.base);
        const eng = engine(f, { containers, volumes });
        const plan = await cli(f, eng, ['plan', '--scope', scopeName, '--mode', 'keep-data', '--lock-held']);
        assert.deepEqual(plan, { status: 1, output: { result: 'refused', code } }, code);
        writeMarker(f);
        const execute = await cli(f, eng, ['execute', '--scope', scopeName, '--mode', 'keep-data', '--quiesce', 'fatal',
            '--plan-digest', `sha256:${'0'.repeat(64)}`, '--lock-held']);
        assert.equal(execute.status, 1);
        assert.equal(execute.output.code, code);
        assert.equal(execute.output.phase, 'plan');
        assert.deepEqual(mutations(eng), []);
        fs.rmSync(f.paths.state, { recursive: true });
        assert.equal(contentListing(f.base), listing);
    }
});

test('AC14 r2: a destroy stops and removes unknown QA containers; delete-data also removes QA volumes and everything', async t => {
    const f = fixture(t);
    observedLayout(f);
    const sibling = path.join(f.base, 'admin-home-sibling');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'keep'), 'keep');
    writeMarker(f);
    writeStash(f);
    const unknown = { engine: 'podman', id: OTHER, name: 'nested-helper', running: true, image: SOUL_IMAGE,
        labels: { 'io.assistos.ploinky-box.path-hash': HASH } };
    const eng = engine(f, { containers: [exactBox(true), unknown, legacyBox(true), soulBox()],
        volumes: [{ engine: 'podman', name: `${BOX}-workspace`, labels: { 'io.assistos.ploinky-box.path-hash': HASH } },
            { engine: 'podman', name: 'soul-data', labels: {} }] });
    const plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'delete-data', '--lock-held']);
    assert.equal(plan.status, 0, JSON.stringify(plan.output));
    const result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'delete-data', '--quiesce', 'skip',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.status, 0, JSON.stringify(result.output));
    assert.deepEqual(mutations(eng), [['stop', 'podman', EXACT], ['stop', 'podman', LEGACY], ['stop', 'podman', OTHER],
        ['rm', 'podman', EXACT], ['rm', 'podman', LEGACY], ['rm', 'podman', OTHER], ['untag', 'podman', BOX_IMAGE],
        ['image-rm', 'podman', BOX_IMAGE], ['volume-rm', 'podman', `${BOX}-workspace`]]);
    // SOUL_IMAGE is still used by the Soul container, so it is retained.
    assert.deepEqual(result.output.retainedImages.map(item => [item.id, item.reason]), [[SOUL_IMAGE, 'retained-in-use']]);
    assert.equal(exists(f.paths.workspace), false);
    assert.equal(exists(f.paths.state), false);
    assert.equal(fs.readFileSync(path.join(sibling, 'keep'), 'utf8'), 'keep');
    assert.deepEqual(eng.state.volumes.map(item => item.name), ['soul-data']);
    assert.deepEqual(result.output.workspace, { result: 'deleted', workspace: 'removed', state: 'removed' });
    assert.equal(result.output.marker, null);
    assert.equal(result.output.stash, 'removed');
});

test('AC14 r2: a refused image removal exits 1 in a crash-table state and the next run retries the recorded image', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const eng = engine(f, { containers: [exactBox(true)], images: [boxImage()], fail: failOnce(name => name === 'image-rm') });
    const run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 1);
    assert.equal(run.execute.output.phase, 'images');
    assert.equal(run.execute.output.code, 'QA_TEST_INJECTED');
    assert.deepEqual(readMarker(f).images, [{ engine: 'podman', id: BOX_IMAGE }]);
    assert.equal(eng.state.images.length, 1);
    await runToCompletion(f, eng, 'fresh');
    assert.deepEqual(eng.state.images.map(item => item.id), [NEW_IMAGE]);
    assertConverged(f);
});

// ---------------------------------------------------------------------------
// Crash points (AC15 r2) and the chained keep-data destroy (AC27)
// ---------------------------------------------------------------------------

test('AC15 r2: before mark (a plan or capacity refusal) leaves QA untouched and routes select', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const listing = contentListing(f.base);
    const eng = engine(f, { fail: failOnce((name, args) => name === 'privileged' && args[0] === 'plan-workspace') });
    const run = await deployTeardown(f, eng);
    assert.equal(run.plan.status, 1);
    assert.equal(run.plan.output.code, 'QA_TEST_INJECTED');
    assert.equal(contentListing(f.base), listing);
    assert.deepEqual(mutations(eng), []);
    await runToCompletion(f, eng, 'select');
    assertConverged(f);
});

test('AC15 r2: after mark, during quiesce or stop, the next deploy rebuilds with quiesce warn', async t => {
    // Quiesce fails on the first attempt (fatal): the Box keeps running and the marker stays.
    let f = fixture(t);
    observedLayout(f, { retired: false });
    let eng = engine(f, { quiesce: () => ({ result: 'failed', phase: 'agent-stop', code: 'QA_CONTAINER_CHANGED' }) });
    let run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 1);
    assert.equal(run.execute.output.code, 'QA_TEARDOWN_QUIESCE_FAILED');
    assert.deepEqual(mutations(eng), [['quiesce', EXACT, false]]);
    assert.equal(readMarker(f).operation, 'rebuild');
    // The marker predates the next attempt, so a failing quiesce only warns.
    eng.state.fail = null;
    const routed = await cli(f, eng, ['route', '--lock-held']);
    assert.equal(routed.output.route, 'rebuild');
    assert.equal(routed.output.reason, 'install-marker-present');
    const warned = await deployTeardown(f, eng);
    assert.equal(warned.execute.status, 0, JSON.stringify(warned.execute.output));
    assert.equal(warned.execute.output.warnings.length, 1);
    assert.match(eng.state.logs[0], /^::warning::Explorer QA quiesce did not pass \(QA_CONTAINER_CHANGED\)/);
    assert.ok(await deployTail(f, eng));
    assertConverged(f);
    // A failing stop leaves a running Box (R5) and the run completes afterwards.
    f = fixture(t);
    observedLayout(f, { retired: false });
    eng = engine(f, { fail: failOnce(name => name === 'stop') });
    run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 1);
    assert.equal(run.execute.output.phase, 'stop');
    await runToCompletion(f, eng, 'rebuild');
    assertConverged(f);
});

test('AC15 r2: during container or image removal the next deploy takes R6 or R3', async t => {
    // The exact Box is stopped but not removed: R6.
    let f = fixture(t);
    observedLayout(f, { retired: false });
    let eng = engine(f, { fail: failOnce(name => name === 'rm') });
    let run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 1);
    assert.equal(run.execute.output.phase, 'remove-containers');
    assert.deepEqual(eng.state.containers.find(item => item.id === EXACT).running, false);
    let routed = await cli(f, eng, ['route', '--lock-held']);
    assert.equal(routed.output.reason, 'exact-box-stopped');
    await runToCompletion(f, eng, 'rebuild');
    assertConverged(f);
    // The exact Box is gone and a stopped legacy Box remains: R3.
    f = fixture(t);
    observedLayout(f, { retired: false });
    eng = engine(f, { containers: [exactBox(true), legacyBox(false)], fail: failOnce((name, args) => name === 'rm' && args[1] === LEGACY) });
    run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 1);
    routed = await cli(f, eng, ['route', '--lock-held']);
    assert.equal(routed.output.route, 'fresh');
    assert.equal(routed.output.legacy.length, 1);
    await runToCompletion(f, eng, 'fresh');
    assertConverged(f);
    assert.equal(eng.state.containers.some(item => item.id === LEGACY), false);
});

test('AC15 r2: during the stash a leftover temporary copy is discarded and the policy is parked again', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const eng = engine(f);
    const once = failOnce(() => true);
    eng.state.hooks.afterCopy = () => { if (once()) throw injected(); };
    const run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 1);
    assert.equal(run.execute.output.phase, 'workspace');
    assert.equal(run.execute.output.privileged.operation, 'stash-policy');
    assert.equal(stashPresent(f), false);
    assert.equal(fs.readdirSync(f.paths.state).filter(name => /^router-security\.tmp-[0-9]+$/.test(name)).length, 1);
    for (const [name, value] of Object.entries(POLICY)) assert.equal(f.read(`${POLICY_DIR}/${name}`), value);
    await runToCompletion(f, eng, 'fresh');
    assertConverged(f);
});

test('AC15 r2: during the reduction W keeps K and the next fresh install reduces again', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const eng = engine(f);
    let count = 0;
    eng.state.hooks.afterRemove = () => { count += 1; if (count === 3) throw injected(); };
    const run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 1);
    assert.equal(run.execute.output.privileged.operation, 'reduce-workspace');
    assert.equal(run.execute.output.privileged.deleted.length, 3);
    for (const name of durableList({ retired: false })) assert.equal(f.read(name), `original:${name}`);
    assert.equal(stashPresent(f), true);
    await runToCompletion(f, eng, 'fresh');
    assertConverged(f);
});

test('AC15 r2: tail failures before the restore, after it and during the stash removal all converge', async t => {
    for (const stopAfter of ['prepare', 'edge-init', 'restore', 'removing']) {
        const f = fixture(t);
        observedLayout(f, { retired: false });
        const eng = engine(f);
        const run = await deployTeardown(f, eng);
        assert.equal(run.execute.status, 0, JSON.stringify(run.execute.output));
        if (stopAfter === 'removing') {
            eng.state.hooks.afterRename = () => { throw injected(); };
            const restored = await deployTail(f, eng);
            assert.equal(restored.status, 1);
            assert.equal(fs.readdirSync(f.paths.state).filter(name => /^router-security\.removing-[0-9]+$/.test(name)).length, 1);
            assert.equal(stashPresent(f), false);
        } else await deployTail(f, eng, { stopAfter });
        assert.equal(stashPresent(f), stopAfter === 'prepare' || stopAfter === 'edge-init', stopAfter);
        const routed = await cli(f, eng, ['route', '--lock-held']);
        assert.equal(routed.output.route, 'rebuild', stopAfter);
        assert.equal(routed.output.reason, 'install-marker-present');
        // The new Box is the one the next rebuild removes; the original policy wins in every case.
        await runToCompletion(f, eng, 'rebuild');
        assertConverged(f);
    }
});

test('AC15 r2 and AC27: keep-data destroy crash points and the chained destroy, route, fresh install and restore', async t => {
    // Quiesce preflight fails: nothing is stopped or written; the next deploy selects.
    let f = fixture(t);
    observedLayout(f, { retired: false });
    let listing = contentListing(f.base);
    let eng = engine(f, { preflight: () => ({ result: 'failed', phase: 'preflight', code: 'QA_REGISTRY_INVALID' }) });
    let plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    let result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.output.code, 'QA_TEARDOWN_QUIESCE_PREFLIGHT_FAILED');
    assert.deepEqual(mutations(eng), [['quiesce', EXACT, true]]);
    assert.equal(contentListing(f.base), listing);
    assert.equal((await cli(f, eng, ['route', '--lock-held'])).output.route, 'select');
    // The preflight passes but the real quiesce fails: exit 1, nothing stopped, no marker, W unchanged.
    eng = engine(f, { quiesce: () => ({ result: 'failed', phase: 'agent-stop', code: 'QA_CONTAINER_CHANGED' }) });
    result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.output.code, 'QA_TEARDOWN_QUIESCE_FAILED');
    assert.deepEqual(mutations(eng), [['quiesce', EXACT, true], ['quiesce', EXACT, false]]);
    assert.equal(contentListing(f.base), listing);
    await runToCompletion(f, eng, 'select');
    assertConverged(f);

    // After the containers are removed and before the marker: R3 reduces, and the deploy parks the policy.
    f = fixture(t);
    observedLayout(f, { retired: false });
    eng = engine(f, { fail: failOnce(name => name === 'now') });
    plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.output.phase, 'marker');
    assert.equal(readMarker(f), null);
    assert.deepEqual(result.output.removedContainers.map(item => item.id), [EXACT]);
    await runToCompletion(f, eng, 'fresh');
    assertConverged(f);

    // After the marker, at a later point (the reduction): R3 restores the stash.
    f = fixture(t);
    observedLayout(f, { retired: false });
    eng = engine(f);
    const reductionFails = failOnce(() => true);
    eng.state.hooks.afterRemove = () => { if (reductionFails()) throw injected(); };
    plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.status, 1);
    assert.equal(readMarker(f).operation, 'destroy-keep');
    assert.equal(stashPresent(f), true);
    await runToCompletion(f, eng, 'fresh');
    assertConverged(f);

    // AC27: a complete keep-data destroy, then route, fresh install, restore and complete.
    f = fixture(t);
    observedLayout(f, { retired: false });
    eng = engine(f);
    plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.status, 0, JSON.stringify(result.output));
    assert.deepEqual(result.output.marker, { operation: 'destroy-keep' });
    assert.equal(stashPresent(f), true);
    assert.deepEqual(eng.state.containers.map(item => item.id), [SOUL]);
    assert.deepEqual(eng.state.images.map(item => item.id), [SOUL_IMAGE]);
    const routed = await cli(f, eng, ['route', '--lock-held']);
    assert.deepEqual(routed.output, { result: 'routed', route: 'fresh', reason: 'workspace-without-box',
        marker: { operation: 'destroy-keep' }, stash: true, exact: null, legacy: [] });
    await runToCompletion(f, eng, 'fresh');
    assertConverged(f);
});

test('AC15 r2: after complete the next deploy selects', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const eng = engine(f);
    await runToCompletion(f, eng, 'select');
    assertConverged(f);
    const routed = await cli(f, eng, ['route', '--lock-held']);
    assert.deepEqual(routed.output, { result: 'routed', route: 'select', reason: 'exact-box-running', marker: null, stash: false,
        exact: { engine: 'podman', id: NEW_EXACT, running: true }, legacy: [] });
});

// ---------------------------------------------------------------------------
// Marker and complete
// ---------------------------------------------------------------------------

test('mark creates the marker once, keeps an existing one, and complete needs a running exact Box', async t => {
    const f = fixture(t);
    fs.mkdirSync(f.paths.workspace);
    const eng = engine(f, { containers: [exactBox(false)] });
    let result = await cli(f, eng, ['mark', '--operation', 'update', '--dispatch', DISPATCH, '--lock-held']);
    assert.deepEqual(result.output, { result: 'marked', existing: false, marker: { version: 1, operation: 'update',
        createdAt: '2026-10-21T12:00:00.000Z', dispatch: DISPATCH } });
    assert.equal(fs.statSync(f.paths.state).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f.paths.state, teardown.MARKER_NAME)).mode & 0o777, 0o600);
    result = await cli(f, eng, ['mark', '--operation', 'rebuild', '--dispatch', DISPATCH, '--lock-held']);
    assert.equal(result.output.existing, true);
    assert.equal(result.output.marker.operation, 'update');
    for (const argv of [['mark', '--operation', 'destroy-keep', '--dispatch', DISPATCH, '--lock-held'],
        ['mark', '--operation', 'rebuild', '--dispatch', 'main@abc', '--lock-held']]) {
        assert.equal((await cli(f, eng, argv)).output.code, 'QA_TEARDOWN_USAGE_INVALID');
    }
    result = await cli(f, eng, ['complete', '--lock-held']);
    assert.deepEqual(result.output, { result: 'failed', code: 'QA_TEARDOWN_EXACT_BOX_NOT_RUNNING' });
    eng.state.containers = [exactBox(true)];
    result = await cli(f, eng, ['complete', '--lock-held']);
    assert.equal(result.output.result, 'completed');
    result = await cli(f, eng, ['complete', '--lock-held']);
    assert.deepEqual(result.output, { result: 'failed', code: 'QA_TEARDOWN_MARKER_ABSENT' });
    // A rebuild or fresh execute requires the marker.
    const plan = await cli(f, eng, ['plan', '--scope', 'rebuild', '--mode', 'keep-data', '--lock-held']);
    result = await cli(f, eng, ['execute', '--scope', 'rebuild', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.output.code, 'QA_TEARDOWN_MARKER_REQUIRED');
    assert.deepEqual(mutations(eng), []);
});

test('execute refuses a changed container plan before anything is quiesced or stopped', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const eng = engine(f, { containers: [exactBox(true), legacyBox(false)] });
    const plan = await cli(f, eng, ['plan', '--scope', 'rebuild', '--mode', 'keep-data', '--lock-held']);
    await cli(f, eng, ['mark', '--operation', 'rebuild', '--dispatch', DISPATCH, '--lock-held']);
    eng.state.containers = [exactBox(true)];
    const result = await cli(f, eng, ['execute', '--scope', 'rebuild', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.output.code, 'QA_TEARDOWN_PLAN_CHANGED');
    assert.deepEqual(mutations(eng), []);
});

test('the production quiesce adapter execs the quiesce source exactly as the deploy did', async t => {
    const calls = [];
    // Never a real engine: with PATH pointing nowhere, an adapter that ignored the injected spawn
    // could not resolve podman, and the argv assertions below would fail instead.
    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent-qa-teardown-path';
    t.after(() => { process.env.PATH = originalPath; });
    process.env.PLOINKY_TEST_LEAK = 'leak';
    let adapters;
    try {
        adapters = teardown.productionAdapters(teardown.QA_SCOPE, { spawn: (program, args, options) => {
            calls.push({ program, args, options });
            return { status: 0, stdout: 'diagnostic line\n{"result":"passed","phase":"complete"}\n' };
        } });
    } finally { delete process.env.PLOINKY_TEST_LEAK; }
    assert.equal(spawnSync('ls', [], { env: { PATH: process.env.PATH } }).error?.code, 'ENOENT');
    const source = fs.readFileSync(QUIESCE_FILE, 'utf8');
    const workspace = '/home/admin/explorerQaWorkspace';
    for (const preflightOnly of [false, true]) {
        calls.length = 0;
        const receipt = await adapters.quiesce({ engine: 'podman', id: EXACT, name: BOX }, { preflightOnly });
        assert.deepEqual(receipt, { result: 'passed', phase: 'complete' });
        assert.equal(calls.length, 1);
        const [call] = calls;
        assert.equal(call.program, 'podman');
        assert.deepEqual(call.args, ['container', 'exec', '-i', '--user', 'podman', '--workdir', workspace,
            '--env', `PLOINKY_WORKSPACE_ROOT=${workspace}`, '--env', 'PLOINKY_ROUTER_HOST_PORT=8097',
            '--env', 'PLOINKY_MEDIA_HOST_PORT=7882', ...(preflightOnly ? ['--env', 'QA_QUIESCE_PREFLIGHT_ONLY=1'] : []),
            EXACT, 'node', '--input-type=module', '-']);
        assert.equal(call.options.input, source);
        assert.equal(call.options.timeout, teardown.QUIESCE_EXEC_TIMEOUT_MS);
        assert.equal(call.options.timeout, 900_000);
        assert.equal(Object.keys(call.options.env).some(key => /^(?:PLOINKY_|CLOUDFLARE_|GIT_)/.test(key)), false);
    }
    // An unparseable answer is a failed quiesce, never a pass.
    const failing = teardown.productionAdapters(teardown.QA_SCOPE, { spawn: () => ({ status: 0, stdout: 'not json\n' }) });
    assert.deepEqual(await failing.quiesce({ engine: 'podman', id: EXACT }, { preflightOnly: false }),
        { result: 'failed', code: 'QA_TEARDOWN_QUIESCE_EXEC_FAILED' });
    // A failed exec is a failed quiesce whatever its last line says, as under the deploy's set -e before;
    // the helper's own safe code is kept, and anything else becomes the exec code.
    for (const [answer, code] of [
        [{ status: 1, stdout: '{"result":"passed","phase":"complete"}\n' }, 'QA_TEARDOWN_QUIESCE_EXEC_FAILED'],
        [{ status: 1, stdout: '{"result":"failed","code":"QA_QUIESCE_DRAIN_TIMEOUT"}\n' }, 'QA_QUIESCE_DRAIN_TIMEOUT'],
        [{ status: 1, stdout: '{"result":"failed","code":"not a code"}\n' }, 'QA_TEARDOWN_QUIESCE_EXEC_FAILED'],
        [{ status: null, error: new Error('ETIMEDOUT'), stdout: '{"result":"passed"}\n' }, 'QA_TEARDOWN_QUIESCE_EXEC_FAILED'],
    ]) {
        const exec = teardown.productionAdapters(teardown.QA_SCOPE, { spawn: () => answer });
        assert.deepEqual(await exec.quiesce({ engine: 'podman', id: EXACT }, { preflightOnly: false }), { result: 'failed', code },
            JSON.stringify(answer.stdout));
    }
    process.env.PATH = originalPath;
});

test('a marker write interrupted between link and unlink is read as the marker and healed by the next mutation', async t => {
    const markerFile = f => path.join(f.paths.state, teardown.MARKER_NAME);
    const twinName = 'install-pending.json.tmp-4242-0a1b2c3d';
    // The crash point: the marker and its temporary are one inode with two names.
    const crashed = (f, value) => {
        writeMarker(f, value);
        fs.linkSync(markerFile(f), path.join(f.paths.state, twinName));
        assert.equal(fs.statSync(markerFile(f)).nlink, 2);
    };
    // route is read-only: it routes past the second name and leaves it.
    let f = fixture(t);
    observedLayout(f, { retired: false });
    crashed(f, { version: 1, operation: 'rebuild', createdAt: '2026-10-21T00:00:00.000Z', dispatch: DISPATCH });
    let eng = engine(f);
    const routed = await cli(f, eng, ['route', '--lock-held']);
    assert.equal(routed.status, 0, JSON.stringify(routed.output));
    assert.equal(routed.output.route, 'rebuild');
    assert.equal(routed.output.reason, 'install-marker-present');
    assert.equal(exists(path.join(f.paths.state, twinName)), true);
    // The next deploy heals it (mark, execute) and converges.
    await runToCompletion(f, eng, 'rebuild');
    assertConverged(f);
    // complete heals it as well.
    f = fixture(t);
    fs.mkdirSync(f.paths.workspace);
    crashed(f);
    eng = engine(f, { containers: [exactBox(true)] });
    const completed = await cli(f, eng, ['complete', '--lock-held']);
    assert.equal(completed.output.result, 'completed', JSON.stringify(completed.output));
    assert.deepEqual(fs.readdirSync(f.paths.state), []);
    // A keep-data destroy (execute) heals it before it validates.
    f = fixture(t);
    observedLayout(f, { retired: false });
    crashed(f, { version: 1, operation: 'update', createdAt: '2026-10-21T00:00:00.000Z', dispatch: DISPATCH });
    eng = engine(f);
    const plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    assert.equal(plan.status, 0, JSON.stringify(plan.output));
    const destroyed = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(destroyed.status, 0, JSON.stringify(destroyed.output));
    assert.equal(exists(path.join(f.paths.state, twinName)), false);
    assert.equal(fs.statSync(markerFile(f)).nlink, 1);
    // Anything else with a second name still refuses: two temporaries, or a link under another name.
    for (const extra of [['install-pending.json.tmp-1-00000000', 'install-pending.json.tmp-2-00000000'], ['copy-of-marker']]) {
        const g = fixture(t);
        fs.mkdirSync(g.paths.workspace);
        writeMarker(g);
        for (const name of extra) fs.linkSync(markerFile(g), path.join(g.paths.state, name));
        const refused = await cli(g, engine(g, { containers: [] }), ['route', '--lock-held']);
        assert.deepEqual(refused.output, { result: 'refused', code: 'QA_ROUTE_MARKER_INVALID' }, extra.join(','));
    }
});

const tombstoneNames = f => fs.readdirSync(f.base).filter(name => /\.deleting-[0-9]+$/.test(name)).sort();

async function deleteDataDestroy(f, eng) {
    const plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'delete-data', '--lock-held']);
    if (plan.status !== 0) return { plan };
    const execute = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'delete-data', '--quiesce', 'skip',
        '--plan-digest', plan.output.digest, '--lock-held']);
    return { plan, execute };
}

test('delete-data crash points: after the container removal, between the two renames and mid deletion', async t => {
    // After the containers are removed and before delete-data: the data is intact (R3); the next destroy finishes.
    let f = fixture(t);
    observedLayout(f);
    writeMarker(f);
    writeStash(f);
    let eng = engine(f, { fail: failOnce((name, args) => name === 'privileged' && args[0] === 'delete-data') });
    let run = await deleteDataDestroy(f, eng);
    assert.equal(run.execute.status, 1);
    assert.equal(run.execute.output.phase, 'workspace');
    assert.deepEqual(eng.state.containers.map(item => item.id), [SOUL]);
    for (const name of durableList()) assert.equal(f.read(name), `original:${name}`);
    assert.equal((await cli(f, eng, ['route', '--lock-held'])).output.route, 'fresh');
    run = await deleteDataDestroy(f, eng);
    assert.equal(run.execute.status, 0, JSON.stringify(run.execute.output));
    assert.equal(exists(f.paths.workspace) || exists(f.paths.state), false);
    assert.deepEqual(tombstoneNames(f), []);

    // Between the workspace rename and the state rename: W is absent, its tombstone is ignored by the route.
    for (const withStash of [false, true]) {
        f = fixture(t);
        observedLayout(f);
        writeMarker(f);
        if (withStash) writeStash(f);
        eng = engine(f);
        eng.state.hooks.afterRename = file => { if (path.basename(file).startsWith('.explorerQaWorkspace.deleting-')) throw injected(); };
        run = await deleteDataDestroy(f, eng);
        assert.equal(run.execute.status, 1);
        assert.equal(exists(f.paths.workspace), false);
        assert.equal(exists(f.paths.state), true);
        assert.deepEqual(tombstoneNames(f).map(name => name.replace(/[0-9]+$/, 'N')), ['.explorerQaWorkspace.deleting-N']);
        eng.state.hooks = {};
        const routed = await cli(f, eng, ['route', '--lock-held']);
        // Without a stash the next deploy installs fresh (R1); a parked policy without its workspace refuses (R1b).
        if (withStash) assert.deepEqual(routed.output, { result: 'refused', code: 'QA_ROUTE_STASH_WITHOUT_WORKSPACE' });
        else assert.equal(routed.output.route, 'fresh');
        // A deploy plan ignores the tombstone; a destroy plan proves it and the destroy finishes it.
        const deployPlan = await cli(f, eng, ['plan', '--scope', 'fresh', '--mode', 'keep-data', '--lock-held']);
        assert.deepEqual(deployPlan.output.workspace.pendingDeletions, []);
        const mode = withStash ? 'delete-data' : 'keep-data';
        const plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', mode, '--lock-held']);
        assert.deepEqual(plan.output.workspace.pendingDeletions, tombstoneNames(f));
        const finished = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', mode,
            '--quiesce', mode === 'keep-data' ? 'fatal' : 'skip', '--plan-digest', plan.output.digest, '--lock-held']);
        assert.equal(finished.status, 0, JSON.stringify(finished.output));
        assert.deepEqual(finished.output.finishedDeletions, plan.output.workspace.pendingDeletions);
        assert.deepEqual(tombstoneNames(f), []);
        assert.equal(exists(f.paths.workspace), false);
    }

    // Mid deletion, after both renames: W and S are both absent (R1, no stash); the next destroy finishes both.
    f = fixture(t);
    observedLayout(f);
    writeMarker(f);
    writeStash(f);
    eng = engine(f);
    eng.state.hooks.afterRename = file => {
        if (!path.basename(file).startsWith('.qa-deployment-state.deleting-')) return;
        const partial = tombstoneNames(f).find(name => name.startsWith('.explorerQaWorkspace.deleting-'));
        fs.rmSync(path.join(f.base, partial, '.data'), { recursive: true });
        throw injected();
    };
    run = await deleteDataDestroy(f, eng);
    assert.equal(run.execute.status, 1);
    assert.equal(exists(f.paths.workspace) || exists(f.paths.state), false);
    assert.equal(tombstoneNames(f).length, 2);
    eng.state.hooks = {};
    const routed = await cli(f, eng, ['route', '--lock-held']);
    assert.deepEqual(routed.output, { result: 'routed', route: 'fresh', reason: 'workspace-absent', marker: null, stash: false,
        exact: null, legacy: [] });
    run = await deleteDataDestroy(f, eng);
    assert.equal(run.execute.status, 0, JSON.stringify(run.execute.output));
    assert.equal(run.execute.output.finishedDeletions.length, 2);
    assert.deepEqual(run.execute.output.workspace, { result: 'deleted', workspace: 'absent', state: 'absent' });
    assert.deepEqual(tombstoneNames(f), []);
});

test('a delete-data tombstone that is a link or holds a mount refuses the destroy plan, and a deploy ignores it', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    const tombstone = path.join(f.base, '.explorerQaWorkspace.deleting-99');
    fs.symlinkSync(outside, tombstone);
    const listing = contentListing(f.base);
    let eng = engine(f);
    let plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'delete-data', '--lock-held']);
    assert.deepEqual(plan.output, { result: 'refused', code: 'QA_TEARDOWN_TOMBSTONE_INVALID', privileged: { operation: 'plan-workspace',
        code: 'QA_TEARDOWN_TOMBSTONE_INVALID' } });
    const deploy = await cli(f, eng, ['plan', '--scope', 'rebuild', '--mode', 'keep-data', '--lock-held']);
    assert.equal(deploy.status, 0, JSON.stringify(deploy.output));
    fs.unlinkSync(tombstone);
    fs.mkdirSync(tombstone);
    eng = engine(f, { hooks: { mountPoints: () => ['/', path.join(tombstone, 'mnt')] } });
    plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    assert.equal(plan.output.code, 'QA_TEARDOWN_MOUNT_INSIDE');
    assert.deepEqual(mutations(eng), []);
    fs.rmdirSync(tombstone);
    assert.equal(contentListing(f.base), listing.replace(/,\{"path":"\.explorerQaWorkspace\.deleting-99","type":"symlink","target":"[^"]*"\}/, ''));
});

test('a destroy plan previews the legacy-backup prune read-only and refuses a mount inside a backup before anything stops', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    legacyBackups(f);
    const listing = contentListing(f.base);
    let eng = engine(f);
    const plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    assert.equal(plan.status, 0, JSON.stringify(plan.output));
    assert.deepEqual(plan.output.legacyBackups, { remove: LEGACY_EXPECTED.removed, replayTombstones: LEGACY_EXPECTED.replayedTombstones,
        retained: LEGACY_EXPECTED.retainedBackups.filter(item => /^redeploy-[A-Za-z0-9]{8}$/.test(item.name))
            .map(item => ({ name: item.name, class: item.reason })),
        retainedSiblings: ['redeploy-Ddddddd4-lock.log'], unrecognized: ['unrelated-notes'] });
    assert.equal(contentListing(f.base), listing);
    const deployPlan = await cli(f, eng, ['plan', '--scope', 'rebuild', '--mode', 'keep-data', '--lock-held']);
    assert.equal(deployPlan.output.legacyBackups, null);
    for (const mode of ['keep-data', 'delete-data']) {
        eng = engine(f, { hooks: { mountPoints: () => ['/', path.join(f.paths.backups, 'redeploy-Aaaaaaa1', 'workspace')] } });
        const refused = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', mode, '--lock-held']);
        assert.equal(refused.status, 1);
        assert.equal(refused.output.code, 'QA_TEARDOWN_MOUNT_INSIDE', mode);
        assert.equal(refused.output.privileged.operation, 'plan-legacy-backups');
        assert.deepEqual(mutations(eng), []);
        assert.equal(contentListing(f.base), listing);
    }
});

// ---------------------------------------------------------------------------
// Legacy backups (AC31, with the three I1 fixtures)
// ---------------------------------------------------------------------------

function legacyBackups(f, { workspace = f.paths.workspace } = {}) {
    fs.mkdirSync(f.paths.backups, { mode: 0o700, recursive: true });
    const backup = (name, files = {}) => {
        const directory = path.join(f.paths.backups, name);
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.mkdirSync(path.join(directory, 'helpers'));
        fs.writeFileSync(path.join(directory, 'helpers/node-runtime-path'), '/home/admin/.qa-deployment-tools/node\n');
        fs.writeFileSync(path.join(directory, 'prior-containers.txt'), `podman|${EXACT}|${BOX}\n`);
        fs.writeFileSync(path.join(directory, 'rollback-authority.json'), '{}');
        for (const [relative, value] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
            if (value === null) fs.mkdirSync(path.join(directory, relative), { recursive: true });
            else fs.writeFileSync(path.join(directory, relative), typeof value === 'string' ? value : JSON.stringify(value));
        }
        return directory;
    };
    const complete = (name, extra = {}, omit = []) => {
        const files = { 'workspace/.data/one': 'old data', 'preservation.json': { version: 1, exactCopiesVerified: true,
            source: path.join(f.paths.backups, name, 'workspace'), target: workspace, copied: ['.data'] },
        'policy-restoration.json': { copied: [], exactCopiesVerified: true }, 'restored-selections.json': { boxId: NEW_EXACT },
        'quiesce.log': '{"result":"passed"}', ...extra };
        for (const name2 of omit) delete files[name2];
        return backup(name, files);
    };
    complete('redeploy-Aaaaaaa1');
    backup('redeploy-Bbbbbbb2');
    fs.mkdirSync(path.join(f.paths.backups, 'redeploy-Bbbbbbb2-helpers'), { mode: 0o700 });
    fs.writeFileSync(path.join(f.paths.backups, 'redeploy-Bbbbbbb2-helpers/rollback-explorer-qa.mjs'), '// helper');
    fs.mkdirSync(path.join(f.paths.backups, '.pruning-redeploy-Ccccccc3/workspace'), { recursive: true, mode: 0o700 });
    backup('redeploy-Ddddddd4', { 'workspace/.data/one': 'data' });
    fs.writeFileSync(path.join(f.paths.backups, 'redeploy-Ddddddd4-lock.log'), 'lock');
    complete('redeploy-Eeeeeee5', { 'preservation.json': { version: 1, exactCopiesVerified: false,
        source: path.join(f.paths.backups, 'redeploy-Eeeeeee5', 'workspace'), target: workspace, copied: [] } });
    complete('redeploy-Fffffff6', { 'failed-workspace/.data/one': 'failed' });
    fs.mkdirSync(path.join(f.paths.backups, 'unrelated-notes'));
    // I1: a rollback result beside a verified preservation; no policy restoration; a source mismatch.
    complete('redeploy-Ggggggg7', { 'rollback-result.json': { result: 'recovered' } });
    complete('redeploy-Hhhhhhh8', {}, ['policy-restoration.json']);
    complete('redeploy-Iiiiiii9', { 'preservation.json': { version: 1, exactCopiesVerified: true,
        source: path.join(f.paths.backups, 'redeploy-Aaaaaaa1', 'workspace'), target: workspace, copied: [] } });
}

const LEGACY_EXPECTED = Object.freeze({
    removed: ['redeploy-Aaaaaaa1', 'redeploy-Bbbbbbb2'],
    replayedTombstones: ['.pruning-redeploy-Ccccccc3'],
    retainedBackups: [
        { name: 'redeploy-Ddddddd4', reason: 'incomplete-redeploy' },
        { name: 'redeploy-Eeeeeee5', reason: 'incomplete-redeploy' },
        { name: 'redeploy-Fffffff6', reason: 'rollback-attempted' },
        { name: 'redeploy-Ggggggg7', reason: 'rollback-attempted' },
        { name: 'redeploy-Hhhhhhh8', reason: 'incomplete-redeploy' },
        { name: 'redeploy-Iiiiiii9', reason: 'incomplete-redeploy' },
        { name: 'redeploy-Ddddddd4-lock.log', reason: 'sibling-of-retained' },
        { name: 'unrelated-notes', reason: 'unrecognized' },
    ],
});
const LEGACY_REMAINING = Object.freeze(['redeploy-Ddddddd4', 'redeploy-Ddddddd4-lock.log', 'redeploy-Eeeeeee5', 'redeploy-Fffffff6',
    'redeploy-Ggggggg7', 'redeploy-Hhhhhhh8', 'redeploy-Iiiiiii9', 'unrelated-notes']);

test('AC31: a keep-data destroy removes only the classified legacy backups and reports the rest', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    legacyBackups(f);
    const kept = Object.fromEntries(LEGACY_REMAINING.map(name => [name, contentListing(path.join(f.paths.backups, name))]));
    const eng = engine(f);
    const plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    const result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.status, 0, JSON.stringify(result.output));
    assert.deepEqual(result.output.legacyBackups, { removed: LEGACY_EXPECTED.removed, replayedTombstones: LEGACY_EXPECTED.replayedTombstones });
    assert.deepEqual(result.output.retainedBackups, LEGACY_EXPECTED.retainedBackups);
    assert.deepEqual(fs.readdirSync(f.paths.backups).sort(), [...LEGACY_REMAINING]);
    for (const name of LEGACY_REMAINING) assert.equal(contentListing(path.join(f.paths.backups, name)), kept[name], name);
    // Idempotent: a second pass removes nothing else.
    const again = privileged.privilegedOperation('remove-legacy-backups', { paths: f.paths, owner: uid });
    assert.deepEqual(again.removed, []);
    assert.deepEqual(fs.readdirSync(f.paths.backups).sort(), [...LEGACY_REMAINING]);
});

test('AC31: a delete-data destroy prunes the legacy backups after the workspace is gone', async t => {
    const f = fixture(t);
    observedLayout(f);
    legacyBackups(f);
    const eng = engine(f);
    const plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'delete-data', '--lock-held']);
    const result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'delete-data', '--quiesce', 'skip',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.status, 0, JSON.stringify(result.output));
    assert.equal(exists(f.paths.workspace), false);
    assert.deepEqual(result.output.legacyBackups.removed, LEGACY_EXPECTED.removed);
    assert.deepEqual(result.output.retainedBackups, LEGACY_EXPECTED.retainedBackups);
    assert.deepEqual(fs.readdirSync(f.paths.backups).sort(), [...LEGACY_REMAINING]);
    // Destroy twice: nothing left to remove, and it still succeeds.
    const replan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'delete-data', '--lock-held']);
    const twice = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'delete-data', '--quiesce', 'skip',
        '--plan-digest', replan.output.digest, '--lock-held']);
    assert.equal(twice.status, 0, JSON.stringify(twice.output));
    assert.deepEqual(twice.output.removedContainers, []);
    assert.deepEqual(twice.output.workspace, { result: 'deleted', workspace: 'absent', state: 'absent' });
});

// ---------------------------------------------------------------------------
// Protected snapshot (AC20, contract 8)
// ---------------------------------------------------------------------------

// The inline snapshot of deploy-explorer-qa.yml:1128-1168 at 916078b2, verbatim.
const BASE_SNAPSHOT_SCRIPT = String.raw`import { execFileSync } from 'node:child_process';

const [qaHash, qaName] = process.argv.slice(2);
const run = (engine, args) => execFileSync(engine, args, { encoding: 'utf8' }).trim();
const engines = ['podman', 'docker'].filter((engine) => {
  try { run('sh', ['-lc', ${'`'}command -v ${'$'}{engine}${'`'}]); return true; } catch { return false; }
});
const protectedState = [];
for (const engine of engines) {
  const containerIds = run(engine, ['container', 'ls', '-aq']).split('\n').filter(Boolean);
  for (const id of containerIds) {
    const item = JSON.parse(run(engine, ['container', 'inspect', id]))[0];
    const labels = item?.Config?.Labels || item?.Labels || {};
    const name = String(item?.Name || '').replace(/^\//, '');
    if (labels['io.assistos.ploinky-box.path-hash'] === qaHash || name === qaName) continue;
    protectedState.push({
      engine,
      kind: 'container',
      id: item.Id,
      name,
      image: item.Image,
      labels: Object.fromEntries(Object.entries(labels).sort()),
    });
  }
  const volumeNames = run(engine, ['volume', 'ls', '-q']).split('\n').filter(Boolean);
  for (const name of volumeNames) {
    const item = JSON.parse(run(engine, ['volume', 'inspect', name]))[0];
    const labels = item?.Labels || {};
    if (labels['io.assistos.ploinky-box.path-hash'] === qaHash
      || name.startsWith(${'`'}${'$'}{qaName}-${'`'})) continue;
    protectedState.push({
      engine,
      kind: 'volume',
      name,
      labels: Object.fromEntries(Object.entries(labels).sort()),
    });
  }
}
protectedState.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
process.stdout.write(${'`'}${'$'}{JSON.stringify(protectedState)}\n${'`'});
`;

const ENGINE_STUB = `
import fs from 'node:fs';
import path from 'node:path';
const engine = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.QA_STUB_LOG, JSON.stringify([engine, ...args]) + '\\n');
const inventory = JSON.parse(fs.readFileSync(process.env.QA_STUB_INVENTORY, 'utf8'))[engine] || { containers: [], volumes: [], images: [] };
const key = args.slice(0, 2).join(' ');
const out = value => process.stdout.write(value);
if (key === 'container ls') out(inventory.containers.map(item => item.Id.slice(0, 12)).join('\\n') + '\\n');
else if (key === 'container inspect') out(JSON.stringify([inventory.containers.find(item => item.Id.startsWith(args[2]))]));
else if (key === 'volume ls') out(inventory.volumes.map(item => item.Name).join('\\n') + '\\n');
else if (key === 'volume inspect') out(JSON.stringify([inventory.volumes.find(item => item.Name === args[2])]));
else if (key === 'image inspect') out(JSON.stringify([inventory.images.find(item => item.Id === args[2] || item.Id === 'sha256:' + args[2])]));
else process.exit(125);
`;

// Both scripts detect an engine through `sh` (`sh -lc 'command -v podman'` in the base script,
// `sh -c 'command -v "$1"' sh podman` here). A Debian login shell resets PATH, so `sh` is stubbed
// too: both stub engines are reported installed and every other command goes to /bin/sh.
const SH_STUB = `
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const args = process.argv.slice(2);
if ((args[0] === '-lc' || args[0] === '-c') && /^command -v /.test(args[1] || '')) {
    const name = args[0] === '-lc' ? args[1].slice('command -v '.length).trim() : args[args.length - 1];
    if (['podman', 'docker'].includes(name)) { process.stdout.write(path.join(path.dirname(process.argv[1]), name) + '\\n'); process.exit(0); }
    process.exit(1);
}
const result = spawnSync('/bin/sh', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`;

function stubEngines(t, inventory) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-teardown-stub-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['podman', 'docker']) {
        fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${ENGINE_STUB}`, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(bin, 'sh'), `#!${process.execPath}\n${SH_STUB}`, { mode: 0o755 });
    fs.writeFileSync(path.join(base, 'inventory.json'), JSON.stringify(inventory));
    const log = path.join(base, 'calls.log');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, QA_STUB_INVENTORY: path.join(base, 'inventory.json'), QA_STUB_LOG: log };
    const calls = () => exists(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    return { env, calls, base };
}

function snapshotPair(t, inventory) {
    const stubs = stubEngines(t, inventory);
    const old = spawnSync(process.execPath, ['--input-type=module', '-', HASH, BOX], { input: BASE_SNAPSHOT_SCRIPT, encoding: 'utf8',
        env: stubs.env, timeout: 60_000 });
    assert.equal(old.status, 0, old.stderr);
    const oldCalls = stubs.calls();
    assert.ok(oldCalls.length > 0, 'the base script must have used the stub engines');
    assert.ok(['podman', 'docker'].every(name => oldCalls.some(([engineName]) => engineName === name)), 'both stub engines were listed');
    fs.rmSync(path.join(stubs.base, 'calls.log'));
    const current = spawnSync(process.execPath, [ADMIN_FILE, 'protected-snapshot'], { encoding: 'utf8', env: stubs.env, timeout: 60_000 });
    assert.equal(current.status, 0, current.stdout + current.stderr);
    assert.ok(stubs.calls().length > 0, 'protected-snapshot must have used the stub engines');
    assert.ok(['podman', 'docker'].every(name => stubs.calls().some(([engineName]) => engineName === name)), 'both stub engines were listed');
    assert.ok(stubs.calls().every(([, ...args]) => !['rm', 'stop', 'untag'].some(verb => args.includes(verb))));
    return { old: old.stdout, current: current.stdout };
}

test('AC20 and contract 8: protected-snapshot keeps the base record format and adds the protected images', t => {
    const qaLabels = { 'io.assistos.ploinky-box.path-hash': HASH, 'io.assistos.ploinky-box.role': 'box' };
    const inventory = { podman: {
        containers: [
            { Id: EXACT, Name: BOX, Image: BOX_IMAGE, Config: { Labels: qaLabels } },
            { Id: LEGACY, Name: `/${BOX}-rollback-redeploy-Ab123456`, Image: BOX_IMAGE, Config: { Labels: qaLabels } },
            { Id: SOUL, Name: 'soul-gateway', Image: SOUL_IMAGE, Config: { Labels: { b: '2', a: '1' } } },
            { Id: OTHER, Name: 'soul-worker', Image: SOUL_IMAGE, Config: { Labels: null } },
        ],
        volumes: [
            { Name: `${BOX}-workspace`, Labels: {} },
            { Name: 'qa-labelled', Labels: { 'io.assistos.ploinky-box.path-hash': HASH } },
            { Name: 'soul-data', Labels: { owner: 'soul' } },
        ],
        images: [{ Id: SOUL_IMAGE, RepoTags: ['docker.io/assistos/soul:latest', 'docker.io/assistos/ploinky-box:latest'] }],
    }, docker: {
        // The exact QA name without the QA label is excluded by name, as in the base script.
        containers: [{ Id: '7'.repeat(64), Name: `/${BOX}`, Image: `sha256:${BOX_IMAGE}`, Config: { Labels: {} } }],
        volumes: [{ Name: 'docker-protected', Labels: {} }],
        images: [],
    } };
    const { old, current } = snapshotPair(t, inventory);
    const records = JSON.parse(current);
    assert.deepEqual(records.filter(item => item.kind === 'image'), [{ engine: 'podman', kind: 'image', id: SOUL_IMAGE,
        tags: ['docker.io/assistos/soul:latest'] }]);
    assert.equal(`${JSON.stringify(records.filter(item => item.kind !== 'image'))}\n`, old);
    assert.ok(records.some(item => item.engine === 'docker' && item.name === 'docker-protected'));
    assert.equal(records.some(item => item.id === EXACT || item.id === LEGACY || item.id === '7'.repeat(64) || item.name === 'qa-labelled'
        || item.name === `${BOX}-workspace`), false);
    // With no protected container the output is byte-identical.
    const empty = snapshotPair(t, { podman: { containers: inventory.podman.containers.slice(0, 2), volumes: inventory.podman.volumes, images: [] },
        docker: inventory.docker });
    assert.equal(empty.current, empty.old);
});

// ---------------------------------------------------------------------------
// Adversarial probes
// ---------------------------------------------------------------------------

test('probe: boundary names, an empty workspace and minimal layouts are kept or reduced and nothing else is touched', async t => {
    const names = ['données-é', 'n'.repeat(255), '-rf', '--', ' leading space'];
    const f = fixture(t);
    observedLayout(f, { retired: false });
    for (const name of names) {
        f.write(name, `original:${name}`);
        f.write(`.ploinky/${name}`, `original:.ploinky/${name}`);
    }
    const eng = engine(f);
    const run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 0, JSON.stringify(run.execute.output));
    for (const name of names) {
        assert.equal(f.read(name), `original:${name}`);
        assert.equal(f.read(`.ploinky/${name}`), `original:.ploinky/${name}`);
    }
    for (const setup of [() => {}, g => g.write('.ploinky/data/master-key'), g => fs.mkdirSync(g.at('.ploinky'))]) {
        const g = fixture(t);
        fs.mkdirSync(g.paths.workspace);
        setup(g);
        const listing = contentListing(g.paths.workspace);
        const gEng = engine(g, { containers: [] });
        const plan = await cli(g, gEng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
        assert.equal(plan.status, 0, JSON.stringify(plan.output));
        assert.deepEqual(plan.output.workspace.delete, []);
        const result = await cli(g, gEng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
            '--plan-digest', plan.output.digest, '--lock-held']);
        assert.equal(result.status, 0, JSON.stringify(result.output));
        assert.equal(contentListing(g.paths.workspace), listing);
    }
});

test('probe: a code link to / is deleted without being followed and a real skills directory is kept', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    fs.symlinkSync('/', f.at('.ploinky/code/root-link'));
    f.write('.ploinky/skills/explorer/SKILL.md');
    const eng = engine(f);
    const run = await deployTeardown(f, eng);
    assert.equal(run.execute.status, 0, JSON.stringify(run.execute.output));
    assert.equal(exists(f.at('.ploinky/code/root-link')), false);
    assert.equal(f.read('.ploinky/skills/explorer/SKILL.md'), 'original:.ploinky/skills/explorer/SKILL.md');
    assert.ok(fs.readdirSync('/').length > 0);
});

test('probe: execute twice and keep-data destroy twice are no-ops the second time; then the deploy restores once', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const eng = engine(f);
    for (let round = 0; round < 2; round += 1) {
        const plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
        const result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
            '--plan-digest', plan.output.digest, '--lock-held']);
        assert.equal(result.status, 0, JSON.stringify(result.output));
        if (round === 1) {
            assert.deepEqual(result.output.workspace.deleted, []);
            assert.equal(result.output.stash, 'kept');
            assert.deepEqual(result.output.removedContainers, []);
            assert.equal(readMarker(f).operation, 'destroy-keep');
        }
    }
    const restores = [];
    const original = eng.adapters.runPrivileged;
    eng.adapters.runPrivileged = args => { if (args[0] === 'stash-restore') restores.push(args[0]); return original(args); };
    await runToCompletion(f, eng, 'fresh');
    assert.equal(restores.length, 1);
    assertConverged(f);
});

test('probe: orphans; a destroy-keep marker without a stash installs with a fresh policy; a legacy Box without its backup is removed', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    fs.rmSync(f.at(POLICY_DIR), { recursive: true });
    writeMarker(f, { version: 1, operation: 'destroy-keep', createdAt: '2026-10-21T00:00:00.000Z', dispatch: null });
    const eng = engine(f, { containers: [legacyBox(false), soulBox()] });
    newDeployEngine(f, eng);
    const run = await deployTeardown(f, eng);
    assert.equal(run.routed.output.route, 'fresh');
    assert.equal(run.execute.status, 0, JSON.stringify(run.execute.output));
    assert.deepEqual(run.execute.output.removedContainers.map(item => item.id), [LEGACY]);
    assert.equal(run.execute.output.stash, 'none');
    const done = await deployTail(f, eng);
    assert.equal(done.status, 0, JSON.stringify(done.output));
    assertConverged(f, { policy: { 'policy-state.json': '{"policy":"fresh"}\n' } });
});

test('probe: without the host lock every command refuses before any engine or privileged call', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const listing = contentListing(f.base);
    const digest = `sha256:${'0'.repeat(64)}`;
    for (const argv of [['route', '--lock-held'], ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held'],
        ['mark', '--operation', 'rebuild', '--dispatch', DISPATCH, '--lock-held'],
        ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal', '--plan-digest', digest, '--lock-held'],
        ['complete', '--lock-held'], ['stash-restore', '--lock-held'], ['stash-clear', '--lock-held']]) {
        const eng = engine(f, { lock: false });
        const result = await cli(f, eng, argv);
        assert.equal(result.status, 1, argv[0]);
        assert.equal(result.output.code, 'QA_TEARDOWN_HOST_LOCK_REQUIRED', argv[0]);
        assert.deepEqual(eng.state.calls, [['host'], ['lock']], argv[0]);
    }
    assert.equal(contentListing(f.base), listing);
});

test('probe: sudo, engine listing and image removal failures exit 1 before deletion or in a crash-table state', async t => {
    const f = fixture(t);
    observedLayout(f, { retired: false });
    const listing = contentListing(f.base);
    let eng = engine(f);
    eng.state.privilegedUnavailable = true;
    let plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    assert.equal(plan.output.code, 'QA_TEARDOWN_PRIVILEGED_UNAVAILABLE');
    eng = engine(f, { fail: name => name === 'images' });
    plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    assert.deepEqual(plan.output, { result: 'refused', code: 'QA_TEARDOWN_ENGINE_PROBE_FAILED' });
    eng = engine(f, { hooks: { mountPoints: () => ['/', f.at('.ploinky/box/images')] } });
    plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    assert.equal(plan.output.code, 'QA_TEARDOWN_MOUNT_INSIDE');
    assert.equal(contentListing(f.base), listing);
    // sudo fails after the containers are gone: the stash is the first privileged step (crash row "during the stash").
    eng = engine(f);
    plan = await cli(f, eng, ['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']);
    const original = eng.adapters.runPrivileged;
    eng.adapters.runPrivileged = args => args[0] === 'stash-policy' ? { status: 1, error: true, stdout: '' } : original(args);
    const result = await cli(f, eng, ['execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal',
        '--plan-digest', plan.output.digest, '--lock-held']);
    assert.equal(result.output.code, 'QA_TEARDOWN_PRIVILEGED_UNAVAILABLE');
    assert.equal(result.output.phase, 'workspace');
    for (const name of durableList({ retired: false })) assert.equal(f.read(name), `original:${name}`);
    assert.equal((await cli(f, eng, ['route', '--lock-held'])).output.route, 'fresh');
});

// ---------------------------------------------------------------------------
// AC25 r2 and AC30 (apparatus): the real root program on root- and subuid-owned fixtures
// ---------------------------------------------------------------------------

const PRIVILEGED_REQUESTED = process.env.QA_TEARDOWN_PRIVILEGED_TESTS === '1';
const privilegedSkip = PRIVILEGED_REQUESTED ? false : 'set QA_TEARDOWN_PRIVILEGED_TESTS=1 with passwordless sudo to run the root cases';
// The real bind mount is an apparatus probe (AC30); workflow runners never mount anything.
const mountProbeSkip = privilegedSkip || (process.env.QA_TEARDOWN_MOUNT_PROBE !== '1'
    ? 'set QA_TEARDOWN_MOUNT_PROBE=1 on the apparatus host to run the real bind-mount probe'
    : process.platform !== 'linux' ? 'Linux only' : false);

function sudo(args, options = {}) {
    return spawnSync('sudo', ['-n', ...args], { encoding: 'utf8', timeout: 120_000, ...options });
}

function rootFixture(t) {
    // When requested, the root cases must run: a sudo failure is a test failure, never a skip.
    assert.equal(sudo(['true']).status, 0, 'QA_TEARDOWN_PRIVILEGED_TESTS=1 needs passwordless sudo');
    const f = fixture(t, 'qa-teardown-priv-', { cleanup: false });
    f.mounts = [];
    // N2: one cleanup hook. It unmounts what the test mounted, then removes the root- and
    // subuid-owned fixture with sudo, only inside this exact temporary directory.
    t.after(() => {
        for (const target of f.mounts.reverse()) {
            if (spawnSync('mountpoint', ['-q', '--', target]).status === 0) sudo(['umount', '--', target]);
        }
        assert.match(path.basename(f.base), /^qa-teardown-priv-[A-Za-z0-9]{6}$/);
        assert.equal(path.dirname(f.base), fs.realpathSync(os.tmpdir()));
        const removed = sudo(['rm', '-rf', '--', f.base]);
        assert.equal(removed.status, 0, removed.stderr);
    });
    return f;
}

/** Runs one argv as root through the real module and the real uid check, on fixture paths. */
function asRoot(f, argv) {
    const driver = `const m = await import(${JSON.stringify(pathToFileURL(PRIVILEGED_FILE).href)});
const { argv, paths } = JSON.parse(process.argv[1]);
const result = m.runPrivilegedArgv(argv, { paths });
process.stdout.write(result.stdout);
process.exitCode = result.status;`;
    const run = sudo([process.execPath, '--input-type=module', '-e', driver, JSON.stringify({ argv, paths: f.paths })]);
    const lines = run.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, run.stdout + run.stderr);
    return { status: run.status, output: JSON.parse(lines[0]) };
}

const rootStat = file => {
    const run = sudo(['stat', '-c', '%u:%g:%a', '--', file]);
    return run.status === 0 ? run.stdout.trim() : null;
};

test('AC25 r2: as root, keep-data keeps root- and subuid-owned data, parks the policy with its owners and reduces', { skip: privilegedSkip }, t => {
    const f = rootFixture(t);
    observedLayout(f, { retired: false });
    fs.mkdirSync(f.paths.state, { mode: 0o700 });
    for (const relative of ['.data/umamiAgent', '.ploinky/box', POLICY_DIR]) {
        assert.equal(sudo(['chown', '-R', '100999:100999', '--', f.at(relative)]).status, 0);
    }
    assert.equal(sudo(['chmod', '-R', 'go-rwx', '--', f.at('.data/umamiAgent'), f.at('.ploinky/box')]).status, 0);
    assert.equal(sudo(['chown', '0:0', '--', f.at('.data/soul-gateway/data.sqlite-wal')]).status, 0);
    const owner = ['--owner', String(uid)];
    const plan = asRoot(f, ['plan-workspace', '--scope', 'rebuild', '--mode', 'keep-data', '--measure', ...owner]);
    assert.equal(plan.status, 0, JSON.stringify(plan.output));
    assert.ok(plan.output.reclaimableBytes > 0);
    const stash = asRoot(f, ['stash-policy', ...owner]);
    assert.equal(stash.output.result, 'stashed');
    assert.equal(rootStat(path.join(f.paths.state, teardown.STASH_NAME, 'policy-state.json')).split(':')[0], '100999');
    const replan = asRoot(f, ['plan-workspace', '--scope', 'rebuild', '--mode', 'keep-data', ...owner]);
    const reduce = asRoot(f, ['reduce-workspace', '--scope', 'rebuild', '--plan-digest', replan.output.digest, ...owner]);
    assert.equal(reduce.status, 0, JSON.stringify(reduce.output));
    assert.equal(rootStat(f.at('.data/umamiAgent/postgres/PG_VERSION')).split(':')[0], '100999');
    assert.equal(rootStat(f.at('.data/soul-gateway/data.sqlite-wal')).split(':')[0], '0');
    assert.equal(rootStat(f.at('.ploinky/box')), null);
    assert.equal(rootStat(f.at(POLICY_DIR)), null);
    const second = asRoot(f, ['plan-workspace', '--scope', 'rebuild', '--mode', 'keep-data', ...owner]);
    assert.deepEqual(second.output.delete, []);
    // Restore into a fresh, subuid-owned policy and remove the stash.
    f.write(`${POLICY_DIR}/policy-state.json`, '{"policy":"fresh"}\n');
    assert.equal(sudo(['chown', '-R', '100999:100999', '--', f.at(POLICY_DIR)]).status, 0);
    const restored = asRoot(f, ['stash-restore', ...owner]);
    assert.equal(restored.output.result, 'restored', JSON.stringify(restored.output));
    assert.equal(sudo(['cat', '--', f.at(`${POLICY_DIR}/policy-state.json`)]).stdout, POLICY['policy-state.json']);
    assert.equal(rootStat(path.join(f.paths.state, teardown.STASH_NAME)), null);
});

test('AC25 r2: as root, delete-data and the legacy backups handle root-owned receipts', { skip: privilegedSkip }, t => {
    const f = rootFixture(t);
    observedLayout(f);
    legacyBackups(f);
    writeMarker(f);
    assert.equal(sudo(['chown', '-R', '100999:100999', '--', f.at('.ploinky/box'), f.at('.data')]).status, 0);
    for (const name of ['redeploy-Aaaaaaa1', 'redeploy-Hhhhhhh8']) {
        assert.equal(sudo(['chown', '0:0', '--', path.join(f.paths.backups, name, 'preservation.json')]).status, 0);
        assert.equal(sudo(['chmod', '600', '--', path.join(f.paths.backups, name, 'preservation.json')]).status, 0);
    }
    const owner = ['--owner', String(uid)];
    const deleted = asRoot(f, ['delete-data', ...owner]);
    assert.deepEqual({ ...deleted.output, digest: undefined }, { result: 'deleted', workspace: 'removed', state: 'removed',
        finishedDeletions: [], digest: undefined });
    assert.equal(exists(f.paths.workspace), false);
    assert.equal(exists(f.paths.state), false);
    const pruned = asRoot(f, ['remove-legacy-backups', ...owner]);
    assert.equal(pruned.status, 0, JSON.stringify(pruned.output));
    assert.deepEqual(pruned.output.removed, LEGACY_EXPECTED.removed);
    assert.deepEqual(pruned.output.retained.map(item => item.name).sort(), ['redeploy-Ddddddd4', 'redeploy-Eeeeeee5', 'redeploy-Fffffff6',
        'redeploy-Ggggggg7', 'redeploy-Hhhhhhh8', 'redeploy-Iiiiiii9']);
    // The root check is the real one: the same driver without sudo is refused.
    const notRoot = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(PRIVILEGED_FILE).href)});
process.stdout.write(m.runPrivilegedArgv(['stash-clear', '--owner', '${uid}'], { paths: ${JSON.stringify(f.paths)} }).stdout);`], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(notRoot.stdout), { result: 'failed', code: 'QA_TEARDOWN_ROOT_REQUIRED' });
});

test('AC30 (apparatus): a real bind mount below the workspace refuses from /proc/self/mountinfo', { skip: mountProbeSkip }, t => {
    const f = rootFixture(t);
    observedLayout(f);
    const scratch = path.join(f.base, 'scratch');
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, 'outside'), 'outside');
    const target = f.at('.ploinky/box/images');
    const listing = contentListing(f.base);
    f.mounts.push(target);
    assert.equal(sudo(['mount', '--bind', scratch, target]).status, 0);
    for (const argv of [['plan-workspace', '--scope', 'destroy', '--mode', 'keep-data', '--owner', String(uid)],
        ['delete-data', '--owner', String(uid)]]) {
        const result = asRoot(f, argv);
        assert.equal(result.status, 1);
        assert.equal(result.output.code, 'QA_TEARDOWN_MOUNT_INSIDE');
    }
    assert.equal(sudo(['umount', '--', target]).status, 0);
    assert.equal(contentListing(f.base), listing);
    assert.equal(fs.readFileSync(path.join(scratch, 'outside'), 'utf8'), 'outside');
});

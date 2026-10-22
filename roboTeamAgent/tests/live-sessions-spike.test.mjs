import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listenProbe, connectProbe, SOCKET_PATHS } from './spikes/live-sessions-process-probe.mjs';
import { captureGrants, aliasesFor, parseMountInfo } from './spikes/live-sessions-sandbox.mjs';
import { assembleEvidence } from './spikes/live-sessions-evidence.mjs';

const identity = { pid: process.pid, uid: process.getuid(), mountNamespace: 'mnt:[1234]' };
// New spike exports load lazily so this file also runs against older spike sources.
const spike = name => import(`./spikes/live-sessions-${name}.mjs`);
const fileSha256 = async name => createHash('sha256').update(await fs.readFile(new URL(`./spikes/${name}`, import.meta.url))).digest('hex');
const CANDIDATE = { wrapper: await fileSha256('live-sessions-sandbox.mjs'),
    backend: await fileSha256('live-sessions-probe-claude.mjs'), owner: await fileSha256('live-sessions-owner.mjs'),
    toolcache: await fileSha256('live-sessions-toolcache.mjs') };
const GENERATION = name => `/data/tool-cache/${name}/generations/${createHash('sha256').update(name).digest('hex')}`;
const REVISIONS = { ploinky: '3a4b882b4616366665d6bd21c14801ecd48b7aee', AssistOSExplorer: '61b90f512ddecb2bea1e8fa2d0c3961bfbd1c929',
    AchillesCLI: 'ef57087cf645df0e905454e69fc841ebfc4c44bc', AdvancedLanguageAgent: '0ef0a85d821fb5d492537792a18007a739bfc2cc' };
const SERVICE_NAMESPACE = 'mnt:[4026532871]';
const SHM_DEVICE = '0:29';
const cleanCheckout = async () => ({ revision: REVISIONS.AssistOSExplorer, dirty: false, source: 'git' });
const assemble = (root, options = {}) => assembleEvidence(root, { readCheckout: cleanCheckout, ...options });
const git = (directory, ...args) => execFileSync('git', ['-C', directory, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ls-spike-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, socketPath: path.join(root, 'private', 'registry.sock') };
}

test('production entrypoints carry no diagnostic hook, flag or test import; commands are preserved', async () => {
    for (const name of ['main', 'robot-cli']) {
        const source = await fs.readFile(new URL(`../server/${name}.mjs`, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /ROBOTEAM_LIVE_SESSIONS_SPIKE/u, name);
        assert.doesNotMatch(source, /tests\//u, name);
    }
    const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url)));
    assert.equal(manifest.agent, 'exec sh /code/scripts/startAgent.sh');
    assert.equal(manifest.cli, 'node /code/server/robot-cli.mjs');
    assert.equal(JSON.stringify(manifest).includes('ROBOTEAM_LIVE_SESSIONS_SPIKE'), false);
    assert.deepEqual(SOCKET_PATHS, ['/dev/shm/roboteam-live/registry.sock']);
});

test('private listener accepts a fresh challenge and cleans up its exact identities', async t => {
    const { socketPath } = await fixture(t);
    const listener = await listenProbe(socketPath, identity);
    try {
        assert.equal((await fs.stat(path.dirname(socketPath))).mode & 0o777, 0o700);
        assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
        const observed = await connectProbe(socketPath, identity, listener.incarnationDigest);
        assert.equal(observed.service.pid, process.pid);
        assert.equal(observed.client.pid, process.pid);
        assert.equal(observed.incarnationDigest, listener.incarnationDigest);
        await assert.rejects(listenProbe(socketPath, identity), { code: 'EEXIST' });
        await assert.rejects(connectProbe(socketPath, identity, '0'.repeat(64)), /incarnation/);
        await assert.rejects(connectProbe(socketPath, { ...identity, uid: identity.uid + 1 }), /identity/);
    } finally { await listener.close(); }
    await assert.rejects(fs.lstat(path.dirname(socketPath)), { code: 'ENOENT' });
});

test('preexisting directory and symlink are refused without adoption or unlink', async t => {
    const { root, socketPath } = await fixture(t);
    const directory = path.dirname(socketPath);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'sentinel'), 'preserve');
    await assert.rejects(listenProbe(socketPath, identity), { code: 'EEXIST' });
    assert.equal(await fs.readFile(path.join(directory, 'sentinel'), 'utf8'), 'preserve');
    await fs.symlink(directory, path.join(root, 'alias'));
    await assert.rejects(listenProbe(path.join(root, 'alias', 'registry.sock'), identity), { code: 'EEXIST' });
    assert.ok((await fs.lstat(path.join(root, 'alias'))).isSymbolicLink());
});

test('malformed and oversized clients leave the listener available', async t => {
    const { socketPath } = await fixture(t);
    const listener = await listenProbe(socketPath, identity);
    try {
        for (const message of ['not-json\n', 'x'.repeat(4097), '{}\n', '{}\n{}\n']) {
            const socket = net.connect(socketPath);
            socket.on('error', () => {});
            const closed = once(socket, 'close');
            socket.write(message);
            await closed;
            assert.equal((await connectProbe(socketPath, identity)).service.pid, identity.pid);
        }
    } finally { await listener.close(); }
});

test('client rejects a response for another challenge', async t => {
    const { socketPath } = await fixture(t);
    await fs.mkdir(path.dirname(socketPath));
    const server = net.createServer(socket => socket.once('data', () => socket.end(JSON.stringify({
        version: 1, challenge: '0'.repeat(64), incarnation: '1'.repeat(64), ...identity,
    }) + '\n')));
    await new Promise(resolve => server.listen(socketPath, resolve));
    try { await assert.rejects(connectProbe(socketPath, identity), /challenge/); }
    finally { await new Promise(resolve => server.close(resolve)); }
});

test('a stalled client is closed at the five-second deadline', { timeout: 7000 }, async t => {
    const { socketPath } = await fixture(t);
    const listener = await listenProbe(socketPath, identity);
    try {
        const socket = net.connect(socketPath);
        const closed = once(socket, 'close');
        socket.write('{');
        await closed;
        assert.equal((await connectProbe(socketPath, identity)).service.pid, identity.pid);
    } finally { await listener.close(); }
});

test('cleanup refuses replacement identities without deleting them', async t => {
    const { socketPath } = await fixture(t);
    const listener = await listenProbe(socketPath, identity);
    const moved = path.dirname(socketPath) + '-moved';
    await fs.rename(path.dirname(socketPath), moved);
    await fs.mkdir(path.dirname(socketPath));
    await fs.writeFile(socketPath, 'replacement');
    await assert.rejects(listener.close(), /changed identity/);
    assert.equal(await fs.readFile(socketPath, 'utf8'), 'replacement');
    await fs.unlink(socketPath);
    await fs.rmdir(path.dirname(socketPath));
    await fs.rename(moved, path.dirname(socketPath));
    await listener.close();
});

test('actual grant capture excludes environment values and discovers bind aliases by mount identity', () => {
    const grants = captureGrants(['--ro-bind', '/workspace', '/workspace', '--bind', '/data', '/robot-data',
        '--dev', '/dev', '--tmpfs', '/tmp', '--setenv', 'CREDENTIAL', 'never-record-this', '--', '/usr/bin/node']);
    assert.equal(JSON.stringify(grants).includes('never-record-this'), false);
    assert.equal(grants[0].permission, 'ro');
    assert.equal(grants[1].permission, 'rw');
    const mounts = parseMountInfo('1 0 0:1 / / rw - overlay overlay rw\n'
        + '2 1 0:2 / /dev/shm rw - tmpfs shm rw\n'
        + '3 1 0:2 / /data rw - tmpfs shm rw\n'
        + '4 1 0:2 / /workspace/.data/roboTeamAgent rw - tmpfs shm rw\n');
    assert.deepEqual(aliasesFor('/dev/shm/roboteam-live/registry.sock', grants, mounts, value => value),
        ['/dev/shm/roboteam-live/registry.sock', '/robot-data/roboteam-live/registry.sock',
            '/workspace/.data/roboTeamAgent/roboteam-live/registry.sock']);
    assert.throws(() => captureGrants(['--', '/usr/bin/node']), /actual ALA/);
});

test('missing runtime evidence never creates a passing artifact', async t => {
    const { root } = await fixture(t);
    await assert.rejects(assembleEvidence(root), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(root, 'p3-spike.txt')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(root, 'p3-spike.json')), { code: 'ENOENT' });
});

function completeEvidence() {
    const hash = 'a'.repeat(64);
    const service = SOCKET_PATHS.map(socketPath => ({ kind: 'service-ready', socketPath,
        pid: 77, uid: 0, mountNamespace: SERVICE_NAMESPACE, incarnationDigest: hash }));
    const controls = challengeDigest => service.map(entry => ({ kind: 'cli-connected', socketPath: entry.socketPath,
        service: { pid: entry.pid }, client: { pid: 78, uid: entry.uid, mountNamespace: entry.mountNamespace },
        incarnationDigest: entry.incarnationDigest, challengeDigest }));
    const before = controls(hash);
    const after = controls('b'.repeat(64));
    const owner = { kind: 'owner-spike', status: 'passed', ploinky: { revision: REVISIONS.ploinky, dirty: false },
        ploinkyAfter: { revision: REVISIONS.ploinky, dirty: false },
        harnessSha256: CANDIDATE.owner, checks: ['real-router-serializer-minter', 'raw-hash', 'wrong-tuple', 'jti-replay',
            'text', 'presentation', 'tool', 'audience', 'expiry', 'receive-preparation-delay'],
        started: [{ admittedAt: 1, expiresAt: 2, startedAt: 3 }] };
    const bind = (source, target, permission = 'ro') => ({ source, target, permission, kind: 'bind' });
    const grants = [bind('/usr', '/usr'), bind('/etc', '/etc'), { kind: 'symlink', source: 'usr/bin', target: '/bin', permission: 'link' },
        { kind: 'proc', target: '/proc', permission: 'private' }, { kind: 'dev', target: '/dev', permission: 'private' },
        { kind: 'tmpfs', target: '/tmp', permission: 'private' },
        bind('/data/robots/p3/home', '/home/ala', 'rw'), bind('/code/tests/spikes', '/code/tests/spikes'),
        bind('/workspace/p3-sandbox', '/workspace', 'rw'),
        bind('/data/robots/p3/sessions/s1/skills', '/workspace/.agents/skills'),
        bind('/tmp/ploinky-runtime-x', '/workspace/ploinky-runtime'), bind('/tmp/human-input-x', '/workspace/roboflow-human-input', 'rw'),
        bind('/tmp/task-failure-x', '/workspace/roboteam-task-failure', 'rw'), bind('/code/copilot/src/skills/report-task-blocked', '/workspace/report-task-blocked')];
    const mount = (id, device, root, target, type) => ({ id: String(id), parent: '400', device, root, target, options: 'ro', type });
    const mounts = [mount(401, '0:61', '/', '/', 'tmpfs'), mount(402, '0:48', '/usr', '/usr', 'overlay'),
        mount(403, '0:62', '/', '/dev', 'tmpfs'), mount(404, '0:22', '/null', '/dev/null', 'devtmpfs'),
        mount(405, '0:63', '/', '/tmp', 'tmpfs'), mount(406, '0:48', '/workspace/p3-sandbox', '/workspace', 'overlay')];
    return {
        'runtime-pins.json': { workspace: path.join(os.homedir(), 'work', 'testExplorerFresh'), branch: 'live-sessions',
            revisions: { ...REVISIONS },
            images: Object.fromEntries(['box', 'roboTeam'].map(name => [name, { digest: `sha256:${hash}`, id: `sha256:${hash}` }])),
            containers: { box: hash, roboTeam: hash }, candidateManifestSha256: hash, readinessEvidenceSha256: hash },
        'service-probe.json': service, 'cli-before.json': before, 'cli-after.json': after,
        'owner-result.json': owner,
        'sandbox-result.json': { kind: 'sandbox-spike', status: 'passed', before, after, backendSha256: CANDIDATE.backend,
            plan: { version: 1, kind: 'actual-bwrap-spawn', capturePid: 90, grants, wrapperSha256: CANDIDATE.wrapper,
                sockets: SOCKET_PATHS.map(socketPath => ({ socketPath, realpath: socketPath, aliases: [socketPath] })) },
            observed: { kind: 'sandbox-socket-probe', pid: 2, uid: 0, mountNamespace: 'mnt:[4026533104]', cwd: '/workspace', mounts,
                results: SOCKET_PATHS.map(socketPath => ({ path: socketPath, error: 'ENOENT' })) },
            socketDevices: SOCKET_PATHS.map(socketPath => ({ socketPath, realpath: socketPath, device: SHM_DEVICE,
                file: '/roboteam-live/registry.sock', statDevice: SHM_DEVICE })) },
        'toolcache-result.json': { kind: 'toolcache-probe', status: 'observed', collectorSha256: CANDIDATE.toolcache,
            mountNamespace: SERVICE_NAMESPACE, cacheRoot: '/data/tool-cache', mountinfoEntries: 31, cacheMounts: [],
            ala: { packageRoot: '/Agent/linked/AdvancedLanguageAgent', sandboxSha256: hash },
            agents: ['claude', 'codex'].map(name => ({ name, binary: `${GENERATION(name)}/bin/${name}`,
                realpath: `${GENERATION(name)}/lib/node_modules/${name}/cli.js`, generation: GENERATION(name), runtimeMounts: [GENERATION(name)] })) },
        'commands.json': Array.from({ length: 5 }, () => ({ command: 'diagnostic fixture', exitCode: 0 })),
    };
}

async function writeEvidence(root, files) {
    for (const [name, value] of Object.entries(files)) await fs.writeFile(path.join(root, name), JSON.stringify(value));
}

test('standalone sandbox verifier accepts distinct realpath and derived aliases only when all are probed', async () => {
    const { verifySandboxRecord } = await spike('sandbox');
    const record = completeEvidence()['sandbox-result.json'];
    const socket = record.plan.sockets[0];
    socket.realpath = '/run/roboteam-live/registry.sock';
    socket.aliases.push(socket.realpath, '/workspace/socket-alias/registry.sock');
    record.observed.results = socket.aliases.map(alias => ({ path: alias, error: 'ENOENT' }));
    assert.doesNotThrow(() => verifySandboxRecord(record, SERVICE_NAMESPACE));
    record.observed.results.pop();
    assert.throws(() => verifySandboxRecord(record, SERVICE_NAMESPACE), { code: 'ERR_ASSERTION' });
});

test('standalone sandbox verifier refuses incomplete socket sets and invalid aliases', async t => {
    const { verifySandboxRecord } = await spike('sandbox');
    const cases = [
        ['missing socket', record => { record.plan.sockets = []; }],
        ['foreign socket', record => { record.plan.sockets[0].socketPath = '/other/registry.sock'; }],
        ['duplicate socket', record => { record.plan.sockets.push(structuredClone(record.plan.sockets[0])); }],
        ['empty aliases', record => { record.plan.sockets[0].aliases = []; }],
        ['unrelated aliases', record => { record.plan.sockets[0].aliases = ['/elsewhere/registry.sock']; }],
        ['missing distinct realpath alias', record => { record.plan.sockets[0].realpath = '/run/roboteam-live/registry.sock'; }],
        ['missing aliases', record => { delete record.plan.sockets[0].aliases; }],
        ['duplicate alias', record => { record.plan.sockets[0].aliases.push(record.plan.sockets[0].socketPath); }],
        ['relative alias', record => { record.plan.sockets[0].aliases.push('relative.sock'); }],
        ['non-string alias', record => { record.plan.sockets[0].aliases.push(null); }],
        ['empty realpath', record => { record.plan.sockets[0].realpath = ''; }],
        ['relative realpath', record => { record.plan.sockets[0].realpath = 'relative.sock'; }],
        ['non-string realpath', record => { record.plan.sockets[0].realpath = null; }],
    ];
    for (const [name, change] of cases) await t.test(name, () => {
        const record = completeEvidence()['sandbox-result.json'];
        change(record);
        // Keep the observations consistent with the supplied aliases so only
        // the verifier's socket-set and alias validation can reject the record.
        const aliases = [...new Set(record.plan.sockets.flatMap(socket => socket.aliases))];
        record.observed.results = aliases.map(alias => ({ path: alias, error: 'ENOENT' }));
        assert.throws(() => verifySandboxRecord(record, SERVICE_NAMESPACE), { code: 'ERR_ASSERTION' });
    });
});

test('owner evidence without the wrong-tuple control cannot produce passing artifacts', async t => {
    const { root } = await fixture(t);
    const files = completeEvidence();
    const owner = files['owner-result.json'];
    owner.checks = owner.checks.filter(check => check !== 'wrong-tuple');
    await writeEvidence(root, files);
    await assert.rejects(assemble(root), /wrong-tuple/);
    await assert.rejects(fs.lstat(path.join(root, 'p3-spike.txt')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(root, 'p3-spike.json')), { code: 'ENOENT' });
    owner.checks.push('wrong-tuple');
    await fs.writeFile(path.join(root, 'owner-result.json'), JSON.stringify(owner));
    const correctWorkspace = files['runtime-pins.json'].workspace;
    files['runtime-pins.json'].workspace = path.join(os.homedir(), 'work', 'different-workspace');
    await fs.writeFile(path.join(root, 'runtime-pins.json'), JSON.stringify(files['runtime-pins.json']));
    await assert.rejects(assemble(root), { code: 'ERR_ASSERTION' });
    await assert.rejects(fs.lstat(path.join(root, 'p3-spike.json')), { code: 'ENOENT' });
    files['runtime-pins.json'].workspace = correctWorkspace;
    await fs.writeFile(path.join(root, 'runtime-pins.json'), JSON.stringify(files['runtime-pins.json']));
    const manifest = await assemble(root);
    assert.equal(manifest.checks.realRouterOwnerProbe, true);
    assert.equal(manifest.selectedSocketPath, '/dev/shm/roboteam-live/registry.sock');
});

test('selected socket evidence refuses incomplete or substituted identity and alias records', async t => {
    const cases = [
        ['missing primary', files => { files['sandbox-result.json'].plan.sockets = []; }],
        ['foreign primary', files => { files['sandbox-result.json'].plan.sockets[0].socketPath = '/run/roboteam-live/registry.sock'; }],
        ['duplicate primary', files => { files['sandbox-result.json'].plan.sockets.push(structuredClone(files['sandbox-result.json'].plan.sockets[0])); }],
        ['missing direct alias', files => {
            files['sandbox-result.json'].plan.sockets[0].aliases = ['/elsewhere/registry.sock'];
            files['sandbox-result.json'].observed.results[0].path = '/elsewhere/registry.sock';
        }],
        ['missing realpath alias', files => { files['sandbox-result.json'].plan.sockets[0].realpath = '/elsewhere/registry.sock'; }],
        ['missing alias result', files => { files['sandbox-result.json'].observed.results = []; }],
        ['unprobed derived alias', files => { files['sandbox-result.json'].plan.sockets[0].aliases.push('/workspace/alias/registry.sock'); }],
        ['non-ENOENT', files => { files['sandbox-result.json'].observed.results[0].error = 'EACCES'; }],
        ['missing service', files => { files['service-probe.json'] = []; }],
        ['missing CLI before', files => { files['cli-before.json'] = []; }],
        ['missing CLI after', files => { files['cli-after.json'] = []; }],
        ['duplicate CLI', files => { files['cli-before.json'].push(structuredClone(files['cli-before.json'][0])); }],
        ['incarnation mismatch', files => { files['cli-after.json'][0].incarnationDigest = 'c'.repeat(64); }],
    ];
    for (const [name, change] of cases) await t.test(name, async child => {
        const { root } = await fixture(child);
        const files = completeEvidence();
        change(files);
        await writeEvidence(root, files);
        await assert.rejects(assemble(root), { code: 'ERR_ASSERTION' });
        await assert.rejects(fs.lstat(path.join(root, 'p3-spike.txt')), { code: 'ENOENT' });
        await assert.rejects(fs.lstat(path.join(root, 'p3-spike.json')), { code: 'ENOENT' });
    });
});

async function refuses(child, files, options, reason) {
    const { root } = await fixture(child);
    await writeEvidence(root, files);
    await assert.rejects(assemble(root, options), error => error.code === 'ERR_ASSERTION' && reason.test(error.message));
    await assert.rejects(fs.lstat(path.join(root, 'p3-spike.txt')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(root, 'p3-spike.json')), { code: 'ENOENT' });
}

test('assembler re-verifies the sandbox record, provenance and owner source instead of trusting status', async t => {
    const sandbox = files => files['sandbox-result.json'];
    const toolcache = files => files['toolcache-result.json'];
    const claudeMounts = sources => files => { toolcache(files).agents.find(agent => agent.name === 'claude').runtimeMounts = sources; };
    const shmMount = root => files => { sandbox(files).observed.mounts.push({ id: '499', parent: '401', device: SHM_DEVICE,
        root, target: '/run/exposed', options: 'rw', type: 'tmpfs' }); };
    const cases = [
        ['wrong plan kind', files => { sandbox(files).plan.kind = 'synthetic-plan'; }, /actual bwrap spawn/],
        ...['ploinky-runtime', 'roboflow-human-input', 'roboteam-task-failure', 'report-task-blocked'].map(name => [`missing ${name} grant`,
            files => { sandbox(files).plan.grants = sandbox(files).plan.grants.filter(grant => grant.target !== `/workspace/${name}`); },
            new RegExp(`Missing production /workspace/${name} grant`)]),
        ['missing skill overlay grant', files => { sandbox(files).plan.grants = sandbox(files).plan.grants.filter(grant => !grant.target.endsWith('/.agents/skills')); }, /skill overlay/],
        ['production grant only as tmpfs', files => { sandbox(files).plan.grants.find(grant => grant.target === '/workspace/ploinky-runtime').kind = 'tmpfs'; }, /ploinky-runtime grant/],
        ['missing grants', files => { delete sandbox(files).plan.grants; }, /grants are required/],
        ['wrong observation kind', files => { sandbox(files).observed.kind = 'synthetic-probe'; }, /diagnostic backend/],
        ['malformed sandbox namespace', files => { sandbox(files).observed.mountNamespace = '4026533104'; }, /Sandbox mount namespace is required/],
        ['same mount namespace', files => { sandbox(files).observed.mountNamespace = SERVICE_NAMESPACE; }, /distinct mount namespace/],
        ['wrong sandbox record kind', files => { sandbox(files).kind = 'other'; }, /come from the sandbox harness/],
        ['wrong owner record kind', files => { files['owner-result.json'].kind = 'other'; }, /come from the owner probe/],
        ['harness hash mismatch', files => { sandbox(files).plan.wrapperSha256 = 'f'.repeat(64); }, /candidate harness/],
        ['backend hash mismatch', files => { sandbox(files).backendSha256 = 'f'.repeat(64); }, /candidate fixture/],
        ['owner harness hash mismatch', files => { files['owner-result.json'].harnessSha256 = 'f'.repeat(64); }, /Owner probe must be the candidate/],
        ['Ploinky revision mismatch', files => { files['owner-result.json'].ploinky.revision = 'f'.repeat(40); }, /pinned Ploinky revision/],
        ['Ploinky source dirty', files => { files['owner-result.json'].ploinky.dirty = true; }, /Ploinky source must be clean/],
        ['Ploinky dirty state missing', files => { delete files['owner-result.json'].ploinky.dirty; }, /Ploinky source must be clean/],
        ['Ploinky revision missing', files => { delete files['owner-result.json'].ploinky; }, /pinned Ploinky revision/],
        ['Ploinky revision changed during the probe', files => { files['owner-result.json'].ploinkyAfter.revision = 'f'.repeat(40); }, /must not change during the probe/],
        ['Ploinky end state missing', files => { delete files['owner-result.json'].ploinkyAfter; }, /must not change during the probe/],
        ['Explorer revision mismatch', () => ({ readCheckout: async () => ({ revision: 'f'.repeat(40), dirty: false, source: 'git' }) }), /pinned Explorer revision/],
        ['retired Achilles checkout revision', () => ({ readCheckout: async () => ({ revision: REVISIONS.AchillesCLI, dirty: false, source: 'git' }) }), /pinned Explorer revision/],
        ['Explorer spike files dirty', () => ({ readCheckout: async () => ({ revision: REVISIONS.AssistOSExplorer, dirty: true, source: 'git' }) }), /spike files must be unmodified/],
        ['shm device mounted at its root', shmMount('/'), /expose the socket filesystem/],
        ['shm device mounted at the socket directory', shmMount('/roboteam-live'), /expose the socket filesystem/],
        ['shm device mounted at the socket file', shmMount('/roboteam-live/registry.sock'), /expose the socket filesystem/],
        ['empty sandbox mountinfo', files => { sandbox(files).observed.mounts = []; }, /mountinfo must be observed/],
        ['missing sandbox mountinfo', files => { delete sandbox(files).observed.mounts; }, /mountinfo must be observed/],
        ['malformed sandbox mount device', files => { sandbox(files).observed.mounts[0].device = 'shm'; }, /entries must be complete/],
        ['missing sandbox root mount', files => { sandbox(files).observed.mounts = sandbox(files).observed.mounts.filter(mount => mount.target !== '/'); }, /include its root mount/],
        ['missing socket device', files => { delete sandbox(files).socketDevices; }, /device identities are required/],
        ['malformed socket device', files => { Object.assign(sandbox(files).socketDevices[0], { device: 'shm', statDevice: 'shm' }); }, /Socket device is required/],
        ['socket device stat disagreement', files => { sandbox(files).socketDevices[0].statDevice = '0:30'; }, /stat devices must agree/],
        ['substituted socket device path', files => { sandbox(files).socketDevices[0].socketPath = '/run/roboteam-live/registry.sock'; }, /exactly the selected socket set/],
        ['tool cache unavailable', files => { Object.assign(toolcache(files), { status: 'unavailable', agents: [] }); delete toolcache(files).ala; }, /Tool-cache state must be observed/],
        ['tool-cache collector hash mismatch', files => { toolcache(files).collectorSha256 = 'f'.repeat(64); }, /collector must be the candidate/],
        ['wrong tool-cache record kind', files => { toolcache(files).kind = 'other'; }, /must come from the collector/],
        ['tool cache in another namespace', files => { toolcache(files).mountNamespace = 'mnt:[4026533999]'; }, /service mount namespace/],
        ['runtime mount equal to /dev/shm', claudeMounts(['/dev/shm']), /must not equal or contain \/dev\/shm/],
        ['runtime mount equal to /data', claudeMounts(['/data']), /must not equal or contain \/data/],
        ['runtime mount equal to /', claudeMounts(['/']), /must not equal or contain \//],
        ['runtime mount outside generations', claudeMounts(['/usr/local/lib/claude']), /inside its tool-cache generation/],
        ['runtime mount in the cache root', claudeMounts(['/data/tool-cache']), /inside its tool-cache generation/],
        ['runtime mount in another agent generation', claudeMounts([GENERATION('codex')]), /inside its tool-cache generation/],
        ['runtime mount not normalized', claudeMounts([`${GENERATION('claude')}/../../../..`]), /normalized absolute path/],
        ['no runtime mounts', claudeMounts([]), /runtime mounts must be observed/],
        ['claude not observed', files => { toolcache(files).agents = toolcache(files).agents.filter(agent => agent.name !== 'claude'); }, /Claude runtime mounts/],
        ['generation is not a cache generation', files => { toolcache(files).agents[0].generation = '/data/tool-cache/claude/current'; }, /resolve to a tool-cache generation/],
        ['executable outside its generation', files => { toolcache(files).agents[0].realpath = '/usr/bin/claude'; }, /executable must resolve inside/],
        ['mount under the tool cache', files => { toolcache(files).cacheMounts.push({ id: '77', device: '0:29', root: '/', target: '/data/tool-cache/claude', type: 'tmpfs' }); }, /Nothing may be mounted/],
        ['collector mountinfo empty', files => { toolcache(files).mountinfoEntries = 0; }, /Collector mountinfo must be observed/],
    ];
    for (const [name, change, reason] of cases) await t.test(name, async child => {
        const files = completeEvidence();
        const options = change(files) || {};
        await refuses(child, files, options, reason);
    });
});

test('fresh tmpfs devices and unrelated shm roots still produce evidence', async t => {
    const { root } = await fixture(t);
    const files = completeEvidence();
    files['sandbox-result.json'].observed.mounts.push({ id: '498', parent: '401', device: SHM_DEVICE,
        root: '/unrelated', target: '/run/other', options: 'rw', type: 'tmpfs' });
    await writeEvidence(root, files);
    const manifest = await assemble(root);
    assert.equal(manifest.assemblerCheckout.revision, REVISIONS.AssistOSExplorer);
    assert.deepEqual(manifest.candidateSha256, CANDIDATE);
    assert.equal(manifest.checks.socketDeviceUnexposed, true);
    assert.match(await fs.readFile(path.join(root, 'p3-spike.txt'), 'utf8'), /clean Ploinky 3a4b882b/);
});

test('default checkout reader binds the real repository revision', async t => {
    const { readCheckout } = await spike('evidence');
    const spikes = fileURLToPath(new URL('./spikes/', import.meta.url));
    const head = git(spikes, 'rev-parse', 'HEAD');
    const observed = await readCheckout(spikes);
    assert.equal(observed.revision, head);
    assert.equal(observed.source, 'git');
    assert.equal(typeof observed.dirty, 'boolean');
    await assert.rejects(readCheckout(spikes, { explicitRevision: 'f'.repeat(40) }), { code: 'ERR_ASSERTION' });
    const { root } = await fixture(t);
    await assert.rejects(readCheckout(root), /supply the checkout revision/);
    assert.deepEqual(await readCheckout(root, { explicitRevision: head }), { revision: head, dirty: null, source: 'explicit' });
    const files = completeEvidence();
    files['runtime-pins.json'].revisions.AssistOSExplorer = 'f'.repeat(40);
    await writeEvidence(root, files);
    await assert.rejects(assembleEvidence(root), { code: 'ERR_ASSERTION' });
    await assert.rejects(fs.lstat(path.join(root, 'p3-spike.json')), { code: 'ENOENT' });
});

test('owner source revision requires a repository root and reports tracked changes', async t => {
    const { sourceRevision } = await spike('owner');
    const { root } = await fixture(t);
    assert.throws(() => sourceRevision(root));
    git(root, 'init', '-q');
    await fs.writeFile(path.join(root, 'tracked.js'), 'export {};\n');
    git(root, 'add', 'tracked.js');
    git(root, 'commit', '-q', '-m', 'fixture');
    const revision = git(root, 'rev-parse', 'HEAD');
    assert.deepEqual(sourceRevision(root), { revision, dirty: false });
    await fs.writeFile(path.join(root, 'untracked.js'), 'export {};\n');
    assert.deepEqual(sourceRevision(root), { revision, dirty: false });
    await fs.writeFile(path.join(root, 'tracked.js'), 'export const changed = true;\n');
    assert.deepEqual(sourceRevision(root), { revision, dirty: true });
    await fs.mkdir(path.join(root, 'nested'));
    assert.throws(() => sourceRevision(path.join(root, 'nested')), { code: 'ERR_ASSERTION' });
});

test('socket device coordinates detect shared filesystems, stacked and non-root shm mounts', async () => {
    const { mountCoordinate, socketDeviceExposures, linuxDevice } = await spike('sandbox');
    assert.equal(linuxDevice(29n), '0:29');
    assert.equal(linuxDevice(2049n), '8:1');
    assert.equal(linuxDevice(66307n), '259:3');
    assert.equal(linuxDevice(1048620n), '0:300');
    const service = parseMountInfo('1 0 0:40 / / rw - overlay overlay rw\n'
        + '2 1 0:5 /containers/abc/shm /dev/shm rw - tmpfs shm rw\n'
        + '3 2 0:29 / /dev/shm rw - tmpfs shm rw\n');
    const socket = { socketPath: SOCKET_PATHS[0], ...mountCoordinate(SOCKET_PATHS[0], service) };
    assert.deepEqual([socket.device, socket.file], ['0:29', '/roboteam-live/registry.sock']);
    const podman = { socketPath: SOCKET_PATHS[0], ...mountCoordinate(SOCKET_PATHS[0], service.slice(0, 2)) };
    assert.deepEqual([podman.device, podman.file], ['0:5', '/containers/abc/shm/roboteam-live/registry.sock']);
    assert.throws(() => mountCoordinate('/dev/shm/x', []), { code: 'ERR_ASSERTION' });
    const entry = (device, root) => ({ device, root, target: '/mnt' });
    assert.deepEqual(socketDeviceExposures([entry('0:62', '/'), entry('0:5', '/containers/abc/other')], [podman]), []);
    for (const root of ['/', '/containers', '/containers/abc/shm', '/containers/abc/shm/roboteam-live',
        '/containers/abc/shm/roboteam-live/registry.sock']) {
        assert.equal(socketDeviceExposures([entry('0:5', root)], [podman]).length, 1, root);
    }
    const spaced = { device: '0:7', file: '/a b/registry.sock' };
    assert.equal(socketDeviceExposures([entry('0:7', '/a\\040b')], [spaced]).length, 1);
});

test('a missing tool-cache record produces no evidence', async t => {
    const { root } = await fixture(t);
    const files = completeEvidence();
    delete files['toolcache-result.json'];
    await writeEvidence(root, files);
    await assert.rejects(assemble(root), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(root, 'p3-spike.txt')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(root, 'p3-spike.json')), { code: 'ENOENT' });
});

test('tool-cache collector peeks without preparing and records the production binary path', async t => {
    const { collectToolCache, verifyToolCacheRecord } = await spike('toolcache');
    const { root } = await fixture(t);
    const generation = path.join(root, 'claude', 'generations', 'a'.repeat(64));
    await fs.mkdir(path.join(generation, 'bin'), { recursive: true });
    await fs.writeFile(path.join(generation, 'bin', 'claude'), '');
    const mountinfo = '1 0 0:40 / / rw - overlay overlay rw\n2 1 0:41 / /data rw - ext4 /dev/vda rw\n';
    const seen = [];
    const toolCache = { root: '/data/tool-cache', peeked: 0, async peekShellTools() { this.peeked++; return { agents: { claude: { path: generation, binPath: path.join(generation, 'bin') } } }; },
        prepareShellTools() { throw new Error('collector must not prepare tools'); } };
    const record = await collectToolCache({ mountinfo, mountNamespace: SERVICE_NAMESPACE, toolCache,
        runtimeMounts: binary => { seen.push(binary); return [generation]; } });
    assert.equal(toolCache.peeked, 1);
    assert.deepEqual(seen, [path.join(generation, 'bin', 'claude')]);
    assert.equal(record.status, 'observed');
    assert.deepEqual(record.cacheMounts, []);
    assert.equal(record.collectorSha256, CANDIDATE.toolcache);
    assert.deepEqual(record.agents[0], { name: 'claude', binary: path.join(generation, 'bin', 'claude'),
        realpath: path.join(generation, 'bin', 'claude'), generation, runtimeMounts: [generation] });
    // A temporary generation is not the production cache path, so it is refused.
    assert.throws(() => verifyToolCacheRecord(record), /tool-cache generation/);
    const mounted = await collectToolCache({ mountinfo: mountinfo + '3 2 0:42 / /data/tool-cache/claude rw - tmpfs tmpfs rw\n',
        mountNamespace: SERVICE_NAMESPACE, toolCache: { root: '/data/tool-cache', async peekShellTools() { return null; } } });
    assert.equal(mounted.status, 'unavailable');
    assert.deepEqual(mounted.cacheMounts.map(mount => mount.target), ['/data/tool-cache/claude']);
    assert.throws(() => verifyToolCacheRecord(mounted), /must be observed/);
});

test('assembler checkout provenance through the real git reader', async t => {
    const { readCheckout } = await spike('evidence');
    const { root: checkout } = await fixture(t);
    const through = directory => (_, options) => readCheckout(directory, options);
    const run = async (directory, revision, options = {}) => {
        const { root } = await fixture(t);
        const files = completeEvidence();
        files['runtime-pins.json'].revisions.AssistOSExplorer = revision;
        await writeEvidence(root, files);
        return { root, result: assembleEvidence(root, { readCheckout: through(directory), ...options }) };
    };
    // Provably outside any repository: only an operator-asserted revision passes, and says so.
    const noRevision = await run(checkout, REVISIONS.AssistOSExplorer);
    await assert.rejects(noRevision.result, /supply the checkout revision/);
    const explicit = await run(checkout, REVISIONS.AssistOSExplorer, { explicitRevision: REVISIONS.AssistOSExplorer });
    const manifest = await explicit.result;
    assert.deepEqual(manifest.assemblerCheckout, { revision: REVISIONS.AssistOSExplorer, source: 'explicit' });
    assert.match(await fs.readFile(path.join(explicit.root, 'p3-spike.txt'), 'utf8'), /operator-asserted and unverified/);
    // Any other git failure is refused even with an explicit revision.
    const broken = path.join(checkout, 'broken');
    await fs.mkdir(broken);
    await fs.writeFile(path.join(broken, '.git'), 'gitdir: /nonexistent/p3-fixture\n');
    const refused = await run(broken, REVISIONS.AssistOSExplorer, { explicitRevision: REVISIONS.AssistOSExplorer });
    await assert.rejects(refused.result, /Git could not verify the assembler checkout: fatal: not a git repository: /);
    await assert.rejects(fs.lstat(path.join(refused.root, 'p3-spike.txt')), { code: 'ENOENT' });
    // A real repository at the pinned revision with a modified tracked spike file is refused.
    const repository = path.join(checkout, 'repository');
    await fs.mkdir(repository);
    git(repository, 'init', '-q');
    await fs.writeFile(path.join(repository, 'live-sessions-evidence.mjs'), 'export {};\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '-q', '-m', 'fixture');
    const head = git(repository, 'rev-parse', 'HEAD');
    const clean = await run(repository, head);
    assert.equal((await clean.result).assemblerCheckout.source, 'git');
    await fs.writeFile(path.join(repository, 'live-sessions-evidence.mjs'), 'export const weakened = true;\n');
    const dirty = await run(repository, head);
    await assert.rejects(dirty.result, /spike files must be unmodified/);
    await assert.rejects(fs.lstat(path.join(dirty.root, 'p3-spike.json')), { code: 'ENOENT' });
});

// G2 trusted controls against the production IPC listener.
const production = () => import('./spikes/live-sessions-production-probe.mjs');
const NET_UNIX_HEADER = 'Num       RefCount Protocol Flags    Type St Inode Path';

async function fakeProc(root, socketPath, { inode = '4242', owners = [7001], namespace = 'mnt:[4026531840]', listening = true, uid = process.getuid() } = {}) {
    const proc = path.join(root, 'proc');
    await fs.mkdir(path.join(proc, 'net'), { recursive: true });
    await fs.writeFile(path.join(proc, 'net', 'unix'), [NET_UNIX_HEADER,
        `0000000000000000: 00000002 00000000 ${listening ? '00010000' : '00000000'} 0001 01 ${inode} ${socketPath}`,
        `0000000000000000: 00000002 00000000 00010000 0001 01 9999 /other/socket`, ''].join('\n'));
    for (const pid of owners) {
        await fs.mkdir(path.join(proc, String(pid), 'fd'), { recursive: true });
        await fs.mkdir(path.join(proc, String(pid), 'ns'), { recursive: true });
        await fs.symlink(`socket:[${inode}]`, path.join(proc, String(pid), 'fd', '7'));
        await fs.symlink('/dev/null', path.join(proc, String(pid), 'fd', '1'));
        await fs.symlink(namespace, path.join(proc, String(pid), 'ns', 'mnt'));
        await fs.writeFile(path.join(proc, String(pid), 'status'), `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    }
    await fs.mkdir(path.join(proc, 'self'));
    return proc;
}

test('production controls parse only the listening socket for the exact path', async () => {
    const { unixListenerInode } = await production();
    const text = [NET_UNIX_HEADER, '0: 00000002 00000000 00010000 0001 01 11 /dev/shm/roboteam-live/registry.sock',
        '0: 00000003 00000000 00000000 0001 03 12 /dev/shm/roboteam-live/registry.sock', '0: 00000002 00000000 00010000 0001 01 13 /x'].join('\n');
    assert.equal(unixListenerInode(text, '/dev/shm/roboteam-live/registry.sock'), '11');
    assert.throws(() => unixListenerInode(text, '/missing'), /Exactly one listening/);
    assert.throws(() => unixListenerInode(`${text}\n0: 00000002 00000000 00010000 0001 01 14 /x`, '/x'), /Exactly one listening/);
});

test('production controls identify the single owning process and refuse ambiguity', async t => {
    const { root } = await fixture(t);
    const { socketListenerProcess } = await production();
    const proc = await fakeProc(root, '/s', { owners: [7001] });
    assert.deepEqual(await socketListenerProcess('4242', { procRoot: proc }), { pid: 7001, uid: process.getuid(), mountNamespace: 'mnt:[4026531840]' });
    await assert.rejects(socketListenerProcess('5555', { procRoot: proc }), /Exactly one process/);
    const shared = await fakeProc(path.join(root, 'shared'), '/s', { owners: [7001, 7002] });
    await assert.rejects(socketListenerProcess('4242', { procRoot: shared }), /Exactly one process/);
});

test('production controls accept the real IPC listener, bind its incarnation and refuse every mismatch', async t => {
    const { root, socketPath } = await fixture(t);
    const { connectProductionProbe } = await production();
    const { LiveSessionsIpcServer } = await import('../server/live-sessions/ipc-server.mjs');
    const { LiveSessionsRegistry } = await import('../server/live-sessions/registry.mjs');
    const registry = new LiveSessionsRegistry();
    const server = new LiveSessionsIpcServer({ registry, log: () => {} });
    await server.listen(socketPath);
    try {
        const procRoot = await fakeProc(root, socketPath);
        const local = { pid: process.pid, uid: process.getuid(), mountNamespace: 'mnt:[4026531840]' };
        const before = await connectProductionProbe(socketPath, local, undefined, { procRoot });
        assert.equal(before.listener, 'production');
        assert.deepEqual(before.service, { pid: 7001, uid: process.getuid(), mountNamespace: 'mnt:[4026531840]' });
        const after = await connectProductionProbe(socketPath, local, before.incarnationDigest, { procRoot });
        assert.equal(after.incarnationDigest, before.incarnationDigest);
        assert.notEqual(after.challengeDigest, before.challengeDigest, 'each control is a fresh exchange');
        await assert.rejects(connectProductionProbe(socketPath, local, '0'.repeat(64), { procRoot }), /incarnation mismatch/);
        await assert.rejects(connectProductionProbe(socketPath, { ...local, mountNamespace: 'mnt:[1]' }, undefined, { procRoot }), /identity or protocol/);
        await assert.rejects(connectProductionProbe(socketPath, { ...local, uid: local.uid + 1 }, undefined, { procRoot }), /service user/);
        const notListening = await fakeProc(path.join(root, 'idle'), socketPath, { listening: false });
        await assert.rejects(connectProductionProbe(socketPath, local, undefined, { procRoot: notListening }), /Exactly one listening/);
        await fs.chmod(socketPath, 0o644);
        await assert.rejects(connectProductionProbe(socketPath, local, undefined, { procRoot }), /private/);
        await fs.chmod(socketPath, 0o600);
    } finally { await server.close(); registry.close(); }
});

test('production controls refuse a listener that does not speak the production protocol', async t => {
    const { root, socketPath } = await fixture(t);
    const { connectProductionProbe } = await production();
    const listener = await listenProbe(socketPath, identity);
    try {
        const procRoot = await fakeProc(root, socketPath, { namespace: identity.mountNamespace });
        await assert.rejects(connectProductionProbe(socketPath, identity, undefined, { procRoot }), /Production probe/);
    } finally { await listener.close(); }
});

test('production controls identify a real listener through the real /proc', { skip: process.platform !== 'linux' && 'needs Linux /proc' }, async t => {
    const { socketPath } = await fixture(t);
    const { connectProductionProbe } = await production();
    const { processIdentity } = await import('./spikes/live-sessions-process-probe.mjs');
    const { LiveSessionsIpcServer } = await import('../server/live-sessions/ipc-server.mjs');
    const { LiveSessionsRegistry } = await import('../server/live-sessions/registry.mjs');
    const registry = new LiveSessionsRegistry();
    const server = new LiveSessionsIpcServer({ registry, log: () => {} });
    await server.listen(socketPath);
    try {
        const local = await processIdentity();
        const before = await connectProductionProbe(socketPath, local);
        assert.equal(before.service.pid, process.pid);
        assert.equal(before.service.mountNamespace, local.mountNamespace);
        const after = await connectProductionProbe(socketPath, local, before.incarnationDigest);
        assert.equal(after.incarnationDigest, before.incarnationDigest);
    } finally { await server.close(); registry.close(); }
});

async function probeServer(t, socketPath, onConnection = () => {}) {
    await fs.mkdir(path.dirname(socketPath), { mode: 0o700 });
    const sockets = new Set();
    const server = net.createServer(async socket => {
        sockets.add(socket);
        socket.on('error', () => {});
        await onConnection();
        socket.end(`${JSON.stringify({ type: 'welcome', publisherId: 'p'.repeat(32), resumeToken: 'r'.repeat(32) })}\n`);
    });
    await new Promise(resolve => server.listen(socketPath, resolve));
    await fs.chmod(socketPath, 0o600);
    return { close: () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); } };
}

test('production controls refuse a replaced listener, a different owning process and a foreign process uid', async t => {
    const { root, socketPath } = await fixture(t);
    const { connectProductionProbe } = await production();
    const server = await probeServer(t, socketPath);
    try {
        const local = { pid: process.pid, uid: process.getuid(), mountNamespace: 'mnt:[4026531840]' };
        const before = await connectProductionProbe(socketPath, local, undefined, { procRoot: await fakeProc(path.join(root, 'a'), socketPath) });
        const otherInode = await fakeProc(path.join(root, 'b'), socketPath, { inode: '4343' });
        await assert.rejects(connectProductionProbe(socketPath, local, before.incarnationDigest, { procRoot: otherInode }), /incarnation mismatch/);
        const otherPid = await fakeProc(path.join(root, 'c'), socketPath, { owners: [7002] });
        await assert.rejects(connectProductionProbe(socketPath, local, before.incarnationDigest, { procRoot: otherPid }), /incarnation mismatch/);
        const foreignUid = await fakeProc(path.join(root, 'd'), socketPath, { uid: process.getuid() + 1 });
        await assert.rejects(connectProductionProbe(socketPath, local, undefined, { procRoot: foreignUid }), /identity or protocol/);
    } finally { await server.close(); }
});

test('production controls refuse a listener that changes during the exchange', async t => {
    const { root, socketPath } = await fixture(t);
    const { connectProductionProbe } = await production();
    const procRoot = await fakeProc(root, socketPath);
    const swapped = (await fs.readFile(path.join(procRoot, 'net', 'unix'), 'utf8')).replace(' 4242 ', ' 4343 ');
    const server = await probeServer(t, socketPath, async () => {
        await fs.writeFile(path.join(procRoot, 'net', 'unix'), swapped);
        await fs.symlink('socket:[4343]', path.join(procRoot, '7001', 'fd', '8'));
    });
    try {
        const local = { pid: process.pid, uid: process.getuid(), mountNamespace: 'mnt:[4026531840]' };
        await assert.rejects(connectProductionProbe(socketPath, local, undefined, { procRoot }), /changed during the exchange/);
    } finally { await server.close(); }
});

test('the sandbox harness requires an explicit listener mode', async () => {
    const harness = fileURLToPath(new URL('./spikes/live-sessions-sandbox.mjs', import.meta.url));
    for (const args of [['p3-spike-x', os.tmpdir()], ['p3-spike-x', os.tmpdir(), '--other'], ['p3-spike-x', os.tmpdir(), '--production', 'extra']]) {
        let failure;
        try { execFileSync(process.execPath, [harness, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (error) { failure = error; }
        assert.ok(failure, args.join(' '));
        assert.equal(failure.status, 1);
        const report = JSON.parse(String(failure.stderr).trim().split('\n').at(-1));
        assert.equal(report.code, 'ERR_ASSERTION');
        assert.ok(!report.frames.some(frame => frame.includes('runSandboxProbe')), 'refused as a usage error before any probe runs');
    }
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { SOCKET_PATHS } from './live-sessions-process-probe.mjs';
import { verifySandboxRecord } from './live-sessions-sandbox.mjs';
import { verifyToolCacheRecord } from './live-sessions-toolcache.mjs';

const SPIKE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
// Candidate files whose recorded runtime hashes must equal this checkout's copy.
export const CANDIDATE_FILES = Object.freeze({ wrapper: 'live-sessions-sandbox.mjs',
    backend: 'live-sessions-probe-claude.mjs', owner: 'live-sessions-owner.mjs', toolcache: 'live-sessions-toolcache.mjs' });
const REVISION = /^[a-f0-9]{40}$/;

export async function candidateHashes(directory = SPIKE_DIRECTORY) {
    const hashes = {};
    for (const [name, file] of Object.entries(CANDIDATE_FILES)) {
        hashes[name] = createHash('sha256').update(await fs.readFile(path.join(directory, file))).digest('hex');
    }
    return hashes;
}

// Revision of the checkout that holds this assembler. An explicit revision is
// accepted only when git is not installed or the directory is provably outside
// any repository; every other git failure is refused. It never overrides git.
export async function readCheckout(directory = SPIKE_DIRECTORY, { explicitRevision } = {}) {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), LC_ALL: 'C' };
    const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let observed;
    try {
        observed = { revision: git('rev-parse', 'HEAD'),
            dirty: git('status', '--porcelain', '--untracked-files=no', '--', '.') !== '', source: 'git' };
    } catch (error) {
        const stderr = String(error.stderr || '');
        const unavailable = error.code === 'ENOENT' || /^fatal: not a git repository \(or any of the parent directories\)/m.test(stderr);
        if (!unavailable) assert.fail(`Git could not verify the assembler checkout: ${stderr.trim().split('\n')[0] || error.code || error.message}`);
        assert.ok(typeof explicitRevision === 'string' && REVISION.test(explicitRevision),
            'Git is unavailable; supply the checkout revision explicitly');
        return { revision: explicitRevision, dirty: null, source: 'explicit' };
    }
    if (explicitRevision !== undefined) assert.equal(explicitRevision, observed.revision, 'Explicit revision differs from the git checkout');
    return observed;
}

function requireSocketSet(records, label) {
    assert.ok(Array.isArray(records), `${label} records are required`);
    assert.deepEqual(records.map(entry => entry?.socketPath).sort(), [...SOCKET_PATHS].sort(),
        `${label} must contain exactly the selected socket set`);
}

// Inputs are redacted JSON records only, never container logs, environment
// dumps, envelopes or credentials. Coordinator supplies checked identities.
// Tests may inject the checkout reader; the CLI accepts only an explicit revision.
export async function assembleEvidence(directory, { explicitRevision, readCheckout: reader = readCheckout } = {}) {
    const read = async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    const pins = await read('runtime-pins.json');
    assert.equal(pins.workspace, path.join(os.homedir(), 'work', 'testExplorerFresh'));
    assert.equal(pins.branch, 'live-sessions');
    for (const name of ['ploinky', 'AssistOSExplorer', 'AdvancedLanguageAgent']) {
        assert.match(pins.revisions?.[name], /^[a-f0-9]{40}$/);
    }
    for (const name of ['box', 'roboTeam']) {
        assert.match(pins.images?.[name]?.digest, /^sha256:[a-f0-9]{64}$/);
        assert.match(pins.images?.[name]?.id, /^sha256:[a-f0-9]{64}$/);
        assert.match(pins.containers?.[name], /^[a-f0-9]{64}$/);
    }
    assert.match(pins.candidateManifestSha256, /^[a-f0-9]{64}$/);
    assert.match(pins.readinessEvidenceSha256, /^[a-f0-9]{64}$/);
    const checkout = await reader(SPIKE_DIRECTORY, { explicitRevision });
    assert.equal(checkout?.revision, pins.revisions.AssistOSExplorer, 'Assembler checkout must be the pinned Explorer revision');
    if (checkout.source !== 'explicit') assert.equal(checkout.dirty, false, 'Assembler spike files must be unmodified');
    const candidate = await candidateHashes();
    const before = await read('cli-before.json');
    const after = await read('cli-after.json');
    const service = await read('service-probe.json');
    const sandbox = await read('sandbox-result.json');
    const owner = await read('owner-result.json');
    const toolcache = await read('toolcache-result.json');
    assert.equal(sandbox.status, 'passed');
    assert.equal(owner.status, 'passed');
    assert.equal(sandbox.kind, 'sandbox-spike', 'Sandbox result must come from the sandbox harness');
    assert.equal(owner.kind, 'owner-spike', 'Owner result must come from the owner probe');
    assert.equal(sandbox.plan?.wrapperSha256, candidate.wrapper, 'Sandbox wrapper must be the candidate harness');
    assert.equal(sandbox.backendSha256, candidate.backend, 'Sandbox backend must be the candidate fixture');
    assert.equal(owner.harnessSha256, candidate.owner, 'Owner probe must be the candidate harness');
    assert.equal(owner.ploinky?.revision, pins.revisions.ploinky, 'Owner probe must import the pinned Ploinky revision');
    assert.equal(owner.ploinky?.dirty, false, 'Owner probe Ploinky source must be clean');
    assert.deepEqual(owner.ploinkyAfter, owner.ploinky, 'Owner probe Ploinky source must not change during the probe');
    requireSocketSet(service, 'Service');
    requireSocketSet(before, 'CLI before');
    requireSocketSet(after, 'CLI after');
    requireSocketSet(sandbox.before, 'Sandbox trusted before');
    requireSocketSet(sandbox.after, 'Sandbox trusted after');
    requireSocketSet(sandbox.plan?.sockets, 'Sandbox plan');
    for (const socket of sandbox.plan.sockets) {
        assert.ok(typeof socket.realpath === 'string' && path.posix.isAbsolute(socket.realpath), 'Socket realpath is required');
        assert.ok(Array.isArray(socket.aliases), 'Socket aliases are required');
        assert.equal(new Set(socket.aliases).size, socket.aliases.length, 'Socket aliases must be unique');
        assert.ok(socket.aliases.every(alias => typeof alias === 'string' && path.posix.isAbsolute(alias)), 'Socket aliases must be absolute paths');
        assert.ok(socket.aliases.includes(socket.socketPath), 'Socket aliases must include the direct path');
        assert.ok(socket.aliases.includes(socket.realpath), 'Socket aliases must include its realpath');
    }
    for (const socketPath of SOCKET_PATHS) {
        const main = service.find(entry => entry.kind === 'service-ready' && entry.socketPath === socketPath);
        assert.ok(main);
        for (const controls of [before, after]) {
            const cli = controls.find(entry => entry.kind === 'cli-connected' && entry.socketPath === socketPath);
            assert.ok(cli);
            assert.equal(cli.service.pid, main.pid);
            assert.notEqual(cli.client.pid, main.pid);
            assert.equal(cli.client.uid, main.uid);
            assert.equal(cli.client.mountNamespace, main.mountNamespace);
            assert.equal(cli.incarnationDigest, main.incarnationDigest);
            assert.match(cli.challengeDigest, /^[a-f0-9]{64}$/);
        }
        assert.notEqual(before.find(entry => entry.socketPath === socketPath).challengeDigest,
            after.find(entry => entry.socketPath === socketPath).challengeDigest);
        for (const controls of [sandbox.before, sandbox.after]) {
            const control = controls.find(entry => entry.socketPath === socketPath);
            assert.equal(control?.incarnationDigest, main.incarnationDigest);
            assert.equal(control?.service.pid, main.pid);
        }
    }
    const expected = [...new Set(sandbox.plan.sockets.flatMap(entry => entry.aliases))].sort();
    assert.deepEqual(sandbox.observed.results.map(entry => entry.path).sort(), expected);
    assert.ok(expected.length >= SOCKET_PATHS.length);
    assert.ok(sandbox.observed.results.every(entry => entry.error === 'ENOENT'));
    // Re-run every harness check on the record instead of trusting its status.
    const main = service.find(entry => entry.kind === 'service-ready' && entry.socketPath === SOCKET_PATHS[0]);
    verifySandboxRecord(sandbox, main.mountNamespace);
    // The fixture backend's runtime mount differs from production; production
    // agent binaries must mount only their own tool-cache generation.
    assert.equal(toolcache?.collectorSha256, candidate.toolcache, 'Tool-cache collector must be the candidate harness');
    verifyToolCacheRecord(toolcache);
    assert.equal(toolcache.mountNamespace, main.mountNamespace, 'Tool cache must be observed in the service mount namespace');
    const sourceChecks = ['real-router-serializer-minter', 'raw-hash', 'wrong-tuple', 'jti-replay', 'text', 'presentation', 'tool', 'audience', 'expiry', 'receive-preparation-delay'];
    for (const check of sourceChecks) assert.ok(owner.checks.includes(check), `Missing owner probe check: ${check}`);
    assert.ok(owner.started.some(entry => entry.startedAt > entry.expiresAt && entry.admittedAt < entry.expiresAt));
    const commands = await read('commands.json');
    assert.ok(Array.isArray(commands) && commands.length >= 5);
    assert.ok(commands.every(entry => typeof entry.command === 'string' && entry.exitCode === 0));
    // Project only known metadata; unknown input keys never enter artifacts.
    const manifest = { version: 1, diagnosticOnly: true, createdAt: new Date().toISOString(),
        selectedSocketPath: SOCKET_PATHS[0],
        workspace: pins.workspace, branch: pins.branch,
        revisions: Object.fromEntries(['ploinky', 'AssistOSExplorer', 'AdvancedLanguageAgent'].map(name => [name, pins.revisions[name]])),
        images: Object.fromEntries(['box', 'roboTeam'].map(name => [name, { digest: pins.images[name].digest, id: pins.images[name].id }])),
        containers: Object.fromEntries(['box', 'roboTeam'].map(name => [name, pins.containers[name]])),
        candidateManifestSha256: pins.candidateManifestSha256,
        readinessEvidenceSha256: pins.readinessEvidenceSha256,
        assemblerCheckout: { revision: checkout.revision, source: checkout.source },
        candidateSha256: candidate,
        checks: { sameUidAndMountNamespace: true, realCliBeforeAfter: true,
            allSocketAliasesAbsent: true, realRouterOwnerProbe: true, sandboxRecordReverified: true,
            socketDeviceUnexposed: true, harnessHashesBound: true, ownerPloinkyRevisionPinned: true,
            productionRuntimeMountsInToolCacheGeneration: true },
        inputHashes: {} };
    for (const name of ['runtime-pins.json', 'cli-before.json', 'cli-after.json', 'service-probe.json',
        'sandbox-result.json', 'owner-result.json', 'toolcache-result.json', 'commands.json']) {
        manifest.inputHashes[name] = createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex');
    }
    await fs.writeFile(path.join(directory, 'p3-spike.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(directory, 'p3-spike.txt'),
        'P3.0 diagnostic checks passed. Production publishing and release gates remain pending.\n'
        + `Candidate manifest SHA256: ${manifest.candidateManifestSha256}\n`
        + `Selected socket: ${manifest.selectedSocketPath}\n`
        + `Socket alias probes: ${expected.length}; every result ENOENT.\n`
        + 'No sandbox mount exposes the socket filesystem device; the backend ran in a distinct mount namespace.\n'
        + 'Production coding-agent runtime mounts stay inside their tool-cache generations; nothing is mounted below the cache.\n'
        + (checkout.source === 'explicit'
            ? `Harness hashes match this checkout, whose Explorer revision ${checkout.revision} is operator-asserted and unverified (git unavailable).\n`
            : `Harness hashes match Explorer ${checkout.revision}; the checkout's spike files are unmodified.\n`)
        + `Owner probe used clean Ploinky ${owner.ploinky.revision}, unchanged during the probe.\n`
        + 'Real service and CLI identity controls agree before and after the sandbox run.\n'
        + 'Real Router minting, expiry, replay, tampering and receive/preparation delay checks passed.\n', { flag: 'wx', mode: 0o600 });
    return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const flag = process.argv.indexOf('--explorer-revision');
    try {
        assert.ok([3, 5].includes(process.argv.length) && (process.argv.length === 3 || flag === 3),
            'Usage: node live-sessions-evidence.mjs /artifact/dir [--explorer-revision SHA]');
        await assembleEvidence(await fs.realpath(process.argv[2]), { explicitRevision: flag === 3 ? process.argv[4] : undefined });
    }
    catch { console.error('P3 evidence incomplete or inconsistent; no success claim is available.'); process.exitCode = 1; }
}

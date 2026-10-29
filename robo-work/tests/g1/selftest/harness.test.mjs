import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkBinding, checkManifest, checkPost, runProbe, writeIdentity } from '../harness.mjs';
import { addProcess, syntheticProc, tcpTable, tempDir, udp6Table, udpTable } from './synthProc.mjs';

// SYNTHETIC trees only: the harness selfcheck (manifest, R1.6 binding, post-conditions), identity and probe flow.

const here = path.dirname(fileURLToPath(import.meta.url));
const g1 = path.resolve(here, '..');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function manifestTree(files) {
    const root = tempDir('g1man-');
    const lines = [];
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
        lines.push(`${sha(Buffer.from(text))}  ${rel}`);
    }
    fs.writeFileSync(path.join(root, 'MANIFEST.sha256'), `${lines.join('\n')}\n`);
    return root;
}

test('selfcheck manifest: exact tree passes; a one-byte change, an unlisted file or a symlink is refused', () => {
    const root = manifestTree({ 'harness.mjs': 'a\n', 'lib/record.mjs': 'b\n' });
    assert.equal(checkManifest(path.join(root, 'MANIFEST.sha256')).ok, true);
    fs.writeFileSync(path.join(root, 'lib/record.mjs'), 'c\n');
    assert.equal(checkManifest(path.join(root, 'MANIFEST.sha256')).ok, false);
    const extra = manifestTree({ 'harness.mjs': 'a\n' });
    fs.writeFileSync(path.join(extra, 'injected.mjs'), 'x');
    assert.match(checkManifest(path.join(extra, 'MANIFEST.sha256')).problems.join(' '), /injected.mjs: not in the manifest/);
    const linked = manifestTree({ 'harness.mjs': 'a\n' });
    fs.renameSync(path.join(linked, 'harness.mjs'), path.join(linked, 'real.mjs'));
    fs.symlinkSync('real.mjs', path.join(linked, 'harness.mjs'));
    assert.equal(checkManifest(path.join(linked, 'MANIFEST.sha256')).ok, false);
    const empty = manifestTree({});
    assert.equal(checkManifest(path.join(empty, 'MANIFEST.sha256')).ok, false, 'an empty manifest proves nothing');
});

test('selfcheck binding (R1.6): modules resolve under the prefix and match the frozen manifest; a one-byte change is refused', () => {
    const root = tempDir('g1bind-');
    const server = path.join(root, 'opt/robo-work/server/execution');
    fs.mkdirSync(server, { recursive: true });
    fs.writeFileSync(path.join(server, 'gateProtocol.mjs'), 'export const COMMIT_BYTE = 1;\n');
    const manifest = path.join(root, 's4.manifest.sha256');
    fs.writeFileSync(manifest, `${sha(Buffer.from('export const COMMIT_BYTE = 1;\n'))}  robo-work/server/execution/gateProtocol.mjs\n`);
    const prefix = `${fs.realpathSync(path.join(root, 'opt/robo-work/server'))}/`;
    const binding = { allowedPrefix: prefix, modules: [{ specifier: 'gate', manifest, manifestPath: 'robo-work/server/execution/gateProtocol.mjs' }] };
    const resolve = () => path.join(server, 'gateProtocol.mjs');
    assert.equal(checkBinding(binding, { resolve }).ok, true);
    fs.writeFileSync(path.join(server, 'gateProtocol.mjs'), 'export const COMMIT_BYTE = 2;\n');
    assert.equal(checkBinding(binding, { resolve }).ok, false);
    assert.equal(checkBinding({ ...binding, allowedPrefix: '/elsewhere/' }, { resolve }).ok, false);
    assert.equal(checkBinding(binding, { resolve: () => { throw new Error('nope'); } }).ok, false);
});

test('static gate (R1.6): the harness tree defines none of the bound production exports and copies no server file', () => {
    const exportsUnderTest = ['createAdmission', 'admitStartRequest', 'admitStreamPaths', 'createSupervisorEndpointServer', 'validateEndpointRequest',
        'validateSupervisorFrame', 'createFrameChannel', 'resolveEndpointLimits', 'createControlStreamReader', 'resolveControlStreamLimits',
        'createExecutionLedger', 'RELEASE_STEPS', 'deriveLocator', 'newLocatorId', 'createGate', 'COMMIT_BYTE', 'createWalker', 'recoverGeneration',
        'openWorkerState', 'createRootLeaseIssuer', 'confirmRevocation', 'validateMountRequest', 'validateRootLeaseFrame'];
    const files = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== 'selftest') walk(full);
            else if (entry.isFile() && /\.(mjs|py|js)$/.test(entry.name)) files.push(full);
        }
    })(g1);
    assert.ok(files.length >= 8);
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const name of exportsUnderTest) {
            assert.doesNotMatch(text, new RegExp(`(function\\s+${name}\\b|(const|let|var|class)\\s+${name}\\b)`), `${file} defines ${name}`);
        }
    }
    const serverDir = path.resolve(g1, '../../server');
    const serverHashes = new Set();
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) serverHashes.add(sha(fs.readFileSync(full)));
        }
    })(serverDir);
    for (const file of files) assert.equal(serverHashes.has(sha(fs.readFileSync(file))), false, `${file} is a copy of a server file`);
});

test('identity and probe flow: identity is exclusive, the record carries its hash, a re-run never overwrites', async () => {
    const out = tempDir('g1out-');
    const identitySha = writeIdentity({ run: 'abcdef012345', stage: 'S0', out, inputs: { boxImage: 'x' } });
    assert.throws(() => writeIdentity({ run: 'abcdef012345', stage: 'S0', out, inputs: {} }), /EEXIST/);
    assert.equal(sha(fs.readFileSync(path.join(out, 'identity.json'))), identitySha);
    const stdinJson = { tables: { udp: udpTable([['127.0.0.1', 17972]]), udp6: udp6Table([]), tcp: tcpTable([['0.0.0.0', 8080, '0A']]), tcp6: tcpTable([]) } };
    const { record } = await runProbe({ probeId: 'T0-04', run: 'abcdef012345', stage: 'S0', out, stdinJson });
    assert.equal(record.verdict, 'PASS');
    assert.equal(record.candidateIdentitySha256, identitySha);
    await assert.rejects(runProbe({ probeId: 'T0-04', run: 'abcdef012345', stage: 'S0', out, stdinJson }), /EEXIST/);
    await assert.rejects(runProbe({ probeId: 'T0-04', run: 'abcdef012345', stage: 'S0', out: tempDir('g1noid-'), stdinJson }), /identity.json missing/);
    await assert.rejects(runProbe({ probeId: 'G1-03', run: 'abcdef012345', stage: 'S0', out, stdinJson }), /not a S0 probe/);
});

test('a probe whose collector throws writes a NOT-RUN record', async () => {
    const out = tempDir('g1err-');
    writeIdentity({ run: 'abcdef012345', stage: 'S0', out, inputs: {} });
    const { record } = await runProbe({ probeId: 'T0-04', run: 'abcdef012345', stage: 'S0', out, stdinJson: null });
    assert.equal(record.verdict, 'FAIL', 'a missing capture is unreadable input, graded FAIL');
    assert.equal(record.unreadable.length, 4);
});

test('post-condition: a process carrying the run marker or a leftover task file fails; the own chain is excluded', () => {
    const proc = syntheticProc();
    addProcess(proc, { pid: 40, cmdline: ['bash'], status: 'PPid:\t1\n' });
    addProcess(proc, { pid: 41, cmdline: ['node', 'harness.mjs', 'selfcheck', '--post', '--run', 'abcdef012345'], status: 'PPid:\t40\n' });
    const roots = [tempDir('g1root-')];
    assert.equal(checkPost({ run: 'abcdef012345', procRoot: proc, selfPid: 41, roots }).ok, true);
    addProcess(proc, { pid: 42, cmdline: ['python3', '-c', 'x', 'g4rw-abcdef012345'], status: 'PPid:\t1\n' });
    assert.equal(checkPost({ run: 'abcdef012345', procRoot: proc, selfPid: 41, roots }).ok, false);
    const clean = syntheticProc();
    fs.writeFileSync(path.join(roots[0], 'g4rw-abcdef012345-s.sock'), '');
    assert.match(checkPost({ run: 'abcdef012345', procRoot: clean, selfPid: 1, roots }).problems.join(' '), /leftover/);
});

test('CLI: probe T0-04 from stdin exits 0 with a record; unknown probes and bad run ids exit 2', () => {
    const out = tempDir('g1cli-');
    const harness = path.join(g1, 'harness.mjs');
    const identity = spawnSync(process.execPath, [harness, 'identity', '--run', 'abcdef012345', '--stage', 'S0', '--out', out, '--inputs', Buffer.from('{}').toString('base64url')], { encoding: 'utf8' });
    assert.equal(identity.status, 0, identity.stderr);
    const input = JSON.stringify({ tables: { udp: udpTable([['127.0.0.1', 17972]]), udp6: udp6Table([]), tcp: tcpTable([]), tcp6: tcpTable([]) } });
    const probe = spawnSync(process.execPath, [harness, 'probe', 'T0-04', '--run', 'abcdef012345', '--stage', 'S0', '--out', out, '--stdin'], { input, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(JSON.parse(probe.stdout).verdict, 'PASS');
    assert.equal(spawnSync(process.execPath, [harness, 'probe', 'T0-99', '--run', 'abcdef012345', '--stage', 'S0', '--out', out], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [harness, 'probe', 'T0-04', '--run', 'XYZ', '--stage', 'S0', '--out', out, '--stdin'], { input, encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [harness, 'selfcheck'], { encoding: 'utf8' }).status, 2);
});

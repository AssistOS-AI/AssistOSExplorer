// Offline synthetic checks only: these do not prove a Linux namespace, overlay or cgroup claim.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { confinementProblems, createPodmanProbe, imageView, parseOptions, parseWorkloadOutput, recoverJournaledNetworks, SOURCE, taskProcesses, verifyManifest, WORKLOAD_PROBE } from './live/environmentSpike.mjs';
import { buildBwrapArgs } from '../../server/sandbox/bwrapArgs.mjs';
import { createExecutionNetwork, namesFor } from '../../server/sandbox/executionNetwork.mjs';
import { createExecutionSupervisor } from '../../server/sandbox/executionSupervisor.mjs';

const digest = 'a'.repeat(64);
const reservation = 'c'.repeat(32);
const image = `docker.io/library/debian:bookworm@sha256:${digest}`;
const validArgs = ['--image', image, '--workspace', 'env-spike', '--reservation', reservation, '--candidate-manifest', '/tmp/candidate.json', '--output', '/tmp/spike-evidence'];
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const temp = (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'env-spike-unit-')));
    t.after(() => fs.rmSync(root, { recursive: true }));
    return root;
};

test('the harness worker source bind builds a real endpoint request before any sandbox resource is created', () => {
    const buffer = buildBwrapArgs({
        role: 'endpoint', marker: 'a'.repeat(32), netMode: 'join',
        seccompFd: 5, blockFd: 6, infoFd: 7, jsonStatusFd: 8,
        cwd: '/', argv: ['/usr/local/bin/node', '-e', 'setInterval(() => {}, 1000000)'], env: {},
        roBinds: [{ source: '/usr', dest: '/usr' }, { source: SOURCE, dest: '/opt/robo-work' }],
        symlinks: [{ target: 'usr/bin', dest: '/bin' }, { target: 'usr/sbin', dest: '/sbin' },
            { target: 'usr/lib', dest: '/lib' }, { target: 'usr/lib64', dest: '/lib64' }],
    });
    const args = buffer.toString().split('\0');
    const codeMount = args.indexOf('/opt/robo-work');
    assert.ok(codeMount > 1);
    assert.equal(args[codeMount - 2], '--ro-bind');
    assert.equal(args[codeMount - 1], SOURCE);
});

test('CLI requires an exact public digest and rejects ambiguous, unsafe or incomplete arguments before execution', () => {
    assert.equal(parseOptions(validArgs).image, image);
    assert.deepEqual(parseOptions(['--freeze']), { freeze: true });
    for (const badImage of ['debian:bookworm', 'docker.io/library/debian:latest', `localhost/private@sha256:${digest}`, `https://docker.io/x@sha256:${digest}`, `docker.io/a/../b@sha256:${digest}`, `docker.io/a@sha256:${'A'.repeat(64)}`, '']) {
        assert.throws(() => parseOptions(['--image', badImage, ...validArgs.slice(2)]), /invalid_arguments/u);
    }
    for (const suffix of [['--image', image], ['--all', 'true'], ['--output'], ['--freeze']]) assert.throws(() => parseOptions([...validArgs, ...suffix]), /invalid_arguments/u);
    assert.throws(() => parseOptions(validArgs.slice(0, -2)), /invalid_arguments/u);
    assert.throws(() => parseOptions(validArgs.map((value) => value === 'env-spike' ? '../foreign' : value)), /invalid_arguments/u);
    assert.throws(() => parseOptions(validArgs.map((value) => value === '/tmp/spike-evidence' ? '/tmp/../other' : value)), /invalid_arguments/u);
});

test('real CLI refuses malformed input and creates no evidence path', (t) => {
    const root = temp(t);
    const evidence = path.join(root, 'must-not-exist');
    const executable = fileURLToPath(new URL('./live/environmentSpike.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [executable, '--output', evidence], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"status":"REFUSED"/u);
    assert.match(result.stderr, /invalid_arguments/u);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(evidence), false);
});

function candidateFixture(t) {
    const root = temp(t);
    const names = ['robo-work/server/main.mjs', 'robo-work/tests/sandbox/live/environmentSpike.mjs'];
    const files = {};
    for (const name of names) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), 'synthetic-source');
        files[name] = sha('synthetic-source');
    }
    const identity = { commit: 'd'.repeat(40), tree: 'e'.repeat(40), diffSha256: sha('') };
    return { root, manifest: { schemaVersion: 1, repositories: {
        Explorer: { ...identity, files }, Ploinky: { ...identity }, CIB: { ...identity }, ALA: { ...identity },
    }, workerImage: { reference: 'localhost/worker-spike:test', id: `sha256:${digest}`, baseReference: image, archiveSha256: sha('synthetic-oci-archive') },
    boxId: '1'.repeat(64), workerContainerId: '2'.repeat(64) } };
}

test('source identity includes dirty/untracked harness bytes and refuses changed or omitted runtime code', (t) => {
    const { root, manifest } = candidateFixture(t);
    assert.equal(verifyManifest(manifest, root), manifest);
    fs.writeFileSync(path.join(root, 'robo-work/server/main.mjs'), 'changed-runtime');
    assert.throws(() => verifyManifest(manifest, root), /source_identity_mismatch/u);
    delete manifest.repositories.Explorer.files['robo-work/server/main.mjs'];
    assert.throws(() => verifyManifest(manifest, root), /incomplete_source_identity/u);
});

test('source identity refuses symlinks, traversal, missing repositories and an unpinned worker base', (t) => {
    const { root, manifest } = candidateFixture(t);
    manifest.repositories.Explorer.files['robo-work/../outside'] = digest;
    assert.throws(() => verifyManifest(manifest, root), /invalid_source_identity/u);
    delete manifest.repositories.Explorer.files['robo-work/../outside'];
    const source = path.join(root, 'robo-work/server/main.mjs');
    fs.unlinkSync(source);
    fs.symlinkSync('/etc/passwd', source);
    assert.throws(() => verifyManifest(manifest, root), /source_symlink/u);
    delete manifest.repositories.ALA;
    assert.throws(() => verifyManifest(manifest, root), /invalid_repository_identity/u);
    manifest.workerImage.baseReference = 'debian:latest';
    assert.throws(() => verifyManifest(manifest, root), /invalid_candidate_manifest/u);
});

function confined() {
    return {
        status: ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((key) => `${key}:\t0000000000000000`).join('\n') + '\nNoNewPrivs:\t1\nSeccomp:\t2',
        unshareVersionStatus: '0', unshareVersion: 'unshare from util-linux 2.41', trueStatus: '0',
        unshareStatus: '1', unshareError: 'unshare: unshare failed: Operation not permitted',
        pidNamespace: 'pid:[200]', sentinelVisible: '0', procScanStatus: '0',
    };
}
function control() {
    return { workerPidNamespace: 'pid:[100]', workloadPidNamespace: '200', exitCode: 0, signal: null,
        sentinelBefore: { pid: 42, startTime: '900', marker: 'sentinel' }, sentinelAfter: { pid: 42, startTime: '900', marker: 'sentinel' } };
}

test('all five capability sets, NNP and seccomp are required independently', () => {
    assert.deepEqual(confinementProblems(confined(), control()), []);
    for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
        const facts = confined();
        facts.status = facts.status.replace(`${key}:\t0000000000000000`, `${key}:\t0000000000000001`);
        assert.ok(confinementProblems(facts, control()).includes(key));
    }
    assert.ok(confinementProblems({ ...confined(), status: '' }, control()).includes('Seccomp'));
});

test('ENOENT, loader failure, signalled or successful unshare cannot become a userns refusal pass', () => {
    for (const delta of [
        { unshareVersionStatus: '127', unshareStatus: '127', unshareError: '/usr/bin/unshare: not found' },
        { unshareVersionStatus: '126', unshareStatus: '126', unshareError: 'error while loading shared libraries' },
        { unshareStatus: '0', unshareError: '' }, { unshareStatus: '', unshareError: '' },
        { unshareStatus: '1', unshareError: 'unshare: failed to execute /usr/bin/true: No such file or directory' },
        { trueStatus: '127' },
    ]) assert.ok(confinementProblems({ ...confined(), ...delta }, control()).length > 0);
});

test('private PID namespace alone is insufficient: a living same-identity sentinel must be invisible across the probe', () => {
    assert.ok(confinementProblems({ ...confined(), sentinelVisible: '1' }, control()).includes('worker_sentinel_visible_or_scan_incomplete'));
    assert.ok(confinementProblems({ ...confined(), procScanStatus: '1' }, control()).includes('worker_sentinel_visible_or_scan_incomplete'));
    assert.ok(confinementProblems({ ...confined(), pidNamespace: 'pid:[100]' }, control()).includes('private_pid_namespace'));
    const changed = control(); changed.sentinelAfter.startTime = '901';
    assert.ok(confinementProblems(confined(), changed).includes('sentinel_not_alive_across_probe'));
    assert.ok(confinementProblems(confined(), { ...control(), sentinelAfter: null }).includes('sentinel_not_alive_across_probe'));
    assert.ok(confinementProblems(confined(), { ...control(), exitCode: 71 }).includes('workload_exit'));
});

test('section parser rejects duplicate facts and unrelated output rather than accepting a convenient last value', () => {
    assert.deepEqual(parseWorkloadOutput('@@status\nCapEff:\t0\n@@done\nyes\n'), { status: 'CapEff:\t0', done: 'yes' });
    assert.throws(() => parseWorkloadOutput('@@unshareStatus\n0\n@@unshareStatus\n1\n'), /duplicate_probe_section/u);
    assert.throws(() => parseWorkloadOutput('loader failure\n@@done\nyes\n'), /unexpected_probe_output/u);
    assert.doesNotMatch(WORKLOAD_PROBE, /grep[^\n]*"\$1"/u, 'sentinel matching must not use a probe argv value');
    assert.match(WORKLOAD_PROBE, /PROBE_SENTINEL/u);
});

function syntheticPodman({ foreign = false, unknown = false, rmFails = false } = {}) {
    const calls = [];
    let present = true;
    const name = `rw-env-${reservation}`;
    const root = '/var/lib/robo-work/environment-spike/synthetic/storage';
    const labels = { 'robo-work.workspace': 'env-spike', 'robo-work.reservation': reservation, 'robo-work.spike': 'environment-s1-s5' };
    const probe = createPodmanProbe({ root, runroot: '/run/synthetic', workspace: 'env-spike', reservation, mounted: () => true,
        run(command, args) {
            calls.push({ command, args });
            const offset = args.indexOf('cgroupfs') + 1;
            const argv = args.slice(offset);
            if (argv[0] === 'container' && argv[1] === 'exists') return { status: unknown ? 125 : present ? 0 : 1, stdout: '', stderr: 'synthetic' };
            if (argv[0] === 'container' && argv[1] === 'inspect') return { status: 0, stdout: JSON.stringify([{ Id: digest, Name: name, Config: { Labels: { ...labels, ...(foreign ? { 'robo-work.workspace': 'somebody-else' } : {}) } }, State: { Running: false }, GraphDriver: { Data: { MergedDir: `${root}/overlay/merged` } } }]) };
            if (argv[0] === 'unmount') return { status: 0, stdout: '' };
            if (argv[0] === 'rm') { if (!rmFails) present = false; return { status: rmFails ? 125 : 0, stdout: '' }; }
            throw new Error(`unexpected synthetic command ${argv.join(' ')}`);
        },
    });
    return { probe, calls, name };
}

test('synthetic cleanup removes the verified exact ID and is idempotent on a repeated call', () => {
    const { probe, calls, name } = syntheticPodman();
    assert.equal(probe.remove(name).absent, true);
    assert.equal(probe.remove(name).alreadyAbsent, true);
    const mutations = calls.filter((call) => call.args.includes('rm') || call.args.includes('unmount'));
    assert.equal(mutations.length, 2);
    assert.ok(mutations.every((call) => call.args.at(-1) === digest));
    assert.ok(calls.every((call) => !call.args.some((arg) => ['-a', '--all', 'prune', 'reset'].includes(arg))));
});

test('synthetic cleanup refuses foreign labels, foreign names, uncertain absence and failed removal', () => {
    const foreign = syntheticPodman({ foreign: true });
    assert.throws(() => foreign.probe.remove(foreign.name), /container_ownership_mismatch/u);
    assert.ok(foreign.calls.every((call) => !call.args.includes('rm') && !call.args.includes('unmount')));
    assert.throws(() => foreign.probe.remove('another-container'), /foreign_container/u);
    const unknown = syntheticPodman({ unknown: true });
    assert.throws(() => unknown.probe.remove(unknown.name), /container_absence_unknown/u);
    const failed = syntheticPodman({ rmFails: true });
    assert.throws(() => failed.probe.remove(failed.name), /podman_rm_failed/u);
    assert.throws(() => failed.probe.remove(failed.name), /podman_rm_failed/u);
    const entries = [
        { pid: 10, startTime: '100', cmdline: ['fuse-overlayfs', '-o', 'upperdir=/task/store/overlay/upper'] },
        { pid: 11, startTime: '101', cmdline: ['renamed-helper'] },
        { pid: 12, startTime: '103', cmdline: ['unrelated'] },
        { pid: 13, startTime: '104', cmdline: ['self', '/task/store/file'] },
    ];
    assert.deepEqual(taskProcesses(entries, { names: [], identities: [{ pid: 11, startTime: '101' }, { pid: 12, startTime: '102' }],
        dataRoot: '/task/store', runtimeRoot: '/task/run', selfPid: 13 }).map((entry) => entry.pid), [10, 11],
    'a path-attributed helper and surviving same-identity process block cleanup; a reused PID or supervisor does not');
});

test('runner refuses broad/destructive arguments without dispatching them', () => {
    const { probe, calls } = syntheticPodman();
    for (const args of [['system', 'reset'], ['image', 'prune'], ['rm', '--all'], ['rm', '-a'], ['rm', 'a\0b']]) assert.throws(() => probe.call(args), /unsafe_podman_arguments/u);
    assert.equal(calls.length, 0);
});

test('read-only image view derives bin/library symlinks from the image, including absolute image targets', (t) => {
    const root = temp(t);
    for (const dir of ['usr/bin', 'usr/sbin', 'usr/lib', 'usr/lib64']) fs.mkdirSync(`${root}/${dir}`, { recursive: true });
    for (const [name, target] of [['bin', '/usr/bin'], ['sbin', 'usr/sbin'], ['lib', 'usr/lib'], ['lib64', 'usr/lib64']]) fs.symlinkSync(target, `${root}/${name}`);
    const view = imageView(root);
    assert.deepEqual(view.roBinds, [{ source: `${root}/usr`, dest: '/usr' }]);
    assert.deepEqual(view.symlinks[0], { target: '/usr/bin', dest: '/bin' });
    assert.equal(view.symlinks.length, 4);
    fs.unlinkSync(`${root}/lib`); fs.symlinkSync('lib', `${root}/lib`);
    assert.throws(() => imageView(root), /image_symlink_loop/u);
});

function failedNetworkFixture({ unknownListing = false } = {}) {
    const locator = { netns: 'a'.repeat(32) };
    const names = namesFor(locator.netns);
    const state = { netns: false, veth: false, nft: false, allowDelete: false, unknownListing };
    const calls = [];
    const run = async (command, args) => {
        calls.push([command, args]);
        if (command === 'nft' && args[0] === '-f') { state.nft = true; return { status: 1, stdout: '', stderr: 'synthetic partial firewall failure' }; }
        if (command === 'ip' && args[0] === 'netns' && args[1] === 'add') state.netns = true;
        if (command === 'ip' && args[0] === 'link' && args[1] === 'add') state.veth = true;
        const part = command === 'nft' && args[0] === 'delete' ? 'nft' : command === 'ip' && args[1] === 'del' ? args[0] === 'link' ? 'veth' : 'netns' : null;
        if (part) {
            if (!state.allowDelete) return { status: 1, stdout: '', stderr: 'synthetic refused deletion' };
            const wasPresent = state[part]; state[part] = false;
            return { status: wasPresent ? 0 : 1, stdout: '', stderr: wasPresent ? '' : 'synthetic already absent' };
        }
        if (command === 'ip' && args[0] === '-o') return { status: state.unknownListing ? 125 : 0, stdout: state.veth ? `9: ${names.host}@if10: <UP>\n` : '', stderr: '' };
        if (command === 'nft' && args[0] === 'list') return { status: state.unknownListing ? 125 : 0, stdout: state.nft ? `table inet ${names.table}\n` : '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
    };
    const existsImpl = (file) => file === `/run/netns/${names.netns}` && state.netns;
    let actualNetwork;
    const supervisor = createExecutionSupervisor({
        view: { process: () => null, listProcesses: () => [] }, launcher: { launch: () => assert.fail('no sandbox launch expected') },
        admission: { inventory: [], streamDirectory: '/stream' }, roles: { orchestration: {}, endpoint: {}, workload: {} },
        createNetwork(options) {
            actualNetwork = createExecutionNetwork({ ...options, run, exists: existsImpl, listUsed: async () => new Set(), enableForwarding: async () => {}, statNs: () => ({ ino: 123n }) });
            return actualNetwork;
        },
    });
    const entry = { kind: 'netns', resourceId: 'synthetic-reserved-network', locator, state: 'reserved' };
    return { state, calls, run, existsImpl, supervisor, entry, names, actualNetwork: () => actualNetwork };
}

test('rejected real network setup cannot report clean when supervisor release loses the handle and exact resources remain', async () => {
    const fixture = failedNetworkFixture({ unknownListing: true });
    await assert.rejects(fixture.supervisor.create(fixture.entry), { code: 'network_setup_failed' });
    const before = fixture.calls.length;
    await fixture.supervisor.releaseEgress();
    assert.equal(fixture.calls.length, before, 'real supervisor has no network handle after rejected setup');
    assert.equal((await fixture.actualNetwork().verifyAbsent()).absent, false);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const recovered = await recoverJournaledNetworks([fixture.entry], fixture);
        assert.ok(recovered.errors.length > 0, 'cleanup error must propagate to the harness quarantine verdict');
        assert.equal(recovered.records[0].after.absent, false);
        assert.ok(recovered.records[0].after.problems.includes('netns_file'));
        assert.ok(recovered.records[0].after.problems.includes('link_list_failed'));
        assert.ok(recovered.records[0].after.problems.includes('nft_list_failed'));
    }
    const deletions = fixture.calls.slice(before).filter(([, args]) => args[0] === 'delete' || args[1] === 'del');
    assert.equal(deletions.length, 6, 'each independent cleanup pass attempts the three exact resource deletions');
    assert.deepEqual(new Set(deletions.map(([, args]) => args.at(-1))), new Set([fixture.names.table, fixture.names.host, fixture.names.netns]));
});

test('independent recovery proves all parts of a rejected partial setup absent and repeats without deleting unrelated resources', async () => {
    const fixture = failedNetworkFixture();
    await assert.rejects(fixture.supervisor.create(fixture.entry), { code: 'network_setup_failed' });
    assert.deepEqual([fixture.state.netns, fixture.state.veth, fixture.state.nft], [true, true, true]);
    fixture.state.allowDelete = true;
    const first = await recoverJournaledNetworks([fixture.entry], fixture);
    assert.deepEqual(first.errors, []);
    assert.deepEqual(first.records[0].before.problems, ['netns_file', 'veth', 'nft_table']);
    assert.deepEqual(first.records[0].after, { absent: true, problems: [] });
    const deleted = fixture.calls.filter(([, args]) => args[0] === 'delete' || args[1] === 'del').length;
    const second = await recoverJournaledNetworks([fixture.entry], fixture);
    assert.deepEqual(second.errors, []);
    assert.deepEqual(second.records[0].before, { absent: true, problems: [] });
    assert.equal(fixture.calls.filter(([, args]) => args[0] === 'delete' || args[1] === 'del').length, deleted);
});

test('a transient unknown network listing remains a cleanup error even when later exact removal proves absence', async () => {
    const fixture = failedNetworkFixture();
    await assert.rejects(fixture.supervisor.create(fixture.entry), { code: 'network_setup_failed' });
    fixture.state.allowDelete = true;
    let queries = 0;
    const run = async (command, args, options) => {
        if (command === 'ip' && args[0] === '-o' && queries++ === 0) return { status: 125, stdout: '', stderr: 'synthetic unknown listing' };
        return fixture.run(command, args, options);
    };
    const recovered = await recoverJournaledNetworks([fixture.entry], { ...fixture, run });
    assert.equal(recovered.records[0].after.absent, true);
    assert.ok(recovered.errors.some((error) => error.code === 'network_recovery_command_failed' && error.phase === 'inspect-before'));
});

// Test-only S1–S5 feasibility probe. See environmentSpike.md before running in a NEW task-owned worker.
// This uses the real r10 launcher/supervisor; it neither enables Environment admissions nor implements E5.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createProcView, parseMountinfoLine } from '../../../server/execution/procView.mjs';
import { deriveLocator, newLocatorId } from '../../../server/execution/resourceLocators.mjs';
import { createExecutionSupervisor } from '../../../server/sandbox/executionSupervisor.mjs';
import { createExecutionNetwork, defaultRun as runNetworkCommand } from '../../../server/sandbox/executionNetwork.mjs';
import { createSandboxLauncher, TOOL_PATH } from '../../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';

const SOURCE = fileURLToPath(new URL('../../../', import.meta.url));
const REPOSITORY = path.dirname(SOURCE.replace(/\/$/u, ''));
const SHA = /^[a-f0-9]{64}$/u;
const ID = /^sha256:[a-f0-9]{64}$/u;
const IMAGE = /^(?:docker\.io|quay\.io|ghcr\.io)\/[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]+)?@sha256:[a-f0-9]{64}$/u;
const LABELS = ['robo-work.workspace', 'robo-work.reservation', 'robo-work.spike'];
const CAPS = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function deadline(promise, ms, code) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms); })]); }
    finally { clearTimeout(timer); }
}
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const errorFact = (error) => ({ code: error?.code ?? 'probe_failed', message: String(error?.message ?? error).slice(0, 500) });
const read = (file) => fs.readFileSync(file, 'utf8');
const exists = (file) => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const within = (base, file) => file === base || file.startsWith(`${base}/`);

export function parseOptions(argv) {
    if (argv.length === 1 && argv[0] === '--freeze') return { freeze: true };
    const names = new Set(['image', 'workspace', 'reservation', 'candidate-manifest', 'output']);
    const result = {};
    for (let i = 0; i < argv.length; i += 2) {
        const name = argv[i]?.slice(2);
        if (!argv[i]?.startsWith('--') || !names.has(name) || result[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid_arguments');
        result[name] = argv[i + 1];
    }
    if (Object.keys(result).length !== names.size || !IMAGE.test(result.image) || result.image.includes('..')
        || !/^[a-z][a-z0-9-]{2,39}$/u.test(result.workspace) || !/^[a-f0-9]{32}$/u.test(result.reservation)) fail('invalid_arguments');
    for (const name of ['candidate-manifest', 'output']) {
        if (!path.isAbsolute(result[name]) || path.normalize(result[name]) !== result[name] || result[name] === '/') fail('invalid_arguments');
    }
    return result;
}

// Freeze captures dirty tracked bytes and untracked source too; callers add the other repositories and runtime identities.
export function freezeExplorer(repository = REPOSITORY) {
    const git = (args) => {
        const result = spawnSync('git', ['-C', repository, ...args], { env: { PATH: TOOL_PATH }, encoding: null, timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
        if (result.error || result.status !== 0) fail('git_identity_unavailable');
        return result.stdout;
    };
    const files = {};
    const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'robo-work/server', 'robo-work/tests/sandbox/live', 'robo-work/tests/sandbox/environmentSpike.test.mjs']).toString().split('\0').filter(Boolean);
    for (const name of [...new Set(listed)].sort()) {
        const stat = fs.lstatSync(path.join(repository, name));
        if (!stat.isFile() || stat.isSymbolicLink()) fail('source_not_regular');
        files[name] = hash(fs.readFileSync(path.join(repository, name)));
    }
    return {
        commit: git(['rev-parse', 'HEAD']).toString().trim(), tree: git(['rev-parse', 'HEAD^{tree}']).toString().trim(),
        diffSha256: hash(git(['diff', '--binary', 'HEAD', '--'])), files,
    };
}

export function verifyManifest(manifest, repository = REPOSITORY) {
    if (manifest?.schemaVersion !== 1 || !manifest.repositories || !manifest.workerImage || !IMAGE.test(manifest.workerImage.baseReference ?? '')
        || typeof manifest.workerImage.reference !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u.test(manifest.workerImage.reference)
        || !ID.test(manifest.workerImage.id ?? '') || !SHA.test(manifest.workerImage.archiveSha256 ?? '')
        || !/^[a-f0-9]{64}$/u.test(manifest.boxId ?? '') || !/^[a-f0-9]{64}$/u.test(manifest.workerContainerId ?? '')) fail('invalid_candidate_manifest');
    for (const name of ['Explorer', 'Ploinky', 'CIB', 'ALA']) {
        const item = manifest.repositories[name];
        if (!/^[a-f0-9]{40}$/u.test(item?.commit ?? '') || !/^[a-f0-9]{40}$/u.test(item?.tree ?? '') || !SHA.test(item?.diffSha256 ?? '')) fail('invalid_repository_identity');
    }
    const files = manifest.repositories.Explorer.files;
    if (!files || !Object.hasOwn(files, 'robo-work/tests/sandbox/live/environmentSpike.mjs')) fail('incomplete_source_identity');
    const required = (dir) => fs.readdirSync(path.join(repository, dir), { withFileTypes: true }).flatMap((entry) => {
        const name = `${dir}/${entry.name}`;
        if (entry.isSymbolicLink()) fail('source_symlink');
        return entry.isDirectory() ? required(name) : [name];
    });
    for (const name of required('robo-work/server')) if (!Object.hasOwn(files, name)) fail('incomplete_source_identity');
    for (const [name, digest] of Object.entries(files)) {
        if (!name.startsWith('robo-work/') || name.split('/').some((part) => ['..', '.', ''].includes(part)) || !SHA.test(digest)) fail('invalid_source_identity');
        const file = path.join(repository, name);
        if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile() || hash(fs.readFileSync(file)) !== digest) fail('source_identity_mismatch');
    }
    return manifest;
}

// Podman receives no inherited credentials, proxy settings, shell or caller-supplied options.
export function createPodmanProbe({ root, runroot, workspace, reservation, run, observe = () => {}, mounted = (file) => mountFacts().some((entry) => entry.mountpoint === file) }) {
    const common = ['--root', root, '--runroot', runroot, '--storage-driver', 'overlay', '--events-backend', 'file', '--cgroup-manager', 'cgroupfs'];
    const labels = { [LABELS[0]]: workspace, [LABELS[1]]: reservation, [LABELS[2]]: 'environment-s1-s5' };
    const labelArgs = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    const names = new Set([`rw-env-${reservation}`, `rw-env-alt-${reservation}`]);
    const call = (args, extra = {}) => {
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || ['prune', 'reset', '-a', '--all'].includes(arg))) fail('unsafe_podman_arguments');
        return run('podman', [...common, ...args], extra);
    };
    const checked = (args, extra) => {
        const result = call(args, extra);
        if (result.error || result.signal || result.status !== 0) fail(`podman_${args[0]}_failed`);
        return result.stdout.trim();
    };
    function present(name) {
        if (!names.has(name)) fail('foreign_container');
        const result = call(['container', 'exists', name]);
        if (!result.error && !result.signal && result.status === 1) return false;
        if (!result.error && !result.signal && result.status === 0) return true;
        fail('container_absence_unknown');
    }
    function inspectOwned(name) {
        if (!names.has(name)) fail('foreign_container');
        const value = JSON.parse(checked(['container', 'inspect', name]));
        if (!Array.isArray(value) || value.length !== 1) fail('container_identity_unknown');
        const item = value[0];
        if (item.Name?.replace(/^\//u, '') !== name || !/^[a-f0-9]{64}$/u.test(item.Id ?? '') || Object.entries(labels).some(([key, expected]) => item.Config?.Labels?.[key] !== expected)) fail('container_ownership_mismatch');
        observe(item);
        return item;
    }
    function remove(name) {
        if (!present(name)) return { name, absent: true, alreadyAbsent: true };
        const item = inspectOwned(name);
        // Exact ID obtained after checking BOTH exact name and all labels. Unknown errors remain failures.
        const merged = item.GraphDriver?.Data?.MergedDir;
        if (merged && !within(root, merged)) fail('foreign_merged_path');
        if (!item.State?.Running && merged && mounted(merged)) checked(['unmount', item.Id]);
        checked(['rm', '--force', item.Id]);
        if (present(name)) fail('container_remains');
        return { name, id: item.Id, absent: true };
    }
    return { call, checked, present, inspectOwned, remove, labelArgs, names: [...names] };
}

export function parseWorkloadOutput(text) {
    const blocks = {};
    let current = null;
    for (const line of text.split('\n')) {
        const match = /^@@([a-zA-Z0-9]+)$/u.exec(line);
        if (match) { if (Object.hasOwn(blocks, match[1])) fail('duplicate_probe_section'); current = match[1]; blocks[current] = []; }
        else if (current) blocks[current].push(line);
        else if (line !== '') fail('unexpected_probe_output');
    }
    return Object.fromEntries(Object.entries(blocks).map(([key, lines]) => [key, lines.join('\n').trim()]));
}

export function confinementProblems(facts, control) {
    const problems = [];
    const status = Object.fromEntries((facts.status ?? '').split('\n').map((line) => line.split(/:\s*/u)).filter((entry) => entry.length === 2));
    for (const key of CAPS) if (status[key] !== '0000000000000000') problems.push(key);
    if (status.NoNewPrivs !== '1') problems.push('NoNewPrivs');
    if (status.Seccomp !== '2') problems.push('Seccomp');
    if (facts.unshareVersionStatus !== '0' || !/^unshare from util-linux /u.test(facts.unshareVersion ?? '') || facts.trueStatus !== '0') problems.push('unshare_prerequisite');
    if (!/^[1-9][0-9]*$/u.test(facts.unshareStatus ?? '') || ['126', '127'].includes(facts.unshareStatus)
        || !/^unshare: unshare failed: Operation not permitted$/u.test(facts.unshareError ?? '')) problems.push('userns_refusal_not_proven');
    if (!/^pid:\[[0-9]+\]$/u.test(facts.pidNamespace ?? '') || facts.pidNamespace === control.workerPidNamespace
        || facts.pidNamespace !== `pid:[${control.workloadPidNamespace}]`) problems.push('private_pid_namespace');
    if (facts.sentinelVisible !== '0' || facts.procScanStatus !== '0') problems.push('worker_sentinel_visible_or_scan_incomplete');
    if (!control.sentinelBefore || !control.sentinelAfter || control.sentinelBefore.pid !== control.sentinelAfter.pid
        || control.sentinelBefore.startTime !== control.sentinelAfter.startTime || control.sentinelBefore.marker !== control.sentinelAfter.marker) problems.push('sentinel_not_alive_across_probe');
    if (control.exitCode !== 0 || control.signal) problems.push('workload_exit');
    return problems;
}

// Literal program: marker is environment data, absent from this shell's argv. /proc/$$ measures this shell, not cat.
export const WORKLOAD_PROBE = String.raw`
set -u
section() { printf '@@%s\n' "$1"; }
section status; /usr/bin/cat /proc/$$/status
section uidMap; /usr/bin/cat /proc/$$/uid_map
section gidMap; /usr/bin/cat /proc/$$/gid_map
section cgroup; /usr/bin/cat /proc/$$/cgroup
section pidNamespace; /usr/bin/readlink /proc/$$/ns/pid
section pid; printf '%s\n' "$$"
section pids; printf '%s\n' /proc/[0-9]*
/usr/bin/unshare --version >/tmp/unshare-version 2>&1; version=$?
section unshareVersionStatus; printf '%s\n' "$version"
section unshareVersion; /usr/bin/cat /tmp/unshare-version
/usr/bin/true; true_status=$?
section trueStatus; printf '%s\n' "$true_status"
/usr/bin/unshare -U /usr/bin/true >/tmp/unshare-output 2>/tmp/unshare-error; unshare_status=$?
section unshareStatus; printf '%s\n' "$unshare_status"
section unshareError; /usr/bin/cat /tmp/unshare-error
visible=0; scan_status=0
for p in /proc/[0-9]*; do
    if /usr/bin/tr '\000' '\n' <"$p/cmdline" >/tmp/proc-cmdline 2>/dev/null; then
        /usr/bin/grep -Fx -- "$PROBE_SENTINEL" /tmp/proc-cmdline >/dev/null 2>&1; match_status=$?
        case "$match_status" in 0) visible=1;; 1) :;; *) scan_status=1;; esac
    elif [ -d "$p" ]; then scan_status=1; fi
done
section sentinelVisible; printf '%s\n' "$visible"
section procScanStatus; printf '%s\n' "$scan_status"
section skillsNames; /usr/bin/ls -1 /run/robo-work/skills
section skillBytes; /usr/bin/wc -c </run/robo-work/skills/alpha/SKILL.md
section maskedSkillBytes; /usr/bin/wc -c </run/robo-work/skills/alpha/.env
section maskedProjectBytes; /usr/bin/wc -c </projects/p/.env
section fdLinks; for f in /proc/$$/fd/*; do /usr/bin/readlink "$f" || exit 71; done
section usrMount; /usr/bin/grep ' /usr ' /proc/$$/mountinfo
section done; printf 'yes\n'
`;

function mountFacts() {
    return read('/proc/self/mountinfo').trim().split('\n').map((line) => {
        const parsed = parseMountinfoLine(line, 'self');
        if (!parsed) fail('mountinfo_unreadable');
        return { ...parsed, line };
    });
}

function closestMount(file) {
    const matches = mountFacts().filter((item) => within(item.mountpoint, file)).sort((a, b) => b.mountpoint.length - a.mountpoint.length);
    if (!matches.length) fail('mount_identity_unknown');
    return matches[0];
}

function assertNoMounts(paths) {
    if (paths.length === 0) return { absent: true, checkedPaths: [] };
    const matches = mountFacts().filter((item) => paths.some((file) => within(file, item.mountpoint)));
    if (matches.length) fail('task_mount_remains');
    return { absent: true, checkedPaths: paths };
}

export function taskProcesses(processes, { names, identities, dataRoot, runtimeRoot, selfPid = process.pid }) {
    return processes.filter((entry) => entry.pid !== selfPid && (names.some((name) => entry.cmdline.includes(name))
        || entry.cmdline.some((arg) => [dataRoot, runtimeRoot].some((base) => arg === base || arg.includes(`${base}/`)))
        || identities.some((known) => known.pid === entry.pid && known.startTime === entry.startTime)));
}

// Reconstruct from the reservation, even when supervisor.create('netns') rejected before retaining its handle.
// The real network module's recovery release uses only these exact names and never creates a resource.
export async function recoverJournaledNetworks(ledger, { run = runNetworkCommand, existsImpl = exists, note = () => {} } = {}) {
    const records = [];
    const errors = [];
    for (const entry of ledger.filter((item) => item.kind === 'netns')) {
        let before = null;
        let phase = 'inspect-before';
        const resource = { resourceId: entry.resourceId, locator: entry.locator };
        try {
            if (!/^[a-f0-9]{32}$/u.test(entry.locator?.netns ?? '')) fail('invalid_network_recovery_locator');
            const network = createExecutionNetwork({ reservationId: entry.locator.netns, exists: existsImpl,
                run: async (command, args, options) => {
                    let result;
                    try { result = await run(command, args, options); }
                    catch (error) { result = { status: 128, stdout: '', stderr: errorFact(error).message, error }; }
                    const fact = { cleanup: 'journaled-network-command', phase, ...resource, command, args,
                        status: result?.status ?? null, error: result?.error?.code ?? null, signal: result?.signal ?? null,
                        stdout: String(result?.stdout ?? '').slice(0, 4096), stderr: String(result?.stderr ?? '').slice(0, 1000) };
                    note(fact);
                    if (result?.status !== 0 || result?.error || result?.signal) {
                        const part = command === 'nft' && args[0] === 'delete' ? 'nft_table'
                            : command === 'ip' && args[0] === 'link' && args[1] === 'del' ? 'veth'
                                : command === 'ip' && args[0] === 'netns' && args[1] === 'del' ? 'netns_file' : null;
                        // release() attempts all three deletes. Only a part already proved absent can be benign;
                        // an inspection error or failed deletion of a present part remains quarantined after a retry.
                        const knownAbsent = result?.status === 1 && part && phase === 'release' && before && !before.problems.includes(part)
                            && !before.problems.some((problem) => problem.endsWith('_failed') || problem === 'inspection_threw');
                        if (!knownAbsent || result?.error || result?.signal || !Number.isInteger(result?.status)) errors.push({ ...fact, code: 'network_recovery_command_failed' });
                    }
                    return result;
                },
            });
            try { before = await network.verifyAbsent(); }
            catch (error) {
                errors.push({ cleanup: 'network_inspect_before', ...resource, ...errorFact(error) });
                before = { absent: false, problems: ['inspection_threw'] };
            }
            if (!before.absent) {
                phase = 'release';
                try { await network.release(); } catch (error) { errors.push({ cleanup: 'network_release', ...resource, ...errorFact(error) }); }
            }
            phase = 'inspect-after';
            const after = await network.verifyAbsent();
            const record = { cleanup: 'journaled-network-absence', ...resource,
                names: { netns: network.name, host: network.hostVeth, peer: network.peerVeth, table: network.table }, before, after };
            records.push(record);
            note(record);
            if (after.absent !== true) errors.push({ cleanup: 'network_absence', ...resource, code: 'network_absence_unproven', problems: after.problems });
        } catch (error) { errors.push({ cleanup: 'journaled-network', ...resource, ...errorFact(error) }); }
    }
    return { records, errors };
}

// Only image /usr and existing fixed library destinations are used. Image symlinks are reproduced verbatim,
// after proving their resolved targets stay within this root. This is deliberately NOT the full E5 view.
export function imageView(merged) {
    const roBinds = [{ source: `${merged}/usr`, dest: '/usr' }];
    const symlinks = [];
    const insideImage = (file) => {
        let at = file;
        for (let depth = 0; depth < 32; depth += 1) {
            const parts = at.split('/').filter(Boolean);
            let prefix = merged;
            let restarted = false;
            for (let i = 0; i < parts.length; i += 1) {
                prefix = path.join(prefix, parts[i]);
                const stat = fs.lstatSync(prefix);
                if (stat.isSymbolicLink()) {
                    const link = fs.readlinkSync(prefix);
                    const relParent = path.relative(merged, path.dirname(prefix));
                    at = path.posix.normalize(path.posix.join(link.startsWith('/') ? '/' : `/${relParent}`, link, ...parts.slice(i + 1)));
                    restarted = true;
                    break;
                }
            }
            if (!restarted) return prefix;
        }
        fail('image_symlink_loop');
    };
    if (!fs.lstatSync(`${merged}/usr`).isDirectory()) fail('image_usr_not_directory');
    for (const name of ['bin', 'sbin', 'lib', 'lib64']) {
        const file = `${merged}/${name}`;
        if (!exists(file)) { if (name === 'bin') fail('image_missing_bin'); continue; }
        const stat = fs.lstatSync(file);
        const resolved = insideImage(`/${name}`);
        if (!within(merged, resolved)) fail('image_symlink_escape');
        if (stat.isSymbolicLink()) {
            const target = fs.readlinkSync(file);
            if (/[\r\n\0]/u.test(target)) fail('image_invalid_symlink');
            symlinks.push({ target, dest: `/${name}` });
        } else if (stat.isDirectory()) roBinds.push({ source: file, dest: `/${name}` });
        else fail('image_invalid_library_view');
    }
    return { roBinds, symlinks };
}

async function sandboxProbe(context) {
    const { runtimeRoot, merged, note } = context;
    const root = path.join(runtimeRoot, 'sandbox');
    fs.mkdirSync(root);
    const project = path.join(root, 'project');
    const home = path.join(root, 'home');
    const skills = path.join(root, 'skills');
    for (const dir of [project, home, path.join(skills, 'alpha')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${project}/.env`, 'synthetic-project-secret');
    fs.writeFileSync(`${project}/README.md`, 'spike');
    fs.writeFileSync(`${skills}/alpha/SKILL.md`, 'synthetic skill');
    fs.writeFileSync(`${skills}/alpha/.env`, 'synthetic-skill-secret');
    const fds = [project, home, `${skills}/alpha`].map((file) => fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY));
    const view = createProcView({ runtimeRoot: root });
    const masks = readProcMasks();
    const beforeMasks = JSON.stringify(masks);
    const ledger = [];
    const servers = [];
    const sockets = new Set();
    const errors = [];
    const networkCleanup = [];
    let sentinel;
    let sentinelIdentity;
    const sentinelMarker = `rw-sentinel-${context.reservation}`;
    const workerImage = { roBinds: [{ source: '/usr', dest: '/usr' }, { source: SOURCE, dest: '/opt/robo-work' }], symlinks: [
        { target: 'usr/bin', dest: '/bin' }, { target: 'usr/sbin', dest: '/sbin' }, { target: 'usr/lib', dest: '/lib' }, { target: 'usr/lib64', dest: '/lib64' },
    ] };
    const workerNode = '/usr/local/bin/node';
    const supervisor = createExecutionSupervisor({
        view, launcher: createSandboxLauncher({ view, procMasks: masks }),
        admission: { inventory: [{ name: 'sh' }], streamDirectory: '/stream' },
        roles: {
            orchestration: { ...workerImage, argv: [workerNode, '--import', '/opt/robo-work/server/sandbox/fdTrim.mjs', '-e', 'process.stdout.write("ready\\n")'] },
            endpoint: { ...workerImage, argv: [workerNode, '--import', '/opt/robo-work/server/sandbox/fdTrim.mjs', '-e', 'setInterval(() => {}, 1000000)'] },
            workload: imageView(merged),
        },
        home: { path: home, fd: fds[1] }, grants: [{ name: 'p', path: '/projects/p', hostPath: project, fd: fds[0], access: 'write' }],
        skills: [{ name: 'alpha', stageName: 's0', path: `${skills}/alpha`, fd: fds[2] }],
        onInfrastructureLoss: (reason) => errors.push({ code: reason }), limits: { stopGraceMs: 500 },
    });
    const keeper = { id: null };
    async function publish(kind, spec) {
        const resourceId = crypto.randomBytes(16).toString('base64url');
        const locator = { ...deriveLocator(kind, newLocatorId(), { runtimeDir: root }), ...(kind === 'keeper' ? {} : { keeper: keeper.id }) };
        const entry = { kind, resourceId, marker: resourceId, locator, state: 'reserved' };
        ledger.push(entry);
        note({ ...entry });
        const created = await supervisor.create({ kind, resourceId, marker: resourceId, locator, spec });
        entry.identity = created.identity;
        note({ ...entry, state: 'identity-recorded' });
        if (kind === 'keeper') keeper.id = resourceId;
        if (created.gate && await created.gate.commit() !== true) fail('sandbox_gate_failed');
        entry.state = 'committed';
        note({ ...entry });
        return created;
    }
    function sentinelFact() {
        if (!sentinel || sentinel.exitCode !== null || sentinel.signalCode !== null) fail('sentinel_gone');
        const value = view.process(sentinel.pid);
        if (!value || !value.cmdline.includes(sentinelMarker) || (sentinelIdentity && value.startTime !== sentinelIdentity.startTime)) fail('sentinel_identity_changed');
        return { pid: value.pid, startTime: value.startTime, marker: sentinelMarker };
    }
    let result;
    let stageError;
    try {
        await publish('keeper');
        await publish('runtime-dir');
        await publish('netns');
        await publish('endpoint', { config: {} });
        const orchestration = await publish('process-tree', { role: 'orchestration' });
        const orchestrationExit = await deadline(orchestration.handle.wait(), 20000, 'orchestration_timeout');
        if (orchestrationExit.exitCode !== 0) fail('orchestration_prerequisite');
        note({ resource: 'sentinel', marker: sentinelMarker, state: 'reserved' });
        sentinel = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(() => {}, 1000000)', sentinelMarker], { env: { PATH: TOOL_PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('sentinel_start_timeout')), 5000);
            sentinel.once('error', (error) => { clearTimeout(timer); reject(error); });
            sentinel.stdout.once('data', () => { clearTimeout(timer); resolve(); });
        });
        sentinelIdentity = sentinelFact();
        note({ resource: 'sentinel', state: 'committed', identity: sentinelIdentity });
        const stdout = [];
        const stderr = [];
        for (const [name, chunks] of [['stdoutaaaa', stdout], ['stderrbbbb', stderr]]) {
            const server = net.createServer((socket) => {
                sockets.add(socket);
                socket.on('close', () => sockets.delete(socket));
                socket.on('data', (chunk) => {
                    chunks.push(chunk);
                    if (chunks.reduce((sum, entry) => sum + entry.length, 0) > 256 * 1024) { errors.push({ code: 'probe_output_overflow' }); socket.destroy(); }
                });
            });
            servers.push(server);
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`${supervisor.runtimeDir}/stream/${name}`, resolve); });
        }
        const before = sentinelFact();
        const workload = await publish('process-tree', { role: 'workload', process: 1, request: {
            processClass: 'run', executable: '/bin/sh', args: ['-c', WORKLOAD_PROBE, 'rw-env-probe'], env: { LC_ALL: 'C', PROBE_SENTINEL: sentinelMarker },
            home: '/home/robot', cwd: '/projects/p', folders: [{ path: '/projects/p', access: 'write' }], network: 'robot-egress',
            requirements: { privateProc: true }, communication: { kind: 'stdio', stdin: 'ignore' },
        }, streams: { stdout: '/stream/stdoutaaaa', stderr: '/stream/stderrbbbb' } });
        const firstProcessCgroup = read(`/proc/${workload.identity.init.pid}/cgroup`);
        const exit = await deadline(workload.handle.wait(), 30000, 'workload_timeout');
        await sleep(100);
        const after = sentinelFact();
        const facts = parseWorkloadOutput(Buffer.concat(stdout).toString());
        const control = { workerPidNamespace: fs.readlinkSync('/proc/self/ns/pid'), workloadPidNamespace: workload.identity.pidNs,
            sentinelBefore: before, sentinelAfter: after, exitCode: exit.exitCode, signal: exit.signal };
        const problems = confinementProblems(facts, control);
        if (facts.done !== 'yes') problems.push('probe_incomplete');
        if (facts.skillsNames !== 'alpha' || Number(facts.skillBytes) <= 0 || facts.maskedSkillBytes !== '0' || facts.maskedProjectBytes !== '0') problems.push('skills_or_masks');
        if (!facts.usrMount?.split(' ').includes('ro,relatime') && !/\sro(?:,|\s)/u.test(facts.usrMount ?? '')) problems.push('image_usr_not_readonly');
        result = { facts, control, firstProcessCgroup, workloadIdentity: workload.identity, problems, stderr: Buffer.concat(stderr).toString().slice(0, 2000),
            coverage: 'read-only image /usr and libraries; P-CAP and P-NS only; NOT full writable E5 or L-1 acceptance' };
    } catch (error) { stageError = errorFact(error); }
    finally {
        for (let attempt = 1; attempt <= 2; attempt += 1) for (const method of ['endProcessTrees', 'endEndpoint', 'releaseEgress', 'releaseViews', 'removeRuntime', 'exit']) {
            try { await supervisor[method](); note({ cleanup: method, attempt, ok: true }); } catch (error) { errors.push({ cleanup: method, attempt, ...errorFact(error) }); }
            if (method === 'releaseEgress') {
                const recovered = await recoverJournaledNetworks(ledger, { note: (fact) => note({ ...fact, attempt }) });
                networkCleanup.push({ attempt, records: recovered.records });
                errors.push(...recovered.errors.map((error) => ({ ...error, attempt })));
            }
        }
        if (sentinel) {
            try {
                const fresh = sentinelFact();
                sentinel.kill('SIGKILL');
                await new Promise((resolve) => sentinel.once('exit', resolve));
                if (view.process(fresh.pid)?.startTime === fresh.startTime) fail('sentinel_remains');
            } catch (error) { errors.push({ cleanup: 'sentinel', ...errorFact(error) }); }
        }
        for (const socket of sockets) socket.destroy();
        for (const server of servers) await new Promise((resolve) => server.close(resolve));
        for (const fd of fds) fs.closeSync(fd);
        try {
            if (JSON.stringify(readProcMasks()) !== beforeMasks) fail('worker_proc_masks_changed');
            const remaining = view.listProcesses().filter((item) => ledger.some((entry) => item.cmdline.includes(entry.marker)
                || (entry.identity?.pid === item.pid && entry.identity.startTime === item.startTime)));
            if (remaining.length) fail('sandbox_process_remains');
            assertNoMounts([root]);
            if (ledger.some((entry) => entry.kind === 'runtime-dir' && exists(entry.locator.path))) fail('runtime_dir_remains');
        } catch (error) { errors.push({ cleanup: 'sandbox_absence', ...errorFact(error) }); }
    }
    return { ...result, stageError, ledger, networkCleanup, cleanupErrors: errors };
}

function cgroupProbe(reservation, note) {
    const facts = { selfCgroup: read('/proc/self/cgroup'), mounts: mountFacts().filter((item) => item.fstype === 'cgroup2') };
    const own = /^0::(.*)$/mu.exec(facts.selfCgroup)?.[1];
    if (!own || !own.startsWith('/') || own.split('/').includes('..')) return { ...facts, error: { code: 'own_cgroup_unknown' } };
    // Resolve only the caller's own cgroup. Never move processes, enable controllers, chmod or remount anything.
    const candidates = facts.mounts.map((mount) => path.join(mount.mountpoint, own));
    const base = candidates.find((candidate) => {
        try { return read(`${candidate}/cgroup.procs`).trim().split('\n').includes(String(process.pid)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    if (!base) return { ...facts, error: { code: 'own_cgroup_not_resolved' } };
    facts.base = base;
    facts.controllers = read(`${base}/cgroup.controllers`).trim();
    facts.subtreeControl = read(`${base}/cgroup.subtree_control`).trim();
    facts.internalProcesses = read(`${base}/cgroup.procs`).trim().split('\n').filter(Boolean).length;
    const child = path.join(base, `rw-env-spike-${reservation}`);
    facts.child = child;
    facts.limits = {};
    let created = false;
    try {
        note({ resource: 'cgroup', path: child, state: 'reserved' });
        fs.mkdirSync(child); created = true;
        if (fs.statfsSync(child, { bigint: true }).type !== 0x63677270n) fail('not_cgroup2');
        for (const [file, value] of Object.entries({ 'memory.max': '67108864', 'memory.swap.max': '0', 'memory.oom.group': '1', 'cpu.max': '10000 100000', 'pids.max': '32' })) {
            fs.writeFileSync(`${child}/${file}`, value);
            facts.limits[file] = read(`${child}/${file}`).trim();
            if (facts.limits[file] !== value) fail('cgroup_limit_mismatch');
        }
        facts.childProcesses = read(`${child}/cgroup.procs`).trim();
        if (facts.childProcesses !== '') fail('unexpected_child_process');
    } catch (error) { facts.error = errorFact(error); }
    finally {
        if (created) { try { fs.rmdirSync(child); } catch (error) { facts.cleanupError = errorFact(error); } }
        facts.absent = !exists(child);
        note({ resource: 'cgroup', path: child, state: facts.absent ? 'released' : 'quarantined' });
    }
    facts.authorityChanged = false;
    facts.controllerEnablementAttempted = false;
    facts.controllerEnablementReason = 'Observation only: no subtree_control writes or process moves; unavailable inherited controllers fail S4.';
    return facts;
}

export async function runSpike(options) {
    const bytes = fs.readFileSync(options['candidate-manifest']);
    const candidate = verifyManifest(JSON.parse(bytes));
    const output = options.output;
    // Do not overwrite earlier evidence or reuse an old task's storage.
    if (exists(output)) fail('output_already_exists');
    fs.mkdirSync(output, { mode: 0o700 });
    const reservation = options.reservation;
    const dataRoot = `/var/lib/robo-work/environment-spike/${options.workspace}-${reservation}`;
    const runtimeRoot = `/run/rwes-${reservation.slice(0, 16)}`;
    const journal = [];
    const note = (fact) => {
        journal.push(fact);
        fs.appendFileSync(`${output}/resource-journal.jsonl`, `${JSON.stringify(fact)}\n`, { mode: 0o600 });
    };
    const records = [1, 2, 3, 4, 5].map((n) => ({ schemaVersion: 1, probe: `S${n}`, status: 'BLOCKED', candidate,
        candidateManifestSha256: hash(bytes), workspace: options.workspace, reservation, imageReference: options.image, imageId: null, facts: {}, errors: [] }));
    const [s1, s2, s3, s4, s5] = records;
    const cleanupErrors = [];
    const mergedPaths = [];
    let podman;
    let ownedStorage = false;
    let ownedRuntime = false;
    let preflightOk = false;
    const containerIds = new Set();
    const containerProcesses = [];
    let processView;
    function run(command, args, extra = {}) {
        const result = spawnSync(command, args, { env: { PATH: TOOL_PATH, HOME: `${dataRoot}/home`, XDG_RUNTIME_DIR: runtimeRoot, REGISTRY_AUTH_FILE: `${dataRoot}/auth.json`, LC_ALL: 'C' },
            cwd: '/', encoding: 'utf8', timeout: extra.timeout ?? 30000, maxBuffer: 1024 * 1024, stdio: extra.stdio ?? ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
        const fact = { command, args, status: result.status, signal: result.signal, error: result.error?.code ?? null,
            stdout: String(result.stdout ?? '').slice(0, 8192), stderr: String(result.stderr ?? '').slice(0, 4096) };
        journal.push(fact);
        fs.appendFileSync(`${output}/commands.jsonl`, `${JSON.stringify(fact)}\n`, { mode: 0o600 });
        return { ...result, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
    try {
        if (process.platform !== 'linux' || process.getuid() !== 0) fail('requires_linux_task_worker_root');
        if (exists(dataRoot) || exists(runtimeRoot)) fail('task_resource_path_exists');
        const disk = closestMount('/var/lib/robo-work');
        if (disk.mountpoint !== '/var/lib/robo-work' || ['tmpfs', 'ramfs'].includes(disk.fstype)) fail('persistent_disk_bind_required');
        fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 }); ownedStorage = true;
        fs.mkdirSync(runtimeRoot, { mode: 0o700 }); ownedRuntime = true;
        fs.mkdirSync(`${dataRoot}/home`, { mode: 0o700 });
        fs.writeFileSync(`${dataRoot}/auth.json`, '{"auths":{}}\n', { mode: 0o600, flag: 'wx' });
        processView = createProcView();
        podman = createPodmanProbe({ root: `${dataRoot}/storage`, runroot: `${runtimeRoot}/podman`, workspace: options.workspace, reservation, run,
            observe: (item) => {
                containerIds.add(item.Id);
                for (const pid of [item.State?.Pid, item.State?.ConmonPid]) {
                    if (!Number.isSafeInteger(pid) || pid < 1) continue;
                    const identity = processView.process(pid);
                    if (identity) { containerProcesses.push({ pid: identity.pid, startTime: identity.startTime }); note({ resource: 'container-process', containerId: item.Id, pid: identity.pid, startTime: identity.startTime }); }
                }
            },
        });
        s1.facts = { disk, dataRoot, runroot: `${runtimeRoot}/podman`, ownershipLabels: podman.labelArgs };
        s1.facts.podmanVersion = podman.checked(['--version']);
        s1.facts.storage = JSON.parse(podman.checked(['info', '--format', 'json'])).store;
        if (path.resolve(s1.facts.storage?.graphRoot ?? '') !== `${dataRoot}/storage`) fail('graphroot_mismatch');
        s1.facts.graphrootMount = closestMount(`${dataRoot}/storage`);
        if (['tmpfs', 'ramfs'].includes(s1.facts.graphrootMount.fstype)) fail('graphroot_on_memory');
        preflightOk = true;
    } catch (error) { s1.errors.push(errorFact(error)); s1.status = 'FAIL'; }
    if (preflightOk) {
        try {
            podman.checked(['pull', '--authfile', `${dataRoot}/auth.json`, '--tls-verify=true', options.image], { timeout: 900000 });
            const image = JSON.parse(podman.checked(['image', 'inspect', options.image]))[0];
            const imageId = image?.Id?.startsWith('sha256:') ? image.Id : `sha256:${image?.Id}`;
            if (!ID.test(imageId) || !(image.RepoDigests ?? []).some((digest) => digest.endsWith(options.image.slice(options.image.lastIndexOf('@'))))) fail('image_digest_unverified');
            if (image.Architecture !== ({ x64: 'amd64', arm64: 'arm64' })[process.arch]) fail('image_architecture_mismatch');
            for (const record of records) record.imageId = imageId;
            const name = podman.names[0];
            note({ resource: 'container', name, state: 'reserved' });
            podman.checked(['create', '--pull=never', '--network=none', '--ipc=none', '--name', name, ...podman.labelArgs, imageId, '/nonexistent']);
            const created = podman.inspectOwned(name);
            const createdImageId = created.Image?.startsWith('sha256:') ? created.Image : `sha256:${created.Image}`;
            if (createdImageId !== imageId) fail('container_image_mismatch');
            if (created.State?.Running !== false || !['created', 'configured'].includes(created.State?.Status)) fail('rootfs_container_started');
            note({ resource: 'rootfs-mount', name, state: 'reserved' });
            const merged = podman.checked(['mount', name]);
            if (!path.isAbsolute(merged) || !within(`${dataRoot}/storage`, merged) || !fs.lstatSync(merged).isDirectory()) fail('merged_path_invalid');
            mergedPaths.push(merged);
            note({ resource: 'rootfs-mount', containerId: created.Id, merged, state: 'committed' });
            s1.facts.rootfs = { name, containerId: created.Id, merged, imageId, state: created.State.Status };
            s1.status = 'PASS';
            try {
                s2.facts = await sandboxProbe({ runtimeRoot, merged, reservation, note });
                s2.status = !s2.facts.stageError && s2.facts.problems?.length === 0 && s2.facts.cleanupErrors.length === 0 ? 'PASS' : 'FAIL';
            } catch (error) { s2.errors.push(errorFact(error)); s2.status = 'FAIL'; }
            const after = podman.inspectOwned(name);
            if (after.Id !== created.Id || after.State?.Running !== false || !['created', 'configured'].includes(after.State?.Status)) fail('rootfs_container_state_changed');
            s1.facts.rootfs.stateAfterWorkload = after.State.Status;
        } catch (error) { s1.errors.push(errorFact(error)); s1.status = 'FAIL'; }
        try {
            s3.facts = { workerUidMap: read('/proc/self/uid_map'), workerGidMap: read('/proc/self/gid_map'),
                workloadUidMap: s2.facts.facts?.uidMap ?? null, workloadGidMap: s2.facts.facts?.gidMap ?? null };
            s3.status = s3.facts.workloadUidMap && s3.facts.workloadGidMap ? 'PASS' : 'BLOCKED';
        } catch (error) { s3.errors.push(errorFact(error)); s3.status = 'FAIL'; }
        try {
            s4.facts = cgroupProbe(reservation, note);
            s4.status = !s4.facts.error && !s4.facts.cleanupError && s4.facts.absent ? 'PASS' : 'FAIL';
            s4.facts.nextStep = s4.status === 'FAIL' ? 'Q-E4a: ground/review the preapproved own-cgroup delegation delta before product implementation' : null;
        } catch (error) { s4.errors.push(errorFact(error)); s4.status = 'FAIL'; }
        if (s1.imageId) {
            try {
                const name = podman.names[1];
                const fdFile = `${dataRoot}/preserved-fd`;
                fs.writeFileSync(fdFile, 'synthetic-fd-marker', { flag: 'wx', mode: 0o600 });
                const fd = fs.openSync(fdFile, 'r');
                const script = 'printf "@@pidNamespace\\n"; readlink /proc/self/ns/pid; printf "@@pids\\n"; printf "%s\\n" /proc/[0-9]*; printf "@@fd3\\n"; cat /proc/self/fd/3; printf "\\n@@done\\nyes\\n"';
                let alternative;
                note({ resource: 'alternative-container', name, state: 'reserved' });
                try {
                    alternative = podman.call(['run', '--runtime', 'crun', '--pull=never', '--network=none', '--ipc=none', '--cgroups=disabled', '--userns=auto:size=65536',
                        '--preserve-fds=1', '--name', name, ...podman.labelArgs, '--entrypoint', '/bin/sh', s1.imageId, '-c', script], { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 30000 });
                } finally { fs.closeSync(fd); }
                const facts = alternative.status === 0 && !alternative.error && !alternative.signal ? parseWorkloadOutput(alternative.stdout) : {};
                const privateProc = facts.pidNamespace && facts.pidNamespace !== fs.readlinkSync('/proc/self/ns/pid');
                s5.facts = { chosenMechanism: 'A (create+mount+bwrap)', alternative: 'B (crun run), observation only', ipc: 'none', preserveFds: 1,
                    status: alternative.status, signal: alternative.signal, error: alternative.error?.code ?? null, stdout: alternative.stdout.slice(0, 8192), stderr: alternative.stderr.slice(0, 4096),
                    privateProc: Boolean(privateProc), preservedFd: facts.fd3 === 'synthetic-fd-marker', complete: facts.done === 'yes' };
                s5.status = privateProc && s5.facts.preservedFd && s5.facts.complete ? 'OBSERVED_SUCCESS' : 'OBSERVED_FAILURE';
            } catch (error) { s5.errors.push(errorFact(error)); s5.status = 'OBSERVED_FAILURE'; }
        }
    }
    // Always retry exact cleanup once, even after failure. A later success does not erase an earlier unknown error.
    const cleanup = [];
    try {
        if (processView) for (const entry of taskProcesses(processView.listProcesses(), {
            names: [...podman.names, ...containerIds], identities: containerProcesses, dataRoot, runtimeRoot,
        })) {
            const identity = { pid: entry.pid, startTime: entry.startTime };
            containerProcesses.push(identity);
            note({ resource: 'task-helper-process', state: 'observed-before-cleanup', ...identity });
        }
    } catch (error) { cleanupErrors.push(errorFact(error)); }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const entries = [];
        if (podman) for (const name of podman.names) {
            try { entries.push(podman.remove(name)); } catch (error) { const fact = { resource: name, ...errorFact(error) }; cleanupErrors.push(fact); entries.push(fact); }
        }
        try { entries.push(assertNoMounts([...mergedPaths, ...(ownedStorage ? [dataRoot] : []), ...(ownedRuntime ? [runtimeRoot] : [])])); } catch (error) { cleanupErrors.push(errorFact(error)); }
        try {
            if (processView) {
                const processes = processView.listProcesses();
                const remaining = taskProcesses(processes, { names: [...podman.names, ...containerIds], identities: containerProcesses, dataRoot, runtimeRoot });
                if (remaining.length) fail('container_process_remains');
                entries.push({ containerProcessesAbsent: true, knownIdentities: containerProcesses });
            }
            if (s4.facts.child && exists(s4.facts.child)) fail('cgroup_remains');
        } catch (error) { cleanupErrors.push(errorFact(error)); }
        cleanup.push({ attempt, entries });
    }
    if (s2.facts.cleanupErrors?.length) cleanupErrors.push(...s2.facts.cleanupErrors);
    if (s4.facts.cleanupError || s4.facts.absent === false) cleanupErrors.push({ code: 'cgroup_absence_unproven' });
    const quarantine = cleanupErrors.length > 0;
    if (!quarantine) {
        // Storage is deliberately retained for exact-image evidence/recovery; no image GC or recursive store deletion.
        if (ownedRuntime) {
            try { assertNoMounts([runtimeRoot]); fs.rmSync(runtimeRoot, { recursive: true }); } catch (error) { cleanupErrors.push(errorFact(error)); }
        }
    }
    const finalCleanup = { attempts: cleanup, errors: cleanupErrors, quarantine: cleanupErrors.length > 0, retainedStorage: ownedStorage ? dataRoot : null,
        storageRemoval: 'Operator may remove this exact task store after reviewing the retained identities; harness never prunes.' };
    if (finalCleanup.quarantine) {
        fs.writeFileSync(`${output}/quarantine.json`, JSON.stringify({ ...finalCleanup, journal, candidate }, null, 2), { flag: 'wx', mode: 0o600 });
        s1.status = 'FAIL';
    }
    for (const record of records) {
        record.cleanup = finalCleanup;
        fs.writeFileSync(`${output}/${record.probe}.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    fs.writeFileSync(`${output}/resource-journal.json`, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return records;
}

async function main() {
    try {
        const options = parseOptions(process.argv.slice(2));
        if (options.freeze) { process.stdout.write(`${JSON.stringify(freezeExplorer(), null, 2)}\n`); return; }
        const records = await runSpike(options);
        for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
        process.exitCode = records.slice(0, 4).every((record) => record.status === 'PASS') && !records.some((record) => record.cleanup.quarantine) ? 0 : 1;
    } catch (error) {
        process.stderr.write(`${JSON.stringify({ status: 'REFUSED', ...errorFact(error) })}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

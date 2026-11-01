import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const PATH = '/usr/sbin:/usr/bin:/sbin:/bin';
const COMMANDS = new Set(['pull', 'create', 'mount', 'umount', 'rm', 'rmi', 'image', 'container', 'ps', 'inspect']);
// A separate session owns Podman and helpers retaining its group. EOF on the worker-owned pipe kills that group,
// even if the worker was SIGKILLed. Detached storage helpers require rootfs recovery and mount proof. The image and
// every argument remain positional parameters, never shell source.
export const PODMAN_LIFETIME_SCRIPT = [
    'exec 3<&0',
    '/usr/bin/setsid /usr/bin/podman "$@" </dev/null 3<&- &',
    'job=$!',
    '( IFS= read -r _ <&3; /usr/bin/kill -KILL -- "-$job" 2>/dev/null ) &',
    'watcher=$!',
    'exec 3<&-',
    'wait "$job"; result=$?',
    '/usr/bin/kill -KILL "$watcher" 2>/dev/null',
    'wait "$watcher" 2>/dev/null',
    'exit "$result"',
].join('\n');

export function validatePodmanArgs(args) {
    if (!Array.isArray(args) || !COMMANDS.has(args[0]) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0')
        || ['prune', 'reset', '-a', '--all'].includes(arg) || arg.startsWith('--all='))) throw new TypeError('Podman operation refused');
    return args;
}

function privateDirectory(target) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(target);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) throw new Error('Private Podman directory unavailable');
    fs.chmodSync(target, 0o700);
}

export function createPodmanRunner({ dataDir, runroot = '/run/robo-work-podman', spawnImpl = spawn, spawnSyncImpl = spawnSync,
    accessExecutable = (file) => fs.accessSync(file, fs.constants.X_OK) } = {}) {
    const home = path.join(dataDir, 'environment', 'podman-home');
    const auth = path.join(home, 'auth.json');
    let ready = false;
    const children = new Set();
    const env = { PATH, HOME: home, XDG_RUNTIME_DIR: runroot, REGISTRY_AUTH_FILE: auth, CONTAINERS_AUTH_FILE: auth };
    const globals = ['--root', path.join(dataDir, 'podman', 'storage'), '--runroot', runroot, '--storage-driver', 'overlay', '--cgroup-manager', 'cgroupfs'];

    function initialize() {
        if (ready) return;
        for (const executable of ['/bin/sh', '/usr/bin/podman', '/usr/bin/setsid', '/usr/bin/kill', '/usr/bin/mount']) accessExecutable(executable);
        privateDirectory(home);
        privateDirectory(runroot);
        const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
        const mounted = mounts.find((line) => line.split(' ')[4] === runroot);
        if (mounted && mounted.split(' - ')[1]?.split(' ')[0] !== 'tmpfs') throw new Error('Podman runroot is not tmpfs');
        if (!mounted) {
            const result = spawnSyncImpl('/usr/bin/mount', ['-t', 'tmpfs', '-o', 'size=64m,mode=0700,nosuid,nodev', 'tmpfs', runroot], { env: { PATH }, stdio: 'ignore', timeout: 20000 });
            if (result.status !== 0) throw new Error('Podman runroot unavailable');
        }
        const fd = fs.openSync(auth, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, '{"auths":{}}\n'); fs.fchmodSync(fd, 0o600); } finally { fs.closeSync(fd); }
        ready = true;
    }

    function run(args, { signal, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024 } = {}) {
        validatePodmanArgs(args);
        if (!ready) return Promise.reject(Object.assign(new Error('Podman unavailable'), { code: 'runtime_unavailable' }));
        if (signal?.aborted) return Promise.reject(Object.assign(new Error('Podman cancelled'), { code: 'ABORT_ERR' }));
        return new Promise((resolve, reject) => {
            const child = spawnImpl('/bin/sh', ['-c', PODMAN_LIFETIME_SCRIPT, 'rw-podman', ...globals, ...args], {
                env, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'],
            });
            children.add(child);
            let stdout = '';
            let bytes = 0;
            let failure = null;
            const cancel = (code) => { failure ??= code; child.stdin?.destroy(); };
            const abort = () => cancel('ABORT_ERR');
            const timer = setTimeout(() => cancel('ETIMEDOUT'), timeoutMs);
            signal?.addEventListener('abort', abort, { once: true });
            child.stdin?.on('error', () => {});
            child.stdout?.on('data', (chunk) => { bytes += chunk.length; if (bytes > maxBytes) cancel('OUTPUT_LIMIT'); else stdout += chunk; });
            // Registry errors can contain arbitrary registry text. Consume, bound and discard them.
            child.stderr?.on('data', (chunk) => { bytes += chunk.length; if (bytes > maxBytes) cancel('OUTPUT_LIMIT'); });
            const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); children.delete(child); };
            child.once('error', () => { cleanup(); reject(Object.assign(new Error('Podman unavailable'), { code: 'runtime_unavailable' })); });
            child.once('close', (status) => {
                cleanup();
                if (failure) reject(Object.assign(new Error('Podman operation ended'), { code: failure }));
                else resolve({ status: status ?? 128, stdout });
            });
            if (signal?.aborted) abort();
        });
    }

    function runSync(args) {
        validatePodmanArgs(args);
        if (!ready) return { status: 128, stdout: '' };
        const result = spawnSyncImpl('/usr/bin/podman', [...globals, ...args], { env, cwd: '/', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
        return { status: result.status ?? 128, stdout: result.stdout ?? '' };
    }
    return { initialize, run, runSync, close() { for (const child of children) child.stdin?.destroy(); }, get available() { return ready; } };
}

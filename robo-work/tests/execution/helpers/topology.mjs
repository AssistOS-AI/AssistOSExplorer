import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Starts a topology through the non-Node parent (symmetricParent.py, python3 -I). The Node test process is the
// supervisor: it holds one end of any socket pair that the parent hands to a child, and it reads each child's output
// line by line.

const PARENT_SCRIPT = fileURLToPath(new URL('../fixtures/symmetricParent.py', import.meta.url));

export function findPython() {
    const requested = process.env.ROBO_WORK_PYTHON3;
    if (requested) return requested;
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
        const candidate = path.join(directory, 'python3');
        if (directory && fs.existsSync(candidate)) return candidate;
    }
    throw new Error('python3 was not found on PATH (set ROBO_WORK_PYTHON3)');
}

export function pythonVersion() {
    return spawnSync(findPython(), ['-I', '--version'], { encoding: 'utf8' }).stdout.trim();
}

// A short directory for Unix sockets: macOS limits a socket path to 104 bytes.
export function shortTempDirectory(prefix = 'rw') {
    const base = os.tmpdir().length <= 32 ? os.tmpdir() : '/tmp';
    return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

// Removes a directory this suite created (guarded by its prefix). It retries, because a socket path can still be
// appearing in it while its owner shuts down, and it never throws: a cleanup hook must not mask the test's own result.
export function removeDirectory(directory) {
    if (typeof directory === 'string' && directory.length > 8 && path.basename(directory).startsWith('rw')) {
        try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch { /* reported by the leak check */ }
    }
}

function collectLines(stream, sink) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        buffer += chunk;
        for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
            sink.push(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
        }
    });
}

export function nodeChannelEnvironment(extra = {}) {
    return { NODE_CHANNEL_FD: '3', NODE_CHANNEL_SERIALIZATION_MODE: 'json', ...extra };
}

// children: [{ name, argv (after the node binary), env, fds: { n: source }, rlimitNofile, nodeFlags }]
//   source is any symmetricParent.py source, or "supervisor:<name>" for a pipe whose other end this process holds,
//   or "output" for a pipe that this process reads as that child's output.
// pairs: names of socket pairs created by the parent.
// Each child's fds default to 0 devnull, 1 output, 2 stderr.
export function startTopology({ children, pairs = [], waitFor, timeoutS = 30, supervisors = [] }) {
    const stdio = ['ignore', 'pipe', 'pipe', 'pipe'];
    const supervisorIndex = new Map();
    for (const name of supervisors) { supervisorIndex.set(name, stdio.length); stdio.push('pipe'); }
    const outputIndex = new Map();
    for (const child of children) { outputIndex.set(child.name, stdio.length); stdio.push('pipe'); }

    const spec = {
        pairs, wait_for: waitFor, timeout_s: timeoutS, status: 'parent:3',
        children: children.map((child) => {
            const fds = { 0: 'devnull', 1: `parent:${outputIndex.get(child.name)}`, 2: 'stderr', ...child.fds };
            for (const [number, source] of Object.entries(fds)) {
                if (source.startsWith('supervisor:')) fds[number] = `parent:${supervisorIndex.get(source.slice(11))}`;
            }
            let argv = (child.command ? [child.command, ...child.argv] : [process.execPath, ...(child.nodeFlags || []), ...child.argv]).map(String);
            // Node raises its own soft RLIMIT_NOFILE to the hard limit at startup, so the limit is set in both by the shell
            // that execs it (`ulimit -n` sets soft and hard).
            if (child.rlimitNofile) argv = ['/bin/sh', '-c', 'ulimit -n "$1" && shift && exec "$@"', 'sh', String(child.rlimitNofile), ...argv];
            return { name: child.name, argv, env: { PATH: process.env.PATH || '', ...child.env }, fds };
        })
    };
    const parent = spawn(findPython(), ['-I', PARENT_SCRIPT, JSON.stringify(spec)], { stdio });
    const sockets = {};
    for (const [name, index] of supervisorIndex) sockets[name] = parent.stdio[index];
    const outputs = {};
    const statusLines = [];
    collectLines(parent.stdio[3], statusLines);
    for (const child of children) { outputs[child.name] = []; collectLines(parent.stdio[outputIndex.get(child.name)], outputs[child.name]); }
    let stderr = '';
    parent.stderr.setEncoding('utf8');
    parent.stderr.on('data', (chunk) => { stderr += chunk; });
    parent.stdout.resume();
    for (const socket of Object.values(sockets)) socket.on('error', () => {});

    const finished = new Promise((resolve) => {
        parent.once('close', (code, signal) => {
            let summary = null;
            try { summary = JSON.parse(statusLines.at(-1)); } catch { /* no summary: the parent failed */ }
            resolve({ code, signal, summary, outputs, stderr });
        });
    });
    const stop = async () => {
        if (parent.exitCode === null && parent.signalCode === null) {
            parent.kill('SIGTERM');
            const timer = setTimeout(() => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); }, 3000);
            await finished;
            clearTimeout(timer);
        }
    };
    return { parent, sockets, finished, stop };
}

export function lastJson(lines) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try { return JSON.parse(lines[index]); } catch { /* not a result line */ }
    }
    return null;
}

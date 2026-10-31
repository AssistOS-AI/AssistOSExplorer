import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// The robot-terminal PTY host (M-8 SPEC "PTY" row; M-65). It opens a PTY PAIR with the worker image's own node-pty (Ploinky's prebuilt
// 1.0.0 at /usr/local/lib/ploinky/webtty/node_modules/node-pty, Dockerfile robo-work-worker lines 24-27; never downloaded or installed
// here) through `open()`, NOT `spawn()`: node-pty never forks anything. The shell is started by the sandbox launcher chain with the slave
// as stdio 0-2; the MASTER stays in this process for the whole terminal and is closed at its end.
//
// node-pty 1.0.0 `open()` (unixTerminal.js) wraps both ends in pipe sockets and RESUMES the slave socket, so the worker would read the
// shell's input: the slave socket is paused at once and destroyed (its descriptor closed in the worker) right after the launch duplicated
// it into the sandbox. The master descriptor is NOT close-on-exec (Step 1 result), which is why every spawn chain closes inherited
// descriptors (sandboxLauncher keep set, stage.sh prep, the anchor script).
//
//   createPtyHost({ moduleDir?, load? }) -> { available() -> { ok, code? }, open({ cols, rows }) -> Pty }
//   Pty { slaveFd, onData(fn(Buffer)), write(Buffer, cb), resize(cols, rows), pause(), resume(), destroySlave(), close(), bytes }
//     `bytes` { input, output }: counts only. Nothing here logs or keeps PTY bytes.
// moduleDir: ROBO_WORK_NODE_PTY_DIR, default DEFAULT_NODE_PTY_DIR. A missing or unloadable module, or an `open()` result without the
// expected shape, is `sandbox_unavailable` (no shell is better than any fallback).

export const DEFAULT_NODE_PTY_DIR = '/usr/local/lib/ploinky/webtty/node_modules/node-pty';
const EARLY_OUTPUT_BYTES = 256 * 1024;

export class PtyError extends Error {
    constructor(code) {
        super(`pty: ${code}`);
        this.code = code;
    }
}

function defaultLoad(moduleDir) {
    const requireFrom = createRequire(path.join(moduleDir, 'package.json'));
    return requireFrom(moduleDir);
}

export function createPtyHost({ moduleDir = DEFAULT_NODE_PTY_DIR, load = defaultLoad } = {}) {
    let module = null;
    let failure = null;

    function loaded() {
        if (module) return module;
        if (failure) throw failure;
        try {
            if (!path.isAbsolute(moduleDir) || !fs.statSync(moduleDir).isDirectory()) throw new Error('missing');
            const candidate = load(moduleDir);
            if (typeof candidate?.open !== 'function') throw new Error('no open');
            module = candidate;
            return module;
        } catch {
            failure = new PtyError('sandbox_unavailable');
            throw failure;
        }
    }

    function available() {
        try { loaded(); return { ok: true }; } catch (error) { return { ok: false, code: error.code }; }
    }

    function open({ cols, rows }) {
        const pty = loaded();
        let term;
        try {
            term = pty.open({ cols, rows, encoding: null });
        } catch {
            throw new PtyError('sandbox_unavailable');
        }
        const master = term?._master ?? term?._socket;
        const slave = term?._slave;
        const slaveFd = slave?._handle?.fd;
        if (!master || typeof master.on !== 'function' || !slave || typeof slave.pause !== 'function' || !Number.isInteger(slaveFd) || slaveFd < 0
            || typeof term.resize !== 'function') {
            try { slave?.destroy?.(); } catch { /* closed */ }
            try { master?.destroy?.(); } catch { /* closed */ }
            throw new PtyError('sandbox_unavailable');
        }
        // The worker must never read the shell's input.
        slave.pause();
        slave.removeAllListeners?.('data');
        slave.on?.('error', () => {});
        // EIO when the last slave holder closes (the shell exited): an expected end, never an uncaught error.
        master.on('error', () => {});
        const bytes = { input: 0, output: 0 };
        const dataListeners = [];
        // Output produced before the first subscriber (the shell's first prompt, while the launch finishes) is held, bounded, and handed
        // to that subscriber; above the bound the master is paused until then.
        let early = [];
        let earlyBytes = 0;
        let earlyPaused = false;
        master.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes.output += buffer.length;
            if (dataListeners.length === 0) {
                early.push(buffer);
                earlyBytes += buffer.length;
                if (earlyBytes >= EARLY_OUTPUT_BYTES && !earlyPaused) { earlyPaused = true; master.pause(); }
                return;
            }
            for (const fn of dataListeners) fn(buffer);
        });
        let slaveOpen = true;
        let closed = false;
        return {
            slaveFd,
            bytes,
            onData(fn) {
                dataListeners.push(fn);
                if (dataListeners.length === 1) {
                    const held = early;
                    early = [];
                    earlyBytes = 0;
                    // Resume only what this hold paused, before the flush, so the subscriber's own flow control has the last word.
                    if (earlyPaused && !closed) { earlyPaused = false; master.resume(); }
                    for (const buffer of held) fn(buffer);
                }
            },
            write(buffer, callback = () => {}) {
                if (closed) { callback(new PtyError('closed')); return; }
                bytes.input += buffer.length;
                try { master.write(buffer, (error) => callback(error ? new PtyError('write') : null)); } catch { callback(new PtyError('write')); }
            },
            resize(cols, rowsCount) {
                if (closed) return;
                try { term.resize(cols, rowsCount); } catch { /* a closing PTY */ }
            },
            pause() { if (!closed) master.pause(); },
            resume() { if (!closed) master.resume(); },
            // Closes the worker's copy of the slave; call once the launch has duplicated it into the sandbox (or failed).
            destroySlave() {
                if (!slaveOpen) return;
                slaveOpen = false;
                try { slave.destroy(); } catch { /* closed */ }
            },
            // Closes the master (the shell's session gets SIGHUP) and the slave copy if still open.
            close() {
                this.destroySlave();
                if (closed) return;
                closed = true;
                try { master.destroy(); } catch { /* closed */ }
            }
        };
    }

    return Object.freeze({ available, open, moduleDir });
}

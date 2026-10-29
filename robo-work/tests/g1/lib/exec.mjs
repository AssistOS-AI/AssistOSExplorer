// Small process helpers for G1 probes. Every result is recorded verbatim (exit status, signal, spawn error, output),
// so a probe never turns a failed command into an absent observation.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUTPUT_LIMIT = 8 * 1024 * 1024;

export function run(command, args = [], { input, timeoutMs = 30000, env } = {}) {
    const result = spawnSync(command, args, {
        input,
        timeout: timeoutMs,
        encoding: 'utf8',
        env: env ?? process.env,
        maxBuffer: OUTPUT_LIMIT,
    });
    return {
        command: [command, ...args].join(' '),
        rc: typeof result.status === 'number' ? result.status : null,
        signal: result.signal ?? null,
        error: result.error ? (result.error.code ?? result.error.message) : null,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };
}

// Resolve a tool on PATH without running it.
export function which(name, pathEnv = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin') {
    for (const dir of pathEnv.split(':').filter(Boolean)) {
        const candidate = path.join(dir, name);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
            // not in this directory
        }
    }
    return null;
}

export function accessResult(file, mode) {
    try {
        fs.accessSync(file, mode);
        return { ok: true, errno: null };
    } catch (error) {
        return { ok: false, errno: error.code ?? 'ERR' };
    }
}

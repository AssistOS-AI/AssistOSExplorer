import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assertSafeAchillesPrivatePath, ensureSafeAchillesPrivateDirectory } from './privateDataRoot.mjs';

// Best-effort JSONL diagnostics for the copilot runtime. Every record goes to stderr and to
// <workingDir>/.roboteam/logs/copilot-diagnostics.jsonl (mode 0600). Logging never throws and
// never changes the caller's behaviour. Callers pass safe fields only: no tokens, cookies,
// message text or file contents.
export const COPILOT_DIAGNOSTICS_RELATIVE_PATH = path.join('logs', 'copilot-diagnostics.jsonl');
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const files = new Map();

/** Short, non-reversible identifier for a token; never log the token itself. */
export function tokenPrefix(token) {
    if (typeof token !== 'string' || !token) return null;
    return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

/** code, message and stack of any thrown value, truncated. */
export function errorFields(error) {
    try {
        return {
            code: error?.code ?? null,
            name: error?.name ?? null,
            message: String(error?.message ?? error).slice(0, MAX_MESSAGE),
            stack: typeof error?.stack === 'string' ? error.stack.slice(0, MAX_STACK) : null,
        };
    } catch {
        return { code: null, name: null, message: 'unprintable error', stack: null };
    }
}

function diagnosticsFile(workingDir) {
    const key = path.resolve(workingDir);
    if (files.has(key)) return files.get(key);
    ensureSafeAchillesPrivateDirectory(workingDir, 'logs');
    const file = assertSafeAchillesPrivatePath(workingDir, COPILOT_DIAGNOSTICS_RELATIVE_PATH,
        { type: 'file', label: 'Copilot diagnostics log' });
    files.set(key, file);
    return file;
}

function appendLine(workingDir, line) {
    let fd;
    try {
        const file = diagnosticsFile(workingDir);
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeSync(fd, line);
    } catch {
        files.delete(path.resolve(workingDir));
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    }
}

/** Write one record; returns the record, or null when logging is disabled. Never throws. */
export function logDiagnostic(workingDir, event, fields = {}) {
    try {
        if (process.env.ROBOTEAM_COPILOT_DIAGNOSTICS === '0') return null;
        const record = { ts: new Date().toISOString(), pid: process.pid,
            mono: Math.round(performance.now() * 1000) / 1000, event: String(event), ...fields };
        let line;
        try { line = `${JSON.stringify(record)}\n`; }
        catch { line = `${JSON.stringify({ ts: record.ts, pid: record.pid, mono: record.mono, event: record.event, unserializable: true })}\n`; }
        try { process.stderr.write(line); } catch { /* best effort */ }
        if (typeof workingDir === 'string' && workingDir) appendLine(workingDir, line);
        return record;
    } catch {
        return null;
    }
}

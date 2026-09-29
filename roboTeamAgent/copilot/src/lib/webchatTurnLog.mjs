import { assertSafeAchillesPrivatePath } from './privateDataRoot.mjs';
import fs from 'node:fs';
import path from 'node:path';

// Per-turn conversation logs live beside the session store so the RoboTeam
// agent HTTP endpoint can locate them from the session id alone. They are not
// part of the session payload and are only read on demand.
export function webchatTurnLogPath(workingDir, sessionId, messageId) {
    return path.join(workingDir, '.achilles-cli', 'logs', sessionId, `${messageId}.log`);
}

export function writeWebchatTurnLog(workingDir, sessionId, messageId, lines) {
    const entries = (Array.isArray(lines) ? lines : []).map((line) => String(line ?? '').trim()).filter(Boolean);
    if (!entries.length) return null;
    const directory = path.dirname(webchatTurnLogPath(workingDir, sessionId, messageId));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(path.join(directory, '.gitignore'), '*\n', { mode: 0o600 }); } catch { /* best effort */ }
    const file = webchatTurnLogPath(workingDir, sessionId, messageId);
    fs.writeFileSync(file, `${entries.join('\n')}\n`, { mode: 0o600 });
    return file;
}

export function webchatTurnLogUrl(base, sessionId, messageId) {
    const root = String(base || '').replace(/\/+$/, '');
    if (!root) return '';
    return `${root}/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}`;
}

export function appendWebchatTurnLog(workingDir, sessionId, messageId, text) {
    if (![sessionId, messageId].every(id => /^[a-f0-9-]{36}$/.test(id))) throw new Error('Invalid turn log identity');
    for (const relative of ['logs', `logs/${sessionId}`]) {
        const directory = assertSafeAchillesPrivatePath(workingDir, relative, { type: 'directory' });
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const file = assertSafeAchillesPrivatePath(workingDir, `logs/${sessionId}/${messageId}.log`, { type: 'file' });
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
        const start = fs.fstatSync(fd).size;
        fs.writeFileSync(fd, text);
        return start;
    } finally { fs.closeSync(fd); }
}

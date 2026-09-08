import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    getCurrentSessionId,
    setCurrentSessionId,
} from './achillesSettings.mjs';
import {
    assertSafeAchillesPrivatePath,
    ensureAchillesPrivateDataRoot,
} from './privateDataRoot.mjs';
import { withWorkspaceMutation } from './workspaceStateLock.mjs';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^task_[0-9a-f]{24}$/;
const SESSION_STORE_GITIGNORE = '*\n!.gitignore\n';

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertRegularFileOrMissing(filePath) {
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('unsafe_session_file');
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function assertSessionId(sessionId) {
    const normalized = String(sessionId || '').trim().toLowerCase();
    if (!SESSION_ID_RE.test(normalized)) throw new Error('invalid_session_id');
    return normalized;
}

function atomicWriteJson(filePath, value) {
    assertRegularFileOrMissing(filePath);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
        });
        assertRegularFileOrMissing(filePath);
        fs.renameSync(temporaryPath, filePath);
    } finally {
        try {
            fs.unlinkSync(temporaryPath);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

function legacyMessageId(sessionId, index) {
    const bytes = crypto.createHash('sha256').update(`${sessionId}:${index}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeConversationMessage(raw, sessionId, index) {
    if (!raw || typeof raw !== 'object') throw new Error('invalid_session_message');
    if (raw.type === 'task') {
        const taskId = String(raw.taskId || '').trim();
        if (!TASK_ID_RE.test(taskId)) throw new Error('invalid_session_task');
        return { type: 'task', taskId };
    }
    const role = raw.role === 'user' ? 'user' : (raw.role === 'assistant' ? 'assistant' : '');
    if (!role) throw new Error('invalid_session_message');
    const message = {
        id: raw.id === undefined ? legacyMessageId(sessionId, index) : assertSessionId(raw.id),
        role,
        text: typeof raw.text === 'string' ? raw.text : '',
        timestamp: typeof raw.timestamp === 'string' && Number.isFinite(Date.parse(raw.timestamp))
            ? raw.timestamp
            : new Date(0).toISOString(),
        attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
        references: Array.isArray(raw.references) ? raw.references : [],
    };
    if (role === 'assistant' && Array.isArray(raw.progress)) {
        message.progress = raw.progress
            .filter((entry) => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    if (raw.context === false) message.context = false;
    if (raw.turnId !== undefined) {
        if (typeof raw.turnId !== 'string' || !raw.turnId.trim()) throw new Error('invalid_turn_id');
        message.turnId = raw.turnId;
    }
    if (raw.status !== undefined) {
        if (!['pending', 'completed', 'failed', 'interrupted'].includes(raw.status)) {
            throw new Error('invalid_message_status');
        }
        message.status = raw.status;
    }
    return message;
}

function normalizeEngine(raw, sessionId) {
    if (!raw || raw.type !== 'ala' || raw.version !== 1
        || assertSessionId(raw.sessionId) !== sessionId
        || typeof raw.home !== 'string' || !path.isAbsolute(raw.home)
        || typeof raw.cwd !== 'string' || !path.isAbsolute(raw.cwd)
        || (raw.backend !== null && !['codex', 'opencode', 'pi'].includes(raw.backend))) {
        throw new Error('invalid_session_engine');
    }
    return { type: 'ala', version: 1, sessionId, home: raw.home, cwd: raw.cwd, backend: raw.backend };
}

function normalizeSession(raw, expectedId = '') {
    if (!raw || typeof raw !== 'object') throw new Error('invalid_session_file');
    const sessionId = assertSessionId(raw.sessionId);
    if (expectedId && sessionId !== assertSessionId(expectedId)) throw new Error('invalid_session_file');
    if (!Array.isArray(raw.messages)) throw new Error('invalid_session_messages');
    const messages = raw.messages.map((message, index) => normalizeConversationMessage(message, sessionId, index));
    const ids = new Set();
    for (const message of messages) {
        if (!message.id) continue;
        if (ids.has(message.id)) throw new Error('duplicate_session_message_id');
        ids.add(message.id);
    }
    const createdAt = typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt))
        ? raw.createdAt
        : new Date(0).toISOString();
    const updatedAt = typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt))
        ? raw.updatedAt
        : createdAt;
    return {
        sessionId,
        createdAt,
        updatedAt,
        messages,
        ...(raw.cwd && path.isAbsolute(raw.cwd) ? { cwd: raw.cwd } : {}),
        ...(raw.skillSelection ? { skillSelection: structuredClone(raw.skillSelection) } : {}),
        ...(raw.engine === undefined ? {} : { engine: normalizeEngine(raw.engine, sessionId) }),
    };
}

function formatHistoryMessage(message) {
    const parts = [String(message?.text || '').trim()];
    if (message?.attachments?.length) {
        parts.push(`Attachments: ${JSON.stringify(message.attachments)}`);
    }
    if (message?.references?.length) {
        parts.push(`References: ${JSON.stringify(message.references)}`);
    }
    return parts.filter(Boolean).join('\n\n');
}

export function summarizeConversationSession(session) {
    const firstUser = session?.messages?.find((message) => (
        message?.role === 'user' && String(message.text || '').trim()
    ));
    const preview = String(firstUser?.text || 'New session').replace(/\s+/g, ' ').trim();
    return {
        sessionId: session.sessionId,
        preview: preview.length > 96 ? `${preview.slice(0, 93)}...` : preview,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        hasHistory: session.messages.some((message) => (
            message?.role === 'user' || (message?.role === 'assistant' && String(message.text || '').trim())
        )),
    };
}

export function buildConversationInitialHistory(session) {
    if (session?.engine) return [];
    const history = [];
    for (const message of session?.messages || []) {
        if (message?.type === 'task' || message?.context === false) continue;
        const role = message?.role === 'user'
            ? 'user'
            : (message?.role === 'assistant' ? 'assistant' : '');
        const formatted = formatHistoryMessage(message);
        if (role && formatted) history.push({ role, message: formatted });
    }
    return history;
}

export class ConversationSessionStore {
    constructor({ workingDir = process.cwd() } = {}) {
        this.workingDir = fs.realpathSync(path.resolve(workingDir));
        this.sessionsDirectory = this.#validateDirectory();
        this.currentSessionId = null;
        this.startupSelectionRead = false;
    }

    #validateDirectory() {
        return assertSafeAchillesPrivatePath(this.workingDir, 'sessions', {
            label: 'AchillesCLI sessions directory',
            type: 'directory',
        });
    }

    #ensureDirectory() {
        ensureAchillesPrivateDataRoot(this.workingDir);
        this.#validateDirectory();
        fs.mkdirSync(this.sessionsDirectory, { recursive: true, mode: 0o700 });
        const gitignorePath = assertSafeAchillesPrivatePath(this.workingDir, 'sessions/.gitignore', {
            label: 'AchillesCLI session metadata file',
            type: 'file',
        });
        if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, SESSION_STORE_GITIGNORE, {
                encoding: 'utf8', mode: 0o600, flag: 'wx',
            });
        }
    }

    sessionPath(sessionId) {
        const normalized = assertSessionId(sessionId);
        this.#validateDirectory();
        const filePath = path.join(this.sessionsDirectory, `${normalized}.json`);
        if (!isInside(this.sessionsDirectory, filePath)) throw new Error('invalid_session_id');
        return assertSafeAchillesPrivatePath(this.workingDir, `sessions/${normalized}.json`, {
            label: 'AchillesCLI session file',
            type: 'file',
        });
    }

    #readSession(sessionId) {
        const normalized = assertSessionId(sessionId);
        const filePath = this.sessionPath(normalized);
        assertRegularFileOrMissing(filePath);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return { raw, session: normalizeSession(raw, normalized) };
    }

    loadSession(sessionId) {
        return this.#readSession(sessionId).session;
    }

    // Called only inside a workspace mutation. Persist legacy IDs before any
    // insertion/removal can change their original positions.
    #loadMigratedSession(sessionId) {
        const { raw, session } = this.#readSession(sessionId);
        if (raw.messages.some((message) => message.type !== 'task' && message.id === undefined)) {
            atomicWriteJson(this.sessionPath(session.sessionId), session);
        }
        return session;
    }

    async createSession({ sessionId = crypto.randomUUID(), select = true } = {}) {
        return withWorkspaceMutation(this.workingDir, async () => {
            this.#ensureDirectory();
            const now = new Date().toISOString();
            sessionId = assertSessionId(sessionId);
            if (fs.existsSync(this.sessionPath(sessionId))) throw new Error('session_already_exists');
            const session = { sessionId, createdAt: now, updatedAt: now, messages: [], cwd: this.workingDir };
            atomicWriteJson(this.sessionPath(session.sessionId), session);
            if (select) await setCurrentSessionId(this.workingDir, session.sessionId);
            this.currentSessionId = session.sessionId;
            this.startupSelectionRead = true;
            return session;
        });
    }

    async ensureCurrentSession() {
        return withWorkspaceMutation(this.workingDir, async () => {
            if (this.currentSessionId) return this.#loadMigratedSession(this.currentSessionId);
            this.#ensureDirectory();
            if (!this.startupSelectionRead) {
                this.startupSelectionRead = true;
                const startupId = getCurrentSessionId(this.workingDir);
                if (startupId) {
                    this.currentSessionId = startupId;
                    try {
                        const session = this.#loadMigratedSession(startupId);
                        if (!session.cwd || session.cwd === this.workingDir) return session;
                        this.currentSessionId = null;
                    } catch (error) {
                        // Only a missing startup record is repairable. Corrupt
                        // or unsafe data is surfaced without replacing it.
                        if (error?.code !== 'ENOENT') throw error;
                        this.currentSessionId = null;
                    }
                }
            }
            return this.createSession();
        });
    }

    async resumeSession(sessionId) {
        return withWorkspaceMutation(this.workingDir, async () => {
            const session = this.#loadMigratedSession(sessionId);
            await setCurrentSessionId(this.workingDir, session.sessionId);
            this.currentSessionId = session.sessionId;
            this.startupSelectionRead = true;
            return session;
        });
    }

    listSessions(currentSessionId = this.currentSessionId) {
        const marker = currentSessionId ? assertSessionId(currentSessionId) : null;
        const sessions = [];
        this.#validateDirectory();
        let entries;
        try {
            entries = fs.readdirSync(this.sessionsDirectory, { withFileTypes: true });
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            entries = [];
        }
        for (const entry of entries) {
            if (!entry.name.endsWith('.json')) continue;
            const sessionId = entry.name.slice(0, -5);
            if (!SESSION_ID_RE.test(sessionId)) continue;
            try {
                sessions.push(summarizeConversationSession(this.loadSession(sessionId)));
            } catch (cause) {
                throw new Error(`Unable to read conversation ${sessionId}: ${cause.message}`, { cause });
            }
        }
        sessions.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
        return {
            currentSessionId: marker,
            current: sessions.find((session) => session.sessionId === marker) || null,
            sessions,
        };
    }

    async updateSession(sessionId, updater) {
        return withWorkspaceMutation(this.workingDir, () => {
            const session = this.#loadMigratedSession(sessionId);
            const result = updater(session);
            if (result && typeof result.then === 'function') throw new Error('session_updater_must_be_synchronous');
            session.updatedAt = new Date().toISOString();
            const normalized = normalizeSession(session, sessionId);
            atomicWriteJson(this.sessionPath(normalized.sessionId), normalized);
            return normalized;
        });
    }

    async bindEngine(sessionId, { home, cwd, backend = null } = {}) {
        const canonicalDirectory = (directory) => {
            if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('invalid_engine_directory');
            const real = fs.realpathSync(directory);
            if (!fs.statSync(real).isDirectory()) throw new Error('invalid_engine_directory');
            return real;
        };
        const engine = normalizeEngine({
            type: 'ala', version: 1, sessionId,
            home: canonicalDirectory(home), cwd: canonicalDirectory(cwd), backend,
        }, assertSessionId(sessionId));
        return withWorkspaceMutation(this.workingDir, () => {
            const session = this.loadSession(sessionId);
            if (session.engine) {
                for (const field of ['sessionId', 'home', 'cwd']) {
                    if (session.engine[field] !== engine[field]) throw new Error(`session_engine_${field}_mismatch`);
                }
                if (session.engine.backend && engine.backend && session.engine.backend !== engine.backend) {
                    throw new Error('session_engine_backend_mismatch');
                }
                engine.backend = session.engine.backend || engine.backend;
            }
            return this.updateSession(sessionId, (record) => { record.engine = engine; });
        });
    }

    async beginTurn({ sessionId, text = '', attachments = [], references = [], context = true, turnId } = {}) {
        assertSessionId(sessionId);
        const userMessageId = crypto.randomUUID();
        const assistantMessageId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const session = await this.updateSession(sessionId, (record) => {
            const metadata = {
                timestamp,
                ...(context === false ? { context: false } : {}),
                ...(turnId === undefined ? {} : { turnId }),
            };
            record.messages.push({
                ...metadata, id: userMessageId, role: 'user',
                text: typeof text === 'string' ? text : '',
                attachments: Array.isArray(attachments) ? attachments : [],
                references: Array.isArray(references) ? references : [],
            }, {
                ...metadata, id: assistantMessageId, role: 'assistant', text: '',
                attachments: [], references: [], progress: [], status: 'pending',
            });
        });
        return { session, userMessageId, assistantMessageId };
    }

    async beginCommand(options = {}) {
        return this.beginTurn({ ...options, context: false });
    }

    #assistant(record, messageId) {
        const message = typeof messageId === 'string'
            ? record.messages.find((entry) => entry.id === messageId && entry.role === 'assistant')
            : null;
        if (!message) throw new Error('assistant_message_not_found');
        return message;
    }

    async appendProgress(sessionId, assistantMessageId, reason) {
        const progress = String(reason || '').trim();
        return this.updateSession(sessionId, (record) => {
            const message = this.#assistant(record, assistantMessageId);
            if (!progress) return;
            if (!Array.isArray(message.progress)) message.progress = [];
            message.progress.push(progress);
        });
    }

    async completeTurn(sessionId, assistantMessageId, text, { status = 'completed' } = {}) {
        if (!['completed', 'failed', 'interrupted'].includes(status)) throw new Error('invalid_message_status');
        return this.updateSession(sessionId, (record) => {
            const message = this.#assistant(record, assistantMessageId);
            message.text = typeof text === 'string' ? text : String(text ?? '');
            message.status = status;
        });
    }

    async completeCommand(sessionId, assistantMessageId, text) {
        const output = typeof text === 'string' ? text : String(text ?? '');
        return this.updateSession(sessionId, (record) => {
            const message = this.#assistant(record, assistantMessageId);
            if (message.context !== false) throw new Error('command_message_not_found');
            if (output || message.progress?.length) {
                message.text = output;
                message.status = 'completed';
            } else {
                record.messages.splice(record.messages.indexOf(message), 1);
            }
        });
    }

    async insertTask(sessionId, assistantMessageId, taskId) {
        const normalizedTaskId = String(taskId || '').trim();
        if (!TASK_ID_RE.test(normalizedTaskId)) throw new Error('invalid_task_id');
        const session = await this.updateSession(sessionId, (record) => {
            const assistant = this.#assistant(record, assistantMessageId);
            if (record.messages.some((message) => message.type === 'task' && message.taskId === normalizedTaskId)) return;
            let insertion = record.messages.indexOf(assistant) + 1;
            while (record.messages[insertion]?.type === 'task') insertion += 1;
            record.messages.splice(insertion, 0, { type: 'task', taskId: normalizedTaskId });
        });
        return { session, taskId: normalizedTaskId };
    }
}

export const __testables = {
    assertSessionId,
    normalizeSession,
};

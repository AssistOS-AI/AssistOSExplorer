import crypto from 'node:crypto';
import { withoutSummaryMarkers } from '../../../../shared/impact-summary.mjs';
import fs from 'node:fs';
import path from 'node:path';

import {
    getCurrentSessionId,
    setCurrentSessionId,
} from '../config/achillesSettings.mjs';
import { alaTranscript, alaSessionsRoot } from '../execution/alaTranscript.mjs';
import {
    assertSafeAchillesPrivatePath,
    ensureAchillesPrivateDataRoot,
} from './privateDataRoot.mjs';
import { withWorkspaceMutation } from './workspaceStateLock.mjs';

// A RoboTeam conversation has two files with the same session id:
//  - .roboteam/.ala/sessions/<id>.jsonl, written and read only by ALA, holds
//    the user messages, intermediate coding-agent output and final answers;
//  - .roboteam/sessions/<id>.json, owned here, holds everything else: turn
//    identities, attachments, references, slash-command turns, task cards,
//    skill policy and the engine binding.
// loadSession() combines them into the message list the UI renders.

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^task_[0-9a-f]{24}$/;
const METADATA_VERSION = 2;
const STATUSES = ['pending', 'completed', 'failed', 'interrupted'];
const METADATA_FIELDS = ['skillPolicyRef', 'legacySkillSelection', 'skillSelection', 'skillExecution', 'previousSkillExecution'];

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

function validTimestamp(value, fallback) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
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

function normalizeEngine(raw, sessionId) {
    if (!raw || raw.type !== 'ala' || raw.version !== 1
        || assertSessionId(raw.sessionId) !== sessionId
        || typeof raw.home !== 'string' || !path.isAbsolute(raw.home)
        || typeof raw.cwd !== 'string' || !path.isAbsolute(raw.cwd)
        || (raw.backend !== null && !['codex', 'opencode', 'pi', 'claude'].includes(raw.backend))) {
        throw new Error('invalid_session_engine');
    }
    if (raw.robotId !== undefined && !/^[a-z0-9][a-z0-9-]{2,63}$/.test(raw.robotId)) throw new Error('invalid_session_robot');
    return { type: 'ala', version: 1, sessionId, home: raw.home, cwd: raw.cwd, backend: raw.backend,
        ...(raw.robotId ? { robotId: raw.robotId } : {}) };
}

function normalizeTurn(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.turnId !== 'string' || !raw.turnId.trim()) throw new Error('invalid_turn_id');
    const turn = {
        turnId: raw.turnId,
        userMessageId: assertSessionId(raw.userMessageId),
        assistantMessageId: assertSessionId(raw.assistantMessageId),
        timestamp: validTimestamp(raw.timestamp, new Date(0).toISOString()),
        attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
        references: Array.isArray(raw.references) ? raw.references : [],
        tasks: Array.isArray(raw.tasks) ? raw.tasks.filter((taskId) => TASK_ID_RE.test(taskId)) : [],
    };
    if (raw.context === false) turn.context = false;
    if (raw.status !== undefined) {
        if (!STATUSES.includes(raw.status)) throw new Error('invalid_message_status');
        turn.status = raw.status;
    }
    if (Number.isSafeInteger(raw.durationMs) && raw.durationMs >= 0) turn.durationMs = raw.durationMs;
    // userText/text are RoboTeam-owned: slash-command turns, and turns that
    // failed before ALA recorded anything.
    for (const field of ['userText', 'text', 'thinkingUrl']) if (typeof raw[field] === 'string') turn[field] = raw[field];
    return turn;
}

function normalizeMetadata(raw, expectedId = '') {
    if (!raw || typeof raw !== 'object' || raw.version !== METADATA_VERSION) throw new Error('invalid_session_file');
    const sessionId = assertSessionId(raw.sessionId);
    if (expectedId && sessionId !== assertSessionId(expectedId)) throw new Error('invalid_session_file');
    if (!Array.isArray(raw.turns)) throw new Error('invalid_session_turns');
    const turns = raw.turns.map(normalizeTurn);
    const ids = new Set();
    for (const turn of turns) {
        for (const id of [turn.turnId, turn.userMessageId, turn.assistantMessageId]) {
            if (ids.has(id)) throw new Error('duplicate_session_message_id');
            ids.add(id);
        }
    }
    const createdAt = validTimestamp(raw.createdAt, new Date(0).toISOString());
    return {
        version: METADATA_VERSION,
        sessionId,
        createdAt,
        updatedAt: validTimestamp(raw.updatedAt, createdAt),
        turns,
        ...(raw.cwd && path.isAbsolute(raw.cwd) ? { cwd: raw.cwd } : {}),
        ...Object.fromEntries(METADATA_FIELDS.filter((key) => raw[key] !== undefined).map((key) => [key, structuredClone(raw[key])])),
        ...(raw.engine === undefined ? {} : { engine: normalizeEngine(raw.engine, sessionId) }),
    };
}

const ALA_STATUS = { completed: 'completed', failed: 'failed', interrupted: 'interrupted' };

function withThinkingLink(text, url) {
    return url ? `${text}\n\n[View Thinking](${url})` : text;
}

// Build the UI message list from RoboTeam turns and the ALA transcript.
function buildMessages(metadata, alaSession, pendingText) {
    const alaTurns = new Map((alaSession?.turns || []).map((turn) => [turn.turnId, turn]));
    const messages = [];
    for (const turn of metadata.turns) {
        const ala = turn.context === false ? null : alaTurns.get(turn.turnId);
        const shared = { timestamp: turn.timestamp, turnId: turn.turnId, ...(turn.context === false ? { context: false } : {}) };
        messages.push({ ...shared, id: turn.userMessageId, role: 'user',
            text: ala?.user ?? turn.userText ?? pendingText.get(turn.turnId) ?? '',
            attachments: turn.attachments, references: turn.references });
        const status = turn.status || ALA_STATUS[ala?.status] || 'pending';
        // Human-report markers stay in the transcript and View Thinking, not in the chat.
        const text = ala?.final !== null && ala?.final !== undefined && turn.context !== false
            ? withThinkingLink(withoutSummaryMarkers(ala.final), turn.thinkingUrl)
            : withoutSummaryMarkers(turn.text ?? '');
        const durationMs = turn.durationMs ?? ala?.durationMs;
        // A slash command without visible output keeps only its input.
        const silentCommand = turn.context === false && turn.status === 'completed' && !turn.text;
        if (!silentCommand) messages.push({ ...shared, id: turn.assistantMessageId, role: 'assistant', text,
            attachments: [], references: [], progress: [], status,
            ...(Number.isSafeInteger(durationMs) ? { durationMs } : {}) });
        for (const taskId of turn.tasks) messages.push({ type: 'task', taskId });
    }
    return messages;
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
    #pendingUserText = new Map();

    constructor({ workingDir = process.cwd() } = {}) {
        this.workingDir = fs.realpathSync(path.resolve(workingDir));
        this.sessionsDirectory = this.#validateDirectory();
        this.currentSessionId = null;
        this.startupSelectionRead = false;
    }

    #validateDirectory() {
        return assertSafeAchillesPrivatePath(this.workingDir, 'sessions', {
            label: 'RoboTeam sessions directory',
            type: 'directory',
        });
    }

    #ensureDirectory() {
        ensureAchillesPrivateDataRoot(this.workingDir);
        this.#validateDirectory();
        fs.mkdirSync(this.sessionsDirectory, { recursive: true, mode: 0o700 });
    }

    sessionPath(sessionId) {
        const normalized = assertSessionId(sessionId);
        this.#validateDirectory();
        const filePath = path.join(this.sessionsDirectory, `${normalized}.json`);
        if (!isInside(this.sessionsDirectory, filePath)) throw new Error('invalid_session_id');
        return assertSafeAchillesPrivatePath(this.workingDir, `sessions/${normalized}.json`, {
            label: 'RoboTeam session file',
            type: 'file',
        });
    }

    #readMetadata(sessionId) {
        const normalized = assertSessionId(sessionId);
        const filePath = this.sessionPath(normalized);
        assertRegularFileOrMissing(filePath);
        return normalizeMetadata(JSON.parse(fs.readFileSync(filePath, 'utf8')), normalized);
    }

    #writeMetadata(metadata) {
        const normalized = normalizeMetadata(metadata, metadata.sessionId);
        atomicWriteJson(this.sessionPath(normalized.sessionId), normalized);
        return normalized;
    }

    // The ALA transcript lives in the conversation's working folder.
    #alaSession(metadata) {
        const cwd = metadata.engine?.cwd || metadata.cwd || this.workingDir;
        try { return alaTranscript.readSessionSync(alaSessionsRoot(cwd), metadata.sessionId); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }

    #compose(metadata) {
        const alaSession = this.#alaSession(metadata);
        const { version: _version, turns: _turns, ...fields } = metadata;
        const updatedAt = alaSession && alaSession.updatedAt > metadata.updatedAt ? alaSession.updatedAt : metadata.updatedAt;
        return { ...structuredClone(fields), updatedAt, messages: buildMessages(metadata, alaSession, this.#pendingUserText) };
    }

    loadSession(sessionId) {
        return this.#compose(this.#readMetadata(sessionId));
    }

    async createSession({ sessionId = crypto.randomUUID(), select = true } = {}) {
        return withWorkspaceMutation(this.workingDir, async () => {
            this.#ensureDirectory();
            const now = new Date().toISOString();
            sessionId = assertSessionId(sessionId);
            if (fs.existsSync(this.sessionPath(sessionId))) throw new Error('session_already_exists');
            const metadata = this.#writeMetadata({ version: METADATA_VERSION, sessionId, createdAt: now, updatedAt: now, turns: [], cwd: this.workingDir });
            if (select) await setCurrentSessionId(this.workingDir, sessionId);
            this.currentSessionId = sessionId;
            this.startupSelectionRead = true;
            return this.#compose(metadata);
        });
    }

    async ensureCurrentSession() {
        return withWorkspaceMutation(this.workingDir, async () => {
            if (this.currentSessionId) return this.loadSession(this.currentSessionId);
            this.#ensureDirectory();
            if (!this.startupSelectionRead) {
                this.startupSelectionRead = true;
                const startupId = getCurrentSessionId(this.workingDir);
                if (startupId) {
                    this.currentSessionId = startupId;
                    try {
                        const session = this.loadSession(startupId);
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
            const session = this.loadSession(sessionId);
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

    async #updateMetadata(sessionId, updater) {
        return withWorkspaceMutation(this.workingDir, () => {
            const metadata = this.#readMetadata(sessionId);
            updater(metadata);
            metadata.updatedAt = new Date().toISOString();
            return this.#compose(this.#writeMetadata(metadata));
        });
    }

    // Updates the RoboTeam-owned session fields (skill policy, selection). The
    // composed messages are read-only here: conversation text belongs to ALA.
    async updateSession(sessionId, updater) {
        return this.#updateMetadata(sessionId, (metadata) => {
            const session = this.#compose(metadata);
            const result = updater(session);
            if (result && typeof result.then === 'function') throw new Error('session_updater_must_be_synchronous');
            for (const key of METADATA_FIELDS) {
                if (session[key] === undefined) delete metadata[key];
                else metadata[key] = structuredClone(session[key]);
            }
        });
    }

    async bindEngine(sessionId, { home, cwd, backend = null, robotId } = {}) {
        const canonicalDirectory = (directory) => {
            if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('invalid_engine_directory');
            const real = fs.realpathSync(directory);
            if (!fs.statSync(real).isDirectory()) throw new Error('invalid_engine_directory');
            return real;
        };
        const engine = normalizeEngine({
            type: 'ala', version: 1, sessionId,
            home: canonicalDirectory(home), cwd: canonicalDirectory(cwd), backend, ...(robotId ? { robotId } : {}),
        }, assertSessionId(sessionId));
        return this.#updateMetadata(sessionId, (metadata) => {
            if (metadata.engine) {
                for (const field of ['sessionId', 'home', 'cwd']) {
                    if (metadata.engine[field] !== engine[field]) throw new Error(`session_engine_${field}_mismatch`);
                }
                if (metadata.engine.backend && engine.backend && metadata.engine.backend !== engine.backend) {
                    throw new Error('session_engine_backend_mismatch');
                }
                if (metadata.engine.robotId && metadata.engine.robotId !== robotId) throw new Error('session_engine_robot_mismatch');
                engine.backend = metadata.engine.backend || engine.backend;
            }
            metadata.engine = engine;
        });
    }

    // Registers a turn. For a conversation turn the user text is held in memory
    // only until ALA records it in the transcript.
    async beginTurn({ sessionId, text = '', attachments = [], references = [], context = true, turnId = crypto.randomUUID() } = {}) {
        assertSessionId(sessionId);
        const userMessageId = crypto.randomUUID();
        const assistantMessageId = crypto.randomUUID();
        const userText = typeof text === 'string' ? text : '';
        if (context !== false) this.#pendingUserText.set(turnId, userText);
        const session = await this.#updateMetadata(sessionId, (metadata) => {
            metadata.turns.push({
                turnId, userMessageId, assistantMessageId, timestamp: new Date().toISOString(),
                attachments: Array.isArray(attachments) ? attachments : [],
                references: Array.isArray(references) ? references : [],
                tasks: [],
                ...(context === false ? { context: false, userText } : {}),
            });
        });
        return { session, userMessageId, assistantMessageId };
    }

    async beginCommand(options = {}) {
        return this.beginTurn({ ...options, context: false });
    }

    #turn(metadata, assistantMessageId) {
        const turn = typeof assistantMessageId === 'string'
            ? metadata.turns.find((entry) => entry.assistantMessageId === assistantMessageId)
            : null;
        if (!turn) throw new Error('assistant_message_not_found');
        return turn;
    }

    // The answer text of a completed turn is ALA's final record. RoboTeam keeps
    // only the outcome, and its own error text when the turn did not complete.
    async completeTurn(sessionId, assistantMessageId, text, { status = 'completed', durationMs, thinkingUrl } = {}) {
        if (!['completed', 'failed', 'interrupted'].includes(status)) throw new Error('invalid_message_status');
        return this.#updateMetadata(sessionId, (metadata) => {
            const turn = this.#turn(metadata, assistantMessageId);
            turn.status = status;
            if (Number.isSafeInteger(durationMs) && durationMs >= 0) turn.durationMs = durationMs;
            if (thinkingUrl) turn.thinkingUrl = thinkingUrl;
            const ala = this.#alaSession(metadata)?.turns.find((entry) => entry.turnId === turn.turnId);
            if (status !== 'completed') turn.text = typeof text === 'string' ? text : String(text ?? '');
            else if (!ala || ala.final === null) turn.text = typeof text === 'string' ? text : String(text ?? '');
            // Keep the user message when ALA never recorded this turn.
            if (!ala?.user && this.#pendingUserText.has(turn.turnId)) turn.userText = this.#pendingUserText.get(turn.turnId);
            this.#pendingUserText.delete(turn.turnId);
        });
    }

    async completeCommand(sessionId, assistantMessageId, text) {
        const output = typeof text === 'string' ? text : String(text ?? '');
        return this.#updateMetadata(sessionId, (metadata) => {
            const turn = this.#turn(metadata, assistantMessageId);
            if (turn.context !== false) throw new Error('command_message_not_found');
            turn.text = output;
            turn.status = 'completed';
        });
    }

    async insertTask(sessionId, assistantMessageId, taskId) {
        const normalizedTaskId = String(taskId || '').trim();
        if (!TASK_ID_RE.test(normalizedTaskId)) throw new Error('invalid_task_id');
        const session = await this.#updateMetadata(sessionId, (metadata) => {
            const turn = this.#turn(metadata, assistantMessageId);
            if (metadata.turns.some((entry) => entry.tasks.includes(normalizedTaskId))) return;
            turn.tasks.push(normalizedTaskId);
        });
        return { session, taskId: normalizedTaskId };
    }

    // The persisted turn record for an assistant message, with its ALA turn.
    turnForMessage(sessionId, assistantMessageId) {
        const metadata = this.#readMetadata(sessionId);
        const turn = this.#turn(metadata, assistantMessageId);
        const ala = turn.context === false ? null
            : this.#alaSession(metadata)?.turns.find((entry) => entry.turnId === turn.turnId) || null;
        return { turn, ala };
    }
}

export const __testables = {
    assertSessionId,
    normalizeMetadata,
    buildMessages,
};

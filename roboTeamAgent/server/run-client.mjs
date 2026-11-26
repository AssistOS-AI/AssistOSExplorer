import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// One window for the whole startup, not one per call: a long outage must not be waited out again for every robot.
// It stays well inside the launcher's ROBOTEAM_STARTUP_WAIT_SECONDS (600 by default).
export const STARTUP_RETRY_WINDOW_MS = 5 * 60_000;
const STARTUP_RETRY_MAX_DELAY_MS = 5000;
// RoboWork answers robot home operations with OPENCODE_MIGRATING while its own startup upgrades homes to OpenCode V2;
// a fresh deployment, with no homes yet, spent about 40 seconds there preparing OpenCode. Only startup calls that cannot
// be deferred wait, and they share one budget that stays well inside the 600 seconds startAgent.sh gives the service by
// default, so a migration that does not finish is reported by this client rather than by the shell's timeout.
const STARTUP_MIGRATION_WAIT_MS = 300000;
const STARTUP_MIGRATION_DELAYS_MS = [1000, 2000, 4000, 5000];
const CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
    'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
// While Ploinky replaces RoboWork, its Router answers a draining route through cookie access, so an agent call gets
// 401 not_authenticated; a gateway answers 502, 503 or 504; and RoboWork's AgentServer answers before its service
// listens, so the tool reports SERVICE_UNAVAILABLE. Retried only during startup, where every call is idempotent.
const STARTUP_TRANSIENT_STATUSES = new Set([401, 502, 503, 504]);

function unavailable(error) {
    if (error?.statusCode !== undefined || error?.status !== undefined) {
        return (error.statusCode ?? error.status) === 503 && error.code === 'TARGET_INACTIVE';
    }
    const seen = new Set();
    for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
        seen.add(cause);
        if (CONNECTION_ERRORS.has(cause.code)) return true;
    }
    return false;
}

export async function loadAgentClient(env = process.env) {
    const root = String(env.PLOINKY_AGENT_LIB_DIR || '/Agent');
    const file = path.join(root, 'client/AgentMcpClient.mjs');
    if (!fs.existsSync(file)) throw new Error('Ploinky agent client is unavailable');
    return (await import(pathToFileURL(file).href)).createAgentClient;
}

// A failed tool reaches the client as an MCP error whose text ends with the tool's JSON report.
function toolFailure(result) {
    const text = result?.content?.find?.(item => item?.type === 'text')?.text;
    const start = typeof text === 'string' ? text.indexOf('{') : -1;
    if (start < 0) return {};
    try { return JSON.parse(text.slice(start)); } catch { return {}; }
}

function toolError(result) {
    const failure = { ...toolFailure(result), ...result };
    return Object.assign(new Error(failure.message || failure.error || 'RoboWork request failed'), {
        code: failure.code || 'ROBOWORK_FAILED', statusCode: failure.statusCode || 502,
    });
}

// Only the status and code reach the log, never a message or payload.
function describe(error) {
    const status = error?.statusCode ?? error?.status;
    const code = typeof error?.code === 'string' ? error.code : null;
    return [status !== undefined ? `status ${status}` : null, code].filter(Boolean).join(' ') || 'connection failure';
}

export class RoboWorkClient {
    constructor({ createClient = null, agentName = 'roboWorkAgent', startupRetry = false, wait = delay,
        startupRetryWindowMs = STARTUP_RETRY_WINDOW_MS, now = Date.now, log = line => console.error(line) } = {}) {
        this.createClient = createClient;
        this.agentName = agentName;
        this.startupRetry = startupRetry;
        this.wait = wait;
        this.now = now;
        this.log = log;
        this.startupDeadline = now() + startupRetryWindowMs;
        this.migrationWaitMs = 0;
    }

    finishStartup() { this.startupRetry = false; }

    // One request. A transport failure is transient when RoboWork is being replaced; a tool failure only when the
    // tool reports that RoboWork's service is not listening. Every other tool failure is RoboWork's real answer.
    async #attempt(create, tool, input, timeoutMs) {
        let result;
        try {
            const client = await create(this.agentName);
            result = await client.callTool(tool, input, { timeoutMs });
        } catch (error) {
            return { error, unavailable: unavailable(error),
                transient: unavailable(error) || STARTUP_TRANSIENT_STATUSES.has(error?.statusCode ?? error?.status) };
        }
        if (!(result?.isError || result?.ok === false)) return { result };
        const error = toolError(result);
        return { error, unavailable: false, transient: error.code === 'SERVICE_UNAVAILABLE' };
    }

    // waitForMigration applies only before finishStartup().
    async call(tool, input = {}, { timeoutMs = 120000, waitForMigration = false } = {}) {
        const create = this.createClient || await loadAgentClient();
        let since = null;
        for (let attempt = 0, migrating = 0; ; attempt++) {
            const outcome = await this.#attempt(create, tool, input, timeoutMs);
            if (!outcome.error) {
                if (since !== null) this.log(`[roboTeamAgent] RoboWork answered ${tool} again after ${Math.round((this.now() - since) / 1000)} s`);
                if (migrating) this.log(`[roboTeamAgent] ${tool} succeeded after RoboWork's OpenCode V2 migration`);
                return outcome.result;
            }
            const remaining = this.startupDeadline - this.now();
            if (this.startupRetry && outcome.transient && remaining > 0) {
                if (since === null) {
                    since = this.now();
                    this.log(`[roboTeamAgent] RoboWork is unavailable during startup (${describe(outcome.error)}); retrying ${tool} until it answers`);
                }
                await this.wait(Math.min(STARTUP_RETRY_MAX_DELAY_MS, 250 * 2 ** Math.min(attempt, 5), remaining));
                continue;
            }
            if (outcome.unavailable) {
                throw Object.assign(new Error('RoboWork is temporarily unavailable; retry this request.', { cause: outcome.error }), {
                    code: 'ROBOWORK_UNAVAILABLE', statusCode: 503, retryable: true,
                });
            }
            // A migration still in progress is waited for; OPENCODE_MIGRATION_FAILED needs an operator and fails at once.
            // The migration budget is separate from the outage window above: OPENCODE_MIGRATING is never transient.
            if (outcome.error.code === 'OPENCODE_MIGRATING' && waitForMigration && this.startupRetry) {
                const left = STARTUP_MIGRATION_WAIT_MS - this.migrationWaitMs;
                if (left > 0) {
                    if (!migrating) this.log(`[roboTeamAgent] ${tool} waits while RoboWork upgrades robot homes to OpenCode V2`);
                    const ms = Math.min(left, STARTUP_MIGRATION_DELAYS_MS[Math.min(migrating++, STARTUP_MIGRATION_DELAYS_MS.length - 1)]);
                    this.migrationWaitMs += ms;
                    await this.wait(ms);
                    continue;
                }
                throw Object.assign(new Error('RoboWork was still upgrading robot homes to OpenCode V2 after RoboTeam '
                    + `waited ${STARTUP_MIGRATION_WAIT_MS / 1000} seconds during startup`), { code: 'OPENCODE_MIGRATING', statusCode: 503 });
            }
            // Anything else, including a 401 that outlasts the startup window, surfaces unchanged.
            throw outcome.error;
        }
    }
}

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted', 'exited']);

// Owns only the observation of a resident RoboWork run. Disconnecting this
// handle leaves the run alive; explicit kill is the only remote stop path.
export async function spawnRoboWorkRun({ client = new RoboWorkClient(), input, attach = false,
    onCallback, wait = delay } = {}) {
    if (!input?.runId) throw new Error('A RoboWork run id is required');
    if (!attach) await client.call('run_start', input);
    const runId = input.runId;
    const child = new EventEmitter();
    Object.assign(child, { remote: { runId, replayed: attach }, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
    let finished = false;
    let disconnected = false;
    let inputs = Promise.resolve();
    const callbacks = new Map();
    const finish = (code, signal, error) => {
        if (finished) return;
        finished = true;
        child.exitCode = code;
        if (error) child.stderr.write(`${error.message}\n`);
        child.stdout.end(); child.stderr.end();
        if (error && child.listenerCount('error')) child.emit('error', error);
        child.emit('exit', code, signal); child.emit('close', code, signal);
    };
    const send = (body) => {
        const result = inputs.then(() => finished || disconnected ? null : client.call('run_input', { runId, ...body }));
        inputs = result.catch(() => {});
        return result;
    };
    child.stdin = new Writable({
        write(chunk, _encoding, done) { send({ data: Buffer.from(chunk).toString('base64') }).then(() => done(), done); },
        final(done) { send({ close: true }).then(() => done(), done); },
    });
    child.kill = (signal = 'SIGTERM') => {
        if (finished || disconnected) return false;
        void client.call('run_stop', { runId, signal }).catch(error => child.emit('stop-error', error));
        child.killed = true;
        return true;
    };
    child.disconnect = () => { disconnected = true; };
    const dispatch = (callback) => {
        if (!callbacks.has(callback.id)) callbacks.set(callback.id, (async () => {
            try { return { status: 200, body: await onCallback?.(callback) ?? {} }; }
            catch (error) { return { status: error.statusCode || 403, body: { error: error.message } }; }
        })());
        void callbacks.get(callback.id).then(reply => send({ reply: { id: callback.id, ...reply } })).catch(() => {});
    };
    setImmediate(async () => {
        let after = 0;
        let idleMs = 100;
        let failures = 0;
        while (!finished && !disconnected) {
            try {
                const result = await client.call('run_read', { runId, after, waitMs: 100, maxBytes: 1024 * 1024 });
                failures = 0;
                const records = result.records || [];
                for (const record of records) {
                    if (!Number.isSafeInteger(record.seq) || record.seq <= after) continue;
                    if (!['stdout', 'stderr'].includes(record.stream)) throw new Error('Invalid RoboWork output stream');
                    child[record.stream].write(Buffer.from(record.data, 'base64'));
                    after = record.seq;
                }
                for (const callback of result.callbacks || []) dispatch(callback);
                // A capped read can end before the final output; drain before close.
                if (TERMINAL.has(result.state) && !records.length) {
                    const exit = result.exit || {};
                    finish(exit.code ?? (result.state === 'completed' ? 0 : 1), exit.signal ?? null,
                        exit.error ? new Error(exit.error) : null);
                    return;
                }
                if (!records.length) child.remote.replayed = false;
                idleMs = records.length ? 100 : Math.min(2000, Math.ceil(idleMs * 1.5));
                await wait(idleMs);
            } catch (error) {
                if (disconnected) return;
                if (error.code === 'UNKNOWN_RUN' || ++failures >= 6) return finish(null, null, error);
                await wait(Math.min(2000, 250 * 2 ** failures));
            }
        }
    });
    return child;
}

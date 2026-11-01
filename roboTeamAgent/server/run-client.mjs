import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const STARTUP_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 2000];
const CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
    'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

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

export class RoboWorkClient {
    constructor({ createClient = null, agentName = 'roboWorkAgent', startupRetry = false, wait = delay } = {}) {
        this.createClient = createClient;
        this.agentName = agentName;
        this.startupRetry = startupRetry;
        this.wait = wait;
    }

    finishStartup() { this.startupRetry = false; }

    async call(tool, input = {}, { timeoutMs = 120000 } = {}) {
        const create = this.createClient || await loadAgentClient();
        let result;
        for (let attempt = 0; ; attempt++) {
            try {
                const client = await create(this.agentName);
                result = await client.callTool(tool, input, { timeoutMs });
                break;
            } catch (error) {
                if (!unavailable(error)) throw error;
                if (this.startupRetry && attempt < STARTUP_RETRY_DELAYS_MS.length) {
                    await this.wait(STARTUP_RETRY_DELAYS_MS[attempt]);
                    continue;
                }
                throw Object.assign(new Error('RoboWork is temporarily unavailable; retry this request.', { cause: error }), {
                    code: 'ROBOWORK_UNAVAILABLE', statusCode: 503, retryable: true,
                });
            }
        }
        if (result?.isError || result?.ok === false) {
            throw Object.assign(new Error(result.message || result.error || 'RoboWork request failed'), {
                code: result.code || 'ROBOWORK_FAILED', statusCode: result.statusCode || 502,
            });
        }
        return result;
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

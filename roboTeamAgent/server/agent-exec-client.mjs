import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

// A child-process-like handle for one process that the Ploinky Router runs inside another
// global-mode agent's container (the private /api/edge/agent-exec route, granted to RoboTeam by
// routerAccess.agentExec in its manifest). stdin writes become input requests, stdout and stderr
// come from the resumable NDJSON stream, kill() stops the remote process tree, and 'exit'/'close'
// carry its exit code. The process starts without the target's environment; RoboTeam passes every
// variable it needs explicitly.

const EXEC_PATH = '/api/edge/agent-exec';
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

async function defaultSigner(env) {
    const agentLib = String(env.PLOINKY_AGENT_LIB_DIR || '/Agent').replace(/\/+$/u, '');
    const candidates = [path.join(agentLib, 'lib/agentAssertion.mjs')];
    if (env.PLOINKY_WORKSPACE_ROOT) candidates.push(path.join(env.PLOINKY_WORKSPACE_ROOT, 'ploinky/Agent/lib/agentAssertion.mjs'));
    const candidate = candidates.find(file => fs.existsSync(file));
    if (!candidate) throw new Error('Ploinky agent assertion library is unavailable');
    return (await import(pathToFileURL(candidate).href)).signPrivateRouterAssertion;
}

function agentExecError(message, code, status = 0) {
    return Object.assign(new Error(message), { code, status });
}

// Sends one signed private-router request; `stream` returns the response for incremental reading.
export function createPrivateRouterRequester({ env = process.env, fetchImpl = globalThis.fetch, signer = null } = {}) {
    const base = String(env.PLOINKY_INTERNAL_ROUTER_URL || '').replace(/\/+$/u, '');
    let sign = signer;
    return async function request(method, pathname, { query = '', body = null, signal, stream = false } = {}) {
        if (!base) throw agentExecError('PLOINKY_INTERNAL_ROUTER_URL is not set', 'AGENT_EXEC_ROUTER_UNAVAILABLE');
        sign ||= await defaultSigner(env);
        const payload = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
        const assertion = sign({ method, path: pathname, query, body: payload, env });
        const response = await fetchImpl(`${base}${pathname}${query}`, {
            method, signal,
            headers: { 'ploinky-agent-assertion': assertion, ...(payload.length ? { 'content-type': 'application/json' } : {}) },
            ...(payload.length ? { body: payload } : {}),
        });
        if (stream && response.ok) return response;
        const text = await response.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (!response.ok || json?.ok === false) {
            throw agentExecError(json?.message || json?.error || `agent exec request failed with HTTP ${response.status}`,
                json?.error || 'AGENT_EXEC_FAILED', response.status);
        }
        return json;
    };
}

export async function spawnInAgent({ target, argv, env = {}, cwd, request = createPrivateRouterRequester(), wait = ms => new Promise(r => setTimeout(r, ms)) }) {
    const started = await request('POST', EXEC_PATH, { body: { target, argv, env, cwd } });
    const execId = String(started.execId || '');
    if (!/^[a-f0-9]{32}$/u.test(execId)) throw agentExecError('the Router returned no exec id', 'AGENT_EXEC_FAILED');
    const child = new EventEmitter();
    child.pid = undefined;
    child.remote = { target, execId };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    let finished = false;
    let inputs = Promise.resolve();
    const finish = (code, signal, error = null) => {
        if (finished) return;
        finished = true;
        child.exitCode = code;
        // The reason is also written to stderr, where the consumer reads diagnostics.
        if (error) child.stderr.write(`${error.message}\n`);
        child.stdout.end();
        child.stderr.end();
        if (error && child.listenerCount('error')) child.emit('error', error);
        child.emit('exit', code, signal);
        child.emit('close', code, signal);
    };
    const send = (body) => {
        inputs = inputs.then(() => (finished ? null : request('POST', `${EXEC_PATH}/${execId}/input`, { body })))
            .catch((error) => { if (!finished && error?.code !== 'AGENT_EXEC_FINISHED') child.stdin.destroy(error); });
        return inputs;
    };
    child.stdin = new Writable({
        write(chunk, _encoding, done) { send({ data: Buffer.from(chunk).toString('base64') }); done(); },
        final(done) { send({ close: true }).then(() => done(), done); },
    });
    child.kill = (signal = 'SIGTERM') => {
        if (finished) return false;
        request('DELETE', `${EXEC_PATH}/${execId}`).catch(() => {});
        child.killed = true;
        return Boolean(signal);
    };
    // Reads the output stream, reconnecting from the next sequence when the Router ends it early
    // (for example on a routing generation change).
    // Started after the caller attached its listeners.
    setImmediate(async () => {
        let next = 0;
        let failures = 0;
        while (!finished) {
            try {
                const response = await request('GET', `${EXEC_PATH}/${execId}/stream`, { query: next ? `?from=${next}` : '', stream: true });
                const before = next;
                // Reaching the Router resets the failure count; a long silent run may hit the client's
                // body timeout and simply reconnects.
                failures = 0;
                let pending = '';
                for await (const chunk of response.body) {
                    pending += Buffer.from(chunk).toString('utf8');
                    let newline;
                    while ((newline = pending.indexOf('\n')) >= 0) {
                        const line = pending.slice(0, newline);
                        pending = pending.slice(newline + 1);
                        if (!line.trim()) continue;
                        const event = JSON.parse(line);
                        next = Math.max(next, Number(event.seq) + 1);
                        if (event.type === 'stdout') child.stdout.write(Buffer.from(event.data, 'base64'));
                        else if (event.type === 'stderr') child.stderr.write(Buffer.from(event.data, 'base64'));
                        else if (event.type === 'exit') {
                            finish(event.code ?? null, event.signal ?? null,
                                event.error ? agentExecError(`remote process failed to start: ${event.error}`, 'AGENT_EXEC_SPAWN_FAILED') : null);
                        }
                    }
                }
                // A stream that ended without new events is retried with a growing delay.
                if (!finished && next === before) {
                    if (failures >= RECONNECT_DELAYS_MS.length) return finish(null, null, agentExecError(`lost the remote process in ${target}`, 'AGENT_EXEC_LOST'));
                    await wait(RECONNECT_DELAYS_MS[failures++]);
                }
            } catch (error) {
                if (finished) return;
                // An unknown exec means the Router no longer has it (restarted): it is gone.
                if (error?.code === 'AGENT_EXEC_UNKNOWN' || failures >= RECONNECT_DELAYS_MS.length) {
                    return finish(null, null, agentExecError(`lost the remote process in ${target}: ${error.message}`, error?.code || 'AGENT_EXEC_LOST'));
                }
                await wait(RECONNECT_DELAYS_MS[failures++]);
            }
        }
    });
    return child;
}

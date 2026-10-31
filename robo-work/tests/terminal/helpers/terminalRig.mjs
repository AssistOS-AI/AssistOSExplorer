// SYNTHETIC rig for the robot-terminal tests: a real worker store with a ready robot, the real launch-evidence verifier and terminal
// execution path, the real terminal server on a loopback port, and FAKE sandbox pieces (factory and PTY host) that count every
// spawn. Nothing here starts a process.
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

import { createReplayCache, createVerifierConfig } from '../../../server/coordinatorAuth.mjs';
import { createTerminalAuth } from '../../../server/terminal/terminalAuth.mjs';
import { createTerminalExecutions } from '../../../server/terminal/terminalExecutions.mjs';
import { launchHash } from '../../../server/terminal/terminalProtocol.mjs';
import { createTerminalServer } from '../../../server/terminal/terminalServer.mjs';
import { LIMITS, WORKSPACE, makeTempDir, openStore, readyRobot, syntheticContext } from '../../helpers/synthetic.mjs';
import { siblingPath } from '../../../../tests/helpers/sibling-roots.mjs';

export const AUDIENCE = 'agent:AchillesIDE/robo-work';
export const PATH = '/v1/terminal-control';
export const LIMITS_X = Object.freeze({ ...LIMITS, requestBytes: 65536, resultBytes: 4096, admissions: 64, receipts: 256, bindings: 8, controls: 16, tokenReplayEntries: 4096 });

process.env.PLOINKY_AGENTLIB_DIR ||= siblingPath('ploinky', 'node_modules', 'achillesAgentLib');
export const ploinky = (relative) => import(pathToFileURL(siblingPath('ploinky', relative)).href);

export function sign(payload, secret) {
    const input = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
}

// The launch evidence the Router mints (F-7): a Router Request for the creating request's administrator. `claims` override the payload.
export function launchEvidence(secret, fields, claims = {}) {
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: AUDIENCE, tool: '__provider_terminal_launch__', method: 'LAUNCH', path: PATH,
        rch: launchHash(fields), jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30,
        sub: 'user:root', actor: { kind: 'user', id: 'user:root', roles: ['admin'] }, ...claims
    };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    return sign(payload, secret);
}

// A fake PTY: input is echoed back as output (so input bytes appear as output), resize and pause are recorded.
export function fakePtyHost() {
    const host = { opened: [], available: () => ({ ok: true }) };
    host.open = ({ cols, rows }) => {
        const listeners = [];
        const pty = {
            slaveFd: 99, cols, rows, sizes: [[cols, rows]], paused: false, closed: false, slaveDestroyed: false, bytes: { input: 0, output: 0 },
            onData: (fn) => listeners.push(fn),
            emit(buffer) { pty.bytes.output += buffer.length; for (const fn of listeners) fn(buffer); },
            write(buffer, callback) { pty.bytes.input += buffer.length; setImmediate(() => { callback(null); pty.emit(Buffer.from(buffer)); }); },
            resize(c, r) { pty.sizes.push([c, r]); },
            pause() { pty.paused = true; },
            resume() { pty.paused = false; },
            destroySlave() { pty.slaveDestroyed = true; },
            close() { pty.closed = true; }
        };
        host.opened.push(pty);
        return pty;
    };
    return host;
}

// A fake factory: openTerminal never touches the file system; start counts a spawn; end resolves with a release log.
export function fakeFactory(store, { quarantine = false, failStart = false, resolve = null } = {}) {
    const factory = { spawns: 0, opened: [], ends: [] };
    factory.openTerminal = async ({ item, project, context }) => {
        if (resolve) await resolve(project);
        let exit;
        const exited = new Promise((done) => { exit = done; });
        const execution = {
            item, project, cwd: project ? `/projects/${project.selection.split('/').at(-1)}` : '/home/robot', exited, revoked: new Promise(() => {}), lost: new Promise(() => {}),
            exit: (exitCode, signal = null) => exit({ exitCode, signal }),
            async start({ slave }) {
                if (failStart) throw Object.assign(new Error('synthetic'), { code: 'setup_failed' });
                factory.spawns += 1;
                execution.slave = slave;
            },
            async end(outcome) {
                factory.ends.push({ executionId: item.executionId, outcome });
                store.beginAttemptEnd(context, { executionId: item.executionId, attemptId: item.attemptId, expectedState: outcome.expectedState, outcome: { classification: outcome.classification, outputText: outcome.outputText, data: outcome.data } });
                return { releaseLog: quarantine ? [{ kind: 'process-tree', outcome: 'quarantined' }] : [{ kind: 'process-tree', outcome: 'released' }] };
            }
        };
        factory.opened.push(execution);
        return execution;
    };
    return factory;
}

export async function terminalRig(t, { factoryOptions = {}, serverLimits = {}, executionLimits } = {}) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: LIMITS_X });
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: `workspace:${WORKSPACE}`, scope: 'scope-robots' }));
    const secret = crypto.randomBytes(32);
    const verifier = createVerifierConfig({ secret, audience: AUDIENCE, coordinators: [], replayCache: createReplayCache() });
    const logs = [];
    const log = (event, fields = {}) => logs.push(JSON.stringify({ event, ...fields }));
    const factory = fakeFactory(store, factoryOptions);
    const ptyHost = fakePtyHost();
    const executions = createTerminalExecutions({ store, verifier, workspaceId: WORKSPACE, path: PATH, factory, ptyHost, log, ...(executionLimits ? { limits: executionLimits } : {}) });
    const tokenModule = await ploinky('Agent/lib/routerServiceToken.mjs');
    const auth = createTerminalAuth({ module: tokenModule, secret, audience: AUDIENCE, path: PATH, generationStartMs: Date.now() - 60000 });
    const server = createTerminalServer({ path: PATH, auth, executions, log, limits: serverLimits });
    const http1 = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    http1.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head));
    await new Promise((done) => http1.listen(0, '127.0.0.1', done));
    const port = http1.address().port;
    t.after(async () => {
        await server.close();
        await new Promise((done) => { http1.close(() => done()); http1.closeAllConnections?.(); });
        store.close();
    });
    return { dir, store, robotId, secret, verifier, logs, factory, ptyHost, executions, server, port, tokenModule };
}

// The transport Ploinky's ProviderTerminalClient expects, over Node's WebSocket client.
export function openTransportFor(port, opened = []) {
    return ({ path, headers, signal }) => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
        ws.binaryType = 'arraybuffer';
        const transport = new EventEmitter();
        let open = false;
        transport.ws = ws;
        transport.send = (data, { binary } = {}, callback = () => {}) => {
            try { ws.send(binary ? data : String(data)); queueMicrotask(() => callback(null)); } catch (error) { queueMicrotask(() => callback(error)); }
        };
        transport.close = () => { try { ws.close(); } catch { /* closed */ } };
        ws.onopen = () => { open = true; opened.push(transport); resolve(transport); };
        ws.onerror = () => { if (!open) reject(new Error('open failed')); else transport.emit('error', new Error('ws')); };
        ws.onclose = () => transport.emit('close');
        ws.onmessage = (event) => {
            if (typeof event.data === 'string') transport.emit('message', event.data, false);
            else transport.emit('message', Buffer.from(event.data), true);
        };
        signal?.addEventListener?.('abort', () => transport.close(), { once: true });
    });
}

export const CLIENT_LIMITS = Object.freeze({
    handshakeMs: 5000, sendMs: 5000, operationMs: 5000, heartbeatMs: 300, leaseMs: 15000, queueBytes: 1 << 20, inputBytes: 1 << 20, operations: 64, ptys: 128
});

export async function ploinkyClient(rig, { opened = [], limits = CLIENT_LIMITS, evidence } = {}) {
    const { ProviderTerminalClient } = await ploinky('cli/server/webtty/providerTerminalClient.mjs');
    const { RouterServiceTokenService } = await ploinky('cli/server/security/tokens/RouterServiceTokenService.js');
    const client = new ProviderTerminalClient({
        provider: AUDIENCE, path: PATH, openTransport: openTransportFor(rig.port, opened),
        routerServiceTokenService: new RouterServiceTokenService({ resolveAgentSecret: () => rig.secret }),
        mintLaunchEvidence: ({ launch }) => (evidence ? evidence(launch) : launchEvidence(rig.secret, launch)),
        isLeaseCurrent: () => true, limits
    });
    return client;
}

export const until = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise((done) => setTimeout(done, 10));
    }
};

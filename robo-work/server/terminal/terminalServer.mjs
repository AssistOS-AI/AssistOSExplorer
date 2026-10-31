import crypto from 'node:crypto';

import { completeUpgrade, createConnection, refuseUpgrade, validateUpgrade } from './wsCodec.mjs';
import {
    LIMITS, ProtocolError, decodeRouterControl, decodeRouterData, encodeWorkerControl, encodeWorkerData, launchFields, launchHash, newNonce,
    newSecret, proofMatches, sequence
} from './terminalProtocol.mjs';
import { TerminalLaunchError } from './terminalExecutions.mjs';

// The robot-terminal endpoint of the worker (M-8 SPEC; plan section 10.1; plan-review F-4, F-6, F-7; delta notes 6, 7). The Router's
// provider adapter (Ploinky ProviderTerminalClient) opens ONE authenticated WebSocket at exactly `terminals.path` on the provider port.
//
// Authentication. The upgrade carries a Router-service token (purpose `execution-provider-terminal`, under `routerServiceToken` in
// `x-ploinky-auth-info`), verified BEFORE the 101 (refused with 401/403/503 and nothing sent). The worker then sends `challenge{nonce}`;
// the Router's `hello` or `reattach` carries a second Router-service token (purpose `execution-provider-terminal-hello`) bound to that
// nonce, verified with Ploinky's own Agent/lib verifier (its jti consumed only after every check). A refused hello or reattach closes the
// connection and changes nothing: the current ownership session, its lease and its PTYs stay as they were.
//
// Ownership. A hello WITHOUT a proof creates the worker generation's single ownership session: `{ownershipSessionId, workerGeneration,
// leaseExpiresAt, secret}` is sent once. The 32-byte secret is held in THIS process's memory only (the possession proof is an HMAC keyed
// by it, so a digest could not verify it); it is never persisted, logged or sent again, and it is zeroed when the session ends. A new hello
// supersedes the previous session: its PTYs end at once with cause `supersession`. A `reattach` with a valid proof over this connection's
// nonce moves the same session to the new connection (`superseded-connection` to the old one) and answers the PTY inventory; anything else
// (unknown session, other generation, expired lease, bad proof) is refused without change. `workerGeneration` is a per-process UUID: no PTY
// survives a worker restart, and recovery ends the prior generation's terminal admissions (`interrupted`).
//
// Lease. Every hello, reattach and heartbeat renews the session lease (`leaseMs`, 15 s). At expiry every PTY of the session ends with cause
// `lease-expiry` and the session is discarded. A PTY that is launched but neither attached nor closed within `unclaimedMs` (15 s) ends with
// cause `unclaimed`. The Router-side WebTTY limits (24 h idle, 7 d absolute) govern idle terminals (M-51 Q2).
//
// Launch is idempotent per (ownership session, operationId): the same operation with the same request hash returns the same PTY (an
// in-flight launch is joined, never started twice); another hash is `launch-failed{operation_conflict}`. Every launch frame's evidence,
// a retry's included, is verified and its jti consumed. Launch refusals are `launch-failed{code}` with nothing spawned.
//
// Data. Output is numbered from 1 per PTY and kept in a bounded replay buffer (`replayBytes`); an attach replays everything after its
// cursor, or sends `gap{firstAvailable}` when that output is gone. While no connection is attached and the buffer is full, and while the
// socket holds more than `highWaterBytes`, the PTY master is paused (backpressure reaches the shell). Input frames are accepted only from
// the attached connection, in sequence: a duplicate is acknowledged again, a jump closes the connection (PTYs unchanged); `ack` follows the
// master write. Ends (`exit`, `shutdown` for user or Router close and Close terminals, `supersession`, `lease-expiry`, `unclaimed`,
// `generation-end` at worker shutdown) run the normal end path, and `ended` is sent only after the result is published; when termination
// cannot be verified no `ended` is sent (the robot becomes nonready with resource_quarantined).
//
// Never logged or persisted: terminal bytes (input or output), tokens, the secret, the nonce or the proof. Logs carry codes, sizes, counts.
//
//   createTerminalServer({ path, auth, executions, limits?, log?, now?, timers? })
//     auth        { verifyUpgrade(authInfoHeader), verifyHello(helloToken, nonce) }  both throw on refusal (error.status 401|403|503)
//     executions  { authorize(fields, evidence), launch({ fields, evidence }) -> Terminal }  (terminalExecutions.mjs)
//   -> { handleUpgrade(req, socket, head), closeRobot(robotId) -> { closed, unverified }, close() -> Promise, stats() }

export const DEFAULT_SERVER_LIMITS = Object.freeze({
    handshakeMs: 10000, leaseMs: 15000, unclaimedMs: 15000, maxConnections: 8, maxPendingConnections: 4, maxOperations: 1024,
    replayBytes: 1024 * 1024, highWaterBytes: 256 * 1024, maxInventory: 128
});
const MAX_FRAME = LIMITS.header + LIMITS.payload;

export function createTerminalServer({ path, auth, executions, limits = {}, log = () => {}, now = Date.now, timers = { setTimeout, clearTimeout } }) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('The terminals path is required');
    if (typeof auth?.verifyUpgrade !== 'function' || typeof auth?.verifyHello !== 'function') throw new TypeError('auth is required');
    if (typeof executions?.launch !== 'function' || typeof executions?.authorize !== 'function') throw new TypeError('executions are required');
    const settings = { ...DEFAULT_SERVER_LIMITS, ...limits };
    const workerGeneration = crypto.randomUUID();
    const connections = new Set();
    let ownership = null;
    let closing = null;

    const stats = () => ({
        connections: connections.size, session: ownership !== null,
        ptys: ownership ? ownership.ptys.size : 0, launching: ownership ? ownership.launching : 0
    });

    // ---- connections ---------------------------------------------------------------------------------------------------

    function handleUpgrade(req, socket, head) {
        socket.on('error', () => {});
        if (String(req.url ?? '') !== path) return refuseUpgrade(socket, 404);
        if (closing) return refuseUpgrade(socket, 503);
        const pending = [...connections].filter((connection) => connection.state === 'challenged').length;
        if (connections.size >= settings.maxConnections || pending >= settings.maxPendingConnections) {
            log('terminal_refusal', { stage: 'upgrade', reason: 'connection_limit' });
            return refuseUpgrade(socket, 503);
        }
        const key = validateUpgrade(req);
        if (key === null) return refuseUpgrade(socket, 400);
        try {
            auth.verifyUpgrade(req.headers['x-ploinky-auth-info']);
        } catch (error) {
            log('terminal_refusal', { stage: 'upgrade', reason: String(error?.reason ?? error?.code ?? 'refused').slice(0, 64) });
            return refuseUpgrade(socket, [401, 403, 503].includes(error?.status) ? error.status : 401);
        }
        completeUpgrade(socket, key);
        const ws = createConnection(socket, { maxPayload: MAX_FRAME, head });
        const connection = { ws, nonce: newNonce(), state: 'challenged', timer: null };
        connections.add(connection);
        ws.on('message', (data, binary) => receive(connection, data, binary));
        ws.on('close', (reason) => closed(connection, reason));
        connection.timer = timers.setTimeout(() => drop(connection, 'handshake_timeout'), settings.handshakeMs);
        connection.timer.unref?.();
        send(connection, 'challenge', { nonce: connection.nonce });
    }

    function send(connection, type, fields = {}) {
        if (!connection || connection.ws.closed) return false;
        connection.ws.send(encodeWorkerControl(type, fields), { binary: false });
        return true;
    }

    function drop(connection, reason) {
        if (connection.state === 'closed') return;
        log('terminal_connection_closed', { reason });
        connection.ws.close(reason === 'protocol' ? 1002 : 1000);
    }

    function closed(connection, reason) {
        if (connection.state === 'closed') return;
        timers.clearTimeout(connection.timer);
        connection.state = 'closed';
        connections.delete(connection);
        // The session survives a lost channel until its lease ends; its PTYs keep running and buffer their output.
        if (ownership && ownership.connection === connection) {
            ownership.connection = null;
            for (const pty of ownership.ptys.values()) {
                if (pty.attached === connection) pty.attached = null;
                flowControl(pty);
            }
        }
        void reason;
    }

    function receive(connection, data, binary) {
        if (connection.state === 'closed') return;
        try {
            if (connection.state === 'challenged') {
                if (binary) throw new ProtocolError();
                handshake(connection, decodeRouterControl(data));
                return;
            }
            const session = ownership;
            // A frame from a connection that no longer carries the session (superseded, or the session ended) is ignored.
            if (!session || session.connection !== connection) return;
            if (binary) input(session, connection, decodeRouterData(data));
            else control(session, connection, decodeRouterControl(data));
        } catch (error) {
            drop(connection, error instanceof ProtocolError ? 'protocol' : 'error');
        }
    }

    // ---- handshake and ownership ---------------------------------------------------------------------------------------

    function handshake(connection, frame) {
        if (frame.type !== 'hello' && frame.type !== 'reattach') throw new ProtocolError();
        try {
            auth.verifyHello(frame.helloToken, connection.nonce);
        } catch (error) {
            log('terminal_refusal', { stage: frame.type, reason: String(error?.reason ?? error?.code ?? 'refused').slice(0, 64) });
            drop(connection, 'hello_refused');
            return;
        }
        timers.clearTimeout(connection.timer);
        if (frame.type === 'hello') {
            if (ownership) endSession(ownership, 'supersession');
            const session = {
                id: crypto.randomUUID(), secret: newSecret(), connection, ptys: new Map(), operations: new Map(), launching: 0,
                leaseTimer: null, deadline: 0, ended: null
            };
            ownership = session;
            connection.state = 'active';
            renew(session);
            send(connection, 'hello-ok', { ownershipSessionId: session.id, workerGeneration, leaseExpiresAt: session.deadline, secret: session.secret.toString('base64url') });
            log('terminal_session', { event: 'hello', superseded: false });
            return;
        }
        const session = ownership;
        const valid = session !== null && frame.ownershipSessionId === session.id && frame.workerGeneration === workerGeneration
            && session.deadline > now() && proofMatches(session.secret, frame.proof, { nonce: connection.nonce, ownershipSessionId: session.id, workerGeneration });
        if (!valid) {
            log('terminal_refusal', { stage: 'reattach', reason: 'ownership' });
            drop(connection, 'reattach_refused');
            return;
        }
        const previous = session.connection;
        session.connection = connection;
        connection.state = 'active';
        for (const pty of session.ptys.values()) {
            pty.attached = null;
            flowControl(pty);
        }
        if (previous && previous !== connection) {
            send(previous, 'superseded-connection');
            previous.ws.close(1000);
        }
        renew(session);
        const ptys = [...session.ptys.values()].filter((pty) => !pty.ending).slice(0, settings.maxInventory).map((pty) => ({
            ptySessionId: pty.id, inputNext: String(pty.inputAccepted + 1n), outputLast: String(pty.outputLast)
        }));
        send(connection, 'reattach-ok', { leaseExpiresAt: session.deadline, ptys });
        log('terminal_session', { event: 'reattach', ptys: ptys.length });
    }

    function renew(session) {
        session.deadline = now() + settings.leaseMs;
        timers.clearTimeout(session.leaseTimer);
        session.leaseTimer = timers.setTimeout(() => { if (ownership === session) endSession(session, 'lease-expiry'); }, settings.leaseMs);
        session.leaseTimer.unref?.();
    }

    // Ends a whole session (supersession, lease expiry, worker shutdown): the secret is zeroed at once and every PTY ends with `cause`.
    function endSession(session, cause) {
        if (session.ended) return session.ended;
        if (ownership === session) ownership = null;
        timers.clearTimeout(session.leaseTimer);
        session.secret.fill(0);
        log('terminal_session', { event: cause, ptys: session.ptys.size });
        session.ended = Promise.allSettled([...session.ptys.values()].map((pty) => endPty(session, pty, cause))).then(() => {
            if (session.connection) session.connection.ws.close(1000);
        });
        session.endCause = cause;
        return session.ended;
    }

    // ---- control frames ------------------------------------------------------------------------------------------------

    function control(session, connection, frame) {
        switch (frame.type) {
            case 'heartbeat':
                renew(session);
                send(connection, 'heartbeat-ok', { leaseExpiresAt: session.deadline });
                return;
            case 'launch': return launch(session, frame);
            case 'attach': return attach(session, connection, frame);
            case 'resize': {
                const pty = session.ptys.get(frame.ptySessionId);
                if (pty && !pty.ending) pty.terminal.resize(frame.cols, frame.rows);
                return;
            }
            case 'close': {
                const pty = session.ptys.get(frame.ptySessionId);
                if (pty) void endPty(session, pty, 'shutdown');
                return;
            }
            default: throw new ProtocolError();
        }
    }

    function replyLaunch(session, operationId, operation) {
        const connection = session.connection;
        if (!connection || ownership !== session) return;
        if (operation.ptySessionId) send(connection, 'launched', { operationId, ptySessionId: operation.ptySessionId });
        else if (operation.code) send(connection, 'launch-failed', { operationId, code: operation.code });
    }

    function launch(session, frame) {
        const fields = launchFields(frame);
        const hash = launchHash(fields);
        const existing = session.operations.get(fields.operationId);
        if (existing) {
            if (existing.hash !== hash) {
                send(session.connection, 'launch-failed', { operationId: fields.operationId, code: 'operation_conflict' });
                return;
            }
            // A retry re-mints its evidence: it must verify too, then it joins (or repeats) the one launch of this operation.
            try {
                executions.authorize(fields, frame.launchEvidence);
            } catch (error) {
                send(session.connection, 'launch-failed', { operationId: fields.operationId, code: error instanceof TerminalLaunchError ? error.code : 'forbidden' });
                return;
            }
            replyLaunch(session, fields.operationId, existing);
            return;
        }
        if (session.operations.size >= settings.maxOperations) {
            send(session.connection, 'launch-failed', { operationId: fields.operationId, code: 'terminal_limit' });
            return;
        }
        const operation = { hash, ptySessionId: null, code: null };
        session.operations.set(fields.operationId, operation);
        session.launching += 1;
        executions.launch({ fields, evidence: frame.launchEvidence }).then((terminal) => {
            session.launching -= 1;
            // The session ended while the launch ran: the new terminal ends with the session's cause and is never announced.
            if (session.ended || ownership !== session) {
                void terminal.end(session.endCause ?? 'supersession');
                return;
            }
            const pty = register(session, terminal);
            pty.operationId = fields.operationId;
            operation.ptySessionId = pty.id;
            replyLaunch(session, fields.operationId, operation);
        }, (error) => {
            session.launching -= 1;
            operation.code = error instanceof TerminalLaunchError ? error.code : 'sandbox_unavailable';
            replyLaunch(session, fields.operationId, operation);
            // The operation is forgotten once its refusal was sent (the Router forgets it on refusal too), so the bound counts open work only.
            if (session.operations.get(fields.operationId) === operation) session.operations.delete(fields.operationId);
        });
    }

    function register(session, terminal) {
        const pty = {
            id: crypto.randomUUID(), robotId: terminal.robotId, terminal, attached: null, ending: null,
            inputAccepted: 0n, inputApplied: 0n, outputLast: 0n, ring: [], ringBytes: 0, paused: false, drainOn: null, claimed: false, unclaimed: null, operationId: null
        };
        session.ptys.set(pty.id, pty);
        pty.unclaimed = timers.setTimeout(() => { if (!pty.claimed) void endPty(session, pty, 'unclaimed'); }, settings.unclaimedMs);
        pty.unclaimed.unref?.();
        terminal.onData((chunk) => output(session, pty, chunk));
        terminal.exited.then(({ exitCode, signal }) => endPty(session, pty, 'exit', signal ? undefined : exitCode), () => endPty(session, pty, 'exit'));
        terminal.revoked?.then(() => endPty(session, pty, 'shutdown'), () => {});
        terminal.lost?.then(() => endPty(session, pty, 'shutdown'), () => {});
        return pty;
    }

    // ---- output, replay and backpressure -------------------------------------------------------------------------------

    function flowControl(pty) {
        const connection = pty.attached;
        const socketFull = connection !== null && connection.ws.bufferedAmount > settings.highWaterBytes;
        const bufferFull = connection === null && pty.ringBytes >= settings.replayBytes;
        const pause = !pty.ending && (socketFull || bufferFull);
        if (socketFull && pty.drainOn !== connection) {
            pty.drainOn = connection;
            connection.ws.once('drain', () => { if (pty.drainOn === connection) pty.drainOn = null; flowControl(pty); });
        }
        if (pause !== pty.paused) {
            pty.paused = pause;
            if (pause) pty.terminal.pause(); else pty.terminal.resume();
        }
    }

    function output(session, pty, chunk) {
        if (pty.ending) return;
        for (let offset = 0; offset < chunk.length; offset += LIMITS.payload) {
            const payload = chunk.subarray(offset, offset + LIMITS.payload);
            pty.outputLast += 1n;
            pty.ring.push({ sequence: pty.outputLast, payload });
            pty.ringBytes += payload.length;
            if (pty.attached) pty.attached.ws.send(encodeWorkerData(pty.id, pty.outputLast, payload), { binary: true });
        }
        // Bounded replay: while attached the oldest output beyond the bound is dropped (a later attach before it gets a gap); while
        // detached the master is paused at the bound instead, so a reconnect within the lease loses nothing.
        if (pty.attached) {
            while (pty.ringBytes > settings.replayBytes && pty.ring.length > 1) pty.ringBytes -= pty.ring.shift().payload.length;
        }
        flowControl(pty);
    }

    function attach(session, connection, frame) {
        const pty = session.ptys.get(frame.ptySessionId);
        if (!pty || pty.ending) return;
        const cursor = sequence(frame.afterOutputSequence, { zero: true });
        if (cursor > pty.outputLast) throw new ProtocolError();
        pty.claimed = true;
        timers.clearTimeout(pty.unclaimed);
        const firstAvailable = pty.ring.length > 0 ? pty.ring[0].sequence : pty.outputLast + 1n;
        if (cursor + 1n < firstAvailable) {
            pty.attached = null;
            send(connection, 'gap', { ptySessionId: pty.id, firstAvailable: String(firstAvailable) });
            flowControl(pty);
            return;
        }
        pty.attached = connection;
        for (const entry of pty.ring) {
            if (entry.sequence > cursor) connection.ws.send(encodeWorkerData(pty.id, entry.sequence, entry.payload), { binary: true });
        }
        while (pty.ringBytes > settings.replayBytes && pty.ring.length > 1) pty.ringBytes -= pty.ring.shift().payload.length;
        flowControl(pty);
    }

    // ---- input ---------------------------------------------------------------------------------------------------------

    function input(session, connection, frame) {
        const pty = session.ptys.get(frame.ptySessionId);
        // Input before an attach on this connection (or for an unknown or ending PTY) is not delivered and not acknowledged: the Router
        // re-sends every unacknowledged frame after its next attach.
        if (!pty || pty.ending || pty.attached !== connection) return;
        if (frame.sequence <= pty.inputAccepted) {
            if (pty.inputApplied >= 1n) send(connection, 'ack', { ptySessionId: pty.id, sequence: String(pty.inputApplied) });
            return;
        }
        if (frame.sequence !== pty.inputAccepted + 1n) throw new ProtocolError();
        pty.inputAccepted = frame.sequence;
        const accepted = frame.sequence;
        pty.terminal.write(Buffer.from(frame.payload), (error) => {
            if (error || pty.ending) return;
            if (accepted > pty.inputApplied) pty.inputApplied = accepted;
            const current = ownership === session ? session.connection : null;
            if (current && pty.attached === current) send(current, 'ack', { ptySessionId: pty.id, sequence: String(accepted) });
        });
    }

    // ---- ends ----------------------------------------------------------------------------------------------------------

    // One end per PTY, whatever comes first. `ended` goes to the session's connection (if any is still open) only after the end path
    // published the result, and only when termination was verified.
    function endPty(session, pty, cause, exitCode) {
        if (pty.ending) return pty.ending;
        timers.clearTimeout(pty.unclaimed);
        pty.attached = null;
        pty.ending = (async () => {
            let verified = false;
            try { ({ verified } = await pty.terminal.end(cause, exitCode)); } catch { verified = false; }
            session.ptys.delete(pty.id);
            // The operation that launched it is forgotten with the PTY (the Router forgets it at the end too).
            if (pty.operationId && session.operations.get(pty.operationId)?.ptySessionId === pty.id) session.operations.delete(pty.operationId);
            pty.ring = [];
            pty.ringBytes = 0;
            if (verified && session.connection && !session.connection.ws.closed) {
                const fields = { ptySessionId: pty.id, cause };
                if (cause === 'exit' && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) fields.exitCode = exitCode;
                send(session.connection, 'ended', fields);
            }
            return { verified };
        })();
        return pty.ending;
    }

    // M-54 Close terminals: every open terminal of one robot ends through the normal end path with cause `shutdown`.
    async function closeRobot(robotId) {
        const targets = ownership ? [...ownership.ptys.values()].filter((pty) => pty.robotId === robotId) : [];
        const session = ownership;
        const results = await Promise.all(targets.map((pty) => endPty(session, pty, 'shutdown')));
        const unverified = results.filter((result) => result.verified !== true).length;
        log('terminal_close_robot', { robotId, closed: results.length - unverified, unverified });
        return { closed: results.length - unverified, unverified };
    }

    // Worker shutdown: the generation ends; every PTY ends with cause `generation-end`, then every connection closes.
    function close() {
        closing ??= (async () => {
            if (ownership) await endSession(ownership, 'generation-end');
            for (const connection of [...connections]) connection.ws.close(1001);
        })();
        return closing;
    }

    return Object.freeze({ handleUpgrade, closeRobot, close, stats, workerGeneration });
}

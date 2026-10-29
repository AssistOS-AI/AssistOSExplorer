// The provider endpoint (plan section 5.5): one per ALA invocation. It terminates ALA's provider channel (fd 3, Node
// IPC with JSON) so that the shared supervisor never parses it, and relays schema-valid, size-bounded requests to the
// supervisor over the framed channel on fd 4. It also hosts the execution's loopback MCP relays.
//
// Every handle ALA receives comes from this endpoint's own accept or connect:
//   - a workload standard stream: the endpoint listens (pauseOnConnect) on a fresh path in its private stream
//     directory, accepts exactly one connection, removes the path and passes the accepted socket unread;
//   - a service connection: after the supervisor admits it, the endpoint connects to 127.0.0.1:<port>, pauses the
//     socket before the connection completes and passes it unread. It refuses its own relay ports and the
//     `unix-socket` form.
// A handle that ALA sends is closed and is a channel-wide failure. A failure of the endpoint ends only this execution.
//
// The module takes its limits as parameters (executionLimits.mjs holds provisional defaults only).

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { assertUnreadSocket, createAlaChannel } from './channelTransport.mjs';
import { createFrameChannel } from './frameCodec.mjs';
import { validateSupervisorFrame } from './endpointFrames.mjs';
import {
    PROVIDER_PROTOCOL, PROVIDER_PROTOCOL_VERSION, validateClientMessage
} from './providerSchema.mjs';

const DESCRIPTOR_DIRECTORIES = ['/proc/self/fd', '/dev/fd'];

// Diagnostic only: the endpoint's own open descriptor count, for the containment evidence.
export function descriptorCount() {
    for (const directory of DESCRIPTOR_DIRECTORIES) {
        try { return fs.readdirSync(directory).length - 1; } catch { /* try the next */ }
    }
    return -1;
}

const isDescriptorExhaustion = (error) => error?.code === 'EMFILE' || error?.code === 'ENFILE';
const refusalText = (error) => ({ code: String(error?.code || 'refused').slice(0, 64), message: String(error?.message || 'refused').slice(0, 256) });

export function createProviderEndpoint({
    channel, supervisorSocket, limits, streamDirectory, relays = [], onEnd = () => {}, timers
}) {
    if (limits.maxInboundQueue > limits.maxInFlightRequests) {
        throw new TypeError('maxInboundQueue must not exceed maxInFlightRequests');
    }
    const processes = new Map();
    const ownPorts = new Set();
    const relayServers = [];
    const relaySockets = new Set();
    const pendingCalls = new Map();
    const listeners = new Set();
    let lastProcess = 0;
    let lastCall = 0;
    let helloSeen = false;
    let inboundPending = 0;
    let pendingConnects = 0;
    let relayConnections = 0;
    let ended = false;
    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });

    // ---------------------------------------------------------------- ending

    function fail(reason) {
        if (ended) return;
        ended = true;
        try { supervisor.send({ event: 'failure', reason: /^[a-z][a-z0-9_]{0,63}$/u.test(reason) ? reason : 'endpoint_failure' }); } catch { /* the supervisor is gone */ }
        teardown();
        try { onEnd(reason); } catch { /* the caller must not break the teardown */ }
    }

    function teardown() {
        for (const server of listeners) { try { server.close(); } catch { /* closed */ } }
        for (const entry of processes.values()) for (const stream of entry.streams.values()) cleanupStream(stream);
        for (const server of relayServers) { try { server.close(); } catch { /* closed */ } }
        for (const socket of relaySockets) socket.destroy();
        for (const call of pendingCalls.values()) call.reject(new Error('The endpoint ended'));
        pendingCalls.clear();
        // The channel to ALA is closed after any failure message has been flushed; the supervisor channel after its
        // last frame. Both waits are bounded.
        ala.disconnect();
        const deadline = Date.now() + 500;
        const settle = () => {
            if (ala.stats().closed || !channel.connected || Date.now() > deadline) {
                supervisor.end().then(resolveClosed);
            } else setTimeout(settle, 5);
        };
        setImmediate(settle);
    }

    function endQuietly(reason) {
        if (ended) return;
        ended = true;
        teardown();
        try { onEnd(reason); } catch { /* ignore */ }
    }

    // ---------------------------------------------------------------- supervisor channel

    const supervisor = createFrameChannel(supervisorSocket, {
        maxFrameBytes: limits.maxFrameBytes, maxInFlight: limits.maxInFlightRequests,
        partialFrameDeadlineMs: limits.partialFrameDeadlineMs, timers,
        onFrame: (frame) => onSupervisorFrame(frame),
        onViolation: (code) => fail(`supervisor_${code}`),
        onClose: () => endQuietly('supervisor_closed')
    });

    function call(op, body = {}) {
        return new Promise((resolve, reject) => {
            if (ended) { reject(new Error('The endpoint ended')); return; }
            lastCall += 1;
            const id = lastCall;
            pendingCalls.set(id, { resolve, reject });
            // Encoding can throw (a frame above the bound); the pending entry must not outlive the failed send.
            let sent = false;
            try { sent = supervisor.send({ id, op, ...body }); } catch { sent = false; }
            if (!sent) { pendingCalls.delete(id); reject(new Error('The supervisor channel is closed or the frame cannot be encoded')); }
        });
    }

    function onSupervisorFrame(frame) {
        if (!validateSupervisorFrame(frame)) { fail('supervisor_bad_frame'); return; }
        if (frame.event === 'report') {
            supervisor.send({
                event: 'status', descriptors: Math.max(descriptorCount(), 0), pendingConnects,
                relayConnections, outboundPending: ala.stats().pendingMessages, processes: processes.size
            });
            return;
        }
        if (frame.event === 'exit') {
            const entry = processes.get(frame.process);
            if (!entry) return;
            entry.exit = { code: frame.code, signal: frame.signal };
            sendExitWhenDelivered(entry);
            return;
        }
        const pending = pendingCalls.get(frame.id);
        if (!pending) { fail('supervisor_unknown_answer'); return; }
        pendingCalls.delete(frame.id);
        pending.resolve(frame);
    }

    // ---------------------------------------------------------------- ALA channel

    const ala = createAlaChannel(channel, {
        limits, onMessage: (message) => onAlaMessage(message),
        onFailure: (detail) => fail(detail), onClose: () => endQuietly('ala_disconnected')
    });

    const reply = (message, handle) => ala.send(message, handle);

    function beginRequest() {
        inboundPending += 1;
        if (inboundPending > limits.maxInboundQueue) { fail('inbound_queue_overflow'); return false; }
        return true;
    }
    const endRequest = () => { inboundPending -= 1; };

    function onAlaMessage(message) {
        if (ended) return;
        const verdict = validateClientMessage(message, limits);
        if (!helloSeen) {
            if (message.type !== 'hello' || !verdict.ok) { ala.fail('protocol', 'the handshake must come first', 'no_handshake'); return; }
            if (!message.versions.includes(PROVIDER_PROTOCOL_VERSION)) {
                ala.fail('protocol', 'no common protocol version', 'unsupported_version');
                return;
            }
            helloSeen = true;
            reply({ type: 'hello', protocol: PROVIDER_PROTOCOL, version: PROVIDER_PROTOCOL_VERSION });
            return;
        }
        if (message.type === 'hello') { ala.fail('protocol', 'repeated hello', 'repeated_hello'); return; }
        if (!verdict.ok) {
            if (message.type === 'start' && Number.isSafeInteger(message.process) && message.process >= 1) {
                reply({ type: 'refused', process: message.process, error: { code: verdict.code, message: verdict.message } });
            } else ala.fail('protocol', verdict.message, verdict.code);
            return;
        }
        switch (message.type) {
            case 'inventory': case 'tempdir': simpleRequest(message); break;
            case 'start': startProcess(message); break;
            case 'stop': stopProcess(message); break;
            case 'connect': connect(message); break;
            default:
        }
    }

    function simpleRequest(message) {
        if (!beginRequest()) return;
        call(message.type).then((answer) => {
            if (answer.ok) reply({ type: 'result', id: message.id, ok: true, value: answer.value });
            else reply({ type: 'result', id: message.id, ok: false, error: answer.error });
        }).catch(() => {
            // ALA is always answered: a request that cannot be relayed is a failed request, not a silent one.
            reply({ type: 'result', id: message.id, ok: false, error: { code: 'endpoint_error', message: 'the endpoint could not relay the request' } });
        }).finally(endRequest);
    }

    // ---------------------------------------------------------------- processes and streams

    function cleanupStream(stream) {
        try { stream.server.close(); } catch { /* closed */ }
        listeners.delete(stream.server);
        fs.rmSync(stream.path, { force: true });
        if (stream.socket && !stream.delivered) stream.socket.destroy();
    }

    function openStream(name) {
        const streamPath = path.join(streamDirectory, crypto.randomBytes(12).toString('hex'));
        const server = net.createServer({ pauseOnConnect: true });
        server.maxConnections = 1;
        listeners.add(server);
        const stream = { name, path: streamPath, server, socket: null, delivered: false, waiter: null };
        stream.accepted = new Promise((resolve, reject) => {
            server.once('connection', (socket) => {
                stream.socket = socket;
                // Exactly one connection per path: the path is gone as soon as it has been accepted.
                try { server.close(); } catch { /* closed */ }
                fs.rmSync(streamPath, { force: true });
                resolve(socket);
            });
            server.once('error', reject);
        });
        stream.accepted.catch(() => {});
        stream.listening = new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
        server.listen(streamPath);
        return stream;
    }

    async function startProcess(message) {
        if (message.process <= lastProcess) { ala.fail('protocol', 'process numbers must increase', 'process_reused'); return; }
        lastProcess = message.process;
        if (processes.size >= limits.maxProcesses) {
            reply({ type: 'refused', process: message.process, error: { code: 'capacity_exceeded', message: 'too many processes' } });
            return;
        }
        if (!beginRequest()) return;
        const { communication } = message.request;
        const names = communication.stdin === 'pipe' ? ['stdin', 'stdout', 'stderr'] : ['stdout', 'stderr'];
        // stopGrace is the smallest grace ALA has asked for; startSent and stopQueued order a stop after its start frame.
        const entry = {
            id: message.process, streams: new Map(), exit: null, delivered: false, started: false, exitSent: false,
            stopGrace: undefined, startSent: false, stopQueued: false
        };
        processes.set(message.process, entry);
        try {
            if (ended) throw new Error('The endpoint ended');
            for (const name of names) entry.streams.set(name, openStream(name));
            await Promise.all([...entry.streams.values()].map((stream) => stream.listening));
            if (ended) throw new Error('The endpoint ended');
            const streams = Object.fromEntries([...entry.streams].map(([name, stream]) => [name, stream.path]));
            const pendingStart = call('start', { process: message.process, request: message.request, streams });
            // The start frame is on the wire. A stop that ALA sent while the listeners were opening follows it, so the
            // supervisor sees the start first and records the stop against the pending start.
            entry.startSent = true;
            if (entry.stopQueued) { entry.stopQueued = false; forwardStop(entry); }
            const answer = await pendingStart;
            if (!answer.ok) {
                for (const stream of entry.streams.values()) cleanupStream(stream);
                processes.delete(message.process);
                reply(answer.kind === 'refused'
                    ? { type: 'refused', process: message.process, error: answer.error }
                    : { type: 'failure', process: message.process, error: answer.error });
                return;
            }
            entry.started = true;
            reply({ type: 'started', process: message.process });
            await deliverStreams(entry);
        } catch (error) {
            if (isDescriptorExhaustion(error)) { fail('descriptor_exhaustion'); return; }
            for (const stream of entry.streams.values()) cleanupStream(stream);
            processes.delete(message.process);
            if (!ended) reply({ type: 'failure', process: message.process, error: { code: 'endpoint', message: 'the endpoint could not start the process' } });
        } finally { endRequest(); }
    }

    async function deliverStreams(entry) {
        for (const [name, stream] of entry.streams) {
            let socket;
            try {
                socket = await Promise.race([stream.accepted, new Promise((_, reject) => {
                    const timer = setTimeout(() => reject(new Error('stream not connected')), limits.streamAcceptDeadlineMs);
                    timer.unref?.();
                })]);
            } catch (error) {
                if (isDescriptorExhaustion(error)) { fail('descriptor_exhaustion'); return; }
                call('stop', { process: entry.id, graceMs: 0 }).catch(() => {});
                for (const other of entry.streams.values()) cleanupStream(other);
                reply({ type: 'failure', process: entry.id, error: { code: 'stream_not_connected', message: `the ${name} stream was not connected` } });
                return;
            }
            try { assertUnreadSocket(socket); } catch { fail('stream_read_before_pass'); return; }
            stream.delivered = true;
            await reply({ type: 'stream', process: entry.id, stream: name }, socket);
        }
        entry.delivered = true;
        sendExitWhenDelivered(entry);
    }

    function sendExitWhenDelivered(entry) {
        if (!entry.delivered || !entry.exit || entry.exitSent) return;
        entry.exitSent = true;
        reply({ type: 'exit', process: entry.id, code: entry.exit.code, signal: entry.exit.signal });
    }

    // A stop is never dropped and never forwarded ahead of its start frame. Repeated stops for one process collapse into
    // one that carries the smallest grace; each stop that is forwarded counts against the inbound bound until the
    // supervisor has answered it, so a flood of stops ends the execution as an ALA queue overflow.
    function stopProcess(message) {
        if (message.process > lastProcess) { ala.fail('protocol', 'stop for a process that was never started', 'unknown_process'); return; }
        const entry = processes.get(message.process);
        if (!entry) return;
        if (entry.stopGrace !== undefined && message.graceMs >= entry.stopGrace) return;
        entry.stopGrace = message.graceMs;
        if (!entry.startSent) { entry.stopQueued = true; return; }
        forwardStop(entry);
    }

    function forwardStop(entry) {
        if (!beginRequest()) return;
        call('stop', { process: entry.id, graceMs: entry.stopGrace }).catch(() => {}).finally(endRequest);
    }

    // ---------------------------------------------------------------- service connections

    function connect(message) {
        const { id, endpoint } = message;
        const result = (error) => reply({ type: 'result', id, ok: false, error });
        if (endpoint.kind === 'unix-socket') {
            result({ code: 'unsupported_endpoint', message: 'the unix-socket endpoint form is not supported in version 1' });
            return;
        }
        if (ownPorts.has(endpoint.port)) {
            result({ code: 'own_port', message: 'the endpoint refuses a port it listens on itself' });
            return;
        }
        const entry = processes.get(message.process);
        if (!entry || !entry.started) { result({ code: 'unknown_process', message: 'no running process with this number' }); return; }
        if (pendingConnects >= limits.maxPendingConnects) { result({ code: 'busy', message: 'too many connections in progress' }); return; }
        if (!beginRequest()) return;
        pendingConnects += 1;
        (async () => {
            const answer = await call('connect', { process: message.process, port: endpoint.port });
            if (!answer.ok) { result(answer.error); return; }
            const socket = net.connect({ host: '127.0.0.1', port: endpoint.port });
            // Paused before the connection completes, so that no byte or end-of-stream is read before ALA owns it.
            socket.pause();
            try {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })), limits.connectDeadlineMs);
                    timer.unref?.();
                    socket.once('connect', () => { clearTimeout(timer); resolve(); });
                    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
                });
            } catch (error) {
                socket.destroy();
                if (isDescriptorExhaustion(error)) { fail('descriptor_exhaustion'); return; }
                result({ code: 'connect_failed', message: 'the service did not accept the connection' });
                return;
            }
            socket.on('error', () => {});
            try { assertUnreadSocket(socket); } catch { socket.destroy(); fail('connection_read_before_pass'); return; }
            await reply({ type: 'result', id, ok: true, value: {} }, socket);
        })().catch((error) => {
            if (isDescriptorExhaustion(error)) fail('descriptor_exhaustion');
            else result({ code: 'endpoint_error', message: 'the endpoint could not relay the request' });
        }).finally(() => { pendingConnects -= 1; endRequest(); });
    }

    // ---------------------------------------------------------------- loopback MCP relays

    async function startRelays() {
        for (const relay of relays) {
            const server = net.createServer((socket) => {
                // One connection is a client socket and its upstream socket: the limit counts connections.
                if (relayConnections >= limits.maxRelayConnections) { socket.destroy(); return; }
                relayConnections += 1;
                const upstream = net.connect(relay.target);
                relaySockets.add(socket);
                relaySockets.add(upstream);
                let closedOnce = false;
                const close = () => {
                    if (!closedOnce) { closedOnce = true; relayConnections -= 1; }
                    socket.destroy();
                    upstream.destroy();
                    relaySockets.delete(socket);
                    relaySockets.delete(upstream);
                };
                // Bytes are copied, never parsed.
                socket.on('error', close);
                upstream.on('error', (error) => {
                    // Running out of descriptors on the endpoint's own connect is an endpoint failure.
                    if (isDescriptorExhaustion(error)) fail('descriptor_exhaustion');
                    close();
                });
                socket.on('close', close);
                upstream.on('close', close);
                socket.pipe(upstream);
                upstream.pipe(socket);
            });
            server.on('error', (error) => { if (isDescriptorExhaustion(error)) fail('descriptor_exhaustion'); });
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen({ host: '127.0.0.1', port: relay.port || 0 }, resolve);
            });
            ownPorts.add(server.address().port);
            relayServers.push(server);
        }
        supervisor.send({ event: 'ready', relayPorts: [...ownPorts] });
    }

    const started = startRelays().catch(() => fail('relay_start_failed'));

    return {
        started,
        closed,
        ownPorts: () => [...ownPorts],
        fail,
        stats: () => ({
            ended, inboundPending, pendingConnects, relayConnections, processes: processes.size, pendingCalls: pendingCalls.size,
            outbound: ala.stats(), supervisor: supervisor.stats()
        })
    };
}

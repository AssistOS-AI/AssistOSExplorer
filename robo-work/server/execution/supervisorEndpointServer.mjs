// The supervisor's side of one execution's provider-endpoint channel (fd 4). One instance per execution. It frames,
// bounds and validates everything the endpoint sends, applies the admission decisions, and drives the sandbox supervisor through a
// small interface:
//
//   sandbox.inventory()                       -> array of { name, version? }   (optional; the admission inventory is used otherwise)
//   sandbox.tempdir()                         -> Promise<string>               a private temporary directory
//   sandbox.start({ process, request, streams }) -> Promise<void>              resolves once the workload exists and is
//                                               connected to every stream path; rejects when setup fails
//   sandbox.stop({ process, graceMs })        -> Promise<void>
//   sandbox.setExitHandler((process, code, signal) => void)
//
// Whatever the endpoint does, the failure ends only this execution: onEnd is called once with a reason, the socket is
// destroyed, and nothing is thrown into the shared supervisor.

import { createFrameChannel } from './frameCodec.mjs';
import { validateEndpointEvent, validateEndpointRequest } from './endpointFrames.mjs';
import { admitStartRequest, admitStreamPaths } from './supervisorRequestValidator.mjs';
import { virtualPathProblem } from './providerSchema.mjs';

export function createSupervisorEndpointServer({ socket, admission, sandbox, limits, onEnd, timers, log = () => {} }) {
    const processes = new Map();
    // Request ids rise strictly. Remembering only the last one keeps the supervisor's memory independent of the number
    // of requests an endpoint sends.
    let lastId = 0;
    let relayPorts = [];
    let readySeen = false;
    let ended = false;
    let reportsOutstanding = 0;
    let reportResolvers = [];
    let requestsHandled = 0;

    function finish(reason) {
        if (ended) return;
        ended = true;
        channel.destroy();
        for (const resolver of reportResolvers.splice(0)) resolver(null);
        try { onEnd(reason); } catch { /* the caller's end handler must not reach the shared supervisor */ }
    }

    const channel = createFrameChannel(socket, {
        maxFrameBytes: limits.maxFrameBytes, maxInFlight: limits.maxInFlightRequests,
        partialFrameDeadlineMs: limits.partialFrameDeadlineMs, timers,
        onFrame: (frame) => handleFrame(frame),
        onViolation: (code) => finish(`channel_violation:${code}`),
        onClose: () => finish('endpoint_lost')
    });

    sandbox.setExitHandler?.((process, code, signal) => {
        const entry = processes.get(process);
        if (ended || !entry || entry.state === 'exited') return;
        // An exit that arrives while the start is still being answered is sent after the answer.
        if (entry.state === 'starting') { entry.pendingExit = { code, signal }; return; }
        entry.state = 'exited';
        channel.send({ event: 'exit', process, code, signal });
    });

    // A request stays in flight until its answer has been flushed to the endpoint. An endpoint that sends requests and
    // never reads the answers therefore reaches maxInFlightRequests, which ends its execution, instead of growing the
    // supervisor's write buffer without bound.
    const answer = (id, body) => {
        if (ended) { channel.settle(id); return; }
        channel.send({ id, ...body }, () => channel.settle(id));
    };
    const refused = (id, error) => answer(id, { ok: false, kind: 'refused', error });
    const failure = (id, error) => answer(id, { ok: false, kind: 'failure', error });

    function handleFrame(frame) {
        if (ended) return;
        if (Object.hasOwn(frame, 'event')) {
            if (!validateEndpointEvent(frame)) { finish('channel_violation:bad_event'); return; }
            // Events are bounded by count: one `ready`, and a `status` only as the answer to a report that was asked for.
            // Any more is a protocol violation that ends this execution.
            if (frame.event === 'failure') finish(`endpoint_failure:${frame.reason}`);
            else if (frame.event === 'ready') {
                if (readySeen) { finish('channel_violation:repeated_ready'); return; }
                readySeen = true;
                relayPorts = frame.relayPorts;
            } else if (frame.event === 'status') {
                if (reportsOutstanding === 0) { finish('channel_violation:unsolicited_status'); return; }
                reportsOutstanding -= 1;
                reportResolvers.shift()?.(frame);
            }
            return;
        }
        const verdict = validateEndpointRequest(frame, limits);
        if (!verdict.ok && !verdict.schema) { finish(`channel_violation:${verdict.code}`); return; }
        if (frame.id <= lastId) { finish('channel_violation:duplicate_id'); return; }
        lastId = frame.id;
        if (!channel.admit(frame.id)) return;
        requestsHandled += 1;
        if (!verdict.ok) { refused(frame.id, { code: verdict.code, message: verdict.message }); return; }
        dispatch(frame).catch(() => failure(frame.id, { code: 'internal', message: 'The supervisor could not complete the request' }));
    }

    async function dispatch(frame) {
        switch (frame.op) {
            case 'inventory':
                answer(frame.id, { ok: true, value: (await sandbox.inventory?.()) ?? admission.inventory.map((entry) => ({ ...entry })) });
                return;
            case 'tempdir': {
                const path = await sandbox.tempdir();
                if (virtualPathProblem(path) || path === '/') {
                    failure(frame.id, { code: 'internal', message: 'The temporary directory is not valid' });
                } else answer(frame.id, { ok: true, value: { path } });
                return;
            }
            case 'start': return start(frame);
            case 'stop': {
                const entry = processes.get(frame.process);
                if (!entry) { refused(frame.id, { code: 'unknown_process', message: 'No such process in this execution' }); return; }
                await stop(frame.process, entry, frame.graceMs);
                answer(frame.id, { ok: true });
                return;
            }
            case 'connect': {
                const entry = processes.get(frame.process);
                if (!entry || entry.state !== 'running' || entry.processClass !== 'service') {
                    refused(frame.id, { code: 'not_a_running_service', message: 'A connection needs a running service of this execution' });
                } else if (relayPorts.includes(frame.port)) {
                    refused(frame.id, { code: 'relay_port', message: 'This port belongs to the execution\'s own relay' });
                } else answer(frame.id, { ok: true });
                return;
            }
            default:
        }
    }

    // A stop is answered ok only after it has been performed. A stop that arrives while the start is still pending cannot
    // be performed yet: it is recorded against the entry (keeping the smallest grace), the sandbox supervisor is asked to stop the
    // process as soon as its start has resolved, and the stop is answered after that. Repeated stops collapse: one that
    // asks for no less grace than a stop already sent waits for that stop instead of being sent again.
    async function stop(processNumber, entry, graceMs) {
        if (entry.state === 'exited') return;
        if (entry.state === 'starting') {
            entry.pendingStop = Math.min(entry.pendingStop ?? graceMs, graceMs);
            await new Promise((resolve, reject) => entry.stopWaiters.push({ resolve, reject }));
            return;
        }
        if (entry.sentGrace !== undefined && graceMs >= entry.sentGrace) { await entry.stopping; return; }
        entry.sentGrace = graceMs;
        entry.stopping = sandbox.stop({ process: processNumber, graceMs });
        entry.stopping.catch(() => {});
        await entry.stopping;
    }

    async function start(frame) {
        const { process, request, streams } = frame;
        if (processes.has(process)) { refused(frame.id, { code: 'duplicate_process', message: 'The process number is already used' }); return; }
        if (processes.size >= limits.maxProcesses) { refused(frame.id, { code: 'capacity_exceeded', message: 'Too many processes in this execution' }); return; }
        const refusal = admitStartRequest(request, admission) || admitStreamPaths(streams, request, admission);
        if (refusal) { refused(frame.id, refusal); return; }
        const entry = { state: 'starting', processClass: request.processClass, stopWaiters: [] };
        processes.set(process, entry);
        try {
            await sandbox.start({ process, request, streams });
        } catch (error) {
            // The endpoint is told only `setup_failed`; the worker log gets the code and a bounded detail (never request content).
            try {
                log('sandbox_start_failed', { process, executable: request.executable, code: error?.code ?? error?.name ?? 'error', detail: String(error?.detail ?? error?.message ?? '').slice(0, 200) });
            } catch { /* logging must not change the answer */ }
            entry.state = 'exited';
            // Nothing was started, so a stop that was waiting has nothing left to stop.
            for (const waiter of entry.stopWaiters.splice(0)) waiter.resolve();
            failure(frame.id, { code: 'setup_failed', message: 'The provider could not start the process' });
            return;
        }
        entry.state = 'running';
        answer(frame.id, { ok: true });
        if (entry.pendingStop !== undefined) {
            entry.sentGrace = entry.pendingStop;
            entry.stopping = sandbox.stop({ process, graceMs: entry.pendingStop });
            entry.stopping.catch(() => {});
            try {
                await entry.stopping;
                for (const waiter of entry.stopWaiters.splice(0)) waiter.resolve();
            } catch (error) {
                for (const waiter of entry.stopWaiters.splice(0)) waiter.reject(error);
            }
        }
        if (entry.pendingExit) {
            entry.state = 'exited';
            if (!ended) channel.send({ event: 'exit', process, ...entry.pendingExit });
        }
    }

    return {
        end: (reason) => finish(reason),
        // Asks the endpoint for its own counters (descriptors, pending work). Diagnostic only.
        report(timeoutMs = 2000) {
            return new Promise((resolve) => {
                // A late answer to a report that timed out is still an asked-for answer.
                reportsOutstanding += 1;
                let answered = false;
                const entry = (value) => { if (!answered) { answered = true; clearTimeout(timer); resolve(value); } };
                const timer = setTimeout(() => entry(null), timeoutMs);
                reportResolvers.push(entry);
                channel.send({ event: 'report' });
            });
        },
        stats: () => ({ ...channel.stats(), ended, requestsHandled, relayPorts: [...relayPorts] })
    };
}

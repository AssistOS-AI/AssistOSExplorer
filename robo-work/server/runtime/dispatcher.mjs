import { createVerifiedServiceContext, WorkerStateError, byteLength } from '../stateProtocol.mjs';
import { resolveControlStreamLimits } from '../execution/executionLimits.mjs';
import { PlanError, planAlaExecution } from './alaPlan.mjs';
import { openAlaStreams } from './alaStreams.mjs';
import { createEventRelay } from './eventRelay.mjs';

// The execution dispatcher (RoboWork r10 wiring). It picks queued attempts, runs ALA for each one through an execution
// (the sandbox supervisor, ledger and provider endpoint; see executionFactory.mjs), relays ALA's records as bounded
// reference events, delivers pending controls and ends the attempt with a classification and the final text.
//
// Execution seam (`factory.open(...)` returns it; tests supply a fake):
//   open({ item, plan, context }) -> execution
//   execution.start()  -> Promise<{ stdin, stdout, stderr }>   everything is published and the ALA process runs, gated
//   execution.exited   -> Promise<{ exitCode, signal }>        of the orchestration process
//   execution.lost     -> Promise<string>  (optional)           resolves when the endpoint or the anchor is lost before the end
//   execution.end({ classification, outputText, data }) -> Promise   the section 5.5 end path; step 1 is beginAttemptEnd
//
// A failure before an execution exists ends the attempt directly through beginAttemptEnd.

const DEFAULTS = Object.freeze({ maxConcurrent: 4, pollMs: 250, controlPollMs: 200, drainMs: 2000, resultBytes: 512 * 1024 - 1024 });
const FATAL_READER_ENDS = new Set(['control_stream_violation', 'control_stall', 'stdin_stall', 'stdin_overflow', 'stdout_error']);
const SKIPPED_TRANSITION = new Set(['robot_busy', 'operation_conflict', 'stale_generation', 'not_found']);

// Cuts `text` to fit the S1 result bound together with `data` (canonical JSON size), on a character boundary.
export function fitOutcome({ classification, outputText = '', data = null }, resultBytes) {
    const size = (text, extra) => byteLength({ outputText: text, data: extra });
    if (size(outputText, data) <= resultBytes) return { classification, outputText, data };
    const marker = { ...(data ?? {}), truncated: true, originalBytes: Buffer.byteLength(outputText, 'utf8') };
    let cut = Math.min(outputText.length, Math.max(0, resultBytes - 512));
    let text = outputText.slice(0, cut);
    while (cut > 0 && size(text, marker) > resultBytes) {
        cut = Math.floor(cut * 0.9);
        text = outputText.slice(0, cut);
    }
    return { classification, outputText: text, data: marker };
}

export function createDispatcher({
    store, workspaceId, workspaceRoot, factory, controlLimits, options = {}, log = () => {}, timers = { setInterval, clearInterval, setTimeout }
}) {
    for (const method of ['listQueuedAdmissions', 'transitionAttempt', 'beginAttemptEnd', 'recordReferenceEvents', 'takePendingControls', 'ackControl']) {
        if (!store || typeof store[method] !== 'function') throw new TypeError(`The store lacks ${method}`);
    }
    if (!factory || typeof factory.open !== 'function') throw new TypeError('An execution factory is required');
    const settings = { ...DEFAULTS, ...options };
    const streamLimits = resolveControlStreamLimits({ maxRecordBytes: 4 * 1024 * 1024, maxBufferedBytes: 16 * 1024 * 1024, maxPendingStdinBytes: 8 * 1024 * 1024, ...controlLimits });
    const context = createVerifiedServiceContext({
        workspaceId, scope: 'worker:adapter', ownerId: 'worker:adapter', robotOwnerId: 'worker:adapter', operations: ['adapter_complete']
    });
    const active = new Map(); // executionId -> { promise, shutdown }
    let timer = null;
    let closed = false;
    const sleep = (ms) => new Promise((resolve) => { timers.setTimeout(resolve, ms).unref?.(); });
    const describe = (error) => (error instanceof WorkerStateError ? error.code : (error?.code ?? error?.name ?? 'error'));

    // Ends an attempt that has no execution (nothing was published).
    function endDirect(item, expectedState, outcome) {
        try {
            store.beginAttemptEnd(context, { executionId: item.executionId, attemptId: item.attemptId, expectedState, outcome: fitOutcome(outcome, settings.resultBytes) });
        } catch (error) {
            log('end_direct_failed', { error: describe(error) });
        }
    }

    async function run(item, shutdownRef) {
        let plan;
        try {
            plan = planAlaExecution({ specification: item.specification, workspaceRoot });
        } catch (error) {
            endDirect(item, 'queued', { classification: 'failed', data: { reason: error instanceof PlanError ? error.reason : 'invalid_specification' } });
            return;
        }
        try {
            store.transitionAttempt({ executionId: item.executionId, attemptId: item.attemptId, expectedState: 'queued', nextState: 'running' });
        } catch (error) {
            if (error instanceof WorkerStateError && SKIPPED_TRANSITION.has(error.code)) return;
            throw error;
        }

        let execution = null;
        let streams = null;
        let relay = null;
        let controlTimer = null;
        let finishing = null;
        let fatal = null;
        const fatalSignal = {};
        fatalSignal.promise = new Promise((resolve) => { fatalSignal.resolve = resolve; });
        let readerEnded = null;
        let starting = null;
        // Resolves when the attempt's end has begun, whoever began it, so the wait for the process cannot outlive it.
        let signalEnded;
        const endedSignal = new Promise((resolve) => { signalEnded = resolve; });

        const partialText = () => (streams ? streams.final.text().trimEnd() : '');
        // The one end of this attempt, whoever asks first (exit, stop, a fatal stream error, shutdown).
        const finish = (outcome) => {
            if (finishing === null) signalEnded();
            finishing ??= (async () => {
                if (controlTimer !== null) { timers.clearInterval(controlTimer); controlTimer = null; }
                streams?.reader.end('ended_by_dispatcher');
                if (relay) await relay.close().catch(() => {});
                const fitted = fitOutcome(outcome, settings.resultBytes);
                if (execution) await execution.end(fitted);
                else store.beginAttemptEnd(context, { executionId: item.executionId, attemptId: item.attemptId, expectedState: 'running', outcome: fitted });
            })();
            return finishing;
        };
        // A shutdown that arrives while the execution is still being published waits for that, so the execution it ends exists.
        shutdownRef.shutdown = async () => {
            if (starting !== null) await starting.catch(() => {});
            return finish({ classification: 'interrupted', outputText: partialText(), data: { reason: 'worker_shutdown' } });
        };

        async function deliverControls() {
            if (finishing !== null) return;
            let controls;
            try {
                controls = store.takePendingControls({ executionId: item.executionId, attemptId: item.attemptId });
            } catch (error) {
                log('controls_read_failed', { error: describe(error) });
                return;
            }
            for (const control of controls) {
                const ack = () => store.ackControl({ executionId: item.executionId, attemptId: item.attemptId, actorKey: control.actorKey, operationId: control.operationId });
                if (control.op === 'stop') {
                    ack();
                    finish({ classification: 'cancelled', outputText: partialText(), data: { reason: 'stopped' } }).catch((error) => log('end_failed', { error: describe(error) }));
                    return;
                }
                if (control.op !== 'message') { ack(); continue; }
                const record = { type: 'message', id: control.payload.id ?? control.operationId, message: control.payload.message };
                if (control.payload.displayText !== undefined) record.displayText = control.payload.displayText;
                let delivered = false;
                try { delivered = await streams.reader.writeControl(record); } catch { delivered = false; }
                // A control that could not be written stays pending; the attempt is ending (stdin closed).
                if (!delivered) return;
                ack();
            }
        }

        try {
            starting = (async () => {
                execution = await factory.open({ item, plan, context });
                return execution.start();
            })();
            const opened = await starting;
            relay = createEventRelay({
                record: (events) => store.recordReferenceEvents({ executionId: item.executionId, attemptId: item.attemptId, events }), log
            });
            readerEnded = new Promise((resolve) => {
                streams = openAlaStreams({
                    ...opened, limits: streamLimits,
                    onRecord: (record, bytes) => relay.push(record, bytes),
                    onEnd: (reason, detail) => {
                        resolve();
                        if (FATAL_READER_ENDS.has(reason) && fatal === null) {
                            fatal = { reason, detail: typeof detail === 'string' ? detail : null };
                            fatalSignal.resolve();
                        }
                    }
                });
            });
            if (finishing !== null) { await finishing; return; }
            let promptWritten = false;
            try { promptWritten = await streams.reader.writeControl(plan.prompt); } catch { promptWritten = false; }
            if (!promptWritten) {
                await finish({ classification: 'failed', data: { reason: 'prompt_not_delivered' } });
                return;
            }
            controlTimer = timers.setInterval(() => { deliverControls().catch((error) => log('controls_failed', { error: describe(error) })); }, settings.controlPollMs);
            controlTimer.unref?.();

            // `execution.lost` (optional) resolves with a reason when the endpoint or the anchor is lost before the end.
            if (execution.lost) execution.lost.then((reason) => { if (fatal === null) { fatal = { reason: 'execution_lost', detail: String(reason).slice(0, 80) }; fatalSignal.resolve(); } });
            const exit = await Promise.race([execution.exited, fatalSignal.promise.then(() => null), endedSignal.then(() => null)]);
            if (finishing !== null) { await finishing; return; }
            if (exit === null) {
                await finish({ classification: 'failed', outputText: partialText(), data: { reason: fatal.reason, ...(fatal.detail ? { detail: fatal.detail } : {}) } });
                return;
            }
            // ALA has exited: let the remaining records and the final text arrive, but not for long.
            await Promise.race([Promise.all([streams.final.done, readerEnded]), sleep(settings.drainMs)]);
            if (finishing !== null) { await finishing; return; }
            const text = streams.final.text().trimEnd();
            if (fatal !== null) await finish({ classification: 'failed', outputText: text, data: { reason: fatal.reason } });
            else if (streams.final.overflowed) await finish({ classification: 'failed', outputText: text, data: { reason: 'output_too_large' } });
            else if (exit.exitCode === 0 && text.length > 0) await finish({ classification: 'completed', outputText: text, data: null });
            else if (exit.exitCode === 0) await finish({ classification: 'failed', data: { reason: 'no_result' } });
            else if (exit.exitCode === 130) await finish({ classification: 'interrupted', outputText: text, data: { reason: 'ala_interrupted' } });
            else await finish({ classification: 'failed', outputText: text, data: { reason: 'ala_failed', exitCode: exit.exitCode, signal: exit.signal } });
        } catch (error) {
            log('execution_failed', { error: describe(error) });
            try {
                const reason = typeof error?.reason === 'string' && /^[a-z0-9_]{1,48}$/u.test(error.reason) ? error.reason : null;
                await finish({ classification: 'failed', outputText: partialText(), data: { reason: reason ?? (streams === null ? 'start_failed' : 'execution_error') } });
            } catch (endError) {
                log('end_failed', { error: describe(endError) });
            }
        }
    }

    function poll() {
        if (closed) return;
        let slots = settings.maxConcurrent - active.size;
        if (slots <= 0) return;
        let items;
        try {
            items = store.listQueuedAdmissions({ limit: 64 });
        } catch (error) {
            log('poll_failed', { error: describe(error) });
            return;
        }
        for (const item of items) {
            if (slots <= 0) break;
            if (active.has(item.executionId)) continue;
            slots -= 1;
            const ref = { shutdown: null };
            const promise = run(item, ref).catch((error) => log('run_failed', { error: describe(error) })).finally(() => active.delete(item.executionId));
            active.set(item.executionId, { promise, ref });
        }
    }

    return Object.freeze({
        poll,
        start() {
            if (timer === null) { timer = timers.setInterval(poll, settings.pollMs); timer.unref?.(); }
            poll();
        },
        // Ends every running attempt as interrupted and waits for the end paths.
        async close() {
            closed = true;
            if (timer !== null) { timers.clearInterval(timer); timer = null; }
            const running = [...active.values()];
            await Promise.allSettled(running.map(({ ref }) => ref.shutdown?.() ?? Promise.resolve()));
            await Promise.allSettled(running.map(({ promise }) => promise));
        },
        get activeCount() { return active.size; }
    });
}

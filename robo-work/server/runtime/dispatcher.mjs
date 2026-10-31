import crypto from 'node:crypto';

import { createVerifiedServiceContext, WorkerStateError, byteLength } from '../stateProtocol.mjs';
import { resolveControlStreamLimits } from '../execution/executionLimits.mjs';
import { PlanError, planAlaExecution } from './alaPlan.mjs';
import { openAlaStreams } from './alaStreams.mjs';
import { createEventRelay } from './eventRelay.mjs';
import { createAttemptWatchdog } from './attemptWatchdog.mjs';

// The execution dispatcher (RoboWork r10 wiring). It picks queued attempts, runs ALA for each one through an execution
// (the sandbox supervisor, ledger and provider endpoint; see executionFactory.mjs), relays ALA's records as bounded
// reference events, delivers pending controls and ends the attempt with a classification and the final text.
//
// Execution seam (`factory.open(...)` returns it; tests supply a fake):
//   open({ item, plan, context }) -> execution
//   execution.start()  -> Promise<{ stdin, stdout, stderr }>   everything is published and the ALA process runs, gated
//   execution.exited   -> Promise<{ exitCode, signal }>        of the orchestration process
//   execution.lost     -> Promise<string>  (optional)           resolves when the endpoint or the anchor is lost before the end
//   execution.lastModelError() -> { status, message } | null  (optional)  the last upstream error of the Soul Gateway model channel (M-43 (a))
//   execution.end({ classification, outputText, data }) -> Promise   the section 5.5 end path; step 1 is beginAttemptEnd
//
// A failure before an execution exists ends the attempt directly through beginAttemptEnd.

const DEFAULTS = Object.freeze({ maxConcurrent: 4, pollMs: 250, controlPollMs: 200, drainMs: 2000, exitGraceMs: 10000, failureAbortMs: 100, humanInputGraceMs: 10000, inactivityTimeoutMs: 20 * 60 * 1000, maxAttemptMs: 4 * 60 * 60 * 1000, resultBytes: 512 * 1024 - 1024 });
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

// The last of ALA's own diagnostic lines, for the worker log only (never the result): lines that start with `ala:` (ALA's error
// prefix) and nothing the coding agents wrote, each cut and stripped of anything that looks like a token or key, at most 2 KiB.
export function alaDiagnostics(tail) {
    const lines = tail.toString('utf8').split('\n').filter((line) => line.startsWith('ala:'))
        .map((line) => line.slice(0, 300).replace(/Bearer\s+\S+/giu, 'Bearer [redacted]').replace(/[A-Za-z0-9_+/=-]{32,}/gu, '[redacted]'));
    return lines.join('\n').slice(-2048);
}

export function createDispatcher({
    store, workspaceId, workspaceRoot, factory, controlLimits, options = {}, log = () => {}, timers = { setInterval, clearInterval, setTimeout, clearTimeout }
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
    const givenUp = new Set(); // attempts whose start was refused for a reason that a retry cannot change
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
            // Anything else would be retried at every poll for ever: fail the attempt once, and remember the refusal if even that fails.
            log('transition_refused', { executionId: item.executionId, error: describe(error) });
            givenUp.add(item.executionId);
            endDirect(item, 'queued', { classification: 'failed', data: { reason: 'start_refused' } });
            return;
        }

        log('attempt_start', { executionId: item.executionId, attemptId: item.attemptId, robotId: item.robotId, kind: item.kind });
        // M-33: the time bounds of a task attempt. Activity is an ALA control-stream record, ALA output, a request from ALA to the provider
        // (including a workload start, stop and exit) and any input delivered to the attempt (prompt, message). They run from here, while the
        // attempt is starting or running, and stop with its end or at a human-input question.
        const watchdog = createAttemptWatchdog({
            inactivityMs: settings.inactivityTimeoutMs, maxMs: settings.maxAttemptMs, timers, now: settings.now ?? Date.now,
            onTimeout: (reason, { runningMs }) => {
                log('attempt_timeout', { executionId: item.executionId, attemptId: item.attemptId, reason, runningMs });
                (async () => {
                    // An attempt still being published is ended once that is over, as at a shutdown.
                    if (starting !== null) await starting.catch(() => {});
                    if (finishing !== null) return;
                    // M-43 (a): an inactive attempt tells the user the last error the model channel saw (status and a sanitized message of
                    // at most 300 characters), so a quota or provider failure is visible instead of a bare timeout.
                    let lastModelError = null;
                    if (reason === 'inactive_timeout') { try { lastModelError = execution?.lastModelError?.() ?? null; } catch { lastModelError = null; } }
                    // The normal end path; if its stop cannot be verified S1 publishes `termination_unverified`, which wins.
                    await finish({ classification: 'failed', outputText: partialText(), data: { reason, ...(lastModelError ? { lastModelError } : {}) } });
                })().catch((error) => log('end_failed', { error: describe(error) }));
            }
        });
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
        let failureMessage = null;
        let humanRequest = null;
        let channelTimer = null;
        const endLater = (ms, outcome, { replace = false } = {}) => {
            if (replace && channelTimer !== null) { timers.clearTimeout(channelTimer); channelTimer = null; }
            channelTimer ??= timers.setTimeout(() => { finish(outcome()).catch((error) => log('end_failed', { error: describe(error) })); }, ms);
            channelTimer.unref?.();
        };
        // Once a question is recorded the attempt can be answered: any end other than a stop (`cancelled`) or a recorded task
        // failure is the `human-input` end, keeping the original reason, exit code and signal for diagnosis. A recorded task
        // failure wins over a question (task_blocked), whatever timer or exit comes first; a stop is always `cancelled`.
        const normalize = (outcome) => {
            if (outcome.classification === 'cancelled') return outcome;
            if (failureMessage !== null) {
                return outcome.classification === 'failed' && outcome.data?.reason === 'task_blocked' ? outcome
                    : { classification: 'failed', outputText: outcome.outputText ?? '', data: { reason: 'task_blocked', message: failureMessage } };
            }
            if (humanRequest !== null && outcome.classification !== 'human-input') {
                const { reason, exitCode, signal, detail } = outcome.data ?? {};
                return {
                    classification: 'human-input', outputText: outcome.outputText ?? '',
                    data: { reason: 'human_input', requestId: humanRequest.requestId, ...(reason ? { endedBy: reason } : {}),
                        ...(exitCode !== undefined ? { exitCode } : {}), ...(signal ? { signal } : {}), ...(detail ? { detail } : {}) }
                };
            }
            return outcome;
        };
        const refused = (status, message) => Object.assign(new Error(message), { statusCode: status });
        // The worker-hosted channels (M-14). Each handler records its event durably BEFORE it returns, which is before the channel
        // replies to the skill. The failure channel ends the run as the local engine does (the skill tells the model to stop); the
        // human-input channel tells the model to end, and the worker ends the attempt `human-input` after a bounded grace.
        const channels = {
            taskFailure: plan.channels.taskFailure ? async ({ message }) => {
                if (finishing !== null) throw refused(409, 'The execution is ending');
                watchdog.touch();
                store.recordChannelEvent({ executionId: item.executionId, attemptId: item.attemptId, type: 'task-failed', data: { message } });
                failureMessage ??= message;
                endLater(settings.failureAbortMs, () => ({ classification: 'failed', outputText: partialText(), data: { reason: 'task_blocked', message: failureMessage } }), { replace: true });
                return {};
            } : null,
            humanInput: plan.channels.humanInput ? async ({ question, options }) => {
                if (finishing !== null) throw refused(409, 'The execution is ending');
                if (humanRequest !== null) {
                    if (humanRequest.question === question && JSON.stringify(humanRequest.options) === JSON.stringify(options)) return { id: humanRequest.requestId };
                    throw refused(409, 'A human-input question is already pending');
                }
                const requestId = crypto.randomBytes(16).toString('base64url');
                store.recordChannelEvent({ executionId: item.executionId, attemptId: item.attemptId, type: 'human-input-request', data: { requestId, question, options } });
                humanRequest = { requestId, question, options };
                // A human-input wait is not the model's inactivity: the attempt is ended by the grace period, not by the clock.
                watchdog.suspend();
                endLater(settings.humanInputGraceMs, () => ({ classification: 'human-input', outputText: partialText(), data: { reason: 'human_input', requestId } }));
                return { id: requestId };
            } : null
        };
        // The one end of this attempt, whoever asks first (exit, stop, a fatal stream error, shutdown).
        const finish = (outcome) => {
            if (finishing === null) signalEnded();
            finishing ??= (async () => {
                watchdog.stop();
                if (controlTimer !== null) { timers.clearInterval(controlTimer); controlTimer = null; }
                if (channelTimer !== null) { timers.clearTimeout(channelTimer); channelTimer = null; }
                streams?.reader.end('ended_by_dispatcher');
                if (relay) await relay.close().catch(() => {});
                const fitted = fitOutcome(normalize(outcome), settings.resultBytes);
                if (streams && fitted.classification !== 'completed' && fitted.classification !== 'cancelled') {
                    const text = alaDiagnostics(streams.reader.stderrTail());
                    if (text) log('ala_stderr_tail', { executionId: item.executionId, attemptId: item.attemptId, text });
                }
                if (execution) await execution.end(fitted);
                else store.beginAttemptEnd(context, { executionId: item.executionId, attemptId: item.attemptId, expectedState: 'running', outcome: fitted });
                log('attempt_end', { executionId: item.executionId, attemptId: item.attemptId, classification: fitted.classification, reason: fitted.data?.reason ?? null });
            })();
            return finishing;
        };
        // A shutdown that arrives while the execution is still being published waits for that, so the execution it ends exists.
        shutdownRef.shutdown = async () => {
            if (starting !== null) await starting.catch(() => {});
            return finish({ classification: 'interrupted', outputText: partialText(), data: { reason: 'worker_shutdown' } });
        };

        // One delivery pass at a time per attempt, and a control that was written is never written again, whatever the stdin
        // flush or the acknowledgement does: a pass that awaits a slow stdin must not let the next interval tick re-take it.
        let delivering = false;
        const writtenControls = new Set();
        async function deliverControls() {
            if (finishing !== null || delivering) return;
            delivering = true;
            try {
                await deliverPass();
            } finally {
                delivering = false;
            }
        }

        async function deliverPass() {
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
                const key = `${control.actorKey}|${control.operationId}`;
                if (writtenControls.has(key)) { ack(); continue; }
                const record = { type: 'message', id: control.payload.id ?? control.operationId, message: control.payload.message };
                if (control.payload.displayText !== undefined) record.displayText = control.payload.displayText;
                let delivered = false;
                try { delivered = await streams.reader.writeControl(record); } catch { delivered = false; }
                // A control that could not be written stays pending; the attempt is ending (stdin closed).
                if (!delivered) return;
                writtenControls.add(key);
                watchdog.touch();
                ack();
            }
        }

        try {
            starting = (async () => {
                execution = await factory.open({ item, plan, context, channels, activity: () => watchdog.touch() });
                return execution.start();
            })();
            const opened = await starting;
            relay = createEventRelay({
                record: (events) => store.recordReferenceEvents({ executionId: item.executionId, attemptId: item.attemptId, events }), log
            });
            readerEnded = new Promise((resolve) => {
                streams = openAlaStreams({
                    ...opened, limits: streamLimits,
                    onRecord: (record, bytes) => { watchdog.touch(); relay.push(record, bytes); },
                    onActivity: () => watchdog.touch(),
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
            watchdog.touch();
            controlTimer = timers.setInterval(() => { deliverControls().catch((error) => log('controls_failed', { error: describe(error) })); }, settings.controlPollMs);
            controlTimer.unref?.();

            // `execution.lost` (optional) resolves with a reason when the endpoint or the anchor is lost before the end.
            if (execution.lost) execution.lost.then((reason) => { if (fatal === null) { fatal = { reason: 'execution_lost', detail: String(reason).slice(0, 80) }; fatalSignal.resolve(); } });
            let exit = await Promise.race([execution.exited, fatalSignal.promise.then(() => null), endedSignal.then(() => null)]);
            if (finishing !== null) { await finishing; return; }
            // An endpoint that ends because ALA died is reported first by the channel and a moment later by the process: when the process
            // exits within the grace period, its exit code is the reason (the endpoint loss is only its echo). The tree's exit is the
            // bwrap monitor's, after its namespace is torn down; it was observed live more than 750 ms after a clean ALA finish (F-R1),
            // so the grace is generous: only a real loss pays it.
            if (exit === null && fatal?.reason === 'execution_lost') {
                const late = await Promise.race([execution.exited, sleep(settings.exitGraceMs)]);
                if (late && typeof late === 'object') { fatal = null; exit = late; }
            }
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
            else if (failureMessage !== null) await finish({ classification: 'failed', outputText: text, data: { reason: 'task_blocked', message: failureMessage } });
            else if (humanRequest !== null && exit.exitCode === 0) await finish({ classification: 'human-input', outputText: text, data: { reason: 'human_input', requestId: humanRequest.requestId } });
            else if (exit.exitCode === 0 && text.length > 0) await finish({ classification: 'completed', outputText: text, data: null });
            else if (exit.exitCode === 0) await finish({ classification: 'failed', data: { reason: 'no_result' } });
            else if (exit.exitCode === 130) await finish({ classification: 'interrupted', outputText: text, data: { reason: 'ala_interrupted' } });
            else await finish({ classification: 'failed', outputText: text, data: { reason: 'ala_failed', exitCode: exit.exitCode, signal: exit.signal, detail: `ala_exit:${exit.exitCode ?? exit.signal}` } });
        } catch (error) {
            // A sandbox launch failure carries a bounded code and detail (SandboxError); nothing of the prompt or the environment.
            log('execution_failed', {
                executionId: item.executionId, attemptId: item.attemptId, error: describe(error),
                ...(error?.name === 'SandboxError' || error?.name === 'ExecutionSetupError' ? { detail: String(error.detail ?? error.message ?? '').slice(0, 200) } : {})
            });
            try {
                const reason = typeof error?.reason === 'string' && /^[a-z0-9_]{1,48}$/u.test(error.reason) ? error.reason : null;
                const code = error?.name === 'SandboxError' && /^[a-z_]{1,40}$/u.test(String(error.code)) ? error.code : null;
                await finish({ classification: 'failed', outputText: partialText(), data: { reason: reason ?? (streams === null ? 'start_failed' : 'execution_error'), ...(code ? { detail: code } : {}) } });
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
            if (active.has(item.executionId) || givenUp.has(item.executionId)) continue;
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

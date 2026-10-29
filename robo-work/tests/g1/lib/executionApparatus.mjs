// Test-only composition. Synthetic authority and injected OS adapters are not Linux/G1 evidence.
import { createProcView } from '../../../server/execution/procView.mjs';
import { createExecutionKeeper } from '../../../server/execution/keeperClient.mjs';
import { createExecutionLedger } from '../../../server/execution/resourceLedger.mjs';
import { createWalker, recoverGeneration } from '../../../server/execution/recoveryWalk.mjs';
import { createSupervisorEndpointServer } from '../../../server/execution/supervisorEndpointServer.mjs';
import { createControlStreamReader } from '../../../server/execution/controlStreamReader.mjs';
import { createAdmission } from '../../../server/execution/supervisorRequestValidator.mjs';
import { resolveControlStreamLimits, resolveEndpointLimits } from '../../../server/execution/executionLimits.mjs';
import { virtualPathProblem } from '../../../server/execution/providerSchema.mjs';

const factories = { createProcView, createExecutionKeeper, createSupervisorEndpointServer, createControlStreamReader };
const requiredStateMethods = ['reserveResource', 'commitResource', 'getResource', 'listUnsettledResources',
    'settleResource', 'beginAttemptEnd', 'getReference', 'close', 'beginGenerationRecovery', 'completeGenerationRecovery'];
const endingError = () => Object.assign(new Error('Apparatus admission is closed'), { code: 'execution_ending' });
const absolute = (value) => typeof value === 'string' && value !== '/' && virtualPathProblem(value) === null;

// state is an already-open task-owned WorkerState; its admitted attempt must be running. reopenState returns a fresh
// handle to that SAME store with create:false. The caller owns store handles and the pre-opened HOME descriptor.
// admission supplies robotId/executionId/attemptId/referenceId, the pinned inventory and private streamDirectory.
// synthetic:true is an explicit test assertion, not an authorization brand. context must still pass WorkerState checks.
// limits has keeper/view/endpoint/control override objects and mandatory positive releaseDeadlineMs/pollMs. Defaults
// within those objects remain the production modules' PROVISIONAL limits. publicationDrainMs defaults to
// releaseDeadlineMs and bounds cancellation drainage in wall-clock time; timeout retains blockers for recovery.
// clock has now()/sleep(ms) for the production walker.
// orchestration has script/args/env; the final environment receives Node JSON IPC fd 3. No setup environment is added.
// adapters replaces named constructors for pure tests; procOptions supplies a fake procRoot/signal when appropriate.
// faults has the real ledger's publication/release hooks. Hooks must not await end() from inside a pending publication.
export function createExecutionApparatus({
    state, reopenState, context, synthetic, admission, layout, home, orchestrationRoot, orchestration,
    limits, clock, faults = {}, onRecord, validateRecord, adapters = {}, procOptions = {},
} = {}) {
    if (synthetic !== true || !context || typeof reopenState !== 'function') throw new TypeError('Explicit synthetic context and reopenState are required');
    if (!state || requiredStateMethods.some((name) => typeof state[name] !== 'function')) throw new TypeError('A durable WorkerState handle is required');
    if (!admission || ['robotId', 'executionId', 'attemptId', 'referenceId'].some((name) => typeof admission[name] !== 'string' || admission[name].length === 0)) {
        throw new TypeError('Admitted execution identity is required');
    }
    if (!Array.isArray(admission.inventory) || admission.inventory.length === 0
        || admission.inventory.some((entry) => !entry || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(entry.name))) {
        throw new TypeError('The fixed inventory is required');
    }
    if (!layout || !absolute(layout.runtimeDir) || layout.cgroupSubtree !== null) throw new TypeError('A runtime layout with null cgroupSubtree is required');
    if (!absolute(admission.streamDirectory) || !admission.streamDirectory.startsWith(`${layout.runtimeDir}/`)) throw new TypeError('A private runtime stream directory is required');
    if (!home || !Number.isSafeInteger(home.fd) || home.fd < 0
        || !['dev', 'ino'].every((key) => typeof home.identity?.[key] === 'string' && /^[0-9]{1,20}$/u.test(home.identity[key]))) {
        throw new TypeError('A held HOME descriptor and identity are required');
    }
    if (!absolute(orchestrationRoot) || !absolute(orchestration?.script) || !orchestration.script.startsWith(`${orchestrationRoot}/`)
        || !Array.isArray(orchestration.args) || orchestration.args.some((arg) => typeof arg !== 'string')
        || Object.keys(orchestration).sort().join(',') !== 'args,env,script'
        || !orchestration.env || Array.isArray(orchestration.env) || Object.values(orchestration.env).some((value) => typeof value !== 'string')) {
        throw new TypeError('An explicit orchestration fixture is required');
    }
    if (!limits || ['releaseDeadlineMs', 'pollMs'].some((key) => !Number.isSafeInteger(limits[key]) || limits[key] <= 0)) throw new TypeError('Positive recovery bounds are required');
    const drainDeadlineMs = limits.publicationDrainMs ?? limits.releaseDeadlineMs;
    if (!Number.isSafeInteger(drainDeadlineMs) || drainDeadlineMs <= 0) throw new TypeError('A positive publication drain deadline is required');
    if (typeof clock?.now !== 'function' || typeof clock?.sleep !== 'function') throw new TypeError('An explicit clock is required');
    if (typeof onRecord !== 'function' || typeof validateRecord !== 'function') throw new TypeError('Control record handlers are required');
    if (Object.keys(adapters).some((key) => !Object.hasOwn(factories, key) || typeof adapters[key] !== 'function')) throw new TypeError('Unknown apparatus adapter');
    if (Object.keys(procOptions).some((key) => !['procRoot', 'signal', 'containerDevpts', 'statfs'].includes(key))) throw new TypeError('Unknown proc option');
    const reference = state.getReference(context, { referenceId: admission.referenceId });
    if (['robotId', 'executionId', 'attemptId'].some((key) => reference[key] !== admission[key])) throw new TypeError('The admitted identity does not match the durable reference');

    const make = { ...factories, ...adapters };
    const endpointLimits = resolveEndpointLimits(limits.endpoint ?? {});
    const controlLimits = resolveControlStreamLimits(limits.control ?? {});
    const runtimeLayout = Object.freeze({ runtimeDir: layout.runtimeDir, cgroupSubtree: null });
    const identity = Object.fromEntries(['robotId', 'executionId', 'attemptId', 'referenceId'].map((key) => [key, admission[key]]));
    const providerAdmission = createAdmission({
        grants: [], inventory: admission.inventory, streamDirectory: admission.streamDirectory, networkModes: ['none'],
    });
    const fixture = structuredClone(orchestration);
    fixture.env = { ...fixture.env, NODE_CHANNEL_FD: '3', NODE_CHANNEL_SERIALIZATION_MODE: 'json' };
    let currentState = state;
    let phase = 'idle';
    let startPromise = null;
    let endPromise = null;
    let recoveryPromise = null;
    let endpoint = null;
    let control = null;
    let endReason = null;
    let endFailed = false;
    const pending = new Set();
    const published = [];
    const isOpen = () => phase === 'starting' || phase === 'running';
    const assertOpen = () => { if (!isOpen()) throw endingError(); };
    const keeperRecord = (blocker) => currentState.getResource({ resourceId: blocker.locator.keeper });
    const view = make.createProcView({
        ...procOptions, runtimeRoot: runtimeLayout.runtimeDir, cgroupSubtree: null, keeperRecord,
        identityForLocator: (kind, locator) => currentState.listUnsettledResources().find((entry) => entry.kind === kind
            && Object.keys(locator).every((key) => entry.locator[key] === locator[key]))?.identity ?? null,
    });
    if (view.cgroupSubtree !== null) throw new TypeError('cgroup_subtree_mismatch');
    const walker = () => createWalker({
        view, clock, keeperRecord, releaseDeadlineMs: limits.releaseDeadlineMs, pollMs: limits.pollMs,
    });
    const lose = (reason) => {
        if (!isOpen()) return;
        endReason ??= reason;
        // Endpoint/client callbacks are synchronous and intentionally do not await the shared teardown.
        end({ classification: 'failed' }).catch(() => {});
    };
    const keeper = make.createExecutionKeeper({
        scope: 'execution', runtimeRoot: runtimeLayout.runtimeDir, ala: true, grantRoots: [],
        home: structuredClone(home), orchestrationRoot, limits: limits.keeper ?? {}, viewLimits: limits.view ?? {},
        endpointLimits, view, cgroupSubtree: null, onInfrastructureLoss: lose,
    });
    // The production ledger remains the only reserve/commit/release implementation. This adapter only prevents a
    // cancelled publication from advancing, including a create that completes after the cancellation fence.
    const guardedKeeper = {
        ...keeper,
        async create(request) {
            assertOpen();
            const created = await keeper.create(request);
            if (!isOpen()) {
                await created.gate?.abort();
                throw endingError();
            }
            if (!created.gate) return created;
            return { ...created, gate: {
                abort: () => created.gate.abort(),
                commit: async () => {
                    if (!isOpen()) { await created.gate.abort(); throw endingError(); }
                    return created.gate.commit();
                },
            } };
        },
    };
    const guardedFaults = { ...faults };
    for (const name of ['afterReserve', 'afterCreate', 'afterCommit', 'afterGateRelease']) {
        guardedFaults[name] = async (info) => {
            assertOpen();
            await faults[name]?.(info);
            assertOpen();
        };
    }
    const ledger = createExecutionLedger({
        state, context, ...identity, layout: runtimeLayout, keeper: guardedKeeper, walker: walker(), clock, faults: guardedFaults,
    });
    function publish(request) {
        assertOpen();
        const operation = request.kind === 'keeper' ? ledger.startKeeper() : ledger.publish(request);
        pending.add(operation);
        return operation.then((record) => { published.push(record); return record; }).finally(() => pending.delete(operation));
    }
    const providerLedger = { publish };

    function closeChannels() {
        endpoint?.end('apparatus_ending');
        control?.end('apparatus_ending');
    }

    function end(outcome = { classification: 'cancelled' }) {
        if (endPromise) return endPromise;
        if (recoveryPromise) return Promise.reject(endingError());
        phase = 'ending';
        // Install the promise before closing channels, whose callbacks can synchronously request another end.
        endPromise = Promise.resolve().then(async () => {
            closeChannels();
            const uncommitted = ledger.unsettled().filter((entry) => entry.identity === null).map((entry) => entry.resourceId);
            const abort = Promise.resolve().then(() => {
                if (uncommitted.length) return keeper.abortUncommitted(uncommitted);
            });
            let timer;
            try {
                await Promise.race([
                    Promise.allSettled([...pending, abort]),
                    new Promise((resolve, reject) => {
                        timer = setTimeout(() => reject(Object.assign(new Error('Publication drain timed out'), { code: 'publication_drain_timeout' })), drainDeadlineMs);
                    }),
                ]);
            } finally { clearTimeout(timer); }
            return ledger.endExecution(outcome);
        }).then((result) => { phase = 'ended'; return result; }, (error) => {
            phase = 'ended';
            endFailed = true;
            throw error;
        });
        return endPromise;
    }

    function start() {
        if (!['idle', 'starting', 'running'].includes(phase)) return Promise.reject(endingError());
        if (startPromise) return startPromise;
        if (phase !== 'idle') return Promise.reject(endingError());
        if (state.getReference(context, { referenceId: identity.referenceId }).state !== 'running') {
            return Promise.reject(new TypeError('The admitted attempt must be running'));
        }
        phase = 'starting';
        startPromise = (async () => {
            try {
                await publish({ kind: 'keeper' });
                await publish({ kind: 'runtime-dir' });
                const netns = await publish({ kind: 'netns' });
                assertOpen();
                const streams = keeper.controlStreams;
                if (!keeper.endpointSocket || !streams?.stdin || !streams?.stdout || !streams?.stderr) throw new TypeError('Inherited endpoint and control sockets are required');
                endpoint = make.createSupervisorEndpointServer({
                    socket: keeper.endpointSocket, admission: providerAdmission,
                    keeper: keeper.providerKeeper(providerLedger, { netnsHandle: netns.handle }), limits: endpointLimits, onEnd: lose,
                });
                assertOpen();
                control = make.createControlStreamReader({
                    ...streams, limits: controlLimits,
                    validateRecord: (record) => {
                        try { return validateRecord(record); } catch { return 'invalid_record'; }
                    },
                    onRecord: async (...args) => {
                        if (!isOpen()) return;
                        try { await onRecord(...args); } catch { lose('control_record_failed'); }
                    },
                    onEnd: lose,
                });
                assertOpen();
                await publish({ kind: 'endpoint', spec: {
                    netns: netns.handle, config: { limits: endpointLimits, relays: [], streamDirectory: providerAdmission.streamDirectory },
                } });
                await publish({ kind: 'process-tree', spec: { role: 'orchestration', ...fixture, netns: null } });
                assertOpen();
                phase = 'running';
                return diagnostics();
            } catch (error) {
                // A simulated supervisor crash deliberately leaves durable reservations for a fresh recovery handle.
                if (error?.injectedCrash === true) { phase = 'crashed'; closeChannels(); throw error; }
                endReason ??= 'start_failed';
                await end({ classification: 'failed' });
                throw error;
            }
        })();
        return startPromise;
    }

    function recover() {
        if (recoveryPromise) return recoveryPromise;
        if (phase !== 'idle') return Promise.reject(endingError());
        phase = 'recovering';
        recoveryPromise = Promise.resolve().then(async () => {
            const generation = currentState.generationId;
            currentState.close();
            currentState = await reopenState();
            if (!currentState || currentState === state) throw new TypeError('Recovery requires a freshly reopened durable store');
            if (currentState.generationId !== generation) throw new TypeError('The reopened generation does not match the durable store');
            const recoveredReference = currentState.getReference(context, { referenceId: identity.referenceId });
            if (['robotId', 'executionId', 'attemptId'].some((key) => recoveredReference[key] !== identity[key])) throw new TypeError('The reopened admission does not match the durable store');
            return recoverGeneration({ state: currentState, walker: walker() });
        }).then((result) => { phase = 'recovered'; return result; }, (error) => { phase = 'recovery_failed'; throw error; });
        return recoveryPromise;
    }

    function diagnostics() {
        return {
            phase, endReason, endFailed, pendingPublications: pending.size,
            resources: published.map(({ resourceId, kind }) => ({ resourceId, kind })),
            keeper: keeper.stats?.() ?? null, endpoint: endpoint?.stats() ?? null, control: control?.stats() ?? null,
        };
    }

    return { start, end, recover, diagnostics };
}

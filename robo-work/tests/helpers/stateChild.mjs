// SYNTHETIC child-process fixture. Usage: node stateChild.mjs '<json spec>'
// The child opens the store with an always-ready synthetic adapter, prints "ready",
// waits for a "go" line on stdin, runs one worker-state method and prints one JSON
// line. `fault` ({when: 'beforeCommit'|'afterCommit', label}) SIGKILLs the process at
// that transaction point through the opt-in test-only fault hook. Optional: `now` (a fixed
// store clock in milliseconds), `limits` (replacing the base LIMITS) and `coordinatorContext`
// (fields of a verified coordinator context, used instead of `context`).
import readline from 'node:readline';
import { openWorkerState, createVerifiedContext, createVerifiedCoordinatorContext } from '../../server/workerState.mjs';
import { LIMITS, PROVIDER, WORKSPACE, syntheticRuntime } from './synthetic.mjs';

const spec = JSON.parse(process.argv[2]);
const faults = {};
if (spec.fault) {
    faults[spec.fault.when] = (label) => {
        if (label === spec.fault.label) process.kill(process.pid, 'SIGKILL');
    };
}
const openStore = () => openWorkerState({
    dataDir: spec.dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: spec.limits ?? LIMITS, create: spec.create === true,
    runtime: syntheticRuntime(), faults, ...(spec.now === undefined ? {} : { now: () => spec.now })
});
// method 'open' races the open itself (concurrent first creation); others open before "ready".
let store = spec.method === 'open' ? null : openStore();
const lines = readline.createInterface({ input: process.stdin });
process.stdout.write('ready\n');
lines.once('line', () => {
    let output;
    try {
        let result;
        if (spec.method === 'open') {
            store = openStore();
            result = { generationId: store.generationId };
        } else if (spec.method === 'beginGenerationRecovery') {
            result = store.beginGenerationRecovery(spec.request.expectedGeneration);
        } else if (spec.coordinatorContext !== undefined) {
            result = store[spec.method](createVerifiedCoordinatorContext(spec.coordinatorContext), spec.request);
        } else if (spec.context === undefined) {
            result = store[spec.method](spec.request);
        } else {
            const context = createVerifiedContext(spec.context);
            result = store[spec.method](context, spec.request);
        }
        output = { ok: true, result };
    } catch (error) {
        output = { ok: false, code: error.code ?? 'unexpected', name: error.name };
    }
    store?.close();
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exit(0);
});

// SYNTHETIC test helpers. Every context and runtime adapter built here is a test
// double: no robot command is launched and no routed authority is established.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createVerifiedContext, openWorkerState } from '../../server/workerState.mjs';
import { OPERATIONS, deriveOperationId, randomId } from '../../server/stateProtocol.mjs';

export const LIMITS = Object.freeze({ requestBytes: 4096, robots: 8, receipts: 64, admissions: 32, resultBytes: 512 });
// Base, S1x extension and S6 limits (S6 Part D obligations).
export const S6_LIMITS = Object.freeze({
    ...LIMITS, bindings: 16, controls: 16, tokenReplayEntries: 256, obligations: 32, outboxRevisions: 64, obligationAcceptMs: 10000
});
export const WORKSPACE = 'ws-synthetic';
export const PROVIDER = 'provider-synthetic';

export function newOriginId() {
    return crypto.randomBytes(16).toString('base64url');
}

export function newId() {
    return randomId();
}

export function syntheticContext(overrides = {}) {
    return createVerifiedContext({
        workspaceId: WORKSPACE, scope: 'scope-synthetic-a', ownerId: 'owner-synthetic-a',
        operations: [...OPERATIONS], originNamespace: 'mcp', originKey: 'user:synthetic-a', ...overrides
    });
}

export function syntheticRuntime(options = {}) {
    const runtime = {
        name: 'synthetic-runtime', prepare: options.prepare ?? true, attest: options.attest ?? true,
        admit: options.admit ?? true, required: options.required ?? {}, absence: options.absence ?? (() => true),
        attestCalls: [], verifyCalls: [],
        canPrepare() { return this.prepare; },
        attestRobot(info) { this.attestCalls.push(info); return this.attest; },
        admissionReady() { return this.admit; },
        requiredKinds(operation) { return this.required[operation] ?? []; },
        verifyAbsence(info) { this.verifyCalls.push(info); return this.absence(info); }
    };
    return runtime;
}

// Creates an isolated temporary data directory under the real OS temp directory.
export function makeTempDir(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'robo-work-state-')));
    t.after(() => {
        if (path.basename(dir).startsWith('robo-work-state-') && path.dirname(dir) === fs.realpathSync(os.tmpdir())) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    return dir;
}

export function openStore(dir, options = {}) {
    return openWorkerState({
        dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS,
        create: true, runtime: syntheticRuntime(), ...options
    });
}

export function storeFile(dir) {
    return path.join(dir, 'execution-store', 'worker-state.sqlite');
}

export function rawDb(dir, options = {}) {
    return new DatabaseSync(storeFile(dir), options);
}

export function count(dir, table) {
    const db = rawDb(dir, { readOnly: true });
    try {
        return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    } finally {
        db.close();
    }
}

export function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function robotConfig(settings = {}, backend = 'synthetic') {
    return { backend, settings };
}

// Provisions and completes a robot (synthetic adapter). Returns its ID.
export function readyRobot(store, context, configuration = robotConfig()) {
    const operationId = newId();
    const { robotId } = store.beginProvision(context, { operationId, name: 'Synthetic robot', configuration });
    store.completePreparation(context, { operationId, outcome: 'succeeded' });
    return robotId;
}

// The operation ID is derived from the verified origin, so the request is built for a context.
export function admitRequest(robotId, overrides = {}, context = syntheticContext()) {
    const originRequestId = overrides.originRequestId ?? newOriginId();
    return {
        operationId: deriveOperationId(context, originRequestId), originRequestId, robotId, configRevision: 1,
        kind: 'task', logical: {}, specification: { prompt: 'synthetic task' }, ...overrides
    };
}

// Ends an attempt through beginAttemptEnd (step 1); returns its result.
export function endAttempt(store, context, admitted, classification = 'completed', extra = {}) {
    return store.beginAttemptEnd(context, {
        executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: extra.expectedState ?? 'queued',
        outcome: { classification, outputText: extra.outputText ?? 'synthetic output', data: extra.data ?? { n: 1 } }
    });
}

export function locatorFor(kind) {
    return { dir: `synthetic/${kind}/${newId()}` };
}

export function expectCode(assert, fn, code) {
    assert.throws(fn, (error) => {
        assert.equal(error.name, 'WorkerStateError');
        assert.equal(error.code, code);
        return true;
    });
}

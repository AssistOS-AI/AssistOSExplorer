import { asResult, digestOf, deepFreeze } from './contract.mjs';

// Frozen v1 protocol ceilings (T0 base §10, split into three scopes by amendment A1.4, relationships amended by A2.4).
// These are T1 protocol ceilings, not measured production capacity (G5).

export const LIMITS_ERROR_CODES = Object.freeze(['invalid_request', 'capacity_exceeded']);

// Declarable per-target limits. A declaration's `limits` has exactly these keys; the admitted value of each key is the
// component-wise minimum of worker policy, declaration and qualification.
export const TARGET_LIMITS_V1 = Object.freeze({
    executionsPerTarget: 8,
    listenersPerExecution: 21,
    connectionsPerExecution: 64,
    connectionsPerTarget: 512,
    pendingOpensPerExecution: 8,
    pendingOpensPerTarget: 64,
    frameBytes: 589824,
    headerBytes: 16384,
    dataBytesPerFrame: 65536,
    descriptorsPerFrame: 8,
    descriptorsPerExecution: 256,
    descriptorsPerTarget: 2048,
    resourcesPerOperation: 512,
    bufferedBytesPerConnection: 262144,
    bufferedBytesPerExecution: 4194304,
    bufferedBytesPerTarget: 33554432,
    outputBytesPerExecution: 67108864,
    channelBytesPerExecution: 268435456,
    controlFramesPerSecond: 2000,
    connectTimeoutMs: 5000,
    partialFrameTimeoutMs: 5000,
    idleTimeoutMs: 300000,
    connectionLifetimeMs: 86400000,
    executionLifetimeMs: 86400000,
    leaseTtlMs: 15000,
    renewIntervalMs: 5000,
    challengeTimeoutMs: 5000,
    releaseTimeoutMs: 10000,
    journalEntries: 65536,
    journalBytes: 268435456,
    ticketReplayEntries: 32768
});

// Fixed worker/helper policy floors; never declarable, never lowered.
export const TARGET_POLICY_V1 = Object.freeze({
    settledReceiptRetentionMs: 604800000
});

// Workspace-wide interlock policy; never in a target declaration. `retiredWorkerGenerations` (A1.4) was removed by A2.3.
export const INTERLOCK_LIMITS_V1 = Object.freeze({
    writableReservations: 4096,
    sourceStateBytes: 33554432,
    operationReceipts: 65536,
    lockWaitMs: 5000
});

// The 512 KiB native request plus envelope (A2.4): a combined frame bound below it refuses.
const MIN_FRAME_BYTES = 589824;

const TARGET_KEYS = Object.freeze(Object.keys(TARGET_LIMITS_V1));
const FOREIGN_KEYS = new Set([...Object.keys(TARGET_POLICY_V1), ...Object.keys(INTERLOCK_LIMITS_V1), 'retiredWorkerGenerations']);

class LimitRefusal {
    constructor(code) { this.code = code; }
}

function need(condition, code = 'invalid_request') {
    if (!condition) throw new LimitRefusal(code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// Key set, positive safe integers and the v1 ceilings, without relationships. A policy or interlock key in a target
// limit set is invalid_request (CAP-03); a value above its ceiling is capacity_exceeded (CAP-01).
function checkShape(value) {
    need(isPlainObject(value));
    const keys = Object.keys(value);
    for (const key of keys) {
        need(!FOREIGN_KEYS.has(key));
        need(Object.hasOwn(TARGET_LIMITS_V1, key));
    }
    for (const key of TARGET_KEYS) need(Object.hasOwn(value, key));
    for (const key of TARGET_KEYS) {
        const entry = value[key];
        need(Number.isSafeInteger(entry) && entry > 0);
        need(entry <= TARGET_LIMITS_V1[key], 'capacity_exceeded');
    }
}

function checkRelationships(limits) {
    const relations = [
        limits.headerBytes + limits.dataBytesPerFrame + 1024 <= limits.frameBytes,
        limits.frameBytes >= MIN_FRAME_BYTES,
        limits.pendingOpensPerExecution <= limits.pendingOpensPerTarget,
        limits.connectionsPerExecution <= limits.connectionsPerTarget,
        limits.descriptorsPerExecution <= limits.descriptorsPerTarget,
        limits.bufferedBytesPerExecution <= limits.bufferedBytesPerTarget,
        limits.connectionsPerExecution >= limits.listenersPerExecution,
        limits.bufferedBytesPerConnection <= limits.bufferedBytesPerExecution,
        limits.dataBytesPerFrame <= limits.bufferedBytesPerConnection,
        limits.descriptorsPerFrame <= limits.descriptorsPerExecution,
        3 * limits.renewIntervalMs <= limits.leaseTtlMs,
        limits.challengeTimeoutMs <= limits.leaseTtlMs,
        limits.connectionLifetimeMs <= limits.executionLifetimeMs,
        limits.idleTimeoutMs <= limits.connectionLifetimeMs
    ];
    need(relations.every(Boolean));
}

function run(check) {
    const result = asResult(() => {
        try {
            return check();
        } catch (error) {
            if (error instanceof LimitRefusal) return { refused: error.code };
            throw error;
        }
    });
    if (result.ok && result.value && result.value.refused) return Object.freeze({ ok: false, error: Object.freeze({ code: result.value.refused }) });
    return result;
}

// One complete target limit set (a declaration's `limits`, worker policy or qualification): exact key set, positive values
// within the v1 ceilings, and every relationship.
export function validateTargetLimits(value) {
    return run(() => {
        checkShape(value);
        checkRelationships(value);
        return deepFreeze({ ...value });
    });
}

// Admitted limits: the component-wise minimum of worker policy, declaration and qualification. Each input must have the
// exact key set and stay within the ceilings; relationships are validated after combination. `targetPolicy` (optional)
// may raise, never lower, TARGET_POLICY_V1. Returns {limits, policy, limitsDigest}; the digest covers the combined
// TARGET_LIMITS_V1 values plus the policy (A1.4) as canonical {version: 1, limits, policy}.
export function combineTargetLimits({ workerPolicy, declaration, qualification, targetPolicy } = {}) {
    return run(() => {
        for (const input of [workerPolicy, declaration, qualification]) checkShape(input);
        const limits = {};
        for (const key of TARGET_KEYS) limits[key] = Math.min(workerPolicy[key], declaration[key], qualification[key]);
        checkRelationships(limits);
        const policy = { ...TARGET_POLICY_V1 };
        if (targetPolicy !== undefined) {
            need(isPlainObject(targetPolicy) && Object.keys(targetPolicy).length === 1 && Object.hasOwn(targetPolicy, 'settledReceiptRetentionMs'));
            need(Number.isSafeInteger(targetPolicy.settledReceiptRetentionMs) && targetPolicy.settledReceiptRetentionMs >= TARGET_POLICY_V1.settledReceiptRetentionMs);
            policy.settledReceiptRetentionMs = targetPolicy.settledReceiptRetentionMs;
        }
        return deepFreeze({ limits, policy, limitsDigest: digestOf({ version: 1, limits, policy }) });
    });
}

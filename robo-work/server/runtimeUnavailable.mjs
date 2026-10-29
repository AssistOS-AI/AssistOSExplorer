// Default runtime adapter. It refuses preparation, readiness attestation, admission and
// quarantine clearing, so a worker-state store opened with it can never publish readiness,
// admit work or clear a quarantine. Adapter methods are synchronous or return plain values:
// they are never called inside an awaited transaction.
//
// Optional adapter methods:
//   requiredKinds(operation)  resource kinds an operation ('admit', 'provision', 'configure')
//                             needs; a quarantined worker-scoped blocker of such a kind refuses it.
//   verifyAbsence(info)       true when the resource is absent through its recorded locator and
//                             identity (or, for an uncommitted process-bearing reservation, its
//                             marker), false when anything is present, null when unverifiable.
export const runtimeUnavailable = Object.freeze({
    name: 'runtime-unavailable',
    canPrepare() { return false; },
    attestRobot() { return false; },
    admissionReady() { return false; },
    requiredKinds() { return []; },
    verifyAbsence() { return null; }
});

export function validateRuntimeAdapter(runtime) {
    if (runtime === null || typeof runtime !== 'object') return false;
    if (!['canPrepare', 'attestRobot', 'admissionReady'].every((name) => typeof runtime[name] === 'function')) return false;
    return ['requiredKinds', 'verifyAbsence'].every((name) => runtime[name] === undefined || typeof runtime[name] === 'function');
}

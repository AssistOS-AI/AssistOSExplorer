import { validateRuntimeAdapter } from '../runtimeUnavailable.mjs';

// The production runtime adapter for openWorkerState. Every method is synchronous and answers from state computed
// earlier (the cached sandbox preflight and plain lstat checks), because S1 calls them inside transactions.
//
//   canPrepare()      the sandbox preflight passed
//   attestRobot()     the preflight passed and the robot's HOME, sessions and managed configuration exist and match
//   admissionReady()  the preflight passed (robotId may be null: the obligation path asks without a robot). Generation
//                     readiness (recovery, quarantine, attestation) is checked by S1 itself.
//   verifyAbsence()   null: this adapter cannot prove absence of a quarantined resource; the operator attests.
export function createProductionRuntime({ preflight, robots }) {
    if (!preflight || typeof preflight.ok !== 'boolean') throw new TypeError('A sandbox preflight result is required');
    if (!robots || typeof robots.verify !== 'function') throw new TypeError('A robot store is required');
    const runtime = Object.freeze({
        name: 'robo-work-sandbox',
        canPrepare: () => preflight.ok,
        attestRobot: ({ robotId, configuration }) => preflight.ok && robots.verify(robotId, configuration),
        admissionReady: () => preflight.ok,
        requiredKinds: () => [],
        verifyAbsence: () => null
    });
    if (!validateRuntimeAdapter(runtime)) throw new TypeError('The runtime adapter is not valid');
    return runtime;
}

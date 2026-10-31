// Errors and response mapping of RoboTeam's worker coordinator callers (design S3c §6.4,
// with review fixes F1 and R-F1). Every mapped body is `{error}` with a fixed code, plus
// `originRequestId` for an admission whose outcome is unknown and `snapshotSequence` for a
// retention gap. A body never carries a token, a grant, a claim or a worker refusal reason.

export const STATUS = Object.freeze({
    owner_evidence_unavailable: 403,
    invalid_request: 400,
    logical_kind_unavailable: 400,
    not_found: 404,
    binding_owner_mismatch: 403,
    binding_revision_unavailable: 409,
    capacity_exceeded: 503,
    worker_coordinator_unavailable: 503,
    worker_route_unavailable: 503,
    worker_unreachable: 503,
    worker_reply_unknown: 503,
    worker_auth_failed: 502,
    forbidden: 403,
    // The worker refuses a phase's Environment selection at admission (existing-agent environments are not available yet).
    environment_unavailable: 400,
});

// A plain, RoboTeam-authored sentence for a worker code the user can act on. It is fixed text for the code, never a worker reason.
export const PLAIN_MESSAGES = Object.freeze({
    environment_unavailable: 'Existing-agent environments are not available.',
});

export class WorkerCoordinatorError extends Error {
    constructor(code, status = STATUS[code] || 500) {
        super(code);
        this.name = 'WorkerCoordinatorError';
        this.code = code;
        this.status = status;
    }
}

// RoboTeam runs every AI task through the worker (decision M-5, R08): there is no local execution path. When the coordinator
// base is not configured an AI task, turn or model call is refused with this error and nothing is spawned. The status is a 409 so
// that the HTTP layer shows the message; the code is the stable part.
export const WORKER_NOT_CONFIGURED = 'worker_not_configured';
export function workerNotConfiguredError() {
    return Object.assign(new Error(`${WORKER_NOT_CONFIGURED}: AI execution is unavailable because ROBOTEAM_WORKER_COORDINATOR_BASE is not set. `
        + 'RoboTeam runs every AI task through the robo-work worker; ask an administrator to configure the worker coordinator.'),
    { code: WORKER_NOT_CONFIGURED, status: 409, statusCode: 409 });
}

export function refusal(code, extra = {}) {
    return { status: STATUS[code] || 500, body: { error: code, ...(PLAIN_MESSAGES[code] ? { message: PLAIN_MESSAGES[code] } : {}), ...extra } };
}

export function errorResult(error) {
    if (error instanceof WorkerCoordinatorError) return { status: error.status, body: { error: error.code } };
    return refusal('worker_coordinator_unavailable');
}

const WORKER_CODE = /^[a-z][a-z_]{0,63}$/u;
const DEFAULT_CODE = Object.freeze({ 400: 'invalid_request', 404: 'not_found', 409: 'operation_conflict', 500: 'state_corrupt', 503: 'runtime_unavailable' });

function workerCode(json, status) {
    const code = json && typeof json === 'object' ? json.error : undefined;
    return typeof code === 'string' && WORKER_CODE.test(code) ? code : DEFAULT_CODE[status];
}

// Maps one hop outcome (see hop.mjs) to the RoboTeam response.
//   unsent                  -> 503 worker_unreachable (nothing reached the Router)
//   unknown                 -> 503 worker_reply_unknown (the caller may recover by lookup)
//   marked Router refusal   -> 503 worker_route_unavailable
//   200                     -> 200, the worker JSON verbatim
//   400 / 404 / 409         -> same status, the worker's code
//   403 (worker or private listener) -> 403 forbidden
//   401 (worker or private listener: hop auth or replay) -> 502 worker_auth_failed
//   500 / 503               -> same status, the worker's code
export function mapHopOutcome(outcome) {
    if (!outcome || outcome.outcome === 'unsent') return refusal('worker_unreachable');
    if (outcome.outcome === 'unknown') return refusal('worker_reply_unknown');
    if (outcome.refusal) return refusal('worker_route_unavailable');
    const { status, json } = outcome;
    if (status === 200) return { status: 200, body: json };
    if (status === 401) return refusal('worker_auth_failed');
    if (status === 403) return refusal('forbidden');
    if (status === 400 || status === 404 || status === 409 || status === 500 || status === 503) {
        const body = { error: workerCode(json, status) };
        if (PLAIN_MESSAGES[body.error]) body.message = PLAIN_MESSAGES[body.error];
        if (Number.isSafeInteger(json?.snapshotSequence)) body.snapshotSequence = json.snapshotSequence;
        return { status, body };
    }
    // hop.mjs classifies every other status as unknown; this is a defensive default.
    return refusal('worker_reply_unknown');
}

// Whether a complete answer settles an admission as refused: a worker 4xx (nothing was
// committed), a worker 500 or 503 (S1 rolled the transaction back), or a marked Router
// refusal (nothing was forwarded). `unknown` keeps the admission recoverable.
export function settlesAsRefused(outcome) {
    return outcome?.outcome === 'response' && outcome.status !== 200;
}

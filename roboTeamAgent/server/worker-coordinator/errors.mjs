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
});

export class WorkerCoordinatorError extends Error {
    constructor(code, status = STATUS[code] || 500) {
        super(code);
        this.name = 'WorkerCoordinatorError';
        this.code = code;
        this.status = status;
    }
}

export function refusal(code, extra = {}) {
    return { status: STATUS[code] || 500, body: { error: code, ...extra } };
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

// Worker-side client of Ploinky's source-protection interlock (proof slice P5; T0 section 6 + A2-A6).
//
// It implements the five interlock operations (`describeStore`, `advanceWorkerGeneration`, `acknowledgeSourceStore`,
// `reserveWritableResources`, `releaseWritableReservation`) plus `readSourceState` for admission. (The reservation
// controller that consumed them was removed with the execution-target library, r10 Q1 = A.) Each call is one request over an injected
// `transport(bytes) -> Promise<{status, body}>`; the host composes the transport from Ploinky's agent-side channel
// (`Agent/lib/sourceProtectionTransport.mjs`: signed private agent assertion to the Router's private listener). The
// Router derives the worker principal, instance and enable generation from that assertion, so the opaque
// `managementContext` passed by the controller is never serialized; only its `workerGeneration` (the worker's S1
// generation) travels, because Ploinky cannot read the worker's store. Advance registers the generation named by
// its own request.
//
// Result mapping: HTTP 200 with a common result (`{ok:true,value}` or `{ok:false,error:{code}}`) is returned as is;
// the controller validates it. A permanent Router refusal (403 `PRIVATE_CALLER_DENIED`, a 400/413 for a malformed
// request) is the terminal refusal `forbidden` / `invalid_request`. Any other transport failure, status or malformed answer throws, which the
// controller reports as `outcome_unknown` and retries with the same body. The client retries nothing, caches nothing
// and holds no authority.

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// Permanent Router refusals (not transient states): the caller is not an admitted holder, or the request itself is
// malformed. They are definitive, so the controller must not treat them as an unknown outcome.
const PERMANENT_403 = new Set(['PRIVATE_CALLER_DENIED']);
const PERMANENT_400 = new Set(['invalid_request', 'invalid_identity', 'request_too_large', 'SOURCE_PROTECTION_REQUEST_INVALID']);

function terminalRefusal(answer) {
    if (![400, 403, 413].includes(answer.status)) return null;
    let code;
    try {
        const body = JSON.parse(Buffer.isBuffer(answer.body) ? answer.body.toString('utf8') : String(answer.body ?? ''));
        code = isPlainObject(body) && typeof body.error === 'string' ? body.error : '';
    } catch {
        return null;
    }
    if (answer.status === 403 && PERMANENT_403.has(code)) return { ok: false, error: { code: 'forbidden' } };
    if ((answer.status === 400 || answer.status === 413) && PERMANENT_400.has(code)) return { ok: false, error: { code: 'invalid_request' } };
    return null;
}

export function createSourceProtectionClient({ transport } = {}) {
    if (typeof transport !== 'function') throw new TypeError('createSourceProtectionClient requires a transport function');

    async function exchange(op, workerGeneration, request) {
        const envelope = { version: 1, op, workerGeneration, ...(request === undefined ? {} : { request }) };
        const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
        if (bytes.length > MAX_REQUEST_BYTES) throw new Error('source_protection_request_too_large');
        const answer = await transport(bytes);
        const terminal = isPlainObject(answer) ? terminalRefusal(answer) : null;
        if (terminal) return terminal;
        if (!isPlainObject(answer) || answer.status !== 200) throw new Error(`source_protection_http_${isPlainObject(answer) ? answer.status : 'invalid'}`);
        const raw = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(String(answer.body ?? ''), 'utf8');
        if (raw.length > MAX_RESPONSE_BYTES) throw new Error('source_protection_response_too_large');
        const parsed = JSON.parse(raw.toString('utf8'));
        if (!isPlainObject(parsed) || typeof parsed.ok !== 'boolean') throw new Error('source_protection_response_invalid');
        return parsed;
    }

    function generationOf(managementContext) {
        const generation = managementContext?.workerGeneration;
        if (typeof generation !== 'string' || generation.length < 1) throw new Error('source_protection_generation_unavailable');
        return generation;
    }

    return Object.freeze({
        describeStore: async () => exchange('describe', null),
        readSourceState: async () => exchange('state', null),
        advanceWorkerGeneration: async (_managementContext, request) => {
            if (!isPlainObject(request) || typeof request.nextGeneration !== 'string') throw new Error('source_protection_request_invalid');
            return exchange('advance', request.nextGeneration, request);
        },
        acknowledgeSourceStore: async (managementContext, request) => exchange('acknowledge', generationOf(managementContext), request),
        reserveWritableResources: async (managementContext, request) => exchange('reserve', generationOf(managementContext), request),
        releaseWritableReservation: async (managementContext, request) => exchange('release', generationOf(managementContext), request)
    });
}

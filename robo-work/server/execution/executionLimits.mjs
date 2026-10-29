// Named, explicit, positive limits for the S4 channel code (plan section 5.5).
//
// Every value below is PROVISIONAL: G5 has not fixed the reviewed limits, and the Box measurements that would
// qualify them have not been taken. Production code receives its limits through constructor parameters; this module
// only supplies defaults, rejects unknown names and rejects any value that is not a positive safe integer.

export const LIMITS_ARE_PROVISIONAL = true;

// PROMPT SIZING is an explicit G5/A37 item. Codex `exec` and Pi pass the whole task prompt as the LAST argv element
// (ALA codex.mjs and pi.mjs at cf2996dc), so one argument must be able to hold a realistic prompt. The provisional
// values below admit a 128 KiB prompt (about 256 KiB once JSON escaping doubles quotes and newlines). G5 must fix the
// real prompt ceiling from the A37 backends, or move large prompts to a stdin route; until then a larger prompt is
// refused with `invalid_request`, never a generic provider failure (see the relationships enforced below).
export const ENDPOINT_LIMIT_DEFAULTS = Object.freeze({
    // Frames on fd 4 (endpoint <-> supervisor).
    maxFrameBytes: 576 * 1024,
    maxInFlightRequests: 16,
    partialFrameDeadlineMs: 5000,
    // Messages from ALA on fd 3.
    maxMessageBytes: 640 * 1024,
    maxInboundQueue: 8,
    maxOutboundBacklogMessages: 64,
    maxOutboundBacklogBytes: 1024 * 1024,
    // Request schema bounds. maxRequestBytes bounds the JSON-encoded start request as a whole, so that a request that
    // passes the schema always fits a frame whatever its arguments and environment add up to.
    maxRequestBytes: 512 * 1024,
    maxArgs: 256,
    maxArgBytes: 256 * 1024,
    maxEnvEntries: 64,
    maxEnvValueBytes: 16 * 1024,
    maxFolders: 32,
    maxExclusions: 64,
    maxPathBytes: 1024,
    // Execution resources.
    maxProcesses: 16,
    maxPendingConnects: 8,
    maxRelayConnections: 16,
    streamAcceptDeadlineMs: 5000,
    connectDeadlineMs: 5000
});

export const CONTROL_STREAM_LIMIT_DEFAULTS = Object.freeze({
    maxRecordBytes: 256 * 1024,
    maxBufferedBytes: 4 * 1024 * 1024,
    maxRecordsPerWindow: 2000,
    rateWindowMs: 1000,
    stallDeadlineMs: 10000,
    stderrRingBytes: 64 * 1024,
    stdinStallDeadlineMs: 10000,
    maxPendingStdinBytes: 1024 * 1024
});

export function resolveLimits(defaults, overrides = {}) {
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw new TypeError('Limits must be an object');
    }
    const limits = { ...defaults };
    for (const [name, value] of Object.entries(overrides)) {
        if (!Object.hasOwn(defaults, name)) throw new TypeError(`Unknown limit: ${name}`);
        limits[name] = value;
    }
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Limit ${name} must be a positive integer`);
    }
    return Object.freeze(limits);
}

// What a `start` frame adds to the request: id, op, process and up to three stream paths.
export const frameEnvelopeBytes = (limits) => 3 * (limits.maxPathBytes + 16) + 256;

// Limits that contradict each other make a schema-valid request fail later with an opaque error, so they are refused here.
export function resolveEndpointLimits(overrides) {
    const limits = resolveLimits(ENDPOINT_LIMIT_DEFAULTS, overrides);
    const problems = [];
    if (limits.maxInboundQueue > limits.maxInFlightRequests) problems.push('maxInboundQueue must not exceed maxInFlightRequests');
    if (limits.maxFrameBytes < limits.maxRequestBytes + frameEnvelopeBytes(limits)) {
        problems.push('maxFrameBytes must hold maxRequestBytes plus the frame envelope');
    }
    if (limits.maxMessageBytes < limits.maxRequestBytes + 1024) problems.push('maxMessageBytes must hold maxRequestBytes plus the message envelope');
    if (limits.maxArgBytes > limits.maxRequestBytes || limits.maxEnvValueBytes > limits.maxRequestBytes) {
        problems.push('a single argument or environment value must fit maxRequestBytes');
    }
    if (problems.length > 0) throw new TypeError(`Inconsistent endpoint limits: ${problems.join('; ')}`);
    return limits;
}
export const resolveControlStreamLimits = (overrides) => resolveLimits(CONTROL_STREAM_LIMIT_DEFAULTS, overrides);

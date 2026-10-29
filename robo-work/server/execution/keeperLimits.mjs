// Named, explicit, positive limits of the supervisor <-> keeper channel (keeper wire contract delta section 2, R1.2,
// R1.6; N-B for pingIntervalMs).
//
// Every value below is PROVISIONAL: G5 has not fixed the reviewed limits. Production code receives its limits through
// constructor parameters; this module only supplies defaults, rejects unknown names, rejects any value that is not a
// positive safe integer, and refuses limits that contradict each other or the endpoint and view limits they must carry.
// The resolver pattern is the one of executionLimits.mjs, which viewLimits.mjs also copies.
//
// The keeper receives every channel limit of the contract (KEEPER_CHANNEL_LIMIT_NAMES, delta section 2, R1.2, R1.6) as
// `--channel-limit <name>=<value>` and every view limit as `--view-limit <name>=<value>`; it refuses any other name. It
// echoes the keeper-side subset (HELLO_LIMIT_NAMES) plus rootLeaseTtlMs in `hello.limits`, and a keeper whose echo
// differs is refused before its commit. Client-only settings (CLIENT_ONLY_LIMIT_NAMES: pingIntervalMs, the N-B liveness
// probe) are never sent to the keeper and never echoed.

import { ENDPOINT_LIMIT_DEFAULTS, frameEnvelopeBytes, resolveEndpointLimits, resolveLimits } from './executionLimits.mjs';
import { resolveViewLimits } from '../views/viewLimits.mjs';

export const KEEPER_LIMITS_ARE_PROVISIONAL = true;

export const KEEPER_LIMIT_DEFAULTS = Object.freeze({
    // Frames. A `create` carries an admitted start request of up to endpoint maxRequestBytes.
    maxFrameBytes: 640 * 1024,
    partialFrameDeadlineMs: 5000,
    // Requests outstanding on the whole channel (pty_input excluded, R1.2). reservedInFlight of them are never used by
    // ordinary ops: only view_root_lease, ping, shutdown, abort_uncommitted and the end-step ops may take them.
    maxInFlight: 16,
    reservedInFlight: 2,
    maxQueuedRequests: 64,
    // Deadlines.
    helloDeadlineMs: 5000,
    requestDeadlineMs: 10000,
    createDeadlineMs: 15000,
    stopExtraMs: 5000,
    keeperExitWaitMs: 2000,
    // Liveness (N-B): a bounded ping with the normal request deadline, so that a keeper with no other periodic
    // request (a terminal keeper without views) is still found hung.
    pingIntervalMs: 5000,
    // PTY output.
    ptyChunkBytes: 16 * 1024,
    ptyMaxCreditBytes: 256 * 1024,
    // PTY input (R1.2): a per-pty window outside the channel in-flight count, and no deadline.
    ptyInputWindowFrames: 8,
    ptyInputWindowBytes: 64 * 1024,
    ptyInputQueueBytes: 256 * 1024,
    ptyInputStallMs: 30000,
    // Keeper side (R1.6): bytes the keeper has written that the supervisor has not read, and ptys per keeper.
    maxOutboundBytes: 1024 * 1024,
    maxPtysPerKeeper: 1,
    // Keeper stderr, kept as a ring and never parsed.
    stderrRingBytes: 64 * 1024
});

// The largest encoded PTY frame (pty_input request or pty_output event) for a chunk bound.
export const ptyFrameCapBytes = (limits) => 4 * Math.ceil(limits.ptyChunkBytes / 3) + 512;

// The 19 limit names of the contract, in the order of section 2: passed to the keeper as --channel-limit.
export const KEEPER_CHANNEL_LIMIT_NAMES = Object.freeze(Object.keys(KEEPER_LIMIT_DEFAULTS).filter((name) => name !== 'pingIntervalMs'));
// Supervisor-only settings: never on the keeper's argv or in hello.limits.
export const CLIENT_ONLY_LIMIT_NAMES = Object.freeze(['pingIntervalMs']);
// The keeper-side channel set echoed in hello.limits (followed by rootLeaseTtlMs), pinned by the shared vectors.
export const HELLO_LIMIT_NAMES = Object.freeze(['maxFrameBytes', 'maxInFlight', 'reservedInFlight', 'partialFrameDeadlineMs', 'ptyChunkBytes',
    'ptyMaxCreditBytes', 'ptyInputWindowFrames', 'ptyInputWindowBytes', 'maxOutboundBytes', 'maxPtysPerKeeper']);

// The --channel-limit set of a resolved limit object.
export function channelLimitsForKeeper(keeperLimits) {
    const out = {};
    for (const name of KEEPER_CHANNEL_LIMIT_NAMES) out[name] = keeperLimits[name];
    return out;
}

// What the keeper may have written and not yet seen read: every byte of the outstanding output credit as base64 frames,
// plus one reply per request slot and input window frame (R1.6 relationship check).
export const minimumOutboundBytes = (limits) => 4 * Math.ceil(limits.ptyMaxCreditBytes / 3)
    + Math.ceil(limits.ptyMaxCreditBytes / limits.ptyChunkBytes) * 512
    + (limits.maxInFlight + limits.ptyInputWindowFrames) * 4096;

// overrides: keeper limit overrides. endpointLimits and viewLimits: the resolved (or override) sets the channel must carry.
export function resolveKeeperLimits(overrides = {}, { endpointLimits = ENDPOINT_LIMIT_DEFAULTS, viewLimits = {} } = {}) {
    const limits = resolveLimits(KEEPER_LIMIT_DEFAULTS, overrides);
    const endpoint = resolveEndpointLimits(pickOverrides(endpointLimits, ENDPOINT_LIMIT_DEFAULTS));
    const view = resolveViewLimits(viewLimits);
    const problems = [];
    if (limits.maxFrameBytes < endpoint.maxRequestBytes + frameEnvelopeBytes(endpoint) + 1024) {
        problems.push('maxFrameBytes must hold the endpoint maxRequestBytes plus the frame envelope and 1024 bytes');
    }
    if (limits.maxFrameBytes < view.maxMountFrameBytes) problems.push('maxFrameBytes must hold view maxMountFrameBytes');
    if (limits.maxFrameBytes < ptyFrameCapBytes(limits)) problems.push('maxFrameBytes must hold one encoded PTY chunk');
    if (limits.reservedInFlight >= limits.maxInFlight) problems.push('reservedInFlight must leave at least one ordinary slot');
    if (limits.ptyMaxCreditBytes < limits.ptyChunkBytes) problems.push('ptyMaxCreditBytes must be at least ptyChunkBytes');
    if (limits.ptyInputWindowBytes < limits.ptyChunkBytes) problems.push('ptyInputWindowBytes must be at least ptyChunkBytes');
    if (limits.ptyInputQueueBytes < limits.ptyInputWindowBytes) problems.push('ptyInputQueueBytes must be at least ptyInputWindowBytes');
    if (limits.maxOutboundBytes < minimumOutboundBytes(limits)) problems.push('maxOutboundBytes must hold the outstanding output credit and replies');
    if (problems.length > 0) throw new TypeError(`Inconsistent keeper limits: ${problems.join('; ')}`);
    return limits;
}

// A resolved endpoint limit set passes through unchanged; overrides are reduced to the names the defaults know.
function pickOverrides(values, defaults) {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Limits must be an object');
    const out = {};
    for (const [name, value] of Object.entries(values)) if (Object.hasOwn(defaults, name)) out[name] = value;
    return out;
}

// The exact `hello.limits` object: the keeper-side channel set plus the view lease lifetime, in a fixed key order.
export function helloLimits(keeperLimits, viewLimits) {
    const out = {};
    for (const name of HELLO_LIMIT_NAMES) out[name] = keeperLimits[name];
    out.rootLeaseTtlMs = viewLimits.rootLeaseTtlMs;
    return out;
}

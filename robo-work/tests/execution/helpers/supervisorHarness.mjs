import { createAdmission } from '../../../server/execution/supervisorRequestValidator.mjs';
import { createSupervisorEndpointServer } from '../../../server/execution/supervisorEndpointServer.mjs';
import { resolveEndpointLimits } from '../../../server/execution/executionLimits.mjs';

// The view that ALA's raw-wire conformance suite uses (tests/provider-protocol.test.mjs at the pinned ALA).
export const CONFORMANCE_VIEW = Object.freeze({ home: '/home/robot', cwd: '/projects/g', folder: '/projects/g', outside: '/outside' });

export function conformanceAdmission(streamDirectory) {
    return createAdmission({
        grants: [{ path: '/projects/g', access: 'write' }, { path: '/projects/ro', access: 'read' }],
        inventory: [{ name: 'codex', version: '0.1.0' }, { name: 'claude', version: '2.1.0' }],
        streamDirectory
    });
}

// PROVISIONAL test limits, small enough to exercise bounds quickly. They are not G5 values.
export const TEST_LIMITS = Object.freeze({
    maxFrameBytes: 64 * 1024, maxRequestBytes: 32 * 1024, maxArgBytes: 16 * 1024, maxEnvValueBytes: 4 * 1024, maxInFlightRequests: 8, maxInboundQueue: 4, partialFrameDeadlineMs: 600,
    streamAcceptDeadlineMs: 2000, connectDeadlineMs: 2000, maxOutboundBacklogMessages: 16,
    maxOutboundBacklogBytes: 64 * 1024, maxMessageBytes: 64 * 1024, maxRelayConnections: 2, maxPendingConnects: 4
});

export function testLimits(overrides = {}) {
    return resolveEndpointLimits({ ...TEST_LIMITS, ...overrides });
}

// Attaches the real supervisor-side server to a socket and records how the execution ends.
export function attachSupervisor({ socket, admission, sandbox, limits = testLimits() }) {
    const ends = [];
    const server = createSupervisorEndpointServer({ socket, admission, sandbox, limits, onEnd: (reason) => ends.push(reason) });
    return { server, ends, limits };
}

import assert from 'node:assert/strict';
import test from 'node:test';

import { runFullStackCheck, runTransportCheck } from './helpers/symmetricCheck.mjs';
import { findPython, pythonVersion } from './helpers/topology.mjs';

// The symmetric NODE_CHANNEL_FD check (plan section 5.5, A37/A38 channel part), on the Mac, without containers.
//
// A non-Node parent (python3 -I, helpers/topology.mjs + fixtures/symmetricParent.py) creates a socket pair and starts
// two Node processes with NODE_CHANNEL_FD=3. They exchange JSON; the endpoint passes a paused connected socket that
// the ALA fixture reads with no byte loss, where the peer writes a known payload and half-closes BEFORE the transfer
// and the fixture must read exactly that payload and the end-of-stream; an ALA-sent handle is detected and closed.
//
// NON-QUALIFYING unless the run is on the image's own Node build, on Linux. The expected build is named explicitly by
// ROBO_WORK_QUALIFYING_NODE (the exact `node --version` of the image manifest, for example "v24.11.1"); a run
// qualifies only when process.version equals it exactly and the platform is linux. With the variable unset the run is
// NON-QUALIFYING, whatever Node it is on, so a stray Node 24.x can never be mistaken for the image's build.
export function qualification({ version = process.version, platform = process.platform, expected = process.env.ROBO_WORK_QUALIFYING_NODE } = {}) {
    if (!expected) return { qualifying: false, reason: 'ROBO_WORK_QUALIFYING_NODE is not set, so no image Node build is named' };
    if (version !== expected) return { qualifying: false, reason: `node ${version} is not the image build ${expected}` };
    if (platform !== 'linux') return { qualifying: false, reason: `platform ${platform} is not linux` };
    return { qualifying: true, reason: `node ${version} equals the image build on linux` };
}

test('the qualification label compares the exact version and the platform, and is non-qualifying when no image build is named', () => {
    assert.equal(qualification({ expected: undefined, version: 'v24.11.1', platform: 'linux' }).qualifying, false);
    assert.equal(qualification({ expected: '', version: 'v24.11.1', platform: 'linux' }).qualifying, false);
    assert.equal(qualification({ expected: 'v24.11.1', version: 'v24.12.0', platform: 'linux' }).qualifying, false, 'another 24.x');
    assert.equal(qualification({ expected: 'v24.11.1', version: 'v24.11.1', platform: 'darwin' }).qualifying, false);
    assert.equal(qualification({ expected: 'v24.11.1', version: 'v24.11.1', platform: 'linux' }).qualifying, true);
});

test('record the runtime of this check: NON-QUALIFYING unless it is the named image Node build on linux', (context) => {
    const nodeVersion = process.version;
    const label = qualification();
    context.diagnostic(`node --version = ${nodeVersion}; platform = ${process.platform}-${process.arch}; parent = ${pythonVersion()} at ${findPython()} with -I`);
    context.diagnostic(label.qualifying ? `QUALIFYING runtime: ${label.reason}` : `NON-QUALIFYING evidence: ${label.reason}`);
    assert.match(nodeVersion, /^v\d+\.\d+\.\d+/);
});

test('transport check, positive: JSON exchange, an unread paused socket with a pre-written payload and its end, an ALA-sent handle closed', async () => {
    const outcome = await runTransportCheck();
    assert.deepEqual(outcome.reasons, []);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ala.receivedBytes, 2048);
    assert.equal(outcome.ala.payloadMatches, true);
    assert.equal(outcome.ala.endOfStream, true);
    assert.deepEqual(outcome.ala.channelFailure, null);
    assert.equal(outcome.endpoint.handleDetected, 'handle_from_ala');
    assert.deepEqual([outcome.exits.endpoint.code, outcome.exits.ala.code], [0, 0]);
});

// Negative controls. Each defect must make the check report failure; otherwise the check could not fail.
test('negative control 1a: an endpoint that reads before it passes is refused by the transfer guard and the check fails', async () => {
    const outcome = await runTransportCheck({ endpointVariant: 'read-one-byte' });
    assert.equal(outcome.ok, false);
    assert.match(outcome.endpoint.error, /cannot be passed unread/);
    assert.equal(outcome.ala.streamReceived, false);
    assert.ok(outcome.reasons.includes('no paused socket arrived'));
});

test('negative control 1b: the same defect with the guard bypassed loses bytes and the check fails on the payload comparison', async () => {
    const outcome = await runTransportCheck({ endpointVariant: 'read-one-byte-unguarded' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ala.streamReceived, true, 'the socket still arrived');
    assert.equal(outcome.ala.payloadMatches, false);
    assert.ok(outcome.ala.receivedBytes < 2048, `at least one byte was lost (received ${outcome.ala.receivedBytes} of 2048)`);
    assert.ok(outcome.reasons.some((reason) => reason.startsWith('the payload was not received exactly')));
});

// A Node process whose NODE_CHANNEL_FD is not a socket behaves per platform. Where its bootstrap survives (Darwin) it
// reports that no hello was seen. Where the runtime rejects the descriptor (Linux, inferred: libuv/epoll abort) the
// process dies with no result line, and the check must then show SIGABRT and name the missing result. That second shape
// is accepted on Linux only: on any other platform a missing result fails the test. In both cases the check must
// report failure; it is never accepted as ok.
function transportDiagnostic(outcome) {
    const stderr = String(outcome.stderr ?? '');
    return JSON.stringify({ exits: outcome.exits, stderrHead: stderr.slice(0, 1000), stderrTail: stderr.length > 1000 ? stderr.slice(-1000) : '' });
}

function assertNonSocketSideFailed(outcome, side, missingReason) {
    assert.equal(outcome.ok, false);
    if (outcome[side] === null) {
        assert.equal(process.platform, 'linux', `a missing ${side} result is accepted on linux only (exits: ${JSON.stringify(outcome.exits)})`);
        assert.equal(outcome.exits[side]?.signal, 6, `the ${side} process was killed by SIGABRT (exits: ${JSON.stringify(outcome.exits)})`);
        assert.ok(outcome.reasons.includes(missingReason), `reasons name the missing result: ${JSON.stringify(outcome.reasons)}`);
    } else {
        assert.equal(outcome[side].helloSeen ?? outcome[side].helloReceived, false);
        assert.ok(outcome.reasons.includes('the hello exchange did not complete'), JSON.stringify(outcome.reasons));
    }
}

test('negative control 2: fd 3 bound to a non-socket descriptor (endpoint on /dev/null) makes the check fail', async (context) => {
    const outcome = await runTransportCheck({ endpointChannel: 'devnull' });
    context.diagnostic(transportDiagnostic(outcome));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ala.helloReceived, false);
    assertNonSocketSideFailed(outcome, 'endpoint', 'the endpoint produced no result');
});

test('negative control 2: fd 3 bound to a regular file (ALA side) makes the check fail', async (context) => {
    const outcome = await runTransportCheck({ alaChannel: 'file' });
    context.diagnostic(transportDiagnostic(outcome));
    assert.equal(outcome.ok, false);
    assertNonSocketSideFailed(outcome, 'ala', 'the ALA fixture produced no result');
});

test('negative control 2: fd 3 bound to a pipe (not a socket) makes the check fail', async () => {
    const outcome = await runTransportCheck({ endpointChannel: 'pipe' });
    assert.equal(outcome.ok, false);
    assert.ok(outcome.reasons.includes('the hello exchange did not complete'));
});

test('negative control 3: a fixture that sends a handle with a message draws a channel-wide failure, the handle is closed, and the check fails', async () => {
    const outcome = await runTransportCheck({ alaVariant: 'handle-with-message' });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.ala.channelFailure, { code: 'protocol', message: 'client messages carry no handles' });
    assert.equal(outcome.ala.handlePeerClosed, true, 'the endpoint closed the handle it was sent');
    assert.equal(outcome.endpoint.handleDetected, 'handle_from_ala');
    assert.ok(outcome.reasons.includes('a channel-wide failure arrived during the exchange'));
});

test('full stack, positive: the real endpoint, the real supervisor validator and a deterministic fake keeper on fd 4', async () => {
    const outcome = await runFullStackCheck();
    assert.deepEqual(outcome.reasons, []);
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.ala.streams.sort(), ['stderr', 'stdout']);
    assert.equal(outcome.ala.receivedBytes, 2048);
    assert.deepEqual(outcome.ends, ['endpoint_failure:handle_from_ala'], 'the supervisor saw the ALA-sent handle as an endpoint failure');
    assert.equal(outcome.exits.endpoint.code, 70);
});

test('full stack, negative control: a handle sent with a message ends the execution before any start and the check fails', async () => {
    const outcome = await runFullStackCheck({ variant: 'handle-with-message' });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.ala.channelFailure, { code: 'protocol', message: 'client messages carry no handles' });
    assert.equal(outcome.ala.handlePeerClosed, true);
    assert.equal(outcome.ala.startedReceived, false);
    assert.ok(outcome.reasons.includes('the start was not admitted and started'));
});

test('full stack, negative control: the endpoint with fd 3 on /dev/null cannot serve and the check fails', async () => {
    const outcome = await runFullStackCheck({ endpointChannel: 'devnull' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ala.helloReceived, false);
});

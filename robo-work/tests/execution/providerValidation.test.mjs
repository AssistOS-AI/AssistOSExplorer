import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEndpointLimits } from '../../server/execution/executionLimits.mjs';
import { validateEndpointEvent, validateEndpointRequest, validateSupervisorFrame } from '../../server/execution/endpointFrames.mjs';
import { validateClientMessage, validateStartRequest, virtualPathProblem } from '../../server/execution/providerSchema.mjs';
import { admitStartRequest, admitStreamPaths, createAdmission } from '../../server/execution/supervisorRequestValidator.mjs';

// PROVISIONAL bounds for the tests.
const limits = resolveEndpointLimits({ maxArgs: 4, maxArgBytes: 16, maxEnvEntries: 2, maxEnvValueBytes: 16, maxFolders: 2, maxExclusions: 2, maxPathBytes: 64 });
const admission = createAdmission({
    grants: [{ path: '/projects/g', access: 'write' }, { path: '/projects/ro', access: 'read' }],
    inventory: [{ name: 'codex' }, { name: 'claude' }], streamDirectory: '/run/ep/streams'
});
const valid = (extra = {}) => ({
    processClass: 'run', executable: 'codex', args: ['run'], env: {}, home: '/home/robot', cwd: '/projects/g',
    folders: [{ path: '/projects/g', access: 'read' }], exclusions: [], communication: { kind: 'streams', stdin: 'ignore' },
    lifecycle: { stopGraceMs: 2000 }, network: 'robot-egress', requirements: { privateProc: true }, ...extra
});

test('the schema accepts the version-1 start request exactly and nothing else', () => {
    assert.equal(validateStartRequest(valid(), limits).ok, true);
    assert.equal(validateStartRequest(valid({ communication: { kind: 'service', endpoint: 'loopback-port', stdin: 'pipe' },
        lifecycle: { stopGraceMs: 1, deadlineMs: 5, ready: { condition: 'announced-endpoint', timeoutMs: 9 } } }), limits).ok, true);
    const missing = valid();
    delete missing.requirements;
    const cases = {
        'a missing field': missing,
        'an unknown field': valid({ extra: true }),
        'a non-object': 'start',
        'a class that is not text': valid({ processClass: 7 }),
        'too many arguments': valid({ args: ['a', 'b', 'c', 'd', 'e'] }),
        'an argument that is too long': valid({ args: ['x'.repeat(17)] }),
        'an argument with a NUL byte': valid({ args: ['a\0b'] }),
        'too many environment entries': valid({ env: { A: '1', B: '2', C: '3' } }),
        'an environment value that is too long': valid({ env: { A: 'x'.repeat(17) } }),
        'a non-string environment value': valid({ env: { A: 1 } }),
        'too many folders': valid({ folders: [{ path: '/a', access: 'read' }, { path: '/b', access: 'read' }, { path: '/c', access: 'read' }] }),
        'a folder with an unknown access': valid({ folders: [{ path: '/projects/g', access: 'admin' }] }),
        'a folder with an extra key': valid({ folders: [{ path: '/projects/g', access: 'read', mode: 1 }] }),
        'a path that is too long': valid({ cwd: `/${'a'.repeat(64)}` }),
        'too many exclusions': valid({ exclusions: ['/a', '/b', '/c'] }),
        'a communication kind that is unknown': valid({ communication: { kind: 'pty', stdin: 'pipe' } }),
        'a service endpoint that is not a loopback port': valid({ communication: { kind: 'service', endpoint: 'unix-socket', stdin: 'pipe' } }),
        'a lifecycle with an unknown key': valid({ lifecycle: { stopGraceMs: 1, forever: true } }),
        'a negative stop grace': valid({ lifecycle: { stopGraceMs: -1 } }),
        'requirements that are not boolean': valid({ requirements: { privateProc: 'yes' } }),
        'an object with a foreign prototype': Object.assign(Object.create({ inherited: 1 }), valid())
    };
    for (const [name, request] of Object.entries(cases)) {
        const verdict = validateStartRequest(request, limits);
        assert.equal(verdict.ok, false, name);
        assert.equal(verdict.code, 'invalid_request', name);
    }
});

test('the schema accepts the six client message types and rejects any other type', () => {
    const accepted = [
        { type: 'hello', protocol: 'ala-execution-provider', versions: [1] },
        { type: 'start', process: 1, request: valid() },
        { type: 'stop', process: 1, graceMs: 0 },
        { type: 'inventory', id: 1 },
        { type: 'tempdir', id: 2 },
        { type: 'connect', id: 3, process: 1, endpoint: { kind: 'loopback-port', host: '127.0.0.1', port: 4321 } },
        { type: 'connect', id: 4, process: 1, endpoint: { kind: 'unix-socket', path: '/run/x' } }
    ];
    for (const message of accepted) assert.equal(validateClientMessage(message, limits).ok, true, message.type);
    const rejected = [
        { type: 'shell', command: 'true' }, { type: 'hello', protocol: 'other', versions: [1] },
        { type: 'hello', protocol: 'ala-execution-provider', versions: [] }, { type: 'inventory' }, { type: 'inventory', id: 0 },
        { type: 'inventory', id: 1, extra: 1 }, { type: 'stop', process: 1 }, { type: 'start', process: 0, request: valid() },
        { type: 'connect', id: 1, process: 1, endpoint: { kind: 'loopback-port', host: '10.0.0.1', port: 80 } },
        { type: 'connect', id: 1, process: 1, endpoint: { kind: 'loopback-port', host: '127.0.0.1', port: 70000 } },
        { type: 'connect', id: 1, process: 1, endpoint: { kind: 'abstract', name: 'x' } }, null, 'text', []
    ];
    for (const message of rejected) assert.equal(validateClientMessage(message, limits).ok, false, JSON.stringify(message));
    assert.equal(validateClientMessage({ type: 'shell' }, limits).code, 'unknown_message_type');
});

test('virtual paths must be normalized and absolute', () => {
    for (const good of ['/', '/home/robot', '/projects/g/sub']) assert.equal(virtualPathProblem(good), null, good);
    for (const bad of ['', 'relative', '/a//b', '/a/./b', '/a/../b', '/a/', '/a\\b', '/a\nb', '/a\0b', 7, null]) {
        assert.notEqual(virtualPathProblem(bad), null, String(bad));
    }
});

test('admission refuses each request that is outside the admitted specification, with its own code', () => {
    assert.equal(admitStartRequest(valid(), admission), null);
    assert.equal(admitStartRequest(valid({ processClass: 'service', communication: { kind: 'service', endpoint: 'loopback-port', stdin: 'pipe' } }), admission), null);
    const refusals = [
        ['unknown_process_class', { processClass: 'terminal' }],
        ['executable_not_in_inventory', { executable: '/bin/sh' }],
        ['executable_not_in_inventory', { executable: 'not-a-backend' }],
        ['home_not_admitted', { home: '/home/other' }],
        ['path_outside_view', { cwd: '/outside' }],
        ['path_outside_view', { cwd: '/projects/g/../ro' }],
        ['folder_not_granted', { folders: [{ path: '/outside', access: 'read' }] }],
        ['folder_not_granted', { folders: [{ path: '/projects/gx', access: 'read' }] }],
        ['access_wider_than_grant', { folders: [{ path: '/projects/ro', access: 'write' }] }],
        ['environment_owned_by_provider', { env: { HOME: '/tmp' } }],
        ['environment_owned_by_provider', { env: { XDG_DATA_HOME: '/tmp' } }],
        ['environment_owned_by_provider', { env: { PATH: '/tmp' } }],
        ['environment_not_allowed', { env: { LD_PRELOAD: '/tmp/x' } }],
        ['exclusion_not_enforceable', { exclusions: ['/outside'] }],
        ['network_not_admitted', { network: 'open' }],
        ['private_proc_required', { requirements: { privateProc: false } }]
    ];
    for (const [code, change] of refusals) {
        const refusal = admitStartRequest(valid(change), admission);
        assert.equal(refusal?.code, code, JSON.stringify(change));
    }
    // A read folder inside a write grant, and a write folder inside it, are within the grants.
    assert.equal(admitStartRequest(valid({ folders: [{ path: '/projects/g/sub', access: 'write' }] }), admission), null);
    assert.equal(admitStartRequest(valid({ env: { IS_SANDBOX: '1' } }), admission), null);
});

test('stream paths must be fresh names directly inside the endpoint stream directory, one per requested stream', () => {
    const request = valid();
    const good = { stdout: '/run/ep/streams/aaaaaaaaaaaa', stderr: '/run/ep/streams/bbbbbbbbbbbb' };
    assert.equal(admitStreamPaths(good, request, admission), null);
    const piped = valid({ communication: { kind: 'streams', stdin: 'pipe' } });
    assert.equal(admitStreamPaths({ ...good, stdin: '/run/ep/streams/cccccccccccc' }, piped, admission), null);
    const wrong = [
        [{ stdout: good.stdout }, request], [{ ...good, stdin: '/run/ep/streams/cccccccccccc' }, request], [good, piped],
        [{ stdout: '/run/ep/streams/aaaaaaaaaaaa', stderr: '/run/ep/streams/aaaaaaaaaaaa' }, request],
        [{ stdout: '/run/other/aaaaaaaaaaaa', stderr: good.stderr }, request],
        [{ stdout: '/run/ep/streams/sub/aaaaaaaaaaaa', stderr: good.stderr }, request],
        [{ stdout: '/run/ep/streams/short', stderr: good.stderr }, request],
        [{ stdout: '/run/ep/streams/AAAAAAAAAAAA', stderr: good.stderr }, request]
    ];
    for (const [streams, subject] of wrong) assert.notEqual(admitStreamPaths(streams, subject, admission), null, JSON.stringify(streams));
});

test('frame protocol validation: requests, events and supervisor frames', () => {
    const streams = { stdout: '/run/ep/streams/aaaaaaaaaaaa', stderr: '/run/ep/streams/bbbbbbbbbbbb' };
    assert.equal(validateEndpointRequest({ id: 1, op: 'inventory' }, limits).ok, true);
    assert.equal(validateEndpointRequest({ id: 2, op: 'connect', process: 1, port: 80 }, limits).ok, true);
    assert.equal(validateEndpointRequest({ id: 3, op: 'start', process: 1, request: valid(), streams }, limits).ok, true);
    const bad = validateEndpointRequest({ id: 3, op: 'start', process: 1, request: valid({ extra: 1 }), streams }, limits);
    assert.deepEqual([bad.ok, bad.schema], [false, true]);
    for (const frame of [{ id: 0, op: 'inventory' }, { id: 1, op: 'shell' }, { id: 1, op: 'inventory', x: 1 }, { op: 'inventory' },
        { id: 1, op: 'connect', process: 1, port: 0 }, { id: 1, op: 'start', process: 1, request: valid(), streams: {} },
        { id: 1, op: 'start', process: 1, request: valid(), streams: { stdout: 'relative' } }, null]) {
        assert.equal(validateEndpointRequest(frame, limits).ok, false, JSON.stringify(frame));
    }
    assert.equal(validateEndpointEvent({ event: 'ready', relayPorts: [80] }), true);
    assert.equal(validateEndpointEvent({ event: 'failure', reason: 'outbound_backlog' }), true);
    assert.equal(validateEndpointEvent({ event: 'failure', reason: 'Not Valid' }), false);
    assert.equal(validateEndpointEvent({ event: 'ready', relayPorts: [0] }), false);
    assert.equal(validateEndpointEvent({ event: 'status', descriptors: 9, pendingConnects: 0 }), true);
    assert.equal(validateEndpointEvent({ event: 'status', descriptors: 'many' }), false);
    assert.equal(validateSupervisorFrame({ id: 1, ok: true, value: { path: '/tmp/x' } }), true);
    assert.equal(validateSupervisorFrame({ id: 1, ok: false, kind: 'refused', error: { code: 'c', message: 'm' } }), true);
    assert.equal(validateSupervisorFrame({ id: 1, ok: false, kind: 'other', error: { code: 'c', message: 'm' } }), false);
    assert.equal(validateSupervisorFrame({ event: 'exit', process: 1, code: 0, signal: null }), true);
    assert.equal(validateSupervisorFrame({ event: 'exit', process: 1, code: 'x', signal: null }), false);
    assert.equal(validateSupervisorFrame({ event: 'report' }), true);
});

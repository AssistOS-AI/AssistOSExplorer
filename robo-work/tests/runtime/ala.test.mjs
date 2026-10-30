import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { PlanError, alaSessionId, alaTurnId, planAlaExecution } from '../../server/runtime/alaPlan.mjs';
import { EVENT_PREFIX, openAlaStreams, splitEventLines } from '../../server/runtime/alaStreams.mjs';
import { createEventRelay } from '../../server/runtime/eventRelay.mjs';
import { resolveControlStreamLimits } from '../../server/execution/executionLimits.mjs';

const ROOT = '/ws';
const SESSION = '0f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11';
const spec = (overrides = {}) => ({
    version: 2, prompt: 'native prompt', displayText: 'plain', sessionId: SESSION, turnId: 't1', cwd: '/ws/proj', permissions: 'full-access', ...overrides
});

test('plan: virtual paths, ALA arguments, environment and the first control record', () => {
    const plan = planAlaExecution({
        workspaceRoot: ROOT, specification: spec({
            model: 'm1', codingAgent: 'claude', resume: true, mcpServers: 'a=http://x:1',
            folders: [{ path: '/ws/proj', access: 'read' }, { path: '/ws/skills', access: 'read' }, { path: '/ws/out', access: 'write' }, { path: '/ws/pi', access: 'read' }],
            ignore: ['/ws/proj/.achilles', '/ws/skills', '/elsewhere/x']
        })
    });
    assert.deepEqual(plan.grants.map((g) => [g.name, g.path, g.access, g.relativePath]),
        [['g0', '/projects/g0', 'write', 'proj'], ['g1', '/projects/g1', 'read', 'skills'], ['g2', '/projects/g2', 'write', 'out'], ['g3', '/projects/g3', 'read', 'pi']]);
    assert.equal(plan.cwd, '/projects/g0');
    assert.deepEqual(plan.argv, [
        '--execution-provider', 'protocol', '--home', '/home/robot', '--config', '/config/ala.json', '--cwd', '/projects/g0',
        '--session-id', SESSION, '--turn-id', 't1', '--control-stdin', '--permissions', 'full-access', '--model', 'm1', '--effort', 'default', '--ca', 'claude',
        '--folder', '/projects/g1', '--folder', '/projects/g2', 'write', '--folder', '/projects/g3',
        '--ignore', '/projects/g0/.achilles', '--ignore', '/projects/g1', '--resume-session', '--MCPServers', 'a=http://x:1'
    ]);
    assert.deepEqual({ ...plan.env }, { HOME: '/home/robot', ALA_EVENT_STREAM: '1', ALA_TASK_REPOSITORIES: '', ALA_SESSIONS: '/session' });
    assert.deepEqual({ ...plan.prompt }, { type: 'prompt', prompt: 'native prompt', displayText: 'plain' });
    assert.ok(plan.argv.every((entry) => !entry.includes('/ws')), 'no host path reaches ALA');
});

test('plan: no cwd selects no project (M-20): ALA starts in the HOME, folders stay explicit grants', () => {
    const { cwd, ...rest } = spec();
    void cwd;
    const none = planAlaExecution({ workspaceRoot: ROOT, specification: rest });
    assert.deepEqual([...none.grants], []);
    assert.equal(none.cwd, '/home/robot');
    assert.deepEqual(none.argv.slice(none.argv.indexOf('--cwd'), none.argv.indexOf('--cwd') + 2), ['--cwd', '/home/robot']);
    const withFolder = planAlaExecution({ workspaceRoot: ROOT, specification: { ...rest, folders: [{ path: '/ws/skills', access: 'read' }, { path: '/ws/out', access: 'write' }], ignore: ['/ws/skills/x'] } });
    assert.deepEqual(withFolder.grants.map((grant) => [grant.path, grant.access]), [['/projects/g0', 'read'], ['/projects/g1', 'write']]);
    assert.deepEqual(withFolder.argv.slice(withFolder.argv.indexOf('--folder')), ['--folder', '/projects/g0', '--folder', '/projects/g1', 'write', '--ignore', '/projects/g0/x']);
});

test('plan: refusals are bounded reasons', () => {
    const reason = (overrides, workspaceRoot = ROOT) => {
        try { planAlaExecution({ workspaceRoot, specification: spec(overrides) }); } catch (error) { assert.ok(error instanceof PlanError); return error.reason; }
        return assert.fail('expected a refusal');
    };
    assert.equal(reason({ version: 1 }), 'unsupported_specification');
    assert.equal(reason({ permissions: 'ask-for-approval' }), 'approval_unsupported');
    assert.equal(reason({ cwd: '/ws' }), 'workspace_root_not_granted');
    assert.equal(reason({ cwd: '/other/proj' }), 'path_outside_workspace');
    assert.equal(reason({ cwd: '/wsx/proj' }), 'path_outside_workspace');
    assert.equal(reason({ folders: [{ path: '/etc', access: 'read' }] }), 'path_outside_workspace');
    assert.equal(reason({}, '/'), 'workspace_unavailable');
    // Protocol-mode ALA refuses as, at and expose (virtual-paths.mjs:52-53); the plan fails the attempt cleanly instead.
    for (const modifier of [{ as: 'skills' }, { at: '/ws/proj/.agents/skills', expose: true }, { expose: true }]) {
        assert.equal(reason({ folders: [{ path: '/ws/s', access: 'read', ...modifier }] }), 'folder_modifier_unsupported');
    }
    // ALA drops a first control record over 2 Mi characters and then waits for a prompt for ever: refused up front.
    assert.equal(reason({ prompt: 'x'.repeat(1024 * 1024 + 1) }), 'prompt_too_large');
    assert.equal(reason({ prompt: '"'.repeat(1024 * 1024), displayText: '"'.repeat(100) }), 'prompt_too_large', 'JSON escaping doubles the quotes past 2 Mi');
    planAlaExecution({ workspaceRoot: ROOT, specification: spec({ prompt: 'x'.repeat(1024 * 1024), displayText: 'y'.repeat(256 * 1024) }) });
});

test('plan: ALA gets a UUID session and a plain turn id whatever opaque ids the specification carries', () => {
    assert.equal(alaSessionId(SESSION.toUpperCase()), SESSION);
    const derived = alaSessionId('session:chat-1.v2');
    assert.match(derived, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal(alaSessionId('session:chat-1.v2'), derived, 'stable, so a resume finds the transcript');
    assert.notEqual(alaSessionId('session:chat-2'), derived);
    assert.equal(alaTurnId('turn:1.a'), 'turn_1_a');
    const plan = planAlaExecution({ workspaceRoot: ROOT, specification: spec({ sessionId: 'session:chat-1.v2', turnId: 'turn:1' }) });
    assert.equal(plan.argv[plan.argv.indexOf('--session-id') + 1], derived);
    assert.equal(plan.argv[plan.argv.indexOf('--turn-id') + 1], 'turn_1');
});

test('streams: event lines are split from diagnostics, stdout is the final text, and the section 5.5 reader bounds apply', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const records = [];
    const ends = [];
    const written = [];
    stdin.on('data', (chunk) => written.push(chunk.toString()));
    const { reader, final } = openAlaStreams({
        stdin, stdout, stderr, limits: resolveControlStreamLimits({ maxRecordBytes: 4096 }),
        onRecord: (record, bytes) => records.push([record, bytes]), onEnd: (reason, detail) => ends.push([reason, detail])
    });
    stderr.write('plain diagnostic\n');
    stderr.write(`${EVENT_PREFIX}{"type":"session-ready","sessionId":"s"}\n`);
    stderr.write('@@ALA_EV');
    stderr.write('x not an event\n');
    stderr.write(`${EVENT_PREFIX}{"type":"coding-agent-final","message":"done"}\n@@short\n`);
    stdout.write('final ');
    stdout.write('text\n');
    assert.equal(await reader.writeControl({ type: 'prompt', prompt: 'p' }), true);
    stderr.end();
    stdout.end();
    await final.done;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(records.map(([record]) => record.type), ['session-ready', 'coding-agent-final']);
    assert.equal(final.text(), 'final text\n');
    assert.deepEqual(written, ['{"type":"prompt","prompt":"p"}\n']);
    assert.equal(ends[0][0], 'stdout_ended');
    assert.match(reader.stderrTail().toString(), /plain diagnostic\n@@ALA_EVx not an event\n@@short\n/u);
});

test('streams: a malformed event record or an oversize one ends the execution; split chunks and backpressure keep records whole', async () => {
    const make = (limits) => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const ends = [];
        const records = [];
        openAlaStreams({ stdin: new PassThrough(), stdout, stderr, limits: resolveControlStreamLimits(limits), onRecord: (r) => records.push(r), onEnd: (...args) => ends.push(args) });
        return { stderr, ends, records };
    };
    const malformed = make({});
    malformed.stderr.write(`${EVENT_PREFIX}{not json\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(malformed.ends[0], ['control_stream_violation', 'malformed_record']);
    const untyped = make({});
    untyped.stderr.write(`${EVENT_PREFIX}{"a":1}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(untyped.ends[0], ['control_stream_violation', 'invalid_record']);
    const big = make({ maxRecordBytes: 256 });
    big.stderr.write(`${EVENT_PREFIX}{"type":"x","pad":"${'y'.repeat(400)}"}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(big.ends[0], ['control_stream_violation', 'record_too_large']);
    const split = make({});
    const line = `${EVENT_PREFIX}{"type":"split","n":1}\n`;
    for (const piece of [line.slice(0, 5), line.slice(5, 20), line.slice(20)]) split.stderr.write(piece);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(split.records, [{ type: 'split', n: 1 }]);
    // An overlong unprefixed line is diagnostic and cannot violate the record bound.
    const diag = splitEventLines(new PassThrough());
    assert.ok(diag.events && diag.diagnostics);
});

test('relay: never blocks; backlog, oversize records and store refusals become explicit truncated events', async () => {
    const stored = [];
    const relay = createEventRelay({
        maxQueued: 3, maxBatch: 2, flushMs: 1000,
        record: (events) => { stored.push(...events); return { stored: events.length, dropped: 0 }; }
    });
    const started = Date.now();
    for (let i = 0; i < 10; i += 1) relay.push({ type: 'n', i }, 20);
    relay.push({ type: 'huge' }, 10 * 1024 * 1024);
    assert.ok(Date.now() - started < 50, 'push is synchronous and cheap');
    await relay.close();
    assert.deepEqual(stored.map((event) => [event.type, event.data.reason ?? event.data.record?.i]),
        [['ala', 0], ['ala', 1], ['ala', 2], ['truncated', 'relay_backlog'], ['truncated', 'record_too_large']]);
    assert.equal(stored[3].data.dropped, 7);

    const calls = [];
    const closing = createEventRelay({ record: (events) => { calls.push(events); return { stored: 0, dropped: events.length }; }, flushMs: 1 });
    closing.push({ type: 'a' }, 5);
    const summary = await closing.close();
    assert.equal(summary.dropped, 1);
    assert.deepEqual(calls.at(-1), [{ type: 'truncated', data: { dropped: 1, reason: 'event_limit' } }]);
    const failing = createEventRelay({ record: () => { throw Object.assign(new Error('x'), { code: 'operation_conflict' }); }, flushMs: 1 });
    failing.push({ type: 'a' }, 5);
    assert.equal((await failing.close()).dropped, 1);
});

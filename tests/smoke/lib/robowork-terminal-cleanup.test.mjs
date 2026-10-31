import assert from 'node:assert/strict';
import test from 'node:test';

import { deleteOwnRobotAfterUtilities } from './robowork-terminal-cleanup.mjs';

const robot = { id: 'test-owned-robot', name: 'e2e-term-123456abcdef' };
const busy = { status: 409, payload: { error: 'the robot has running or unsettled work; stop it first' } };
const admission = (kind, state = 'completed', releaseState = 'released') => ({
    execution_id: `${kind}-1`, robot_id: 'worker-robot', kind, state, created_at: 1000, updated_at: 1000,
    blockers: [{ release_state: releaseState, retained: 0 }],
});

function rig({ rows = [admission('terminal')], remove, advance = () => {} } = {}) {
    let time = 1000;
    let calls = 0;
    let confirmed = 0;
    const ledger = { robot: { name: robot.name, id: 'worker-robot', lifecycle: 'ready' }, executions: rows };
    const options = {
        robot, ownedNamePrefix: robot.name,
        readLedger: () => structuredClone(ledger),
        now: () => time,
        sleep: async (ms) => { time += ms; advance(ledger, time); },
        timeoutMs: 300,
        removeRobot: async (id) => {
            assert.equal(id, robot.id);
            calls += 1;
            if (remove) return remove({ ledger, calls, time });
            ledger.robot.lifecycle = 'deleted';
            return { status: 200 };
        },
        confirmAbsent: async ({ workerRobotId, ledger: deleted }) => {
            assert.equal(workerRobotId, 'worker-robot');
            assert.equal(deleted.robot.lifecycle, 'deleted');
            confirmed += 1;
        },
    };
    return { options, ledger, calls: () => calls, confirmed: () => confirmed };
}

test('waits for a page-discovery utility and asynchronous deletion before confirming absence', async () => {
    const r = rig({ rows: [admission('terminal'), admission('utility', 'running', 'committed')],
        advance(ledger, time) {
            const utility = ledger.executions[1];
            utility.state = 'completed'; utility.blockers[0].release_state = 'released'; utility.updated_at = time;
            if (ledger.robot.lifecycle === 'deleting') ledger.robot.lifecycle = 'deleted';
        },
        remove({ ledger }) { ledger.robot.lifecycle = 'deleting'; return { status: 200 }; },
    });
    assert.equal((await deleteOwnRobotAfterUtilities(r.options)).attempts, 1);
    assert.equal(r.calls(), 1);
    assert.equal(r.confirmed(), 1);
});

test('one exact worker-busy refusal is retried only after its overlapping utility settles', async () => {
    const r = rig({
        remove({ ledger, calls, time }) {
            if (calls === 1) {
                ledger.executions.push({ ...admission('utility', 'running', 'committed'), created_at: time, updated_at: time });
                return busy;
            }
            ledger.robot.lifecycle = 'deleted';
            return { status: 200 };
        },
        advance(ledger, time) {
            const utility = ledger.executions[1];
            utility.state = 'completed'; utility.updated_at = time; utility.blockers[0].release_state = 'released';
        },
    });
    assert.equal((await deleteOwnRobotAfterUtilities(r.options)).attempts, 2);
    assert.equal(r.calls(), 2);
    assert.equal(r.confirmed(), 1);
});

test('active terminal/AI work and unsafe or unknown resources never cause a delete call', async (t) => {
    const cases = [
        admission('terminal', 'running', 'committed'), admission('task', 'running', 'committed'),
        admission('utility', 'running', 'quarantined'), admission('unknown'),
        { ...admission('utility'), blockers: [{ release_state: 'released', retained: 1 }] },
        { ...admission('terminal'), robot_id: 'another-worker-robot' },
    ];
    for (const row of cases) await t.test(`${row.kind}/${row.state}/${row.blockers[0].release_state}/${row.robot_id}`, async () => {
        const r = rig({ rows: [row] });
        await assert.rejects(deleteOwnRobotAfterUtilities(r.options));
        assert.equal(r.calls(), 0);
        assert.equal(r.confirmed(), 0);
    });
});

test('busy without fresh utility evidence, terminal busy, unknown 409 and server errors are not retried', async (t) => {
    for (const reply of [busy, { status: 409, payload: { error: '1 terminal is open' } }, { status: 409, payload: { error: 'unknown conflict' } }, { status: 500 }]) {
        await t.test(`${reply.status}/${reply.payload?.error ?? ''}`, async () => {
            const r = rig({ remove: () => reply });
            await assert.rejects(deleteOwnRobotAfterUtilities(r.options));
            assert.equal(r.calls(), 1);
            assert.equal(r.confirmed(), 0);
        });
    }
});

test('stale utility evidence cannot justify retry; repeated fresh utility races stop after two delete calls', async (t) => {
    await t.test('utility finished before the request', async () => {
        const r = rig({ rows: [{ ...admission('utility'), created_at: 900, updated_at: 999 }], remove: () => busy });
        await assert.rejects(deleteOwnRobotAfterUtilities(r.options), /no overlapping discovery utility/);
        assert.equal(r.calls(), 1);
    });
    await t.test('two proven utility races exhaust the single retry', async () => {
        const r = rig({
            remove({ ledger, time }) {
                ledger.executions.push({ ...admission('utility', 'running', 'committed'), created_at: time, updated_at: time });
                return busy;
            },
            advance(ledger, time) {
                for (const row of ledger.executions) if (row.kind === 'utility') {
                    row.state = 'completed'; row.updated_at = time; row.blockers[0].release_state = 'released';
                }
            },
        });
        await assert.rejects(deleteOwnRobotAfterUtilities(r.options), /single utility-only retry/);
        assert.equal(r.calls(), 2);
        assert.equal(r.confirmed(), 0);
    });
});

test('stuck utilities and accepted-but-unfinished deletion time out instead of passing', async (t) => {
    await t.test('utility never settles', async () => {
        const r = rig({ rows: [admission('utility', 'running', 'committed')] });
        await assert.rejects(deleteOwnRobotAfterUtilities(r.options), /Timed out/);
        assert.equal(r.calls(), 0);
    });
    await t.test('HTTP 200 leaves lifecycle deleting', async () => {
        const r = rig({ remove({ ledger }) { ledger.robot.lifecycle = 'deleting'; return { status: 200 }; } });
        await assert.rejects(deleteOwnRobotAfterUtilities(r.options), /Timed out/);
        assert.equal(r.calls(), 1);
        assert.equal(r.confirmed(), 0);
    });
    await t.test('absence assertion fails', async () => {
        const r = rig();
        r.options.confirmAbsent = async () => { throw new Error('robot directory still exists'); };
        await assert.rejects(deleteOwnRobotAfterUtilities(r.options), /directory still exists/);
        assert.equal(r.calls(), 1);
    });
});

test('wrong ownership and a changed worker identity fail before deleting', async () => {
    const wrongOwner = rig();
    wrongOwner.options.ownedNamePrefix = 'e2e-term-abcdef123456';
    await assert.rejects(deleteOwnRobotAfterUtilities(wrongOwner.options), /exact run namespace/);
    assert.equal(wrongOwner.calls(), 0);
    const changed = rig();
    let reads = 0;
    changed.options.readLedger = () => ({ ...structuredClone(changed.ledger), robot: { ...changed.ledger.robot, id: ++reads === 1 ? 'worker-robot' : 'different-worker' } });
    await assert.rejects(deleteOwnRobotAfterUtilities(changed.options), /identity is unchanged/);
    assert.equal(changed.calls(), 0);
});

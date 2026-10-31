import assert from 'node:assert/strict';

const END_STATES = new Set(['completed', 'failed', 'paused', 'human-input', 'cancelled', 'interrupted']);
const KNOWN_KINDS = new Set(['task', 'continuation', 'turn', 'terminal', 'utility']);
const WORKER_BUSY_MESSAGE = 'the robot has running or unsettled work; stop it first';

// Only read-only discovery utilities may delay test cleanup. Active terminal/AI work, retained resources and quarantine fail closed.
function inspectLedger(ledger, robot, workerRobotId) {
    assert.equal(ledger.robot?.name, robot.name, 'Cleanup ledger names the exact test-owned robot');
    assert.equal(ledger.robot.id, workerRobotId, 'Cleanup worker robot identity is unchanged');
    const pending = [];
    for (const row of ledger.executions) {
        assert.equal(row.robot_id, workerRobotId);
        assert.ok(KNOWN_KINDS.has(row.kind), `Unknown admission kind ${row.kind} blocks cleanup`);
        for (const blocker of row.blockers) {
            assert.ok(!blocker.retained, 'Retained resources block cleanup');
            assert.ok(['reserved', 'committed', 'released'].includes(blocker.release_state), 'Quarantined or unknown resources block cleanup');
        }
        const settled = END_STATES.has(row.state) && row.blockers.every((blocker) => blocker.release_state === 'released');
        if (row.kind !== 'utility') assert.ok(settled, `Active or unsettled ${row.kind} blocks cleanup`);
        else if (!settled) {
            assert.ok(END_STATES.has(row.state) || ['queued', 'running', 'stopping'].includes(row.state), 'Unknown utility state blocks cleanup');
            pending.push(row);
        }
    }
    return pending;
}

export async function deleteOwnRobotAfterUtilities({ robot, ownedNamePrefix, readLedger, removeRobot, confirmAbsent,
    now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 20_000, record = () => {} }) {
    assert.match(ownedNamePrefix, /^e2e-term-[a-f0-9]{12}$/u);
    assert.ok(robot.name === ownedNamePrefix || robot.name.startsWith(`${ownedNamePrefix}-`), 'Cleanup owns this exact run namespace');
    assert.ok(typeof robot.id === 'string' && robot.id.length > 0, 'Cleanup names the created RoboTeam robot ID');
    const initial = readLedger();
    const workerRobotId = initial.robot?.id;
    assert.ok(typeof workerRobotId === 'string' && workerRobotId.length > 0, 'Worker robot identity is recorded');
    inspectLedger(initial, robot, workerRobotId);
    const deadline = now() + timeoutMs;
    const waitForLedger = async (probe) => {
        for (;;) {
            const ledger = readLedger();
            const pending = inspectLedger(ledger, robot, workerRobotId);
            if (probe(ledger, pending)) return ledger;
            assert.ok(now() < deadline, 'Timed out waiting for test-owned discovery utilities or deletion to settle');
            await sleep(100);
        }
    };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const before = await waitForLedger((_ledger, pending) => pending.length === 0);
        assert.ok(['ready', 'failed'].includes(before.robot.lifecycle), 'Only an idle ready/failed test robot may be deleted');
        const startedAt = now();
        const reply = await removeRobot(robot.id);
        const repliedAt = now();
        record({ attempt, startedAt, repliedAt, reply });
        if (reply.status === 200) {
            const deleted = await waitForLedger((ledger, pending) => ledger.robot.lifecycle === 'deleted' && pending.length === 0);
            await confirmAbsent({ robot, workerRobotId, ledger: deleted });
            return { attempts: attempt, workerRobotId, lifecycle: deleted.robot.lifecycle };
        }
        // A 409 is retryable only when it is the exact worker busy refusal AND a utility overlaps this particular request.
        assert.ok(reply.status === 409 && reply.payload?.error === WORKER_BUSY_MESSAGE, `Robot delete refused: ${reply.status} ${reply.payload?.error ?? ''}`);
        const after = readLedger();
        inspectLedger(after, robot, workerRobotId);
        const overlapping = after.executions.filter((row) => row.kind === 'utility' && row.created_at <= repliedAt
            && (!END_STATES.has(row.state) || row.updated_at >= startedAt));
        assert.ok(overlapping.length > 0, 'Busy refusal has no overlapping discovery utility; refusing to retry');
        record({ attempt, overlappingUtilities: overlapping.map((row) => row.execution_id) });
        assert.ok(attempt < 2, 'Robot remains busy after the single utility-only retry');
    }
}

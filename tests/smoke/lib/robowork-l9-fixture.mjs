import assert from 'node:assert/strict';

export function runningL9Turn(ledger, { robotName, workerRobotId, sessionId, sinceMs, executionId = null }) {
    assert.equal(ledger.robot?.name, robotName, 'L9 reads the fresh B robot');
    assert.equal(ledger.robot.id, workerRobotId, 'L9 worker robot identity stays pinned');
    assert.ok(sessionId && Number.isFinite(sinceMs), 'L9 has a selected session and send boundary');
    const turns = ledger.executions.filter((row) => ['turn', 'task', 'continuation'].includes(row.kind)
        && row.created_at >= sinceMs);
    assert.ok(turns.length <= 1, 'L9 has exactly one fresh AI admission');
    if (!turns.length) return null;
    const turn = turns[0];
    assert.ok(turn.execution_id, 'The fresh L9 turn has an execution identity');
    assert.equal(turn.kind, 'turn', 'Utilities and other work cannot substitute for the WebChat turn');
    assert.equal(turn.robot_id, workerRobotId);
    assert.equal(turn.specification.sessionId, sessionId, 'The AI admission uses the freshly selected B conversation');
    assert.ok(turn.specification.cwd === undefined || turn.specification.cwd === '', 'L9 has no project cwd');
    assert.deepEqual(turn.specification.folders || [], [], 'L9 has no project folder grant');
    if (executionId) assert.equal(turn.execution_id, executionId, 'Readiness and finish use the same AI admission');
    assert.ok(['queued', 'running'].includes(turn.state), `The L9 AI turn ended before measurement finish: ${turn.state}`);
    return turn.state === 'running' ? turn : null;
}

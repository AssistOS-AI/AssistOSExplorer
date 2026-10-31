import assert from 'node:assert/strict';
import test from 'node:test';
import { runningL9Turn } from './robowork-l9-fixture.mjs';

const scope = { robotName: 'e2e-term-test-b', workerRobotId: 'worker-b', sessionId: 'fresh-session', sinceMs: 1000 };
const turn = (extra = {}) => ({ execution_id: 'actual-ai', kind: 'turn', robot_id: 'worker-b', created_at: 1100,
    state: 'running', specification: { sessionId: scope.sessionId }, ...extra });
const ledger = (executions) => ({ robot: { name: scope.robotName, id: scope.workerRobotId }, executions });

test('utility plus terminal readiness cannot substitute for the fresh scoped B AI turn', () => {
    const utility = turn({ kind: 'utility' });
    const terminal = turn({ kind: 'terminal' });
    assert.equal(runningL9Turn(ledger([utility, terminal]), scope), null);
    const actual = turn();
    assert.equal(runningL9Turn(ledger([utility, terminal, actual]), scope), actual);
    assert.equal(runningL9Turn(ledger([turn({ created_at: 999 })]), scope), null);
    assert.equal(runningL9Turn(ledger([turn({ state: 'queued' })]), scope), null);
});

test('readiness and finish require one live turn in the exact robot/session without project grants', () => {
    const failures = [
        [turn(), turn({ execution_id: 'duplicate-ai' })], [turn({ kind: 'task' })], [turn({ kind: 'continuation' })],
        [turn({ robot_id: 'another-worker' })], [turn({ specification: { sessionId: 'stale-root-session' } })],
        [turn({ specification: { sessionId: scope.sessionId, cwd: '/workspace' } })],
        [turn({ specification: { sessionId: scope.sessionId, folders: [{ path: '/workspace' }] } })],
        [turn({ state: 'completed' })], [turn({ state: 'failed' })], [turn({ state: 'cancelled' })], [turn({ execution_id: null })],
    ];
    for (const executions of failures) assert.throws(() => runningL9Turn(ledger(executions), scope));
    assert.throws(() => runningL9Turn({ ...ledger([turn()]), robot: { id: 'another-worker', name: scope.robotName } }, scope));
    assert.throws(() => runningL9Turn(ledger([turn({ execution_id: 'swapped-ai' })]), { ...scope, executionId: 'first-ai' }));
    assert.throws(() => runningL9Turn(ledger([turn()]), { ...scope, sessionId: null }));
});

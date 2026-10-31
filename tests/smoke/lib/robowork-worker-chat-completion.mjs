import assert from 'node:assert/strict';
import { pinChatTurnBaseline, currentChatTurnAnswer } from './robowork-chat-turn-identity.mjs';

const AI_KINDS = new Set(['turn', 'task', 'continuation']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function pinWorkerChatBaseline(ledger, scope) {
    assert.ok(scope.robotId && scope.robotName, 'The caller supplies its known RoboTeam robot ID and name');
    assert.equal(ledger.robot?.name, scope.robotName, 'Worker baseline names the requested robot');
    assert.ok(ledger.robot.id, 'Worker robot identity is recorded separately from the RoboTeam ID');
    assert.ok(Number.isFinite(scope.startedMs), 'The send has a start boundary');
    return { ...scope, workerRobotId: ledger.robot.id, previousIds: ledger.executions.map((row) => row.execution_id),
        previousAI: ledger.executions.filter((row) => AI_KINDS.has(row.kind)).map((row) => ({ attemptId: row.attempt_id,
            sessionId: row.specification.sessionId, turnId: row.specification.turnId })) };
}

export function selectWorkerChatExecution(ledger, baseline, binding = null) {
    assert.equal(ledger.robot?.id, baseline.workerRobotId, 'The worker robot identity stayed pinned');
    assert.equal(ledger.robot.name, baseline.robotName, 'The worker robot name stayed pinned');
    const prior = new Set(baseline.previousIds);
    const fresh = ledger.executions.filter((row) => !prior.has(row.execution_id) && row.created_at >= baseline.startedMs);
    assert.ok(fresh.every((row) => AI_KINDS.has(row.kind) || ['utility', 'terminal'].includes(row.kind)), 'Unknown new work cannot prove a chat turn');
    const ai = fresh.filter((row) => AI_KINDS.has(row.kind));
    assert.ok(ai.length <= 1, 'Exactly one fresh AI admission may belong to this send');
    if (!ai.length) {
        assert.equal(binding, null, 'The bound worker execution did not disappear');
        return null;
    }
    const execution = ai[0];
    assert.ok(execution.execution_id && execution.attempt_id, 'Worker execution and attempt identities are present');
    assert.equal(execution.robot_id, baseline.workerRobotId, 'The admission belongs to the pinned worker robot');
    assert.equal(execution.specification.cwd || '', baseline.workerCwd, 'The admission has the exact project scope');
    for (const key of ['sessionId', 'turnId']) assert.match(execution.specification[key] || '', UUID, 'The admission has native session/turn identities');
    if (!baseline.workerCwd) assert.deepEqual(execution.specification.folders || [], [], 'A no-project turn receives no project folders');
    assert.ok(!baseline.previousAI.some((row) => row.attemptId === execution.attempt_id
        || (row.sessionId === execution.specification.sessionId && row.turnId === execution.specification.turnId)), 'The new admission did not reuse a prior attempt or turn');
    if (binding) {
        for (const [key, value] of Object.entries({ executionId: execution.execution_id, attemptId: execution.attempt_id,
            sessionId: execution.specification.sessionId, turnId: execution.specification.turnId })) assert.equal(value, binding[key], 'Worker execution/turn binding is stable');
    }
    return execution;
}

function workerCompleted(execution) {
    assert.ok(['queued', 'running', 'stopping', 'completed'].includes(execution.state), `Worker chat ended unsuccessfully: ${execution.state}`);
    assert.ok(execution.end_classification == null || execution.end_classification === 'completed', 'Worker chat classification is not a failure or interruption');
    assert.ok(Array.isArray(execution.blockers), 'Worker resource evidence is available');
    for (const blocker of execution.blockers) {
        assert.ok(!blocker.retained, 'Worker chat resources are not retained');
        assert.ok(['reserved', 'committed', 'released'].includes(blocker.release_state), 'Worker chat resources are not quarantined or unknown');
    }
    if (execution.state !== 'completed') return false;
    assert.equal(execution.end_classification, 'completed');
    let result;
    try { result = typeof execution.result === 'string' ? JSON.parse(execution.result) : execution.result; }
    catch { assert.fail('Worker chat result is invalid JSON'); }
    assert.equal(result?.status, 'completed', 'The worker published a completed result');
    assert.equal(result.cleanup, 'released', 'The worker verified result cleanup');
    assert.ok(typeof result.outputText === 'string' && result.outputText.trim(), 'The worker published nonempty output');
    assert.ok(execution.blockers.length > 0, 'Completed worker resource evidence is nonempty');
    return execution.blockers.every((blocker) => blocker.release_state === 'released');
}

export function matchWorkerChatAnswer({ baseline, execution, metadata, bubbles, busy, binding = null }) {
    const completed = workerCompleted(execution);
    const context = { robotId: baseline.robotId, sessionId: execution.specification.sessionId, cwd: baseline.metadataCwd };
    assert.ok(Array.isArray(metadata.turns), 'Saved conversation turn identities are available');
    const turns = metadata.turns.filter((turn) => turn.turnId === execution.specification.turnId);
    assert.equal(turns.length, 1, 'The worker turn identifies exactly one saved metadata turn');
    const turn = turns[0];
    assert.ok(!baseline.previousDomIds.some((id) => id === turn.userMessageId || id === turn.assistantMessageId), 'The current metadata message IDs were not already displayed before this send');
    const history = { ...metadata, turns: metadata.turns.filter((entry) => entry !== turn) };
    const metadataBaseline = pinChatTurnBaseline(history, context);
    const priorBinding = binding && { turnId: binding.turnId, userMessageId: binding.userMessageId, assistantMessageId: binding.assistantMessageId };
    const matched = currentChatTurnAnswer({ baseline: metadataBaseline, metadata, currentContext: context, bubbles, busy, binding: priorBinding });
    return { binding: { executionId: execution.execution_id, attemptId: execution.attempt_id, sessionId: context.sessionId, ...matched.binding },
        answer: completed ? matched.answer : null };
}

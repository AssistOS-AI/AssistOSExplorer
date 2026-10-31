import assert from 'node:assert/strict';

// UI bubbles can contain transport/model errors. Only the current candidate's completed worker result proves model liveness.
export function validatePreflightExecution({ executions, robotName, cwd, startedMs, observedAtMs, previousExecutionIds = [] }) {
    assert.ok(Number.isFinite(startedMs) && Number.isFinite(observedAtMs) && observedAtMs >= startedMs, 'Preflight has a bounded candidate time window');
    assert.ok(typeof robotName === 'string' && robotName && typeof cwd === 'string' && cwd, 'Preflight has an exact robot and project scope');
    assert.ok(Array.isArray(executions), 'Preflight worker ledger is available');
    const previous = new Set(previousExecutionIds);
    const matching = executions.filter((row) => row.robotName === robotName && row.specification?.cwd === cwd
        && Number.isFinite(row.created_at) && row.created_at >= startedMs && row.created_at <= observedAtMs
        && !previous.has(row.execution_id));
    assert.equal(matching.length, 1, 'Exactly one new worker execution must match this candidate, robot and project');
    const execution = matching[0];
    assert.ok(typeof execution.execution_id === 'string' && execution.execution_id.length > 0
        && typeof execution.attempt_id === 'string' && execution.attempt_id.length > 0, 'Preflight execution and attempt identities are recorded');
    assert.ok(['task', 'turn', 'continuation'].includes(execution.kind), 'Preflight evidence is an AI execution, not a terminal or discovery utility');
    assert.equal(execution.state, 'completed', 'The candidate worker execution completed');
    assert.equal(execution.end_classification, 'completed', 'The candidate worker classified the execution completed');
    let result;
    try { result = typeof execution.result === 'string' ? JSON.parse(execution.result) : execution.result; } catch { assert.fail('Preflight worker result is invalid JSON'); }
    assert.equal(result?.status, 'completed', 'The published worker result is completed');
    assert.equal(result.cleanup, 'released', 'Preflight cleanup is verified, not quarantined or unknown');
    assert.ok(typeof result.outputText === 'string' && result.outputText.trim().length > 0, 'The worker published a nonempty model answer');
    assert.ok(Array.isArray(execution.blockers) && execution.blockers.length > 0, 'Preflight resource evidence is present');
    assert.ok(execution.blockers.every((blocker) => blocker.release_state === 'released' && !blocker.retained), 'All candidate resources are released, none retained or quarantined');
    return { executionId: execution.execution_id, attemptId: execution.attempt_id, outputChars: result.outputText.length };
}

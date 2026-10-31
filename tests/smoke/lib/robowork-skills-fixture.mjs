import assert from 'node:assert/strict';

export function scopedSkillTurn(ledger, { sinceMs, cwd, sessionId }) {
    assert.ok(Number.isFinite(sinceMs), 'Skill turn starts after its conversation selection is saved');
    assert.match(sessionId || '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, 'Skill turn has a configured conversation UUID');
    assert.ok(typeof ledger.robot?.id === 'string' && ledger.robot.id.length > 0, 'Fixture worker robot identity is present');
    // Utilities are the documented read-only model/status jobs. Every other admission remains visible to the assertions.
    const executions = ledger.executions.filter((row) => row.created_at >= sinceMs && row.kind !== 'utility');
    assert.equal(executions.length, 1, 'The fresh skill conversation admitted exactly one AI turn');
    const execution = executions[0];
    assert.ok(['task', 'turn', 'continuation'].includes(execution.kind), 'Unexpected terminal or unknown work is not a skill turn');
    assert.equal(execution.robot_id, ledger.robot?.id, 'Skill turn belongs to the fixture robot');
    assert.equal(execution.specification.cwd || '', cwd || '', 'Skill turn has the exact project scope');
    assert.equal(execution.specification.sessionId, sessionId, 'Skill turn belongs to the conversation configured before sending');
    assert.equal(execution.state, 'completed', 'Skill turn completed');
    assert.equal(execution.end_classification, 'completed', 'Worker classified the skill turn completed');
    return execution;
}

export function assertAdmittedMarker(execution, { name, path }) {
    const admitted = execution.specification.skills?.filter((entry) => entry.name === name);
    assert.deepEqual(admitted, [{ name, path }], 'The worker admission includes exactly the selected marker skill source');
}

export function throwScenarioFailures(primaryError, cleanupErrors) {
    if (primaryError && !cleanupErrors.length) throw primaryError;
    if (primaryError) throw new AggregateError([primaryError, ...cleanupErrors], `Primary failure: ${primaryError.message}; cleanup also failed (${cleanupErrors.length})`, { cause: primaryError });
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Scenario cleanup failed: ${cleanupErrors.map((error) => error.message).join('; ')}`);
}

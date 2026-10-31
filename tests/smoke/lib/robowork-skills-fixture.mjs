import assert from 'node:assert/strict';
import { conversationFromSkillsURL } from './conversation-skills.mjs';
import { deleteOwnRobotAfterUtilities } from './robowork-terminal-cleanup.mjs';

export function freshSkillConversation({ previousLink, selectedLink, origin, robotId }) {
    const selected = conversationFromSkillsURL(selectedLink, origin, { robotId });
    const previous = conversationFromSkillsURL(previousLink, origin, { robotId });
    assert.notEqual(selected.sessionId, previous.sessionId, 'Sessions → New must select a fresh conversation before configuring skills');
    return { ...selected, previousSessionId: previous.sessionId };
}

export function assertNoProjectGrant(execution) {
    assert.ok(execution.specification.cwd === undefined || execution.specification.cwd === '', 'No-project worker admission has no project cwd');
    assert.ok(execution.specification.folders === undefined || (Array.isArray(execution.specification.folders) && execution.specification.folders.length === 0), 'No-project worker admission has no project folder grants');
    assert.ok(execution.specification.ignore === undefined || (Array.isArray(execution.specification.ignore) && execution.specification.ignore.length === 0), 'No-project worker admission has no project ignore paths');
}

const CHAT_DISCONNECT_GRACE_MS = 120_000; // Ploinky cli/server/handlers/webchat/runtimeState.js: STREAM_RECONNECT_GRACE_MS.
const CLI_IN_USE = 'close the robot chat and stop its CLI tasks before deleting it';
class DetachedChatStillInUse extends Error {}

export async function deleteOwnSkillRobotAfterChat({ robot, ownedNamePrefix, detachOwnChat, readLedger, removeRobot, confirmAbsent,
    record = () => {}, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    assert.match(ownedNamePrefix, /^e2e-h-[a-f0-9]{12}$/u);
    assert.equal(robot.name, ownedNamePrefix, 'Skill cleanup owns exactly the robot this scenario created');
    await detachOwnChat();
    const detachedAt = now();
    const readyAt = detachedAt + CHAT_DISCONNECT_GRACE_MS + 1000;
    const deadline = readyAt + 30_000;
    record({ detachedAt, readyAt, deadline, action: 'own WebChat navigation and normal disconnected-runtime grace' });
    while (now() < readyAt) await sleep(Math.min(1000, readyAt - now()));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        assert.ok(now() < deadline, 'Timed out waiting for the detached test chat to release its CLI usage');
        try {
            return await deleteOwnRobotAfterUtilities({
                robot, ownedNamePrefix, readLedger, confirmAbsent, record, now, sleep,
                timeoutMs: Math.min(20_000, deadline - now()),
                removeRobot: async (robotId) => {
                    const reply = await removeRobot(robotId);
                    if (reply.status === 409 && reply.payload?.error === CLI_IN_USE) {
                        record({ cliReleaseAttempt: attempt, at: now(), reply });
                        throw new DetachedChatStillInUse(CLI_IN_USE);
                    }
                    return reply;
                },
            });
        } catch (error) {
            // Only the exact local live-CLI refusal can race disposal. Canonical utility, resource and unknown-error checks remain strict.
            if (!(error instanceof DetachedChatStillInUse) || attempt === 3) throw error;
            await sleep(Math.min(1000, Math.max(0, deadline - now())));
        }
    }
}

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

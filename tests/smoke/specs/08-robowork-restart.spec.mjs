import path from 'node:path';
import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { createResidentProcessBinding } from '../lib/robowork-run-evidence.mjs';
import { resolvePloinkyExecutable } from '../lib/ploinky-executable.mjs';
import { requireAgentEvidence, collectExactAgentState } from '../lib/webtty-runtime-evidence.mjs';
import { assertObserverWindow, pauseOwnedFlow, resumeOwnedFlow } from '../lib/live-sessions-orchestration.mjs';
import { assertExecutionFile, inventory, liveRequest, nativeProcessIdentity, restartRoboWork } from '../lib/live-sessions.mjs';
import { processSelection, runtimeEvidence, attachEvidence, withFixture, startTurn } from '../lib/live-sessions-fixture.mjs';

test.describe('Planned RoboWork restart acceptance', () => {
    test.skip(process.env.SMOKE_ROBOWORK_RESTART !== '1', 'Requires the separate explicit RoboWork RA7 profile.');
    test.setTimeout(600_000);

    test('RoboWork restart pauses live flows, clears native census and resumes execution', async ({ browser }, testInfo) => {
        await withFixture(browser, testInfo, async fixture => {
            const old = await startTurn(fixture);
            const beforeWork = requireAgentEvidence(fixture.evidence, 'roboWorkAgent');
            const beforeTeam = fixture.runtime;
            await fixture.closePages();
            expect(await nativeProcessIdentity(fixture.evidence, beforeTeam, fixture.native, fixture.directoryName,
                old.selection)).toEqual(old.nativeProcess);
            await restartRoboWork({ executable: resolvePloinkyExecutable(), workspaceRoot: smokeConfig.workspaceRoot });
            await expect.poll(() => collectExactAgentState(fixture.evidence, beforeWork).present, { timeout: 60_000 }).toBe(false);
            let evidence, currentWork;
            await expect.poll(() => {
                evidence = runtimeEvidence(fixture.release);
                currentWork = requireAgentEvidence(evidence, 'roboWorkAgent');
                return currentWork.containerId !== beforeWork.containerId;
            }, { timeout: 90_000 }).toBe(true);
            expect(evidence.outerContainerId).toBe(fixture.evidence.outerContainerId);
            expect(requireAgentEvidence(evidence, 'roboTeamAgent')).toEqual(beforeTeam);
            expect(currentWork.instanceId).not.toBe(beforeWork.instanceId);
            expect(currentWork.enableGeneration).not.toBe(beforeWork.enableGeneration);
            fixture.evidence = evidence;
            fixture.residentBinding = await createResidentProcessBinding(fixture);
            await fixture.reopen();
            let interrupted;
            await expect.poll(async () => {
                interrupted = await fixture.capture({ ...old.entry.options, requirePhase: true });
                old.entry.snapshot = interrupted;
                assertObserverWindow(old.snapshot, interrupted);
                return [interrupted.flow.status, interrupted.phase.state];
            }, { timeout: 45_000 }).toEqual(['paused', 'paused']);
            expect(await nativeProcessIdentity(evidence, beforeTeam, fixture.native, fixture.directoryName,
                processSelection(fixture))).toEqual([]);

            await resumeOwnedFlow(fixture.owner, interrupted, fixture);
            let resumedCensus;
            await expect.poll(async () => {
                resumedCensus = await nativeProcessIdentity(evidence, beforeTeam, fixture.native, fixture.directoryName, processSelection(fixture));
                return resumedCensus.length;
            }, { timeout: 120_000 }).toBe(1);
            expect(resumedCensus[0].runId).not.toBe(old.nativeProcess.runId);
            expect(resumedCensus[0].sessionId).toBe(old.selection.sessionId);
            expect(resumedCensus[0].turnId).not.toBe(old.selection.turnId);
            old.entry.options = { ...old.entry.options, resumedExecution: { sessionId: old.selection.sessionId,
                previousTaskId: interrupted.execution.taskId, previousTurnId: old.selection.turnId, currentTurnId: resumedCensus[0].turnId } };
            let row;
            await expect.poll(async () => {
                const rows = (await inventory(fixture.owner)).filter(candidate => candidate.kind === 'workflow-phase'
                    && candidate.cwdDisplay === fixture.directoryName && candidate.status === 'running');
                expect(rows.length).toBeLessThanOrEqual(1);
                row = rows[0];
                return Boolean(row);
            }, { timeout: 45_000 }).toBe(true);
            expect(row).toMatchObject({ isOwner: true, ownerState: 'verified' });
            fixture.runs.push(row);
            const delivered = await liveRequest(fixture.owner, row.id, 'messages', { method: 'POST', body: { message: old.work.message } });
            expect(delivered.status(), 'RA7 uses one owner follow-up and never retries provider work').toBe(200);
            await expect.poll(() => {
                try { assertExecutionFile(path.join(fixture.cwd, old.work.secondFile), old.work.followup, old.work.second); return true; }
                catch { return false; }
            }, { timeout: 120_000 }).toBe(true);
            const resumed = await fixture.capture({ ...old.entry.options, requirePhase: true });
            old.entry.snapshot = resumed;
            expect([resumed.flow.status, resumed.phase.state, resumed.execution?.state]).toEqual(['running', 'running', 'running']);
            const resumedProcess = await nativeProcessIdentity(evidence, beforeTeam, fixture.native, fixture.directoryName,
                processSelection(fixture, 'workflow', resumed.execution.alaSessionId, resumed.execution.turns.at(-1).turnId));
            expect(resumedProcess.runId).not.toBe(old.nativeProcess.runId);
            expect(resumedProcess.native).not.toEqual(old.nativeProcess.native);
            await pauseOwnedFlow(fixture.owner, resumed, fixture);
            await expect.poll(async () => (await nativeProcessIdentity(evidence, beforeTeam, fixture.native, fixture.directoryName,
                processSelection(fixture))).length, { timeout: 45_000 }).toBe(0);
            await attachEvidence(testInfo, 'robowork-restart-observations.json', { beforeWork, currentWork, beforeTeam,
                oldNativeProcess: old.nativeProcess, interrupted, interruptedNativeCensus: [], resumed, resumedProcess,
                ownerFollowUpExecuted: old.work.second });
        });
    });
});

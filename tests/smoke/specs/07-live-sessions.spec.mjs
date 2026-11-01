import crypto from 'node:crypto';
import path from 'node:path';
import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { assertObserverWindow, pauseOwnedFlow } from '../lib/live-sessions-orchestration.mjs';
import { createResidentProcessBinding } from '../lib/robowork-run-evidence.mjs';
import { resolvePloinkyExecutable } from '../lib/ploinky-executable.mjs';
import { requireAgentEvidence, collectExactAgentState } from '../lib/webtty-runtime-evidence.mjs';
import { ROBOTEAM_BASE, LIVE_BASE, assertNoNativeRefusal, assertExecutionFile, liveRequest, inventory,
    openSse, executionText, assertOrderedFrames, openWatch, detachWatch, liveSessionsPanel,
    restartRoboTeam, nativeProcessIdentity, replayApplicationMatches } from '../lib/live-sessions.mjs';
import { createOrchestrationReader } from '../lib/live-sessions-orchestration.mjs';
import { BOT, processSelection, runtimeEvidence, configuredNative, attachEvidence, withFixture, startTurn,
    assertUnchanged, assertStopped } from '../lib/live-sessions-fixture.mjs';

test.describe('Deployed RoboTeam Live Sessions', () => {
    // A first provider refusal or feature failure must never launch another
    // native turn from the second case. A skipped remainder cannot pass ledger.
    test.describe.configure({ mode: 'serial' });
    test.skip(process.env.SMOKE_LIVE_SESSIONS !== '1', 'Requires the fresh-live-sessions profile and real native provider.');
    test.setTimeout(600_000);

    test('RoboTeam Live Sessions preserve owner controls, observer replay, and private scope', async ({ browser }, testInfo) => {
        await withFixture(browser, testInfo, async fixture => {
            const turn = await startTurn(fixture);
            const { owner, admin, foreign } = fixture;
            const adminRow = (await inventory(admin)).find(row => row.id === turn.row.id);
            expect(adminRow).toMatchObject({ isOwner: false, ownerState: 'verified', capabilities: { message: false, stop: true } });
            expect((await inventory(foreign)).some(row => row.id === turn.row.id)).toBe(false);
            const negative = [];
            for (const action of ['stream', 'messages', 'stop', 'transcript']) {
                const response = await liveRequest(foreign, turn.row.id, action, {
                    method: ['messages', 'stop'].includes(action) ? 'POST' : 'GET',
                    ...(['messages', 'stop'].includes(action) ? { body: action === 'messages' ? { message: 'forbidden' } : {} } : {}),
                });
                expect(response.status()).toBe(404);
                expect(await response.text()).toMatch(/live session not found/i);
                negative.push({ action, status: response.status() });
            }
            const nonexistent = await liveRequest(owner, `absent_${turn.work.id.replaceAll('-', '')}`, 'transcript');
            expect(nonexistent.status()).toBe(404);
            const denied = await liveRequest(admin, turn.row.id, 'messages', { method: 'POST', body: { message: 'forbidden' } });
            expect(denied.status()).toBe(403);
            expect(await denied.text()).toMatch(/only the owner can message/i);
            const foreignView = await foreign.request.get(turn.row.viewUrl, { maxRedirects: 0 });
            expect(foreignView.status()).toBe(404);
            expect(await foreignView.text()).toMatch(/live session not found/i);
            for (const body of [{ message: '' }, { message: '   ' }, { message: 'x'.repeat(32769) }]) {
                const refused = await liveRequest(owner, turn.row.id, 'messages', { method: 'POST', body });
                expect(refused.status()).toBe(400);
            }
            const malformed = await liveRequest(owner, turn.row.id, 'messages', { method: 'POST', raw: '{' });
            expect(malformed.status()).toBe(400);
            await assertUnchanged(fixture, turn, { ownerProof: false });
            expect(messageAcceptances(turn.reader.frames)).toHaveLength(0);

            const ownerWatch = await openWatch(owner, turn.row.id);
            const adminWatch = await openWatch(admin, turn.row.id);
            await expect(ownerWatch.output).toContainText(turn.work.first);
            await expect(adminWatch.output).toContainText(turn.work.first);
            await expect(ownerWatch.form).toBeVisible();
            await expect(adminWatch.form).toBeHidden();
            await expect.poll(async () => (await inventory(owner)).find(row => row.id === turn.row.id)?.viewerCount).toBe(3);
            await assertUnchanged(fixture, turn, { ownerProof: false });

            assertOrderedFrames(turn.reader.frames);
            const cursor = Number(turn.reader.frames.filter(frame => frame.event === 'output').at(-1).id);
            const cursorReader = await openSse(owner.context(), smokeConfig.baseURL, turn.row.id, { cursor });
            fixture.readers.push(cursorReader);
            const deliveryResponse = owner.waitForResponse(response => new URL(response.url()).pathname === `${LIVE_BASE}/${turn.row.id}/messages`
                && response.request().method() === 'POST');
            await ownerWatch.form.locator('textarea').fill(turn.work.message);
            await ownerWatch.form.getByRole('button', { name: 'Send message', exact: true }).click();
            const delivered = await deliveryResponse;
            expect(delivered.status(), 'delivery_unknown/refusal fails immediately and is never retried').toBe(200);
            expect(await delivered.json()).toMatchObject({ delivery: expect.stringMatching(/^(delivered|queued)$/) });
            await expect.poll(async () => {
                turn.reader.check(); cursorReader.check();
                assertNoNativeRefusal(await turn.chat.locator(BOT).allTextContents());
                return executionText(turn.reader.frames);
            }, { timeout: nativeTimeout }).toContain(turn.work.second);
            assertExecutionFile(path.join(smokeConfig.workspaceRoot, fixture.directoryName, turn.work.secondFile), turn.work.followup, turn.work.second);
            await expect(ownerWatch.output).toContainText(turn.work.second);
            await expect(adminWatch.output).toContainText(turn.work.second);
            await expect.poll(() => executionText(cursorReader.frames), { timeout: 15_000 }).toContain(turn.work.second);
            expect(cursorReader.frames.filter(frame => frame.event === 'output').every(frame => Number(frame.id) > cursor)).toBe(true);
            expect(executionText(cursorReader.frames)).not.toContain(turn.work.first);
            assertOrderedFrames(cursorReader.frames);
            await assertUnchanged(fixture, turn, { ownerProof: true });
            expect(messageAcceptances(turn.reader.frames), 'exactly one actual workflow native acceptance').toHaveLength(1);
            for (const watched of [ownerWatch, adminWatch]) {
                expect(await watched.output.locator('img, script, [data-ls-canary]').count()).toBe(0);
            }
            expect(await owner.evaluate(() => globalThis.__lsExecuted)).toBeUndefined();
            expect(await admin.evaluate(() => globalThis.__lsExecuted)).toBeUndefined();
            // The output renders in the Live Sessions page frame, so a script that ran there sets its global, not the shell's.
            for (const watched of [ownerWatch, adminWatch]) {
                expect(await watched.output.evaluate(element => element.ownerDocument.defaultView.__lsExecuted),
                    'rendered output must not execute in the Live Sessions page frame').toBeUndefined();
            }

            await detachWatch(owner);
            await expect.poll(async () => (await inventory(admin)).find(row => row.id === turn.row.id)?.viewerCount).toBe(3);
            await expect(adminWatch.output).toContainText(turn.work.second);
            expect((await inventory(admin)).find(row => row.id === turn.row.id)?.status).toBe('running');
            await assertUnchanged(fixture, turn, { ownerProof: true });
            const reopened = await openWatch(owner, turn.row.id);
            await expect.poll(async () => {
                turn.reader.check();
                const reference = turn.reader.frames.slice();
                const applied = await reopened.output.locator(':scope > span').evaluateAll(spans => spans.map(span => ({
                    text: span.textContent || '', style: span.className.replace(/^live-session-/, ''),
                })));
                return replayApplicationMatches(reference, applied);
            }, { timeout: 15_000, message: 'reopened Watch must apply each independent SSE output event once, in order' }).toBe(true);
            const replay = executionText(turn.reader.frames);
            expect(replay.indexOf(turn.work.first)).toBeGreaterThanOrEqual(0);
            expect(replay.indexOf(turn.work.first)).toBeLessThan(replay.indexOf(turn.work.second));
            const popupPromise = admin.context().waitForEvent('page');
            await adminWatch.content.locator(`[data-session-id="${LIVE_BASE}:${turn.row.id}"][data-session-action="pop-out"]`).click();
            const standalone = await popupPromise;
            await standalone.waitForURL(new URL(turn.row.viewUrl, smokeConfig.baseURL).href);
            expect(await standalone.evaluate(() => window.opener)).toBeNull();
            await expect(standalone.locator('#output')).toContainText(turn.work.second);
            expect(await standalone.locator('#output img, #output script, #output [data-ls-canary]').count()).toBe(0);
            expect(await standalone.evaluate(() => globalThis.__lsExecuted)).toBeUndefined();
            for (const badCursor of ['malformed', '999999999999999']) {
                const resync = await openSse(owner.context(), smokeConfig.baseURL, turn.row.id, { cursor: badCursor });
                fixture.readers.push(resync);
                await expect.poll(() => { resync.check(); return resync.frames[0]?.event; }).toBe('resync');
                await expect.poll(() => executionText(resync.frames)).toContain(turn.work.second);
                await resync.close();
                fixture.readers.splice(fixture.readers.indexOf(resync), 1);
            }
            await assertUnchanged(fixture, turn, { ownerProof: true });
            await assertStopped(fixture, turn, admin);
            expect(messageAcceptances(turn.reader.frames)).toHaveLength(1);
            await attachEvidence(testInfo, 'live-session-observations.json', { id: turn.row.id, negative,
                ownerState: turn.row.ownerState, initialMarker: turn.work.first, ownerExecutionMarker: turn.work.second,
                receiptOnlyInsufficient: true, initialCursor: cursor, observerAddedExecutions: 0,
                coverage: { copilotTurn: 'launch/publication/authorization/native identity', workflowPhase: 'owner controls/observers/replay/pause/transcript' },
                front: turn.front, orchestration: turn.snapshot, paused: turn.entry.snapshot,
                nativeProcess: turn.nativeProcess, frames: turn.reader.frames, cursorFrames: cursorReader.frames });
        });
    });

    test('RoboTeam restart retires old Live Sessions and admits a newly verified run', async ({ browser }, testInfo) => {
        await withFixture(browser, testInfo, async fixture => {
            const old = await startTurn(fixture);
            const oldRows = await inventory(fixture.admin);
            const oldIds = oldRows.map(row => row.id);
            expect(oldIds).toContain(old.row.id);
            await openWatch(fixture.admin, old.row.id);
            const oldRuntime = fixture.runtime;
            await assertUnchanged(fixture, old);
            await fixture.closePages();
            expect(await nativeProcessIdentity(fixture.evidence, oldRuntime, fixture.native, fixture.directoryName, old.selection)).toEqual(old.nativeProcess);
            await restartRoboTeam({ executable: resolvePloinkyExecutable(), workspaceRoot: smokeConfig.workspaceRoot });
            await expect.poll(() => collectExactAgentState(fixture.evidence, oldRuntime).present,
                { timeout: 60_000 }).toBe(false);
            let replacementEvidence, replacement;
            await expect.poll(() => {
                replacementEvidence = runtimeEvidence(fixture.release);
                replacement = requireAgentEvidence(replacementEvidence, 'roboTeamAgent');
                return replacement.containerId !== oldRuntime.containerId;
            }, { timeout: 90_000 }).toBe(true);
            expect(replacementEvidence.outerContainerId).toBe(fixture.evidence.outerContainerId);
            expect(replacement.instanceId).not.toBe(oldRuntime.instanceId);
            expect(replacement.enableGeneration).not.toBe(oldRuntime.enableGeneration);
            Object.assign(fixture, { evidence: replacementEvidence, runtime: replacement });
            fixture.capture = await createOrchestrationReader(fixture);
            fixture.residentBinding = await createResidentProcessBinding(fixture);
            await fixture.reopen();
            expect(await configuredNative(fixture.admin, fixture.release, replacement, { initial: false })).toEqual(fixture.native);
            const health = await fixture.admin.request.get(`${ROBOTEAM_BASE}/status`);
            expect(health.status()).toBe(200);
            expect(await health.json()).toMatchObject({ ok: true, service: 'RoboTeamAgent' });
            expect((await inventory(fixture.admin)).some(row => oldIds.includes(row.id))).toBe(false);
            fixture.retainedProofs = [old.nativeProcess];
            const continued = await fixture.capture({ ...old.entry.options, requirePhase: true });
            assertObserverWindow(old.snapshot, continued);
            expect([continued.flow.status, continued.phase.state]).toEqual(['running', 'running']);
            old.entry.snapshot = continued;
            const continuedProcess = await nativeProcessIdentity(fixture.evidence, replacement, fixture.native, fixture.directoryName,
                processSelection(fixture, 'workflow', old.selection.sessionId, old.selection.turnId));
            expect(continuedProcess.runId).toBe(old.nativeProcess.runId);
            expect(continuedProcess.residentRecord).toEqual(old.nativeProcess.residentRecord);
            expect(continuedProcess.native).toEqual(old.nativeProcess.native);
            expect(continuedProcess.controller.attachRun).toBe(old.nativeProcess.runId);
            const continuedCensus = await nativeProcessIdentity(fixture.evidence, replacement, fixture.native, fixture.directoryName,
                processSelection(fixture));
            expect(continuedCensus).toHaveLength(1);
            expect(continuedCensus[0].runId).toBe(old.nativeProcess.runId);
            for (const id of oldIds) {
                for (const action of ['stream', 'messages', 'stop', 'transcript']) {
                    const response = await liveRequest(fixture.owner, id, action, {
                        method: ['messages', 'stop'].includes(action) ? 'POST' : 'GET',
                        ...(['messages', 'stop'].includes(action) ? { body: action === 'messages' ? { message: 'retired-run-probe' } : {} } : {}),
                    });
                    expect(response.status()).toBe(404);
                }
                expect((await fixture.owner.request.get(oldRows.find(row => row.id === id).viewUrl, { maxRedirects: 0 })).status()).toBe(404);
            }
            await pauseOwnedFlow(fixture.owner, continued, fixture);
            await expect.poll(async () => {
                old.entry.snapshot = await fixture.capture({ ...old.entry.options, requirePhase: true });
                return [old.entry.snapshot.flow.status, old.entry.snapshot.phase.state];
            }, { timeout: 45_000 }).toEqual(['paused', 'paused']);
            await expect.poll(async () => (await nativeProcessIdentity(fixture.evidence, replacement, fixture.native,
                fixture.directoryName, processSelection(fixture))).length, { timeout: 45_000 }).toBe(0);
            const fresh = await startTurn(fixture, { replacement: true });
            expect(oldIds).not.toContain(fresh.row.id);
            const watch = await openWatch(fixture.owner, fresh.row.id);
            await expect(watch.output).toContainText(fresh.work.first);
            await assertStopped(fixture, fresh, fixture.owner);
            await attachEvidence(testInfo, 'restart-observations.json', { oldRuntime, replacement,
                outerContainerId: replacementEvidence.outerContainerId, imageDigest: fixture.release.imageDigest,
                oldIds, newId: fresh.row.id, newOwnerState: fresh.row.ownerState,
                oldOwnedFlowAfterRestart: continued, oldFront: old.front, newFront: fresh.front,
                nativeExecutableUnchanged: true, oldNativeProcess: old.nativeProcess,
                continuedProcess, continuedCensus, explicitlyPaused: old.entry.snapshot,
                newNativeProcess: fresh.nativeProcess, newFrames: fresh.reader.frames });
        });
    });
});

function messageAcceptances(frames) {
    return [...executionText(frames).matchAll(/\nMessage [0-9a-f-]{36}: (?:delivered|queued)\n/g)].map(match => match[0]);
}

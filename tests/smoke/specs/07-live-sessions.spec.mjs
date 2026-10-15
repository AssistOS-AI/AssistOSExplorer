import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { test, expect, attachPageDiagnostics } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { readAuthenticatedPrincipal } from '../lib/auth.mjs';
import { openExplorer } from '../lib/explorer.mjs';
import { createDirectory, deleteDirectoryIfPresent, openCopilotForDirectory } from '../lib/copilot.mjs';
import { setComposer, waitForWebchatIdle } from '../lib/webchat.mjs';
import { resolvePloinkyExecutable } from '../lib/ploinky-executable.mjs';
import { collectWebttyRuntimeEvidence, requireAgentEvidence, collectExactAgentState,
    collectAgentProcessRows } from '../lib/webtty-runtime-evidence.mjs';
import { findSecretLeaks } from '../lib/security.mjs';
import { redactTraceText, findTraceCredentialResidue } from '../lib/redacted-trace.mjs';
import { ROBOTEAM_BASE, LIVE_BASE, ENDED, foreignAccount, assertLivePrincipals, assertNoNativeRefusal,
    workload, assertExecutionFile, openSse, executionText, assertOrderedFrames, liveRequest, inventory,
    discoverSource, openWatch, detachWatch, validateNativeEvidence, verifyNativeExecutable,
    activeTurnProcesses, restartRoboTeam, observeFinitePageWork, nativeProcessIdentity,
    replayApplicationMatches } from '../lib/live-sessions.mjs';

const BOT = '#chatList > .wa-message.in:not(.wa-typing):not(.wa-task-item) .wa-message-bubble';
const nativeTimeout = 120_000;

function releaseBinding() {
    const release = JSON.parse(process.env.SMOKE_COPILOT_RELEASE_EVIDENCE || 'null');
    assert.equal(release?.applicationBaseURL, smokeConfig.baseURL);
    assert.equal(release?.boxBaseURL, smokeConfig.baseURL);
    assert.equal(release?.liveBox?.box?.imageId, release?.imageDigest);
    assert.match(release.imageDigest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(path.isAbsolute(smokeConfig.workspaceRoot));
    const executable = resolvePloinkyExecutable();
    assert.equal(fs.realpathSync(executable), fs.realpathSync(path.join(release.ploinkySource.path, 'bin/ploinky')));
    return release;
}

function runtimeEvidence(release) {
    return collectWebttyRuntimeEvidence({
        baseURL: smokeConfig.baseURL, boxBaseURL: smokeConfig.baseURL,
        workspaceRoot: smokeConfig.workspaceRoot, selectedDirectory: smokeConfig.workspaceRoot,
        expectedContainerName: release.liveBox.box.containerName, expectedImageId: release.imageDigest,
        expectedImageRef: release.liveBox.box.imageRef, expectedPloinkySource: release.ploinkySource.path,
        requireFreshImage: false,
    });
}

async function configuredNative(admin, release, runtime, { initial = true } = {}) {
    const evidencePath = process.env.SMOKE_LIVE_SESSIONS_NATIVE_EVIDENCE;
    assert.ok(evidencePath && path.isAbsolute(evidencePath));
    const stat = fs.lstatSync(evidencePath);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 128 * 1024);
    const record = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const robotsResponse = await admin.request.get(`${ROBOTEAM_BASE}/api/robots`, { maxRedirects: 0 });
    expect(robotsResponse.status()).toBe(200);
    const robots = await robotsResponse.json();
    expect(robots).toMatchObject({ ok: true, canAdmin: true });
    const defaults = robots.robots.filter(robot => robot.name === 'default');
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toMatch(/^[a-z0-9][a-z0-9-]{2,63}$/);
    expect(record.robotId).toBe(defaults[0].id);
    const response = await admin.request.get(`${ROBOTEAM_BASE}/api/robots/${defaults[0].id}/coding-agents`, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    const config = await response.json();
    expect(config.ok).toBe(true);
    const native = validateNativeEvidence(record, { release, runtime, workspaceRoot: smokeConfig.workspaceRoot, config, initial });
    await verifyNativeExecutable(runtimeEvidence(release), runtime, native);
    return native;
}

async function attachEvidence(testInfo, name, value) {
    const text = JSON.stringify(value, null, 2);
    expect(findSecretLeaks(text), 'public evidence must contain no private input value').toEqual([]);
    const redacted = redactTraceText(text);
    expect(findTraceCredentialResidue(redacted), 'public evidence must contain no credential residue').toEqual([]);
    await testInfo.attach(name, { body: Buffer.from(redacted), contentType: 'application/json' });
}

async function withFixture(browser, testInfo, operation) {
    const release = releaseBinding();
    const contexts = [], diagnostics = [], readers = [], runs = [], chats = [], markers = [];
    let owner, admin, foreign, directoryPath;
    let primaryFailure;
    const cleanupErrors = [];
    const attempt = async action => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
    async function accountPage(account, label) {
        const context = await browser.newContext({ baseURL: smokeConfig.baseURL, ignoreHTTPSErrors: true });
        contexts.push(context);
        context.on('page', page => diagnostics.push({ page, finite: observeFinitePageWork(page),
            controller: attachPageDiagnostics(page, testInfo, `${label}-${diagnostics.length}`) }));
        const page = await context.newPage();
        await openExplorer(page, { account });
        return page;
    }
    const fixture = { release, readers, runs, chats, markers,
        async reopen() {
            admin = await accountPage(smokeConfig.primaryUser, 'admin-reopened');
            owner = await accountPage(smokeConfig.secondaryUser, 'owner-reopened');
            fixture.admin = admin; fixture.owner = owner;
            assertLivePrincipals(await readAuthenticatedPrincipal(admin, smokeConfig.primaryUser),
                await readAuthenticatedPrincipal(owner, smokeConfig.secondaryUser), fixture.foreignPrincipal);
            await discoverSource(owner);
        },
        async closePages() {
            for (const reader of readers.splice(0)) await reader.close();
            for (const { page, finite } of diagnostics) {
                if (page.isClosed()) continue;
                await detachWatch(page);
                await finite.settle();
                // Closing all pages removes modal pollers, WebChat EventSources,
                // and observer readers before the service is replaced.
                await page.close({ runBeforeUnload: false });
            }
            for (const { controller } of diagnostics) expect(controller.actionableEvents()).toEqual([]);
        },
    };
    try {
        admin = await accountPage(smokeConfig.primaryUser, 'admin');
        owner = await accountPage(smokeConfig.secondaryUser, 'owner');
        foreign = await accountPage(foreignAccount(), 'foreign');
        const principals = await Promise.all([
            readAuthenticatedPrincipal(admin, smokeConfig.primaryUser), readAuthenticatedPrincipal(owner, smokeConfig.secondaryUser),
            readAuthenticatedPrincipal(foreign, foreignAccount()),
        ]);
        assertLivePrincipals(...principals);
        fixture.foreignPrincipal = principals[2];
        await Promise.all([discoverSource(admin), discoverSource(owner), discoverSource(foreign)]);
        const evidence = runtimeEvidence(release);
        const runtime = requireAgentEvidence(evidence, 'roboTeamAgent');
        const native = await configuredNative(admin, release, runtime);
        const directoryName = `live-sessions-${smokeConfig.runId}-${testInfo.testId.replace(/[^A-Za-z0-9]/g, '').slice(-16)}`;
        directoryPath = `/${directoryName}`;
        await createDirectory(owner, directoryName, directoryPath);
        Object.assign(fixture, { admin, owner, foreign, principals, evidence, runtime, native, directoryName, directoryPath });
        await attachEvidence(testInfo, 'native-prerequisite.json', { native, runtime, sourceGraph: release.repositories,
            outerContainerId: release.liveBox.box.containerId, imageDigest: release.imageDigest });
        await operation(fixture);
    } catch (error) {
        primaryFailure = error;
        throw error;
    } finally {
        for (const reader of readers.splice(0)) await attempt(() => reader.close());
        if (markers.length) await attempt(async () => {
            if (!admin || admin.isClosed()) admin = await accountPage(smokeConfig.primaryUser, 'admin-recovery-cleanup');
            for (const row of await inventory(admin)) {
                if (markers.some(marker => row.title.includes(marker)) && !runs.some(run => run.id === row.id)) runs.push(row);
            }
        });
        for (const run of runs) {
            await attempt(async () => {
                if (!admin || admin.isClosed()) {
                    admin = await accountPage(smokeConfig.primaryUser, 'admin-cleanup');
                }
                const current = (await inventory(admin)).find(row => row.id === run.id);
                if (current && !ENDED.includes(current.status)) {
                    const stopped = await liveRequest(admin, run.id, 'stop', { method: 'POST', body: {} });
                    expect(stopped.status()).toBe(200);
                    await expect.poll(async () => (await inventory(admin)).find(row => row.id === run.id)?.status,
                        { timeout: 45_000 }).toMatch(/^(stopped|finished|failed|lost)$/);
                }
            });
        }
        for (const { page } of diagnostics) if (!page.isClosed()) await attempt(() => detachWatch(page));
        for (const chat of chats) if (!chat.isClosed()) await attempt(async () => {
            await diagnostics.find(entry => entry.page === chat).finite.settle();
            await chat.close();
        });
        if (admin && !admin.isClosed()) await attempt(async () => {
            await expect.poll(async () => (await inventory(admin)).filter(row => runs.some(run => run.id === row.id))
                .every(row => ENDED.includes(row.status) && row.viewerCount === 0), { timeout: 30_000 }).toBe(true);
            const evidence = runtimeEvidence(release);
            const runtime = requireAgentEvidence(evidence, 'roboTeamAgent');
            await expect.poll(() => activeTurnProcesses(collectAgentProcessRows(evidence, runtime)).length,
                { timeout: 45_000 }).toBe(0);
        });
        if (directoryPath) await attempt(async () => {
            if (!owner || owner.isClosed()) owner = await accountPage(smokeConfig.secondaryUser, 'owner-cleanup');
            await deleteDirectoryIfPresent(owner, directoryPath);
        });
        for (const { page, finite } of diagnostics) if (!page.isClosed()) await attempt(async () => {
            await finite.settle();
            await page.close();
        });
        for (const context of contexts) await attempt(() => context.close());
        for (const { controller } of diagnostics) await attempt(async () => {
            await controller.flush();
            expect(controller.actionableEvents(), 'all observed browser pages retain strict diagnostics').toEqual([]);
        });
        if (cleanupErrors.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors],
            'Live Sessions cleanup/diagnostics failed; preserve the original failure and all cleanup failures.');
    }
}

async function startTurn(fixture, { replacement = false } = {}) {
    const { owner, directoryPath } = fixture;
    const work = workload();
    fixture.markers.push(work.id);
    const before = await inventory(owner);
    const chat = await openCopilotForDirectory(owner, directoryPath);
    fixture.chats.push(chat);
    await waitForWebchatIdle(chat);
    assertNoNativeRefusal(await chat.locator(BOT).allTextContents());
    const inputResponse = chat.waitForResponse(response => new URL(response.url()).pathname === '/webchat/input'
        && response.request().method() === 'POST' && (response.request().postData() || '').includes(work.id));
    await setComposer(chat, work.prompt);
    await chat.locator('#send').click();
    expect((await inputResponse).status()).toBe(204);
    let row;
    await expect.poll(async () => {
        assertNoNativeRefusal(await chat.locator(BOT).allTextContents());
        const rows = (await inventory(owner)).filter(candidate => candidate.kind === 'copilot-turn'
            && candidate.title.includes(work.id) && !before.some(old => old.id === candidate.id));
        expect(rows.length).toBeLessThanOrEqual(1);
        row = rows[0];
        return Boolean(row);
    }, { timeout: nativeTimeout, intervals: [250, 500, 1000] }).toBe(true);
    fixture.runs.push(row);
    expect(row).toMatchObject({ isOwner: true, ownerState: 'verified', status: 'running',
        capabilities: { watch: true, input: false, stop: true, message: true }, attach: { mode: 'event-stream' } });
    expect(row.cwdDisplay.endsWith(`/${fixture.directoryName}`)).toBe(true);
    const reader = await openSse(owner.context(), smokeConfig.baseURL, row.id);
    fixture.readers.push(reader);
    await expect.poll(async () => {
        reader.check();
        assertNoNativeRefusal(await chat.locator(BOT).allTextContents());
        if (ENDED.includes((await inventory(owner)).find(candidate => candidate.id === row.id)?.status)) {
            throw new Error('Native turn ended before active execution proof; no fallback or retry is permitted.');
        }
        return executionText(reader.frames);
    }, { timeout: nativeTimeout, intervals: [250, 500, 1000] }).toContain(work.first);
    assertExecutionFile(path.join(smokeConfig.workspaceRoot, fixture.directoryName, work.firstFile), work.initial, work.first);
    const processes = activeTurnProcesses(collectAgentProcessRows(fixture.evidence, fixture.runtime));
    expect(processes, 'one actual ALA native turn must be active before observer/restart checks').toHaveLength(1);
    expect(processes[0]).toContain(fixture.directoryName);
    const nativeProcess = await nativeProcessIdentity(fixture.evidence, fixture.runtime, fixture.native, fixture.directoryName);
    return { row, reader, work, chat, processes, nativeProcess, replacement };
}

async function assertStopped(fixture, turn, observer) {
    const stopResponse = observer.waitForResponse(response => new URL(response.url()).pathname === `${LIVE_BASE}/${turn.row.id}/stop`
        && response.request().method() === 'POST');
    const key = `${LIVE_BASE}:${turn.row.id}`;
    const panel = observer.getByRole('dialog', { name: 'Live Sessions', exact: true });
    await panel.locator(`[data-session-id="${key}"][data-session-action="kill"]`).click();
    await panel.locator(`[data-session-id="${key}"][data-session-action="confirm-kill"]`).click();
    expect((await stopResponse).status()).toBe(200);
    await expect.poll(() => {
        turn.reader.check();
        return turn.reader.frames.filter(frame => frame.event === 'exit').map(frame => frame.data.status);
    }, { timeout: 45_000 }).toEqual(['stopped']);
    await expect.poll(() => activeTurnProcesses(collectAgentProcessRows(fixture.evidence, fixture.runtime)).length,
        { timeout: 45_000 }).toBe(0);
    const again = await liveRequest(fixture.owner, turn.row.id, 'stop', { method: 'POST', body: {} });
    expect(again.status()).toBe(409);
    const transcript = await liveRequest(fixture.owner, turn.row.id, 'transcript');
    expect(transcript.status()).toBe(200);
    expect(transcript.headers()['content-type']).toMatch(/^text\/plain/);
    expect(transcript.headers()['x-content-type-options']).toBe('nosniff');
    const text = await transcript.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(text).toContain(turn.work.first);
}

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
            expect(turn.reader.frames.filter(frame => frame.event === 'output' && frame.data.style === 'user')).toHaveLength(0);

            const ownerWatch = await openWatch(owner, turn.row.id);
            const adminWatch = await openWatch(admin, turn.row.id);
            await expect(ownerWatch.output).toContainText(turn.work.first);
            await expect(adminWatch.output).toContainText(turn.work.first);
            await expect(ownerWatch.form).toBeVisible();
            await expect(adminWatch.form).toBeHidden();
            await expect.poll(async () => (await inventory(owner)).find(row => row.id === turn.row.id)?.viewerCount).toBe(3);
            expect(activeTurnProcesses(collectAgentProcessRows(fixture.evidence, fixture.runtime))).toEqual(turn.processes);
            expect(await nativeProcessIdentity(fixture.evidence, fixture.runtime, fixture.native, fixture.directoryName)).toEqual(turn.nativeProcess);

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
            for (const watched of [ownerWatch, adminWatch]) {
                expect(await watched.output.locator('img, script, [data-ls-canary]').count()).toBe(0);
            }
            expect(await owner.evaluate(() => globalThis.__lsExecuted)).toBeUndefined();
            expect(await admin.evaluate(() => globalThis.__lsExecuted)).toBeUndefined();

            await detachWatch(owner);
            await expect.poll(async () => (await inventory(admin)).find(row => row.id === turn.row.id)?.viewerCount).toBe(3);
            await expect(adminWatch.output).toContainText(turn.work.second);
            expect((await inventory(admin)).find(row => row.id === turn.row.id)?.status).toBe('running');
            expect(activeTurnProcesses(collectAgentProcessRows(fixture.evidence, fixture.runtime))).toEqual(turn.processes);
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
            await adminWatch.dialog.locator(`[data-session-id="${LIVE_BASE}:${turn.row.id}"][data-session-action="pop-out"]`).click();
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
            expect(activeTurnProcesses(collectAgentProcessRows(fixture.evidence, fixture.runtime))).toEqual(turn.processes);
            await assertStopped(fixture, turn, admin);
            expect(turn.reader.frames.filter(frame => frame.event === 'output' && frame.data.style === 'user')).toHaveLength(1);
            await attachEvidence(testInfo, 'live-session-observations.json', { id: turn.row.id, negative,
                ownerState: turn.row.ownerState, initialMarker: turn.work.first, ownerExecutionMarker: turn.work.second,
                receiptOnlyInsufficient: true, initialCursor: cursor, observerAddedExecutions: 0,
                nativeProcess: turn.nativeProcess, frames: turn.reader.frames, cursorFrames: cursorReader.frames });
        });
    });

    test('RoboTeam restart retires old Live Sessions and admits a newly verified run', async ({ browser }, testInfo) => {
        await withFixture(browser, testInfo, async fixture => {
            const old = await startTurn(fixture);
            const oldIds = (await inventory(fixture.admin)).map(row => row.id);
            expect(oldIds).toContain(old.row.id);
            await openWatch(fixture.admin, old.row.id);
            const oldRuntime = fixture.runtime;
            await fixture.closePages();
            expect(activeTurnProcesses(collectAgentProcessRows(fixture.evidence, oldRuntime))).toEqual(old.processes);
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
            Object.assign(fixture, { evidence: replacementEvidence, runtime: replacement });
            await fixture.reopen();
            expect(await configuredNative(fixture.admin, fixture.release, replacement, { initial: false })).toEqual(fixture.native);
            const health = await fixture.admin.request.get(`${ROBOTEAM_BASE}/status`);
            expect(health.status()).toBe(200);
            expect(await health.json()).toMatchObject({ ok: true, service: 'RoboTeamAgent' });
            expect((await inventory(fixture.admin)).some(row => oldIds.includes(row.id))).toBe(false);
            for (const id of oldIds) {
                for (const action of ['stream', 'messages', 'stop', 'transcript']) {
                    const response = await liveRequest(fixture.owner, id, action, {
                        method: ['messages', 'stop'].includes(action) ? 'POST' : 'GET',
                        ...(['messages', 'stop'].includes(action) ? { body: action === 'messages' ? { message: 'retired-run-probe' } : {} } : {}),
                    });
                    expect(response.status()).toBe(404);
                }
            }
            const fresh = await startTurn(fixture, { replacement: true });
            expect(oldIds).not.toContain(fresh.row.id);
            const watch = await openWatch(fixture.owner, fresh.row.id);
            await expect(watch.output).toContainText(fresh.work.first);
            await assertStopped(fixture, fresh, fixture.owner);
            await attachEvidence(testInfo, 'restart-observations.json', { oldRuntime, replacement,
                outerContainerId: replacementEvidence.outerContainerId, imageDigest: fixture.release.imageDigest,
                oldIds, newId: fresh.row.id, newOwnerState: fresh.row.ownerState,
                nativeExecutableUnchanged: true, oldNativeProcess: old.nativeProcess,
                newNativeProcess: fresh.nativeProcess, newFrames: fresh.reader.frames });
        });
    });
});

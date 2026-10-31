import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { test, expect, attachPageDiagnostics } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { readAuthenticatedPrincipal } from '../lib/auth.mjs';
import { openExplorer } from '../lib/explorer.mjs';
import { createDirectory, deleteDirectoryIfPresent, openCopilotForDirectory } from '../lib/copilot.mjs';
import { setComposer, waitForWebchatIdle } from '../lib/webchat.mjs';
import { conversationFromSkillsURL } from '../lib/conversation-skills.mjs';
import { createLiveSessionFinalizer } from '../lib/live-sessions-diagnostics.mjs';
import { createOrchestrationReader, assertObserverWindow, terminateOwnedFlow, assertOwnedSettlement } from '../lib/live-sessions-orchestration.mjs';
import { resolvePloinkyExecutable } from '../lib/ploinky-executable.mjs';
import { collectWebttyRuntimeEvidence, requireAgentEvidence, collectExactAgentState } from '../lib/webtty-runtime-evidence.mjs';
import { findSecretLeaks } from '../lib/security.mjs';
import { redactTraceText, findTraceCredentialResidue } from '../lib/redacted-trace.mjs';
import { ROBOTEAM_BASE, LIVE_BASE, ENDED, foreignAccount, assertLivePrincipals, assertNoNativeRefusal,
    workload, assertExecutionFile, openSse, executionText, assertOrderedFrames, liveRequest, inventory,
    discoverSource, openWatch, detachWatch, detachWatchIfShown, liveSessionsPanel, validateNativeEvidence, verifyNativeExecutable,
    restartRoboTeam, observeFinitePageWork, nativeProcessIdentity,
    replayApplicationMatches } from '../lib/live-sessions.mjs';

const BOT = '#chatList > .wa-message.in:not(.wa-typing):not(.wa-task-item) .wa-message-bubble';
const nativeTimeout = 120_000;

function processSelection(fixture, kind = 'census', sessionId, turnId) {
    return { kind, codeRoot: '/code', workflowCodeRoot: path.posix.join(fixture.release.repositories.explorer.repositoryPath, 'roboTeamAgent'),
        alaBinding: fixture.capture.alaBinding,
        ...(sessionId ? { sessionId, turnId } : {}) };
}

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
    return { ...native, robotId: record.robotId };
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
    const contexts = [], diagnostics = [], readers = [], runs = [], chats = [], owned = [];
    let owner, admin, foreign, directoryPath;
    let primaryFailure, hasPrimary = false;
    const finalizer = createLiveSessionFinalizer();
    let cleanupIndex = 0, settled = false;
    const attempt = (label, action) => finalizer.required(label, action);
    async function accountPage(account, label) {
        const context = await browser.newContext({ baseURL: smokeConfig.baseURL, ignoreHTTPSErrors: true });
        contexts.push(context);
        context.on('page', page => diagnostics.push({ page, finite: observeFinitePageWork(page),
            controller: attachPageDiagnostics(page, testInfo, `${label}-${diagnostics.length}`) }));
        const page = await context.newPage();
        await openExplorer(page, { account });
        return page;
    }
    const fixture = { release, readers, runs, chats, owned, testInfo,
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
                await detachWatchIfShown(page);
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
        Object.assign(fixture, { admin, owner, foreign, principals, evidence, runtime, native, robotId: native.robotId, directoryName, directoryPath });
        fixture.cwd = path.join(smokeConfig.workspaceRoot, directoryName);
        fixture.ownerPrincipal = `user:${principals[1].canonicalId}`;
        fixture.capture = await createOrchestrationReader(fixture);
        await attachEvidence(testInfo, 'native-prerequisite.json', { native, runtime, sourceGraph: release.repositories,
            outerContainerId: release.liveBox.box.containerId, imageDigest: release.imageDigest });
        await operation(fixture);
    } catch (error) {
        primaryFailure = error;
        hasPrimary = true;
    } finally {
        for (const reader of readers.splice(0)) await attempt(`close reader ${++cleanupIndex}`, () => reader.close());
        for (const { page } of diagnostics) if (!page.isClosed()) await attempt(`detach viewer ${++cleanupIndex}`, () => detachWatchIfShown(page));
        for (const run of runs) {
            await attempt(`stop owned public row ${run.id}`, async () => {
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
        for (const chat of chats) if (!chat.isClosed()) await attempt(`close launcher ${++cleanupIndex}`, async () => {
            await diagnostics.find(entry => entry.page === chat).finite.settle();
            await chat.close();
        });
        for (const entry of owned) await attempt(`terminate exact owned workflow for ${entry.options.frontSessionId}`, async () => {
                if (!owner || owner.isClosed()) owner = await accountPage(smokeConfig.secondaryUser, 'owner-flow-cleanup');
                const snapshot = await fixture.capture(entry.options);
                entry.snapshot = snapshot;
                if (snapshot.flow) await terminateOwnedFlow(owner, snapshot, fixture);
        });
        if (admin && !admin.isClosed()) await attempt('settle public rows and scoped native census', async () => {
            await expect.poll(async () => (await inventory(admin)).filter(row => runs.some(run => run.id === row.id)
                || [fixture.cwd, fixture.directoryName].includes(row.cwdDisplay))
                .every(row => ENDED.includes(row.status) && row.viewerCount === 0), { timeout: 30_000 }).toBe(true);
            const evidence = runtimeEvidence(release);
            const runtime = requireAgentEvidence(evidence, 'roboTeamAgent');
            let census;
            await expect.poll(async () => {
                census = await nativeProcessIdentity(evidence, runtime, fixture.native, fixture.directoryName, processSelection(fixture));
                return census.length;
            }, { timeout: 45_000 }).toBe(0);
            for (const entry of owned) {
                const snapshot = await fixture.capture(entry.options);
                const ownedFlowIds = owned.map(value => value.snapshot?.flow?.id).filter(Boolean);
                expect(snapshot.census.flows.filter(id => !ownedFlowIds.includes(id)), 'unowned scoped workflows retain the cwd').toEqual([]);
                if (snapshot.flow) assertOwnedSettlement(snapshot, { ...fixture, flowId: snapshot.flow.id }, census,
                    (await inventory(admin)).filter(row => runs.some(run => run.id === row.id)
                        || [fixture.cwd, fixture.directoryName].includes(row.cwdDisplay)));
                else expect(snapshot.task, 'an uncorrelated background task retains the directory').toBeNull();
            }
            settled = true;
        });
        if (directoryPath) await attempt('delete settled owned cwd', async () => {
            expect(settled, 'failed or ambiguous settlement retains the cwd and evidence').toBe(true);
            if (!owner || owner.isClosed()) owner = await accountPage(smokeConfig.secondaryUser, 'owner-cleanup');
            await deleteDirectoryIfPresent(owner, directoryPath);
        });
        for (const { page, finite } of diagnostics) if (!page.isClosed()) await attempt(`close page ${++cleanupIndex}`, async () => {
            await finite.settle();
            await page.close();
        });
        for (const context of contexts) await attempt(`close context ${++cleanupIndex}`, () => context.close());
        for (const { controller } of diagnostics) await attempt(`browser diagnostics ${++cleanupIndex}`, async () => {
            await controller.flush();
            expect(controller.actionableEvents(), 'all observed browser pages retain strict diagnostics').toEqual([]);
        });
        await finalizer.finish(testInfo, primaryFailure, { hasPrimary });
    }
}

async function startTurn(fixture, { replacement = false } = {}) {
    const { owner, directoryPath } = fixture;
    const work = workload();
    const before = await inventory(owner);
    const chat = await openCopilotForDirectory(owner, directoryPath);
    fixture.chats.push(chat);
    await waitForWebchatIdle(chat);
    assertNoNativeRefusal(await chat.locator(BOT).allTextContents());
    await chat.locator('#settingsBtn').click();
    const conversationLink = chat.locator('#sessionSettingsLink');
    await expect(conversationLink).toBeVisible();
    await expect(conversationLink).toHaveText('Conversation skills');
    await expect(conversationLink).toHaveAttribute('href', /\S/);
    const href = await conversationLink.getAttribute('href');
    const frontSessionId = conversationFromSkillsURL(href, smokeConfig.baseURL, { robotId: fixture.robotId }).sessionId;
    await chat.locator('#settingsBtn').click();
    const baseline = (await fixture.capture({})).census;
    const options = { frontSessionId, requestDigest: crypto.createHash('sha256').update(work.prompt).digest('hex'), baseline };
    const entry = { options, snapshot: null };
    fixture.owned.push(entry); // Enroll before the request, including partial launches.
    let front, frontNative, frontFailure, stopCapture = false;
    const selectionFor = (kind, sessionId, turnId) => processSelection(fixture, kind, sessionId, turnId);
    // Start observation before the sole request. A missed short launcher is a
    // failure, never permission for another provider attempt.
    const frontCapture = (async () => {
        const deadline = Date.now() + nativeTimeout;
        while (!stopCapture && Date.now() < deadline) {
            const snapshot = await fixture.capture({ ...options, frontOnly: true });
            entry.snapshot = snapshot;
            const rows = (await inventory(owner)).filter(candidate => candidate.kind === 'copilot-turn'
                && candidate.title.includes(work.id) && candidate.cwdDisplay === fixture.cwd
                && !before.some(old => old.id === candidate.id));
            expect(rows.length).toBeLessThanOrEqual(1);
            if (snapshot.front?.nativeObserved && rows[0]) {
                expect(snapshot.front.status, 'front native capture must occur while active').toBe('running');
                expect(rows[0]).toMatchObject({ isOwner: true, ownerState: 'verified', status: 'running', kind: 'copilot-turn' });
                if (!fixture.runs.some(run => run.id === rows[0].id)) fixture.runs.push(rows[0]);
                expect((await inventory(fixture.foreign)).some(row => row.id === rows[0].id)).toBe(false);
                frontNative = await nativeProcessIdentity(fixture.evidence, fixture.runtime, fixture.native, fixture.directoryName,
                    selectionFor('copilot', snapshot.front.sessionId, snapshot.front.turnId));
                expect(snapshot.front.backend).toBe(fixture.native.backend);
                front = { row: rows[0], metadata: snapshot.front, nativeProcess: frontNative };
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!stopCapture) throw new Error('Active front copilot metadata/native proof was missed; no provider retry is permitted.');
    })().catch(error => { frontFailure = error; });
    const inputResponse = chat.waitForResponse(response => new URL(response.url()).pathname === '/webchat/input'
        && response.request().method() === 'POST' && (response.request().postData() || '').includes(work.id));
    try {
        await setComposer(chat, work.prompt);
        await chat.locator('#send').click();
        expect((await inputResponse).status()).toBe(204);
        await frontCapture;
        if (frontFailure) throw frontFailure;
        expect(front, 'separate front publication and native evidence is required').toBeTruthy();
    } finally { stopCapture = true; await frontCapture; }
    let row;
    await expect.poll(async () => {
        assertNoNativeRefusal(await chat.locator(BOT).allTextContents());
        entry.snapshot = await fixture.capture(options);
        const rows = (await inventory(owner)).filter(candidate => candidate.kind === 'workflow-phase'
            && candidate.cwdDisplay === fixture.directoryName && !before.some(old => old.id === candidate.id));
        expect(rows.length).toBeLessThanOrEqual(1);
        row = rows[0];
        if (row && entry.snapshot.flow) {
            expect(row).toMatchObject({ isOwner: true, ownerState: 'verified', kind: 'workflow-phase' });
            if (!fixture.runs.some(run => run.id === row.id)) fixture.runs.push(row);
        }
        return Boolean(row && entry.snapshot.execution?.turns.length);
    }, { timeout: nativeTimeout, intervals: [250, 500, 1000] }).toBe(true);
    entry.snapshot = await fixture.capture({ ...options, requirePhase: true });
    expect(row).toMatchObject({ isOwner: true, ownerState: 'verified', status: 'running',
        capabilities: { watch: true, input: false, stop: true, message: true }, attach: { mode: 'event-stream' } });
    expect(row.cwdDisplay).toBe(fixture.directoryName);
    expect(entry.snapshot.execution.state).toBe('running');
    expect(entry.snapshot.execution.backend).toBe(fixture.native.backend);
    const selection = selectionFor('workflow', entry.snapshot.execution.alaSessionId, entry.snapshot.execution.turns[0].turnId);
    const reader = await openSse(owner.context(), smokeConfig.baseURL, row.id);
    fixture.readers.push(reader);
    await expect.poll(async () => {
        reader.check();
        assertNoNativeRefusal(await chat.locator(BOT).allTextContents());
        if (ENDED.includes((await inventory(owner)).find(candidate => candidate.id === row.id)?.status)) {
            throw new Error('Workflow phase ended before active execution proof; no fallback or retry is permitted.');
        }
        return executionText(reader.frames);
    }, { timeout: nativeTimeout, intervals: [250, 500, 1000] }).toContain(work.first);
    assertExecutionFile(path.join(smokeConfig.workspaceRoot, fixture.directoryName, work.firstFile), work.initial, work.first);
    await expect.poll(async () => {
        entry.snapshot = await fixture.capture({ ...options, requirePhase: true });
        return entry.snapshot.front.status;
    }, { timeout: nativeTimeout }).toMatch(/^(completed|cancelled|failed)$/);
    expect(entry.snapshot.front.status, 'the supported launcher must finish successfully').toBe('completed');
    let census;
    await expect.poll(async () => {
        census = await nativeProcessIdentity(fixture.evidence, fixture.runtime, fixture.native, fixture.directoryName, processSelection(fixture));
        return census.length;
    }, { timeout: 15000 }).toBe(1);
    const nativeProcess = await nativeProcessIdentity(fixture.evidence, fixture.runtime, fixture.native, fixture.directoryName, selection);
    const turn = { row, reader, work, chat, census, nativeProcess, selection, front, entry, snapshot: entry.snapshot, replacement };
    await assertUnchanged(fixture, turn, { ownerProof: false });
    return turn;
}

async function assertUnchanged(fixture, turn, { ownerProof = false } = {}) {
    const snapshot = await fixture.capture({ ...turn.entry.options, requirePhase: true });
    turn.entry.snapshot = snapshot;
    assertObserverWindow(turn.snapshot, snapshot);
    expect(await nativeProcessIdentity(fixture.evidence, fixture.runtime, fixture.native, fixture.directoryName, turn.selection)).toEqual(turn.nativeProcess);
    expect(await nativeProcessIdentity(fixture.evidence, fixture.runtime, fixture.native, fixture.directoryName, processSelection(fixture))).toEqual(turn.census);
    const rows = (await inventory(fixture.owner)).filter(row => [fixture.directoryName, fixture.cwd].includes(row.cwdDisplay));
    expect(rows.filter(row => !fixture.runs.some(run => run.id === row.id)), 'no unexplained scoped public row').toEqual([]);
    assertExecutionFile(path.join(fixture.cwd, turn.work.firstFile), turn.work.initial, turn.work.first);
    const digests = snapshot.execution.turns[0].followUpDigests;
    if (ownerProof) {
        expect(digests).toEqual([crypto.createHash('sha256').update(turn.work.message).digest('hex')]);
        assertExecutionFile(path.join(fixture.cwd, turn.work.secondFile), turn.work.followup, turn.work.second);
    } else {
        expect(digests, 'negative probes/observers cannot reach native input').toEqual([]);
        expect(fs.existsSync(path.join(fixture.cwd, turn.work.secondFile))).toBe(false);
    }
    return snapshot;
}

async function assertStopped(fixture, turn, observer) {
    const stopResponse = observer.waitForResponse(response => new URL(response.url()).pathname === `${LIVE_BASE}/${turn.row.id}/stop`
        && response.request().method() === 'POST');
    const key = `${LIVE_BASE}:${turn.row.id}`;
    // The run's Stop control is in the Live Sessions page framed by the observer's panel dialog.
    const { content } = liveSessionsPanel(observer);
    const pause = content.locator(`[data-session-id="${key}"][data-session-action="kill"]`);
    await expect(pause).toHaveText('Pause workflow');
    await pause.click();
    const confirm = content.locator(`[data-session-id="${key}"][data-session-action="confirm-kill"]`);
    await expect(confirm).toHaveText('Confirm pause');
    await confirm.click();
    expect((await stopResponse).status()).toBe(200);
    await expect.poll(() => {
        turn.reader.check();
        return turn.reader.frames.filter(frame => frame.event === 'exit').map(frame => frame.data.status);
    }, { timeout: 45_000 }).toEqual(['stopped']);
    await expect.poll(async () => {
        const snapshot = await fixture.capture({ ...turn.entry.options, requirePhase: true });
        turn.entry.snapshot = snapshot;
        return [snapshot.flow.status, snapshot.phase.state];
    }, { timeout: 45_000 }).toEqual(['paused', 'paused']);
    await expect.poll(async () => (await nativeProcessIdentity(fixture.evidence, fixture.runtime, fixture.native,
        fixture.directoryName, processSelection(fixture))).length, { timeout: 45_000 }).toBe(0);
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
    test.skip(true, 'local ALA engine removed (M-5)');
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
            await fixture.reopen();
            expect(await configuredNative(fixture.admin, fixture.release, replacement, { initial: false })).toEqual(fixture.native);
            const health = await fixture.admin.request.get(`${ROBOTEAM_BASE}/status`);
            expect(health.status()).toBe(200);
            expect(await health.json()).toMatchObject({ ok: true, service: 'RoboTeamAgent' });
            expect((await inventory(fixture.admin)).some(row => oldIds.includes(row.id))).toBe(false);
            const interrupted = await fixture.capture({ ...old.entry.options, requirePhase: true });
            assertObserverWindow(old.snapshot, interrupted);
            expect([interrupted.flow.status, interrupted.phase.state]).toEqual(['paused', 'paused']);
            expect(await nativeProcessIdentity(fixture.evidence, replacement, fixture.native, fixture.directoryName,
                processSelection(fixture))).toEqual([]);
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
            const fresh = await startTurn(fixture, { replacement: true });
            expect(oldIds).not.toContain(fresh.row.id);
            const watch = await openWatch(fixture.owner, fresh.row.id);
            await expect(watch.output).toContainText(fresh.work.first);
            await assertStopped(fixture, fresh, fixture.owner);
            await attachEvidence(testInfo, 'restart-observations.json', { oldRuntime, replacement,
                outerContainerId: replacementEvidence.outerContainerId, imageDigest: fixture.release.imageDigest,
                oldIds, newId: fresh.row.id, newOwnerState: fresh.row.ownerState,
                oldOwnedFlowAfterRestart: interrupted, oldFront: old.front, newFront: fresh.front,
                nativeExecutableUnchanged: true, oldNativeProcess: old.nativeProcess,
                newNativeProcess: fresh.nativeProcess, newFrames: fresh.reader.frames });
        });
    });
});

function messageAcceptances(frames) {
    return [...executionText(frames).matchAll(/\nMessage [0-9a-f-]{36}: (?:delivered|queued)\n/g)].map(match => match[0]);
}

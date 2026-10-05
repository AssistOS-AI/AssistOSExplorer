import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { openExplorer } from '../lib/explorer.mjs';
import { callAgentToolViaRouter } from '../lib/mcp.mjs';
import { setComposer, waitForWebchatIdle, cancelWebchatGenerationIfActive } from '../lib/webchat.mjs';
import { createReleaseGateFailureCollector } from '../lib/release-gate-failures.mjs';
import { observeLiveSkillsBrowser, captureLiveSkillsFailure, liveSkillsDiagnosticText } from '../lib/copilot-live-skills-diagnostics.mjs';
import { approveLiveSkillsRequest } from '../lib/copilot-live-skills-approval.mjs';
import {
    createLiveSkillsFixture, liveSkillSources, liveSkillsPrompt,
    isCompletedLiveSkillsTurn, validateLiveSkillsTurn, policyEvidence, liveSkillsHash, LIVE_SKILLS_TURN_TIMEOUT_MS,
} from '../lib/copilot-live-skills.mjs';
import { assertLiveSkillsLivePreflight, createOwnedLiveSkillsFixture, liveSkillsPhasePlan, liveSkillsOwnedLaunchURL, defaultRobotEvidence } from '../lib/copilot-live-skills-fixture.mjs';
import { createLiveSkillsRuntimeReader } from '../lib/copilot-live-skills-runtime.mjs';
import {
    ROBOTEAM_BASE_PATH, conversationFromSkillsURL, roboTeamRobotId, roboTeamApi, openConversationSkills,
    conversationSkillsState, setConversationSkill, refreshConversationSkills,
} from '../lib/conversation-skills.mjs';

const enabled = process.env.SMOKE_COPILOT_LIVE_SKILLS === '1';
const here = path.dirname(fileURLToPath(import.meta.url));

// The conversation skill steps drive RoboTeam's Conversation skills page (WebChat menu), not an Explorer Settings tab.
// Status: unexecuted until the deployment gate (D1/D2); Copilot-family flows are excluded from the 2026-10-02 post-merge acceptance.
// This spec is blocked on SET-2 phase6 credential preflight and independently verified B+C setup.
// This gate deliberately submits exactly seven native turns. A failed completion is never retried.
test.describe('Deployed Copilot live skills', () => {
    test.skip(!enabled, 'Opt in with SMOKE_COPILOT_LIVE_SKILLS=1 and exact host/release pins.');
    test.beforeAll(() => assertLiveSkillsLivePreflight());
    test('one native conversation consumes local edits, additions, disable, re-enable and deletion', async ({ page }, testInfo) => {
        test.setTimeout(25 * 60_000);
        assert.equal(testInfo.retry, 0, 'Acceptance retries are forbidden.');
        assert.equal(testInfo.project.retries, 0, 'Configure zero retries for this gate.');
        assert.equal(testInfo.config.workers, 1, 'Run this gate with one worker.');
        assert.ok(smokeConfig.flags.failOnBrowserErrors, 'Browser errors may not be ignored by this gate.');
        // The Box mounts the workspace at its own host path. The verified root exists before any fixture does.
        const reader = await createLiveSkillsRuntimeReader({ baseURL: smokeConfig.baseURL,
            verifierPath: process.env.SMOKE_COPILOT_RELEASE_VERIFIER || path.resolve(here, '../../../../ploinky/tests/release/verifyCopilot421Bundle.mjs') });
        const workspaceRoot = reader.workspaceRoot;
        const fixture = createLiveSkillsFixture(workspaceRoot);
        const evidence = { kind: 'deployed-copilot-live-skills', runId: fixture.runId, phases: [], result: 'running', cleanup: 'pending' };
        evidence.releaseBefore = reader.release;
        const errors = [];
        const network = [];
        const browser = observeLiveSkillsBrowser({ errors, network });
        const { observe } = browser;
        const failureCollector = createReleaseGateFailureCollector();
        let primaryError;
        page.context().on('page', observe);
        let copilot;
        let settings;
        let existingDefaultId;
        let existingDefaultBefore;
        let roboTeam;
        let owned;
        let receiptDirectoryCreated = false;
        let sessionId;
        let untouchedId;
        let defaultsBefore;
        let untouchedBefore;
        let nativeIdentity;
        let probeIdentity;
        const turnIds = [];
        let receiptNames = [];
        let receiptHashes = {};
        const phases = liveSkillsPhasePlan(fixture);
        const catalog = (id, robot = fixture.robotName) => callAgentToolViaRouter(page, { agent: 'roboTeamAgent', tool: 'list_achilles_skills',
            args: { robot, ...(id ? { sessionId: id } : {}) } });
        const fsTool = (tool, args) => callAgentToolViaRouter(page, { agent: 'explorer', tool, args });
        async function browserSessionId() {
            const href = await copilot.locator('#sessionSettingsLink').getAttribute('href');
            return conversationFromSkillsURL(href, smokeConfig.baseURL, { robotId: fixture.robotId }).sessionId;
        }
        // The robot id lives on RoboTeam's API, so it is read from a short-lived page under the RoboTeam route.
        async function defaultPreservation() {
            const rows = await owned.robots();
            const matches = rows.robots.filter(robot => robot.id === existingDefaultId);
            assert.equal(matches.length, 1);
            return defaultRobotEvidence(matches[0], await catalog(null, 'default'));
        }
        async function unchangedPolicies() {
            assert.deepEqual(policyEvidence(await catalog(), null, fixture.robotName), defaultsBefore, 'Robot defaults changed.');
            assert.deepEqual(policyEvidence(await catalog(untouchedId), untouchedId, fixture.robotName), untouchedBefore, 'The other conversation policy changed.');
            assert.deepEqual(await defaultPreservation(), existingDefaultBefore, 'Existing default configuration, policy or registration changed.');
        }
        async function toggleProbe(value) {
            assert.equal(await browserSessionId(), sessionId);
            if (!settings) settings = await openConversationSkills(copilot);
            else await refreshConversationSkills(settings);
            const before = await conversationSkillsState(settings);
            assert.equal(before.robotId, fixture.robotId);
            assert.equal(before.sessionId, sessionId);
            const item = before.items.filter(entry => entry.name === fixture.probe.name);
            assert.equal(item.length, 1);
            assert.equal(item[0].identity, probeIdentity);
            assert.equal(item[0].enabled, !value);
            const after = await setConversationSkill(settings, probeIdentity, value);
            assert.ok(after.policyVersion > before.policyVersion);
            assert.equal(after.items.filter(entry => entry.name === fixture.probe.name && entry.enabled === value).length, 1);
            const persisted = await catalog(sessionId);
            const selected = persisted.skills.filter(entry => entry.name === fixture.probe.name);
            assert.equal(selected.length, 1);
            assert.equal(selected[0].enabled, value);
            assert.equal(persisted.policy.excludedSkills.includes(probeIdentity), !value);
            await unchangedPolicies();
            await copilot.bringToFront();
        }
        async function turn({ label, selected, available, absent, revisionChange }) {
            evidence.currentPhase = { label, stage: 'baseline', startedAt: new Date().toISOString() };
            assert.equal(await browserSessionId(), sessionId, 'Browser changed conversation between phases.');
            await waitForWebchatIdle(copilot, smokeConfig.timeouts.navigation);
            const baseline = await reader.capture({ sessionId, fixture });
            const baselineIds = baseline.session.messages.filter(message => message.role === 'assistant').map(message => message.id);
            assert.deepEqual(Object.fromEntries(Object.entries(baseline.receipts).map(([name, receipt]) => [name, liveSkillsHash(receipt)])), receiptHashes, 'Receipts changed outside a native turn.');
            const selection = await catalog(sessionId);
            const expectedPolicy = policyEvidence(selection, sessionId, fixture.robotName);
            const phase = randomUUID();
            const prompt = liveSkillsPrompt({ phase, selected });
            const hostStarted = Date.now();
            evidence.currentPhase = { label, phase, stage: 'submit', startedAt: new Date(hostStarted).toISOString(),
                baselineIds, selected: selected.map(skill => skill.name), absent: absent.map(skill => skill.name), approvals: [] };
            const input = copilot.waitForResponse(response => new URL(response.url()).pathname === '/webchat/input'
                && response.request().method() === 'POST', { timeout: smokeConfig.timeouts.action });
            await setComposer(copilot, prompt);
            await copilot.locator('#send').click();
            assert.equal((await input).status(), 204, 'Browser input was not accepted.');
            evidence.currentPhase.stage = 'persisted native completion';
            let snapshot;
            let approvalFailure;
            const remaining = () => Math.max(1, LIVE_SKILLS_TURN_TIMEOUT_MS - (Date.now() - hostStarted));
            await expect.poll(async () => {
                snapshot = await reader.capture({ sessionId, fixture });
                evidence.lastRuntime = snapshot;
                evidence.currentPhase.elapsedMs = Date.now() - hostStarted;
                try {
                    await approveLiveSkillsRequest({ page: copilot, remaining, evidence: evidence.currentPhase,
                        baseURL: smokeConfig.baseURL, snapshot, fixture, workspaceRoot, sessionId, phase, selected, baselineIds, nativeIdentity });
                } catch (error) {
                    // Stop polling and preserve the exact rejected request immediately.
                    approvalFailure = error;
                    return true;
                }
                return isCompletedLiveSkillsTurn(snapshot, baselineIds);
            }, { timeout: remaining(), intervals: [500], message: `${label}: one completed persisted native turn within 150 seconds` }).toBe(true);
            if (approvalFailure) throw approvalFailure;
            evidence.currentPhase.stage = 'browser completion';
            await waitForWebchatIdle(copilot, remaining());
            assert.ok(Date.now() - hostStarted <= LIVE_SKILLS_TURN_TIMEOUT_MS, `${label} exceeded the 150 second completion budget.`);
            const inventory = await catalog(sessionId);
            evidence.currentPhase.stage = 'catalog, receipt and continuation validation';
            const proof = validateLiveSkillsTurn({ snapshot, inventory, baselineIds, priorTurnIds: turnIds, sessionId,
                nativeIdentity, fixture, workspaceRoot, phase, selected, available, absent, expectedPolicy, priorReceiptNames: receiptNames, priorReceiptHashes: receiptHashes,
                priorRevision: evidence.phases.at(-1)?.revision, revisionChange,
                startedAt: Date.parse(baseline.capturedAt), finishedAt: Date.parse(snapshot.capturedAt) });
            const message = copilot.locator(`#chatList > .wa-message.in[data-message-id="${proof.messageId}"]`);
            const bubble = message.locator('.wa-message-bubble');
            await expect(bubble).toHaveCount(1);
            assert.equal(await message.getAttribute('data-message-id'), proof.messageId, 'Browser completion does not match the persisted assistant message.');
            const browserText = await bubble.evaluate(element => (element.dataset.fullText || element.textContent || '').trim());
            for (const skill of selected) {
                assert.ok(browserText.includes(skill.descriptorMarker) && browserText.includes(skill.helperMarker));
            }
            assert.equal(await browserSessionId(), sessionId);
            nativeIdentity = proof.identity;
            turnIds.push(proof.turnId);
            receiptNames = Object.keys(snapshot.receipts);
            receiptHashes = Object.fromEntries(Object.entries(snapshot.receipts).map(([name, receipt]) => [name, liveSkillsHash(receipt)]));
            evidence.phases.push({ label, ...proof, durationMs: Date.now() - hostStarted, approvals: evidence.currentPhase.approvals });
            await unchangedPolicies();
            assert.deepEqual(errors, [], 'Browser errors occurred during the composed gate.');
            evidence.currentPhase.stage = 'passed';
        }
        try {
            evidence.currentPhase = { label: 'setup', stage: 'Explorer and fixture setup' };
            await openExplorer(page);
            observe(page);
            const roots = (await fsTool('list_allowed_directories', {})).rawText || '';
            assert.ok(roots.split('\n').includes(workspaceRoot), 'Explorer is not serving the pinned Box workspace.');
            page.context().off('page', observe);
            roboTeam = await page.context().newPage();
            await roboTeam.goto(new URL(ROBOTEAM_BASE_PATH, smokeConfig.baseURL).toString(), { waitUntil: 'domcontentloaded' });
            page.context().on('page', observe);
            existingDefaultId = await roboTeamRobotId(roboTeam, 'default');
            owned = createOwnedLiveSkillsFixture({ fixture, workspaceRoot, fsTool,
                api: request => roboTeamApi(roboTeam, request), operate: action => reader.fixtureOperation(action, fixture),
                listRepositories: async () => roboTeam.evaluate(async () => {
                    const response = await fetch('/api/marketplace/list-repos', { credentials: 'include', cache: 'no-store' });
                    if (!response.ok) throw new Error('Marketplace repository inventory failed.');
                    const payload = await response.json();
                    return payload.repositories;
                }) });
            existingDefaultBefore = await defaultPreservation();
            evidence.ownership = await owned.setup();
            receiptDirectoryCreated = true;
            defaultsBefore = policyEvidence(await catalog(), null, fixture.robotName);
            copilot = await page.context().newPage();
            await copilot.goto(liveSkillsOwnedLaunchURL(smokeConfig.baseURL, fixture), { waitUntil: 'domcontentloaded' });
            await expect(copilot.locator('#cmd')).toBeEditable({ timeout: smokeConfig.timeouts.navigation });
            await waitForWebchatIdle(copilot, smokeConfig.timeouts.navigation);
            await copilot.locator('#settingsBtn').click();
            await expect(copilot.locator('#sessionSettingsLink')).toBeVisible();
            untouchedId = await browserSessionId();
            untouchedBefore = policyEvidence(await catalog(untouchedId), untouchedId, fixture.robotName);
            await copilot.locator('#settingsBtn').click();
            await copilot.locator('#sessionsBtn').click();
            await copilot.locator('.wa-session-list-new').click();
            await expect.poll(browserSessionId).not.toBe(untouchedId);
            sessionId = await browserSessionId();
            await waitForWebchatIdle(copilot, smokeConfig.timeouts.navigation);
            evidence.conversation = { sessionId, untouchedId, workspaceRoot, workspace: fixture.workspace };
            const initial = await catalog(sessionId);
            const probe = initial.skills.filter(entry => entry.name === fixture.probe.name);
            assert.equal(probe.length, 1);
            assert.equal(probe[0].enabled, true);
            probeIdentity = probe[0].identity;
            assert.equal(probeIdentity, `${fixture.repositoryName}/${fixture.probe.name}`);
            await turn(phases[0]);

            fixture.probe.descriptorMarker = randomUUID();
            await owned.writeSource(`${fixture.repositoryName}/skills/${fixture.probe.name}/SKILL.md`, liveSkillSources(fixture, fixture.probe, workspaceRoot).descriptor);
            await turn(phases[1]);

            fixture.probe.helperMarker = randomUUID();
            await owned.writeSource(`${fixture.repositoryName}/skills/${fixture.probe.name}/receipt.mjs`, liveSkillSources(fixture, fixture.probe, workspaceRoot).helper);
            await turn(phases[2]);

            await owned.installSkill(fixture.added);
            await turn(phases[3]);

            await toggleProbe(false);
            await turn(phases[4]);

            await toggleProbe(true);
            await turn(phases[5]);

            const removed = await fsTool('delete_directory', { path: `${fixture.repositoryName}/skills/${fixture.probe.name}` });
            assert.match(removed.rawText || '', /^Successfully deleted directory /);
            await turn(phases[6]);
            assert.equal(evidence.phases.length, 7);
            assert.equal(new Set(turnIds).size, 7);
            evidence.releaseAfter = await reader.finish();
            evidence.policies = { ownedDefaults: defaultsBefore, untouched: untouchedBefore, existingDefault: existingDefaultBefore };
            evidence.result = 'passed';
        } catch (error) {
            primaryError = error;
            await failureCollector.required('pre-cleanup failure capture', () => captureLiveSkillsFailure({
                error, evidence, collector: failureCollector, copilot, testInfo,
                captureRuntime: sessionId && receiptDirectoryCreated ? () => reader.capture({ sessionId, fixture }) : null,
            }));
        } finally {
            // Detach before intentional popup closure cancels its SSE request. Earlier errors remain fatal.
            page.context().off('page', observe);
            browser.detach();
            evidence.browserErrors = errors;
            evidence.network = network;
            const cleanupErrors = [];
            if (copilot && !copilot.isClosed()) {
                try { await cancelWebchatGenerationIfActive(copilot, { timeout: smokeConfig.timeouts.navigation }); }
                catch (error) { cleanupErrors.push('active native turn could not be cancelled'); failureCollector.add('cancel active native turn', error); }
            }
            if (sessionId && receiptDirectoryCreated && cleanupErrors.length === 0) {
                try {
                    const stopped = await reader.capture({ sessionId, fixture });
                    assert.notEqual(stopped.session.skillExecution?.active, true);
                    assert.ok(!stopped.session.messages.some(message => message.role === 'assistant' && message.status === 'pending'));
                } catch (error) { cleanupErrors.push('persisted native turn did not prove quiescence'); failureCollector.add('persisted native quiescence', error); }
            }
            if (defaultsBefore && untouchedBefore) {
                try { await unchangedPolicies(); } catch (error) { cleanupErrors.push('policy preservation check failed'); failureCollector.add('policy preservation', error); }
            }
            for (const candidate of [settings, copilot]) {
                if (candidate && !candidate.isClosed()) await candidate.close().catch(error => { cleanupErrors.push('popup close failed'); failureCollector.add('popup close', error); });
            }
            if (owned && cleanupErrors.length === 0) {
                try {
                    await owned.cleanup({ quiescent: true });
                    if (existingDefaultBefore) assert.deepEqual(await defaultPreservation(), existingDefaultBefore, 'Existing default changed during cleanup.');
                }
                catch (error) { cleanupErrors.push('owned fixture cleanup failed; retain ownership'); failureCollector.add('owned fixture cleanup', error); }
            }
            if (roboTeam && !roboTeam.isClosed()) await roboTeam.close().catch(error => { cleanupErrors.push('RoboTeam control page close failed'); failureCollector.add('control page close', error); });
            evidence.fixtureState = owned?.state;
            evidence.cleanup = cleanupErrors.length ? cleanupErrors : 'passed';
            if (errors.length) failureCollector.add('browser errors', new Error(liveSkillsDiagnosticText(errors)));
            if (evidence.result !== 'passed' || primaryError || failureCollector.failures.length) evidence.result = 'failed';
            evidence.secondaryFailures = failureCollector.failures.map(error => error.message);
            await failureCollector.required('live-skills evidence attachment', () => testInfo.attach('copilot-live-skills-evidence.json', {
                body: Buffer.from(liveSkillsDiagnosticText(evidence)), contentType: 'application/json',
            }));
        }
        failureCollector.throwIfAny({ primaryError, label: 'deployed Copilot live skills' });
    });
});

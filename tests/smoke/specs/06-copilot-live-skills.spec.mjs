import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { openExplorer } from '../lib/explorer.mjs';
import { createDirectory, openCopilotForDirectory } from '../lib/copilot.mjs';
import { callAgentToolViaRouter } from '../lib/mcp.mjs';
import { setComposer, waitForWebchatIdle, cancelWebchatGenerationIfActive } from '../lib/webchat.mjs';
import { createReleaseGateFailureCollector } from '../lib/release-gate-failures.mjs';
import { observeLiveSkillsBrowser, captureLiveSkillsFailure, liveSkillsDiagnosticText } from '../lib/copilot-live-skills-diagnostics.mjs';
import {
    createLiveSkillsFixture, liveSkillSources, liveSkillsPrompt, conversationFromSettingsURL,
    isCompletedLiveSkillsTurn, validateLiveSkillsTurn, policyEvidence, liveSkillsHash, LIVE_SKILLS_TURN_TIMEOUT_MS,
} from '../lib/copilot-live-skills.mjs';
import { createLiveSkillsRuntimeReader } from '../lib/copilot-live-skills-runtime.mjs';

const enabled = process.env.SMOKE_COPILOT_LIVE_SKILLS === '1';
const here = path.dirname(fileURLToPath(import.meta.url));

// This gate deliberately submits exactly seven native turns. A failed completion is never retried.
test.describe('Deployed Copilot live skills', () => {
    test.skip(!enabled, 'Opt in with SMOKE_COPILOT_LIVE_SKILLS=1 and exact host/release pins.');
    test('one native conversation consumes local edits, additions, disable, re-enable and deletion', async ({ page }, testInfo) => {
        test.setTimeout(25 * 60_000);
        assert.equal(testInfo.retry, 0, 'Acceptance retries are forbidden.');
        assert.equal(testInfo.project.retries, 0, 'Configure zero retries for this gate.');
        assert.equal(testInfo.config.workers, 1, 'Run this gate with one worker.');
        assert.ok(smokeConfig.flags.failOnBrowserErrors, 'Browser errors may not be ignored by this gate.');
        const fixture = createLiveSkillsFixture();
        const evidence = { kind: 'deployed-copilot-live-skills', runId: fixture.runId, phases: [], result: 'running', cleanup: 'pending' };
        const reader = await createLiveSkillsRuntimeReader({ baseURL: smokeConfig.baseURL,
            verifierPath: process.env.SMOKE_COPILOT_RELEASE_VERIFIER || path.resolve(here, '../../../../ploinky/tests/release/verifyCopilot421Bundle.mjs') });
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
        let directoryCreated = false;
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
        const catalog = id => callAgentToolViaRouter(page, { agent: 'roboTeamAgent', tool: 'list_achilles_skills',
            args: { robot: 'default', ...(id ? { sessionId: id } : {}) } });
        const fsTool = (tool, args) => callAgentToolViaRouter(page, { agent: 'explorer', tool, args });
        async function writeSource(relative, content) {
            assert.ok(relative.startsWith(`${fixture.folder}/.agents/skills/`), 'Fixture writes must stay under the run skill folder.');
            const result = await fsTool('write_file', { path: relative, content });
            assert.match(result.rawText || '', /^Successfully wrote to /);
            assert.equal((await fsTool('read_file', { path: relative })).rawText, content);
        }
        async function installSkill(skill) {
            const relative = `${fixture.folder}/.agents/skills/${skill.name}`;
            assert.match((await fsTool('create_directory', { path: relative })).rawText || '', /^Successfully created directory /);
            const source = liveSkillSources(fixture, skill);
            await writeSource(`${relative}/SKILL.md`, source.descriptor);
            await writeSource(`${relative}/receipt.mjs`, source.helper);
        }
        async function browserSessionId() {
            const href = await copilot.locator('#sessionSettingsLink').getAttribute('href');
            return conversationFromSettingsURL(href, smokeConfig.baseURL);
        }
        async function unchangedPolicies() {
            assert.deepEqual(policyEvidence(await catalog(), null), defaultsBefore, 'Robot defaults changed.');
            assert.deepEqual(policyEvidence(await catalog(untouchedId), untouchedId), untouchedBefore, 'The other conversation policy changed.');
        }
        async function currentModal() {
            await expect(settings.locator('settings-modal')).toBeVisible();
            await expect(settings.locator('#copilotSettingsStatus')).toContainText('Current selection loaded.');
            await expect(settings.locator('#copilotSettingsStatus')).not.toHaveClass(/error/);
            const state = await settings.locator('settings-modal').evaluate(element => {
                const presenter = element.webSkelPresenter;
                return { context: presenter.getCopilotContext(), loaded: presenter.state.copilotDataLoaded,
                    policyVersion: presenter.state.copilotPolicyVersion, items: presenter.state.copilotItems };
            });
            assert.deepEqual(state.context, { robot: 'default', sessionId });
            assert.equal(state.loaded, true);
            return state;
        }
        async function toggleProbe(value) {
            assert.equal(await browserSessionId(), sessionId);
            if (!settings) {
                await copilot.locator('#settingsBtn').click();
                await expect(copilot.locator('#sessionSettingsLink')).toBeVisible();
                const popup = page.context().waitForEvent('page');
                await copilot.locator('#sessionSettingsLink').click();
                settings = await popup;
                await settings.waitForLoadState('domcontentloaded');
            } else {
                await settings.getByRole('button', { name: 'Refresh skills', exact: true }).click();
            }
            const before = await currentModal();
            const item = before.items.filter(entry => entry.name === fixture.probe.name);
            assert.equal(item.length, 1);
            assert.equal(item[0].identity, probeIdentity);
            assert.equal(item[0].enabled, !value);
            const row = settings.locator('#copilotSettingsList .plugin-settings-row').filter({
                has: settings.locator('.plugin-settings-key', { hasText: new RegExp(`^${fixture.probe.name}$`) }),
            });
            const button = row.locator('button[data-local-action^="toggleCopilotSkill "]');
            await expect(button).toHaveAttribute('aria-pressed', String(!value));
            await button.click();
            await expect(button).toHaveAttribute('aria-pressed', String(value));
            await expect.poll(async () => (await currentModal()).policyVersion).toBeGreaterThan(before.policyVersion);
            const persisted = await catalog(sessionId);
            const selected = persisted.skills.filter(entry => entry.name === fixture.probe.name);
            assert.equal(selected.length, 1);
            assert.equal(selected[0].enabled, value);
            assert.equal(persisted.policy.excludedSkills.includes(probeIdentity), !value);
            await unchangedPolicies();
            await copilot.bringToFront();
        }
        async function turn(label, selected, available, absent = []) {
            evidence.currentPhase = { label, stage: 'baseline', startedAt: new Date().toISOString() };
            assert.equal(await browserSessionId(), sessionId, 'Browser changed conversation between phases.');
            await waitForWebchatIdle(copilot, smokeConfig.timeouts.navigation);
            const baseline = await reader.capture({ sessionId, fixture });
            const baselineIds = baseline.session.messages.filter(message => message.role === 'assistant').map(message => message.id);
            assert.deepEqual(Object.fromEntries(Object.entries(baseline.receipts).map(([name, receipt]) => [name, liveSkillsHash(receipt)])), receiptHashes, 'Receipts changed outside a native turn.');
            const selection = await catalog(sessionId);
            const expectedPolicy = policyEvidence(selection, sessionId);
            const phase = randomUUID();
            const prompt = liveSkillsPrompt({ phase, selected });
            const hostStarted = Date.now();
            evidence.currentPhase = { label, phase, stage: 'submit', startedAt: new Date(hostStarted).toISOString(),
                baselineIds, selected: selected.map(skill => skill.name), absent: absent.map(skill => skill.name) };
            const input = copilot.waitForResponse(response => new URL(response.url()).pathname === '/webchat/input'
                && response.request().method() === 'POST', { timeout: smokeConfig.timeouts.action });
            await setComposer(copilot, prompt);
            await copilot.locator('#send').click();
            assert.equal((await input).status(), 204, 'Browser input was not accepted.');
            evidence.currentPhase.stage = 'persisted native completion';
            let snapshot;
            const remaining = () => Math.max(1, LIVE_SKILLS_TURN_TIMEOUT_MS - (Date.now() - hostStarted));
            await expect.poll(async () => {
                snapshot = await reader.capture({ sessionId, fixture });
                evidence.lastRuntime = snapshot;
                evidence.currentPhase.elapsedMs = Date.now() - hostStarted;
                return isCompletedLiveSkillsTurn(snapshot, baselineIds);
            }, { timeout: remaining(), intervals: [500], message: `${label}: one completed persisted native turn within 150 seconds` }).toBe(true);
            evidence.currentPhase.stage = 'browser completion';
            await waitForWebchatIdle(copilot, remaining());
            assert.ok(Date.now() - hostStarted <= LIVE_SKILLS_TURN_TIMEOUT_MS, `${label} exceeded the 150 second completion budget.`);
            const inventory = await catalog(sessionId);
            evidence.currentPhase.stage = 'catalog, receipt and continuation validation';
            const proof = validateLiveSkillsTurn({ snapshot, inventory, baselineIds, priorTurnIds: turnIds, sessionId,
                nativeIdentity, fixture, phase, selected, available, absent, expectedPolicy, priorReceiptNames: receiptNames, priorReceiptHashes: receiptHashes,
                priorRevision: evidence.phases.at(-1)?.revision,
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
            evidence.phases.push({ label, ...proof, durationMs: Date.now() - hostStarted });
            await unchangedPolicies();
            assert.deepEqual(errors, [], 'Browser errors occurred during the composed gate.');
            evidence.currentPhase.stage = 'passed';
        }
        try {
            evidence.currentPhase = { label: 'setup', stage: 'Explorer and fixture setup' };
            await openExplorer(page);
            observe(page);
            const roots = (await fsTool('list_allowed_directories', {})).rawText || '';
            assert.ok(roots.split('\n').includes('/workspace'), 'Explorer is not serving the pinned Box workspace.');
            defaultsBefore = policyEvidence(await catalog());
            await createDirectory(page, fixture.folder, `/${fixture.folder}`);
            directoryCreated = true;
            copilot = await openCopilotForDirectory(page, `/${fixture.folder}`);
            await expect(copilot.locator('#cmd')).toBeEditable({ timeout: smokeConfig.timeouts.navigation });
            await waitForWebchatIdle(copilot, smokeConfig.timeouts.navigation);
            await copilot.locator('#settingsBtn').click();
            await expect(copilot.locator('#sessionSettingsLink')).toBeVisible();
            untouchedId = await browserSessionId();
            untouchedBefore = policyEvidence(await catalog(untouchedId), untouchedId);
            await copilot.locator('#settingsBtn').click();
            await copilot.locator('#sessionsBtn').click();
            await copilot.locator('.wa-session-list-new').click();
            await expect.poll(browserSessionId).not.toBe(untouchedId);
            sessionId = await browserSessionId();
            await waitForWebchatIdle(copilot, smokeConfig.timeouts.navigation);
            evidence.conversation = { sessionId, untouchedId, workspace: fixture.workspace };
            assert.match((await fsTool('create_directory', { path: `${fixture.folder}/.receipts` })).rawText || '', /^Successfully created directory /);
            receiptDirectoryCreated = true;
            await installSkill(fixture.control);
            await installSkill(fixture.probe);
            const initial = await catalog(sessionId);
            const probe = initial.skills.filter(entry => entry.name === fixture.probe.name);
            assert.equal(probe.length, 1);
            assert.equal(probe[0].enabled, true);
            probeIdentity = probe[0].identity;
            assert.equal(probeIdentity, `workspace:${fixture.folder}/.agents/skills/${fixture.probe.name}`);
            await turn('original', [fixture.control, fixture.probe], [fixture.control, fixture.probe]);

            fixture.probe.descriptorMarker = randomUUID();
            await writeSource(`${fixture.folder}/.agents/skills/${fixture.probe.name}/SKILL.md`, liveSkillSources(fixture, fixture.probe).descriptor);
            await turn('descriptor edit', [fixture.control, fixture.probe], [fixture.control, fixture.probe]);

            fixture.probe.helperMarker = randomUUID();
            await writeSource(`${fixture.folder}/.agents/skills/${fixture.probe.name}/receipt.mjs`, liveSkillSources(fixture, fixture.probe).helper);
            await turn('helper-only edit', [fixture.control, fixture.probe], [fixture.control, fixture.probe]);

            await installSkill(fixture.added);
            await turn('new skill', [fixture.control, fixture.added], [fixture.control, fixture.probe, fixture.added]);

            await toggleProbe(false);
            await turn('disabled probe', [fixture.control], [fixture.control, fixture.added], [fixture.probe]);

            await toggleProbe(true);
            await turn('re-enabled probe', [fixture.control, fixture.probe], [fixture.control, fixture.probe, fixture.added]);

            const removed = await fsTool('delete_directory', { path: `${fixture.folder}/.agents/skills/${fixture.probe.name}` });
            assert.match(removed.rawText || '', /^Successfully deleted directory /);
            await turn('deleted probe', [fixture.control], [fixture.control, fixture.added], [fixture.probe]);
            assert.equal(evidence.phases.length, 7);
            assert.equal(new Set(turnIds).size, 7);
            evidence.releaseAfter = await reader.finish();
            evidence.policies = { defaults: defaultsBefore, untouched: untouchedBefore };
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
            if (directoryCreated && cleanupErrors.length === 0) {
                try {
                    const removed = await fsTool('delete_directory', { path: fixture.folder });
                    assert.match(removed.rawText || '', /^Successfully deleted directory /);
                }
                catch (error) { cleanupErrors.push('run-owned source/receipt cleanup failed'); failureCollector.add('run-owned source/receipt cleanup', error); }
            }
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

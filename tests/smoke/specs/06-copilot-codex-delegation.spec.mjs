import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { directoryRow, openCopilotForDirectory } from '../lib/copilot.mjs';
import { assertExplorerDirectory, openExplorer } from '../lib/explorer.mjs';
import { setComposer, waitForWebchatIdle, cancelWebchatGenerationIfActive } from '../lib/webchat.mjs';
import { callAgentToolViaRouter } from '../lib/mcp.mjs';
import { ROBOTEAM_BASE_PATH, roboTeamApi, roboTeamRobotId, conversationFromSkillsURL } from '../lib/conversation-skills.mjs';
import { assertLiveSkillsLivePreflight, defaultRobotEvidence } from '../lib/copilot-live-skills-fixture.mjs';
import { liveSkillsHash } from '../lib/copilot-live-skills.mjs';
import { liveSkillsDiagnosticText, observeLiveSkillsBrowser } from '../lib/copilot-live-skills-diagnostics.mjs';
import { createWorkflowDelegationFixture, delegationPrompt, delegationObjective, validateWorkflowDelegation } from '../lib/copilot-workflow-delegation.mjs';
import { createWorkflowDelegationReader } from '../lib/copilot-workflow-delegation-runtime.mjs';
import { createWorkflowDelegationController } from '../lib/copilot-workflow-delegation-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const terminal = status => ['completed', 'failed', 'paused', 'terminated'].includes(status);

test.describe('Copilot delegated Codex workflow', () => {
    test.skip(!smokeConfig.flags.codexDelegation, 'Set SMOKE_CODEX_DELEGATION=1 with exact release pins for the C4 gate.');
    // Discovery is available. Enabled execution remains blocked until the reviewed phase6 runner exists.
    test.beforeAll(() => assertLiveSkillsLivePreflight());
    test('launches one terminal workflow through Copilot with one matching Codex child', async ({ page }, testInfo) => {
        test.setTimeout(Math.max(smokeConfig.timeouts.test, smokeConfig.timeouts.relay + 180_000));
        assert.equal(testInfo.retry, 0); assert.equal(testInfo.project.retries, 0); assert.equal(testInfo.config.workers, 1);
        assert.ok(smokeConfig.flags.failOnBrowserErrors);
        const frontBackend = process.env.SMOKE_C4_FRONT_BACKEND;
        assert.ok(['codex', 'opencode', 'pi'].includes(frontBackend), 'Record the existing front backend in SMOKE_C4_FRONT_BACKEND.');
        const reader = await createWorkflowDelegationReader({ baseURL: smokeConfig.baseURL,
            verifierPath: process.env.SMOKE_COPILOT_RELEASE_VERIFIER || path.resolve(here, '../../../../ploinky/tests/release/verifyCopilot421Bundle.mjs') });
        const fixture = createWorkflowDelegationFixture(reader.workspaceRoot);
        const evidence = { kind: 'copilot-workflow-delegation', runId: fixture.runId, result: 'running', cleanup: 'pending', frontBackend };
        const errors = [], network = [], browser = observeLiveSkillsBrowser({ errors, network }); browser.observe(page);
        page.context().on('page', browser.observe);
        let control, copilot, workflowPage, controller, frontRobotId, frontSessionId, baseline, snapshot, defaultBefore, primary;
        const fsTool = (tool, args) => callAgentToolViaRouter(page, { agent: 'explorer', tool, args });
        const catalog = () => callAgentToolViaRouter(page, { agent: 'roboTeamAgent', tool: 'list_achilles_skills', args: { robot: 'default' } });
        async function preservedDefault() {
            const rows = await controller.robots(), matches = rows.filter(robot => robot.id === frontRobotId); assert.equal(matches.length, 1);
            return defaultRobotEvidence(matches[0], await catalog());
        }
        async function capture() {
            return reader.capture({ fixture, frontSessionId, frontRobotId, baselineFiles: baseline?.userFiles });
        }
        try {
            await openExplorer(page);
            const roots = (await fsTool('list_allowed_directories', {})).rawText || '';
            assert.ok(roots.split('\n').includes(reader.workspaceRoot));
            page.context().off('page', browser.observe); control = await page.context().newPage();
            await control.goto(new URL(ROBOTEAM_BASE_PATH, smokeConfig.baseURL).toString(), { waitUntil: 'domcontentloaded' });
            page.context().on('page', browser.observe);
            frontRobotId = await roboTeamRobotId(control, 'default');
            controller = createWorkflowDelegationController({ fixture, workspaceRoot: reader.workspaceRoot, reader, fsTool,
                api: request => roboTeamApi(control, request), listRepositories: () => control.evaluate(async () => {
                    const response = await fetch('/api/marketplace/list-repos', { credentials: 'include', cache: 'no-store' });
                    if (!response.ok) throw new Error('Marketplace inventory failed.'); return (await response.json()).repositories;
                }) });
            defaultBefore = await preservedDefault(); evidence.ownership = await controller.setup();
            await page.locator('#refreshButton').click();
            copilot = await openCopilotForDirectory(page, `/${fixture.folder}`);
            await expect(copilot.locator('#cmd')).toBeEditable({ timeout: smokeConfig.timeouts.navigation });
            await waitForWebchatIdle(copilot, smokeConfig.timeouts.navigation);
            await copilot.locator('#settingsBtn').click();
            frontSessionId = conversationFromSkillsURL(await copilot.locator('#sessionSettingsLink').getAttribute('href'), smokeConfig.baseURL, { robotId: frontRobotId }).sessionId;
            await copilot.locator('#settingsBtn').click();
            baseline = await capture(); evidence.baseline = { frontSessionId, taskIds: baseline.tasks.map(task => task.id), flowIds: baseline.flows.map(flow => flow.id), userFiles: baseline.userFiles };
            assert.deepEqual(baseline.matchingRobotIds, [fixture.robotId]); assert.equal(baseline.fileContent, null);
            const startedAt = Date.now(), prompt = delegationPrompt(fixture);
            const accepted = copilot.waitForResponse(response => new URL(response.url()).pathname === '/webchat/input' && response.request().method() === 'POST', { timeout: smokeConfig.timeouts.action });
            await setComposer(copilot, prompt); await copilot.locator('#send').click(); assert.equal((await accepted).status(), 204);
            await expect.poll(async () => {
                snapshot = await capture();
                const fresh = snapshot.tasks.filter(task => !baseline.tasks.some(old => old.id === task.id));
                assert.ok(fresh.length <= 1, 'One objective produced more than one background task.');
                return snapshot.flow?.status === 'completed' && snapshot.child?.native?.turns.length === 1
                    && fresh.length === 1 && fresh[0].status === 'finished'
                    && snapshot.front.session.messages.some(message => message.role === 'assistant' && message.status === 'completed' && !baseline.front.session.messages.some(old => old.id === message.id));
            }, { timeout: smokeConfig.timeouts.relay, intervals: [500], message: 'One completed workflow and actual Codex child on the submitted objective' }).toBe(true);
            await waitForWebchatIdle(copilot, smokeConfig.timeouts.navigation);
            const proof = validateWorkflowDelegation({ snapshot, fixture, baseline, frontRobotId, frontBackend, startedAt: Date.parse(baseline.capturedAt), finishedAt: Date.parse(snapshot.capturedAt) });
            const card = copilot.locator(`.wa-task-item[data-task-id="${proof.taskId}"]`); await expect(card).toHaveCount(1);
            await expect(card.locator('.wa-task-status')).toHaveText('COMPLETED');
            await copilot.locator('#tasksBtn').click(); const item = copilot.locator('.wa-task-list-item'); await expect(item).toHaveCount(1); await item.click();
            await expect(copilot.locator('#taskDetail .wa-task-meta')).toContainText('roboTeamAgent · roboflow_start_flow');
            await expect(copilot.locator('#taskDetail .wa-task-log')).toContainText(fixture.marker);
            workflowPage = await page.context().newPage();
            await workflowPage.goto(new URL(snapshot.tasks[0].details.url, smokeConfig.baseURL).toString(), { waitUntil: 'domcontentloaded' });
            await expect(workflowPage.locator('#detail-title')).toHaveText(snapshot.workflow.name);
            await expect(workflowPage.locator('#flowObjective')).toHaveText(delegationObjective(fixture));
            await expect(workflowPage.locator('#flowStatus')).toHaveText('completed');
            const phase = workflowPage.locator('#phaseList .phase-card'); await expect(phase).toHaveCount(1); await expect(phase).toHaveAttribute('data-state', 'completed');
            await expect(phase.locator('.phase-card-meta')).toContainText(`${fixture.robotName} · terminal · completed`); await phase.click();
            await expect(workflowPage.locator('#stageBody .phase-log')).toContainText(fixture.marker);
            await directoryRow(page, `/${fixture.folder}`).click(); await assertExplorerDirectory(page, `/${fixture.folder}`); await page.locator('#refreshButton').click();
            const proofRow = directoryRow(page, `/${fixture.folder}/${fixture.filename}`); await expect(proofRow).toHaveCount(1); await proofRow.click();
            await expect(page.locator('#editorFileName')).toHaveText(fixture.filename); await expect(page.locator('#filePreview')).toHaveText(fixture.marker);
            assert.equal((await fsTool('read_file', { path: `${fixture.folder}/${fixture.filename}` })).rawText, `${fixture.marker}\n`);
            assert.deepEqual(await preservedDefault(), defaultBefore);
            evidence.proof = proof; evidence.release = await reader.finish(); evidence.result = 'passed';
            assert.deepEqual(errors, []);
        } catch (error) { primary = error; evidence.failure = { name: error.name, message: error.message }; }
        finally {
            page.context().off('page', browser.observe); browser.detach(); evidence.browserErrors = errors; evidence.network = network;
            const failures = [];
            try {
                if (copilot && !copilot.isClosed()) await cancelWebchatGenerationIfActive(copilot, { timeout: smokeConfig.timeouts.navigation });
                if (frontSessionId) snapshot = await capture();
                for (const flow of snapshot?.flows || []) if (!terminal(flow.status)) {
                    const reply = await roboTeamApi(control, { method: 'POST', path: `api/roboflow/flows/${flow.id}/pause`, body: {} }); assert.equal(reply.status, 200);
                }
                if (frontSessionId) {
                    snapshot = await capture(); assert.ok(snapshot.flows.every(flow => terminal(flow.status)));
                    for (const session of [snapshot.front?.session, snapshot.child?.session].filter(Boolean)) {
                        assert.notEqual(session.skillExecution?.active, true); assert.ok(!session.messages.some(message => message.status === 'pending'));
                    }
                }
            } catch (error) { failures.push(error.message); }
            for (const popup of [workflowPage, copilot]) if (popup && !popup.isClosed()) await popup.close().catch(error => failures.push(error.message));
            if (controller && failures.length === 0) {
                try { await controller.cleanup({ quiescent: true, observedFlows: snapshot?.flows || [] }); if (defaultBefore) assert.deepEqual(await preservedDefault(), defaultBefore); }
                catch (error) { failures.push(error.message); }
            }
            if (control && !control.isClosed()) await control.close().catch(error => failures.push(error.message));
            evidence.cleanup = failures.length ? failures : 'passed'; evidence.fixtureState = controller?.state;
            if (failures.length || errors.length || primary) evidence.result = 'failed';
            await testInfo.attach('copilot-workflow-delegation-evidence_codex.json', { body: Buffer.from(liveSkillsDiagnosticText(evidence)), contentType: 'application/json' });
            if (!primary && failures.length) primary = new Error('Owned workflow cleanup failed.');
        }
        if (primary) throw primary;
    });
});

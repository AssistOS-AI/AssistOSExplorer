import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { signIn } from '../lib/auth.mjs';
import { ROBOTEAM_BASE_PATH, roboTeamApi, conversationFromSkillsURL, openConversationSkills, conversationSkillsState, setConversationSkill, refreshConversationSkills } from '../lib/conversation-skills.mjs';
import { discoverContainers, readLedger, removeRunDirectory } from '../lib/robowork-e2e.mjs';
import { apiOk, makeStallGuard, toolOutputs, markerOf, workerProcesses } from '../lib/robowork-scenarios.mjs';
import { chatTurn, stopChatTurn, applySelectedModel, postQuietly } from '../lib/robowork-interaction.mjs';
import { projectManifest, runtimeIdentity, requireRoboWorkGateFlags } from '../lib/robowork-terminal.mjs';
import { scopedSkillTurn, assertAdmittedMarker, throwScenarioFailures, freshSkillConversation, assertNoProjectGrant, deleteOwnSkillRobotAfterChat } from '../lib/robowork-skills-fixture.mjs';

// H / S3-S4, fresh deployment only:
// SMOKE_ROBOWORK_SKILLS=1 node scripts/run-robowork-e2e.mjs specs/12-robowork-skills.spec.mjs
// The prompt, SKILL.md, project and robot metadata never contain the random marker.
// Each case gets its own robot and nonce, preventing a prior conversation from supplying the answer.
requireRoboWorkGateFlags(process.env, ['SMOKE_ROBOWORK_SKILLS']);
test.describe('RoboWork admitted skills', () => {
    test.skip(process.env.SMOKE_ROBOWORK_SKILLS !== '1', 'Opt in with SMOKE_ROBOWORK_SKILLS=1.');

    for (const withProject of [true, false]) {
        test(`H: reads the marker skill ${withProject ? 'with' : 'without'} a project; project skill trees stay unchanged`, async ({ page }) => {
            test.setTimeout(9 * 60_000);
            const workspaceRoot = smokeConfig.workspaceRoot;
            assert.ok(path.isAbsolute(workspaceRoot), 'Set SMOKE_WORKSPACE_ROOT to the deployed workspace.');
            const run = `e2e-h-${crypto.randomBytes(6).toString('hex')}`;
            const evidenceDir = path.resolve(process.env.SMOKE_ROBOWORK_EVIDENCE || smokeConfig.artifactRoot, run);
            fs.mkdirSync(evidenceDir, { recursive: true });
            const save = (name, value) => fs.writeFileSync(path.join(evidenceDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
            const repository = path.join(workspaceRoot, `${run}-skills`);
            const project = path.join(workspaceRoot, `${run}-project`);
            const skillName = 'nonce-marker';
            const nonce = crypto.randomBytes(32).toString('hex');
            fs.mkdirSync(path.join(repository, skillName), { recursive: true });
            fs.writeFileSync(path.join(repository, skillName, 'marker.txt'), `${nonce}\n`);
            fs.writeFileSync(path.join(repository, skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Read the diagnostic marker when requested.\n---\n\nRead marker.txt beside this SKILL.md using a shell command. Return its exact contents. Do not write files.\n`);
            fs.mkdirSync(path.join(project, 'nested/.agents/skills/existing'), { recursive: true });
            fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
            fs.writeFileSync(path.join(project, 'README.md'), 'Disposable skill immutability fixture. Do not edit.\n');
            fs.writeFileSync(path.join(project, 'nested/.agents/skills/existing/SKILL.md'), 'Existing project skill; leave unchanged.\n');
            fs.writeFileSync(path.join(project, '.claude/settings.json'), '{}\n');
            // The fixture authors no root runtime state. Only the real root directory may subsequently be created by DS006 runtime code.
            assert.equal(fs.existsSync(path.join(project, '.roboteam')), false);
            const before = projectManifest(project, { ignoreRootRuntime: true });
            save('project-before.json', before);
            save('environment.json', runtimeIdentity(discoverContainers({ workspaceRoot })));
            let robot;
            let robotDeleted = false;
            let primaryError = null;
            let sessionId;
            let turnStartedMs;
            try {
                await signIn(page, smokeConfig.primaryUser, ROBOTEAM_BASE_PATH);
                robot = (await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/robots', body: { name: run, codingAgents: ['opencode'] } }, [201])).robot;
                await applySelectedModel(roboTeamApi, page, robot);
                await apiOk(roboTeamApi, page, { method: 'POST', path: `api/robots/${robot.id}/skillsets`, body: { name: 'markerrepo', source: repository, description: 'Diagnostic marker skill' } });
                const startMs = Date.now();
                const prompt = `Use the admitted ${skillName} skill at /run/robo-work/skills. Use a shell tool to run `
                    + "`p=/run/robo-work/skills/nonce-marker; printf 'READ_PATH=%s\\n' \"$p\"; cat \"$p/marker.txt\"`. "
                    + 'Return the exact marker contents. Do not write or modify any files.';
                assert.ok(!prompt.includes(nonce));
                const guard = makeStallGuard({ workspaceRoot, scratchDir: evidenceDir, sinceMs: startMs, scope: () => ({ cwd: withProject ? project : undefined, robotName: run }) });
                const answer = await chatTurn(page, {
                    // The outer CLI requires a metadata directory even when the worker receives no project grant.
                    robot: run, project: withProject ? path.basename(project) : '.', prompt, check: withProject ? guard : null,
                    beforeSend: async (chatPage) => {
                        const previousLink = await chatPage.locator('#sessionSettingsLink').getAttribute('href');
                        await expect(chatPage.locator('#sessionsBtn')).toBeEnabled();
                        await chatPage.locator('#sessionsBtn').click();
                        await expect(chatPage.locator('#sessionList .wa-session-list-new')).toBeVisible();
                        await chatPage.locator('#sessionList .wa-session-list-new').click();
                        await expect.poll(async () => {
                            try {
                                freshSkillConversation({ previousLink, selectedLink: await chatPage.locator('#sessionSettingsLink').getAttribute('href'), origin: smokeConfig.baseURL, robotId: robot.id });
                                return true;
                            } catch { return false; }
                        }).toBe(true);
                        const fresh = freshSkillConversation({ previousLink, selectedLink: await chatPage.locator('#sessionSettingsLink').getAttribute('href'), origin: smokeConfig.baseURL, robotId: robot.id });
                        save('fresh-conversation.json', fresh);
                        const settings = await openConversationSkills(chatPage);
                        let selectionError = null;
                        try {
                            const context = conversationFromSkillsURL(await chatPage.locator('#sessionSettingsLink').getAttribute('href'), smokeConfig.baseURL, { robotId: robot.id });
                            sessionId = context.sessionId;
                            expect(sessionId).toBe(fresh.sessionId);
                            const initial = await conversationSkillsState(settings);
                            expect(initial.robotId).toBe(robot.id);
                            expect(initial.sessionId).toBe(sessionId);
                            const markers = initial.items.filter((entry) => entry.name === skillName);
                            expect(markers, 'The registered marker skill is available for this exact fresh conversation').toHaveLength(1);
                            if (!markers[0].enabled) await setConversationSkill(settings, markers[0].identity, true);
                            const selected = await refreshConversationSkills(settings);
                            expect(selected.robotId).toBe(robot.id);
                            expect(selected.sessionId).toBe(sessionId);
                            expect(selected.items.filter((entry) => entry.identity === markers[0].identity && entry.name === skillName && entry.enabled)).toHaveLength(1);
                            save('conversation-selection.json', { initial, selected });
                        } catch (error) { selectionError = error; }
                        const selectionCleanupErrors = [];
                        try { await settings.close(); } catch (error) { selectionCleanupErrors.push(error); }
                        throwScenarioFailures(selectionError, selectionCleanupErrors);
                        const current = conversationFromSkillsURL(await chatPage.locator('#sessionSettingsLink').getAttribute('href'), smokeConfig.baseURL, { robotId: robot.id });
                        expect(current.sessionId, 'Sending stays in the conversation whose skill policy was selected').toBe(sessionId);
                        turnStartedMs = Date.now();
                    },
                });
                const ledger = readLedger({ workspaceRoot, scratchDir: evidenceDir, robotName: run });
                save('ledger.json', ledger);
                save('answer.txt', answer);
                const execution = scopedSkillTurn(ledger, { sinceMs: turnStartedMs, cwd: withProject ? project : '', sessionId });
                if (!withProject) assertNoProjectGrant(execution);
                assertAdmittedMarker(execution, { name: skillName, path: fs.realpathSync(path.join(repository, skillName)) });
                expect(answer, 'Only marker.txt supplied this nonce').toContain(nonce);
                const outputs = toolOutputs(execution);
                save('tool-outputs.json', outputs);
                expect(outputs.map(({ text }) => text).join(''), 'Raw ALA tool outputs identify the skill view read immediately followed by its marker contents').toContain(`READ_PATH=/run/robo-work/skills/nonce-marker\n${nonce}`);
            } catch (error) { primaryError = error; }
            const cleanupErrors = [];
            const cleanup = async (action) => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
            await cleanup(() => stopChatTurn(page));
            await cleanup(() => {
                const after = projectManifest(project, { ignoreRootRuntime: true });
                save('project-after.json', after);
                expect(after, 'Every authored file and skill tree is unchanged; only exact root runtime state is reserved').toEqual(before);
            });
            if (robot) await cleanup(async () => {
                const events = [];
                try {
                    await deleteOwnSkillRobotAfterChat({
                        robot, ownedNamePrefix: run,
                        detachOwnChat: () => page.goto(ROBOTEAM_BASE_PATH, { waitUntil: 'load' }),
                        readLedger: () => readLedger({ workspaceRoot, scratchDir: evidenceDir, robotName: run }),
                        removeRobot: (robotId) => postQuietly(page, ROBOTEAM_BASE_PATH, 'api/control', { robotId, operation: 'robot-delete' }),
                        record: (event) => events.push(event),
                        confirmAbsent: async ({ workerRobotId, ledger }) => {
                            expect(fs.existsSync(path.join(workspaceRoot, '.data/robo-work/robots', workerRobotId))).toBe(false);
                            const containers = discoverContainers({ workspaceRoot });
                            for (const row of ledger.executions) for (const blocker of row.blockers.filter((entry) => entry.process_bearing)) {
                                const marker = markerOf(blocker);
                                expect(marker).toBeTruthy();
                                expect(workerProcesses(containers, marker), 'Deleted skill robot has no marked execution process').toEqual([]);
                            }
                            const listed = await roboTeamApi(page, { path: 'api/robots' });
                            expect(listed.status).toBe(200);
                            expect(listed.payload.robots.some((entry) => entry.id === robot.id || entry.name === robot.name)).toBe(false);
                        },
                    });
                    robotDeleted = true;
                } finally { save('robot-cleanup.json', events); }
            });
            // Retain a still-active robot's sources on failure; its read grants may still name these paths.
            if (!robot || robotDeleted) await cleanup(() => {
                for (const directory of [repository, project]) removeRunDirectory({ workspaceRoot, name: path.basename(directory), prefixes: ['e2e-h-'] });
            });
            await cleanup(() => save('cleanup-errors.json', cleanupErrors.map((error) => ({ name: error.name, message: error.message }))));
            throwScenarioFailures(primaryError, cleanupErrors);
        });
    }
});

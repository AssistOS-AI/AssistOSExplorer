import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { signIn } from '../lib/auth.mjs';
import { ROBOTEAM_BASE_PATH, roboTeamApi } from '../lib/conversation-skills.mjs';
import { discoverContainers, readLedger, removeRunDirectory } from '../lib/robowork-e2e.mjs';
import { apiOk, makeStallGuard, toolOutputs } from '../lib/robowork-scenarios.mjs';
import { chatTurn, stopChatTurn, applySelectedModel, postQuietly } from '../lib/robowork-interaction.mjs';
import { projectManifest, runtimeIdentity, requireRoboWorkGateFlags } from '../lib/robowork-terminal.mjs';

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
            const before = projectManifest(project);
            save('project-before.json', before);
            save('environment.json', runtimeIdentity(discoverContainers({ workspaceRoot })));
            let robot;
            let ended = false;
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
                const answer = await chatTurn(page, { robot: run, project: withProject ? path.basename(project) : '', prompt, check: withProject ? guard : null });
                const ledger = readLedger({ workspaceRoot, scratchDir: evidenceDir, robotName: run });
                const executions = ledger.executions.filter((row) => row.created_at >= startMs);
                save('ledger.json', ledger);
                save('answer.txt', answer);
                expect(executions.length, 'The new robot admitted exactly one task').toBe(1);
                expect(executions[0].state).toBe('completed');
                ended = true;
                if (withProject) expect(executions[0].specification.cwd).toBe(project);
                else expect(executions[0].specification.cwd || '').toBe('');
                expect(answer, 'Only marker.txt supplied this nonce').toContain(nonce);
                const outputs = toolOutputs(executions[0]);
                save('tool-outputs.json', outputs);
                expect(outputs.map(({ text }) => text).join(''), 'Raw ALA tool outputs identify the skill view read immediately followed by its marker contents').toContain(`READ_PATH=/run/robo-work/skills/nonce-marker\n${nonce}`);
            } finally {
                await stopChatTurn(page);
                const after = projectManifest(project);
                save('project-after.json', after);
                // Persist both manifests even when the model failed, then make a mutation fail the run.
                expect(after).toEqual(before);
                await page.goto(ROBOTEAM_BASE_PATH, { waitUntil: 'load' });
                if (robot && ended) {
                    const removed = await postQuietly(page, ROBOTEAM_BASE_PATH, 'api/control', { robotName: robot.name, operation: 'robot-delete' });
                    save('robot-cleanup.json', removed);
                    expect(removed.status).toBe(200);
                }
                // Retain a still-active robot's sources on failure; its read grants may still name these paths.
                if (!robot || ended) {
                    for (const directory of [repository, project]) removeRunDirectory({ workspaceRoot, name: path.basename(directory), prefixes: ['e2e-h-'] });
                }
            }
        });
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RobotStore } from '../server/robot-store.mjs';
import { RobotSkillsets } from '../server/robot-skillsets.mjs';
import { copilotSkillset } from '../server/copilot-skillset.mjs';

async function discoverSkills(roots) {
    const results = [];
    async function scan(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await scan(file);
            else if (entry.name === 'SKILL.md') {
                const text = await fs.readFile(file, 'utf8');
                results.push({ name: text.match(/^name: (.+)$/m)[1], description: text.match(/^description: (.+)$/m)[1], directoryPath: directory, filePath: file });
            }
        }
    }
    for (const root of roots) await scan(root);
    return results;
}

test('only opted-in workflow policies mount the internal read-only human input skill, including continuations', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'human-skills-'));
    const docs = path.join(root, 'DocumentationSkills');
    const folder = path.join(docs, 'skills/human-report');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'SKILL.md'), '---\nname: human-report\ndescription: Write the final report.\n---\nReport outcomes.\n');
    const store = new RobotStore({ dataDir: path.join(root, 'private') });
    await store.initialize();
    const robot = await store.create({ name: 'Worker' });
    const skillsets = new RobotSkillsets({ robotStore: store, workspaceRoot: root, discoverSkills,
        repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: docs, origin: 'local' }] } });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    assert.equal(copilotSkillset().skills.some(skill => skill.name === 'require-human-input'), false);
    const launch = flag => skillsets.start(robot, { skillSets: [], skills: [], cwd: root, allowsHumanInput: flag }, (_robot, selection) => selection);
    const plain = await launch(false);
    assert.equal((await skillsets.inventory(robot, { policyId: plain.policyId, cwd: root })).skills.some(skill => skill.name === 'require-human-input'), false);
    const failureSkill = (await skillsets.inventory(robot, { policyId: plain.policyId, cwd: root, workflowExecution: true })).skills.find(skill => skill.name === 'report-task-blocked');
    assert.equal(failureSkill.enabled, true);
    assert.equal(failureSkill.readOnly, true);
    assert.equal(copilotSkillset().skills.some(skill => skill.name === 'report-task-blocked'), false);
    const selected = await launch(true);
    const inventory = await skillsets.inventory(robot, { policyId: selected.policyId, cwd: root });
    const internal = inventory.skills.find(skill => skill.name === 'require-human-input');
    assert.equal(internal.enabled, true);
    assert.equal(internal.readOnly, true);
    const captured = await skillsets.live.capture(robot, selected.policyId, root);
    try {
        assert.ok(captured.resolvedSkills.includes('required/require-human-input'));
        assert.equal(captured.resolvedSkills.includes('required/report-task-blocked'), false);
        await fs.access(path.join(captured.catalogPath, 'require-human-input/scripts/run.mjs'));
        assert.equal((await skillsets.policies.ensure(robot, selected.policyId)).allowsHumanInput, true);
    } finally { await captured.release(); }
});

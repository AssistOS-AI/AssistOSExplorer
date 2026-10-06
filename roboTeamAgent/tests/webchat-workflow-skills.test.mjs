import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RobotStore } from '../server/robot-store.mjs';
import { RobotSkillsets } from '../server/robot-skillsets.mjs';
import { copilotSkillset } from '../server/copilot-skillset.mjs';

// Same contract as the ALA discovery the service uses: scan roots for SKILL.md.
async function discoverSkills(roots) {
    const result = [];
    async function scan(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await scan(file);
            if (entry.name === 'SKILL.md') {
                const source = await fs.readFile(file, 'utf8');
                result.push({ name: source.match(/^name: (.+)$/m)?.[1], description: source.match(/^description: (.+)$/m)?.[1],
                    directoryPath: directory, filePath: file });
            }
        }
    }
    for (const root of [roots].flat()) await scan(root);
    return result;
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-workflow-skills-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspaceRoot = path.join(root, 'workspace');
    const project = path.join(workspaceRoot, 'project');
    const documentation = path.join(workspaceRoot, 'DocumentationSkills');
    await fs.mkdir(path.join(documentation, 'skills', 'human-report'), { recursive: true });
    await fs.writeFile(path.join(documentation, 'skills', 'human-report', 'SKILL.md'), '---\nname: human-report\ndescription: Report\n---\n');
    await fs.mkdir(project, { recursive: true });
    const store = new RobotStore({ dataDir: path.join(root, 'private') });
    const skillsets = new RobotSkillsets({ robotStore: store, workspaceRoot, discoverSkills });
    skillsets.repositoriesClient = { listRepositories: async () => [{ name: 'DocumentationSkills', source: documentation, origin: 'workspace' }] };
    return { store, skillsets, project };
}

const enabled = (result) => result.entries.filter((entry) => entry.enabled).map((entry) => entry.name).sort();

test('every robot gets list-workflows and launch-workflow in WebChat, and only there', async (t) => {
    const f = await fixture(t);
    for (const name of ['default', 'Analyst']) {
        const robot = await f.store.create({ name });
        const reference = await f.skillsets.start(robot, {}, (_robot, selection) => selection);
        const policy = await f.skillsets.policies.read(robot.id, reference.policyId);
        const webchat = await f.skillsets.live.resolve(robot, policy, f.project, { workflowSkills: true });
        assert.ok(enabled(webchat).includes('list-workflows'), name);
        assert.ok(enabled(webchat).includes('launch-workflow'), name);
        assert.ok(webchat.entries.filter((entry) => ['list-workflows', 'launch-workflow'].includes(entry.name)).every((entry) => entry.required && entry.readOnly && entry.builtin));
        const blocked = webchat.entries.find(entry => entry.name === 'report-task-blocked' && entry.enabled);
        assert.equal(blocked, undefined);
        const task = await f.skillsets.live.resolve(robot, policy, f.project);
        assert.equal(enabled(task).includes('report-task-blocked'), false);
        const workflow = await f.skillsets.live.resolve(robot, policy, f.project, { workflowExecution: true });
        const failure = workflow.entries.find(entry => entry.name === 'report-task-blocked');
        assert.ok(failure?.enabled && failure.required && failure.readOnly && failure.executionOnly);
        assert.equal(enabled(task).some((skill) => ['list-workflows', 'launch-workflow'].includes(skill)), false, name);
    }
});

test('the workflow skills are not selectable members of the copilot skillset', () => {
    const names = copilotSkillset().skills.map((skill) => skill.name);
    assert.deepEqual(names.filter((name) => ['list-workflows', 'launch-workflow', 'workflow-creator', 'require-human-input'].includes(name)), []);
    assert.ok(names.includes('bash'));
});

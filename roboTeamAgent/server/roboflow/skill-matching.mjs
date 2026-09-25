import fs from 'node:fs/promises';
import path from 'node:path';
import { availableSkillsets, availableRepositories } from '../copilot-skillset.mjs';
import { repositoryClient } from '../repository-client.mjs';
import { discoverAnthropicSkills } from '../skill-descriptor.mjs';
import { readSkillsetDefinitions } from '../robot-skillsets.mjs';

export const COVERAGE_WARNING = 'No robot has these matching skillsets, add or edit a robot to ensure the workflow runs correctly';
export function canonicalSkillset(source, name) { return `${source.replace(/\/$/, '')}/${encodeURIComponent(name)}`; }
export function canonicalSkill(source, name) { return `${source.replace(/\/$/, '')}/${name}`; }
// A repository contributes either its declared skillsets or, when it declares
// none, its individual skills, mirroring robot task configuration.
export function robotSelections(robot) {
    const disabled = new Set(robot.disabledSkillsets || []);
    const selections = availableSkillsets(robot).filter(set => !disabled.has(set.id)).map(set => ({
        id: canonicalSkillset(set.repository.source, set.name), kind: 'skillset', selector: set.id, name: set.name,
        description: set.description, repositoryId: set.repository.source, repositoryName: set.repository.name,
    }));
    for (const repository of availableRepositories(robot)) {
        if ((repository.definitions || []).length) continue;
        for (const skill of repository.skills || []) selections.push({
            id: canonicalSkill(repository.source, skill.name), kind: 'skill', selector: `${repository.name}/${skill.name}`,
            name: skill.name, description: skill.description, repositoryId: repository.source, repositoryName: repository.name,
        });
    }
    return selections;
}
export function matchRobot(robot, task) {
    const sets = robotSelections(robot);
    return task.skillsets.every(id => sets.some(set => set.id === id));
}
export function coverage(graph, robots) {
    const tasks = graph.tasks.map(task => ({ taskId: task.id, matchingRobotIds: robots.filter(robot =>
        (graph.kind !== 'default' || robot.name === 'default') && matchRobot(robot, task)).map(robot => robot.id) }));
    return { warning: tasks.some(task => !task.matchingRobotIds.length), tasks,
        message: tasks.some(task => !task.matchingRobotIds.length) ? COVERAGE_WARNING : null };
}
export async function discoverWorkflowSkillsets(client) {
    client ||= await repositoryClient();
    const repositories = await client.listRepositories();
    const skillsets = [], diagnostics = [];
    for (let repository of repositories) {
        // Only dedicated skill repositories contribute workflow skillsets. Their
        // skills live under `skills/`; other directories such as `.agents/skills`
        // belong to agent instructions and are never scanned.
        if (repository.kind !== 'skills') continue;
        if (!repository.source) { diagnostics.push({ repository: repository.name, message: 'Repository source is unavailable' }); continue; }
        try {
            if (repository.origin === 'remote') {
                const prepared = await client.prepareRepository({ name: repository.name, url: repository.url || repository.source });
                repository = prepared.find(item => item.name === repository.name) || repository;
                if (repository.origin === 'remote') throw new Error('Skill repository could not be prepared');
            }
            const source = await fs.realpath(repository.source);
            const skillsRoot = path.join(source, 'skills');
            const stat = await fs.stat(skillsRoot).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
            if (!stat?.isDirectory()) continue;
            const skills = await discoverAnthropicSkills(skillsRoot, { validate: false });
            // A repository declares its skillsets either at its root or beside the
            // skill folders; both are read without validating skill names.
            const definitions = await readSkillsetDefinitions(source, skills);
            if (!definitions.length && path.resolve(source) !== path.resolve(skillsRoot)) {
                definitions.push(...await readSkillsetDefinitions(skillsRoot, skills));
            }
            if (definitions.length) for (const set of definitions) skillsets.push({ id: canonicalSkillset(source, set.name), kind: 'skillset',
                name: set.name, description: set.description, repositoryId: source, repositoryName: repository.name });
            else for (const skill of skills) skillsets.push({ id: canonicalSkill(source, skill.name), kind: 'skill', name: skill.name,
                description: skill.description, repositoryId: source, repositoryName: repository.name });
        } catch (error) { diagnostics.push({ repository: repository.name, message: error.message }); }
    }
    for (const repository of availableRepositories({ name: 'default' })) {
        const definitions = repository.definitions || [];
        if (definitions.length) for (const set of definitions) skillsets.push({ id: canonicalSkillset(repository.source, set.name), kind: 'skillset',
            name: set.name, description: set.description, repositoryId: repository.source, repositoryName: repository.name });
        else for (const skill of repository.skills || []) skillsets.push({ id: canonicalSkill(repository.source, skill.name), kind: 'skill',
            name: skill.name, description: skill.description, repositoryId: repository.source, repositoryName: repository.name });
    }
    return { skillsets: [...new Map(skillsets.map(set => [set.id, set])).values()], diagnostics };
}

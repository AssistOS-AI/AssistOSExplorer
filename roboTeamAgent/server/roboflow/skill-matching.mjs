import { availableSkillsets, availableRepositories, COPILOT_SKILLSETS, skillIsActive } from '../copilot-skillset.mjs';
import { repositoryClient } from '../repository-client.mjs';

export const COVERAGE_WARNING = 'No robot has these matching skillsets, add or edit a robot to ensure the workflow runs correctly';
// A repository contributes either its declared skillsets or, when it declares
// none, its individual skills, mirroring robot task configuration.
export function robotSelections(robot) {
    const selections = availableSkillsets(robot).filter(set => set.enabled).map(set => ({
        id: set.id, kind: 'skillset', selector: set.id, name: set.name,
        description: set.description, repositoryId: set.repository.name, repositoryName: set.repository.name,
    }));
    for (const repository of availableRepositories(robot)) {
        if ((repository.definitions || []).length) continue;
        for (const skill of repository.skills || []) {
            if (!skillIsActive(repository, skill.name)) continue;
            const id = `${repository.name}/${skill.name}`;
            selections.push({ id, kind: 'skill', selector: id, name: skill.name, description: skill.description,
                repositoryId: repository.name, repositoryName: repository.name });
        }
    }
    return selections;
}
export function matchRobot(robot, task) {
    const sets = robotSelections(robot);
    return task.skillsets.every(id => sets.some(set => set.id === id));
}
export function coverage(graph, robots) {
    const tasks = graph.tasks.filter(task => task.kind !== 'run-workflows').map(task => ({ taskId: task.id, matchingRobotIds: robots.filter(robot =>
        (graph.kind !== 'default' || robot.name === 'default') && matchRobot(robot, task)).map(robot => robot.id) }));
    return { warning: tasks.some(task => !task.matchingRobotIds.length), tasks,
        message: tasks.some(task => !task.matchingRobotIds.length) ? COVERAGE_WARNING : null };
}
export async function discoverWorkflowSkillsets(client) {
    client ||= await repositoryClient();
    const repositories = await client.listRepositories();
    const skillsets = [], diagnostics = [];
    for (let repository of repositories) {
        // Skill repositories and mixed repositories contribute what Ploinky lists for them.
        if (!['skills', 'mixed'].includes(repository.kind)) continue;
        try {
            if (repository.origin === 'remote') {
                const prepared = await client.prepareRepository({ name: repository.name, url: repository.url || repository.source });
                repository = prepared.find(item => item.name === repository.name) || repository;
                if (repository.origin === 'remote') throw new Error('Skill repository could not be prepared');
            }
            for (const warning of repository.warnings || []) diagnostics.push({ repository: repository.name, message: warning });
            const shared = { repositoryId: repository.name, repositoryName: repository.name, repositoryKind: repository.kind };
            const definitions = repository.skillsets || [];
            if (definitions.length) for (const set of definitions) skillsets.push({ id: `${repository.name}/${set.name}`, kind: 'skillset',
                name: set.name, description: set.description, skills: set.skills, ...shared });
            else for (const name of repository.skills || []) skillsets.push({ id: `${repository.name}/${name}`, kind: 'skill', name, description: '', ...shared });
        } catch (error) { diagnostics.push({ repository: repository.name, message: error.message }); }
    }
    for (const set of COPILOT_SKILLSETS) skillsets.push({ id: `copilot/${set.name}`, kind: 'skillset', name: set.name,
        description: set.description, skills: [...set.skills], repositoryId: 'copilot', repositoryName: 'copilot', repositoryKind: 'builtin' });
    return { skillsets: [...new Map(skillsets.map(set => [set.id, set])).values()], diagnostics };
}

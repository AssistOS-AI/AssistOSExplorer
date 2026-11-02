import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillError } from './skill-files.mjs';
export const copilotSkillsRoot = path.resolve(fileURLToPath(new URL('../copilot/src/skills/', import.meta.url)));
// Bundled skills RoboTeam mounts itself; they are never selectable in a skillset.
export const WEBCHAT_WORKFLOW_SKILLS = Object.freeze(['list-workflows', 'launch-workflow']);
const REQUIRED_ONLY_SKILLS = new Set(['report-task-blocked', 'workflow-creator', 'require-human-input', ...WEBCHAT_WORKFLOW_SKILLS]);
// The bundled skillset, selected as copilot/copilot.
export const COPILOT_SKILLSETS = Object.freeze([Object.freeze({ name: 'copilot',
    description: 'Use in a workflow member robot for shell operations and research.',
    skills: Object.freeze(['bash', 'launch-gpt-researcher']) })]);

export function copilotSkillset() {
    const skills = fs.readdirSync(copilotSkillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !REQUIRED_ONLY_SKILLS.has(entry.name)).map((entry) => {
        const text = fs.readFileSync(new URL(`../copilot/src/skills/${entry.name}/SKILL.md`, import.meta.url), 'utf8');
        return { name: entry.name, directory: entry.name,
            description: text.match(/^description:\s*(.+)$/m)?.[1] || entry.name };
    });
    return { name: 'copilot', description: 'Workspace shell, research and RoboFlow workflow skills.',
        source: 'builtin:copilot', builtin: true, revision: 'bundled', skills };
}

export function availableRepositories(robot) {
    const imported = (robot.skillsets || []).filter(repo => repo.name !== 'copilot');
    if (robot.name !== 'default') return imported;
    const copilot = copilotSkillset();
    const definitions = COPILOT_SKILLSETS;
    const saved = (robot.repositories || []).find(entry => entry.name === 'copilot');
    return [{ ...copilot, definitions, ...(saved ? { active: saved.skills } : {}) }, ...imported];
}

// A repository without a saved selection (the bundled copilot before its first toggle) has everything active.
export function skillIsActive(repo, name) {
    return !repo.active || repo.active.includes(name);
}

export function availableSkillsets(robot) {
    return availableRepositories(robot).flatMap(repo => (repo.definitions || []).map(definition => {
        const active = definition.skills.filter(name => skillIsActive(repo, name));
        return {
            id: `${repo.name}/${definition.name}`,
            name: definition.name,
            description: definition.description,
            repository: repo,
            enabled: active.length === definition.skills.length,
            partial: active.length > 0 && active.length < definition.skills.length,
            skills: definition.skills.map(name => repo.skills.find(skill => skill.name === name)),
        };
    }));
}

export function resolveSkillsetSelector(repositories, definitions, selector) {
    const sources = repositories.filter(repo => repo.name === selector);
    const sets = definitions.filter(set => set.id === selector);
    if (sources.length > 1 || sets.length > 1 || (sources.length && sets.length && sources[0].name !== sets[0].repository.name)) {
        throw skillError(`ambiguous skillset selector: ${selector}; rename a repository or select qualified individual skills`);
    }
    return { repository: sets[0]?.repository || sources[0], definition: sets[0] };
}

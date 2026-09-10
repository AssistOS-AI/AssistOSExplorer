import fs from 'node:fs';
import { skillsetMDParser } from './skillsetMDParser.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillError } from './skill-files.mjs';
export const copilotSkillsRoot = path.resolve(fileURLToPath(new URL('../copilot/src/skills/', import.meta.url)));

export function copilotSkillset() {
    const skills = fs.readdirSync(copilotSkillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
        const text = fs.readFileSync(new URL(`../copilot/src/skills/${entry.name}/SKILL.md`, import.meta.url), 'utf8');
        return { name: entry.name, directory: entry.name,
            description: text.match(/^description:\s*(.+)$/m)?.[1] || entry.name };
    });
    return { name: 'copilot', description: 'Workspace shell, research and robot delegation.',
        source: 'builtin:copilot', builtin: true, revision: 'bundled', skills };
}

export function availableRepositories(robot) {
    const copilot = copilotSkillset();
    const definitions = skillsetMDParser(fs.readFileSync(path.join(copilotSkillsRoot, 'skillsets.md'), 'utf8'), copilot.skills);
    return [{ ...copilot, definitions }, ...(robot.skillsets || []).filter(repo => repo.name !== 'copilot')];
}

export function availableSkillsets(robot) {
    return availableRepositories(robot).flatMap(repo => (repo.definitions || []).map((definition, index) => ({
        id: repo.builtin ? 'copilot' : `${repo.name}-set-${index + 1}`,
        name: definition.name || `set-${index + 1}`,
        description: definition.description,
        repository: repo,
        skills: definition.skills.map(name => repo.skills.find(skill => skill.name === name)),
    })));
}

export function resolveSkillsetSelector(repositories, definitions, selector) {
    const sources = repositories.filter(repo => repo.name === selector);
    const sets = definitions.filter(set => set.id === selector);
    if (sources.length > 1 || sets.length > 1 || (sources.length && sets.length && sources[0].name !== sets[0].repository.name)) {
        throw skillError(`ambiguous skillset selector: ${selector}; rename a repository or select qualified individual skills`);
    }
    return { repository: sets[0]?.repository || sources[0], definition: sets[0] };
}

import fs from 'node:fs';
import { skillsetMDParser } from './skillsetMDParser.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

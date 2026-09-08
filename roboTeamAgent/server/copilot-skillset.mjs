import fs from 'node:fs';
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

export function availableSkillsets(robot) {
    return [copilotSkillset(), ...(robot.skillsets || []).filter((set) => set.name !== 'copilot')];
}

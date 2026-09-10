import path from 'node:path';
import { skillCatalogRequest } from '../server/skill-catalog-api.mjs';
import { prepareCopilotContext } from '../server/copilot-context.mjs';
import { publicSkillsets, publicRepositories } from '../server/robot-skillsets.mjs';
import { loadAutocompleteCatalog, buildSessionCompletions, buildTaskActionCompletions } from '../copilot/src/mcp/list-slash-commands.mjs';

try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const payload = JSON.parse(raw || '{}');
    const input = payload.input || payload.arguments || payload.params?.arguments || {};
    const context = await prepareCopilotContext(input.robot || 'default', { prepareTools: !process.argv.includes('--skills') && !process.argv.includes('--set-skill') });
    const sets = publicSkillsets(context.robot);
    const inventory = await skillCatalogRequest({ skillsets: context.skillsets, robot: context.robot, input,
        mutate: process.argv.includes('--set-skill') });
    const workingDir = path.resolve(inventory.cwd);
    const catalog = { getSkills: () => inventory.skills.filter((entry) => entry.enabled) };
    const result = process.argv.includes('--skills') || process.argv.includes('--set-skill') ? { ...inventory, skillsets: sets }
        : await loadAutocompleteCatalog({ dir: workingDir, skillCatalog: catalog,
            sessionId: input.sessionId, freshSession: true, signal: AbortSignal.timeout(20000),
            sessionCompletions: buildSessionCompletions(workingDir),
            taskCompletions: Object.fromEntries(['view', 'continue', 'stop', 'model', 'login'].map((action) =>
                [action, buildTaskActionCompletions(workingDir, action)])) });
    if (result.commands) {
        const skills = result.commands.find((command) => command.name === '/skills');
        if (skills) Object.assign(skills, { usage: '/skills [list | use <sources or qualified skills> | pin | live]',
            description: 'Inspect and select the next execution catalog for this conversation.', subCommands: [
                { name: 'list', usage: '/skills list', description: 'List allowed robot skillsets' },
                { name: 'use', usage: '/skills use <names|none>', description: 'Select session skills',
                    argCompletions: [{ value: 'none', label: 'none' }, { value: 'workspace', label: 'workspace' }, ...inventory.skills.filter((entry) => entry.source === 'workspace').map((entry) => ({ value: entry.identity, label: entry.identity, description: entry.description })), ...sets.map((set) => ({ value: set.id, label: set.name, description: set.description })),
                        ...publicRepositories(context.robot).flatMap((repo) => repo.skills.map((skill) => ({ value: skill.id, label: skill.id, description: skill.description })))] },
                { name: 'pin', usage: '/skills pin', description: 'Keep the last executed catalog' },
                { name: 'live', usage: '/skills live', description: 'Capture current source files at each execution' },
            ] });
    }
    process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) { console.error(error.message); process.exitCode = 1; }

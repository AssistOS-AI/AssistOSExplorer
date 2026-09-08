import path from 'node:path';
import { prepareCopilotContext } from '../server/copilot-context.mjs';
import { publicSkillsets } from '../server/robot-skillsets.mjs';
import { toAutocompleteCatalog, buildSessionCompletions, buildTaskActionCompletions } from '../copilot/src/mcp/list-slash-commands.mjs';

try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const payload = JSON.parse(raw || '{}');
    const input = payload.input || payload.arguments || payload.params?.arguments || {};
    const context = await prepareCopilotContext(input.robot || 'default', { prepareTools: false });
    const workingDir = path.resolve(input.dir || process.env.PLOINKY_WORKSPACE_ROOT || '/workspace');
    const sets = publicSkillsets(context.robot);
    // Discovery is metadata-only. Different allowed sets may contain the same native name;
    // conflicts are rejected only when both skills are selected for an execution.
    const available = sets.flatMap((set) => set.skills.map((skill) => ({ ...skill,
        enabled: set.builtin && context.robot.name === 'default', skillDir: workingDir })));
    const catalog = { getSkills: () => available };
    const result = process.argv.includes('--skills') ? { skillsets: sets, skills: available.map((skill) => ({
        key: skill.id, name: skill.name, type: 'anthropic', isInternal: true, enabled: skill.enabled })) }
        : await toAutocompleteCatalog({ dir: workingDir, skillCatalog: catalog,
            sessionCompletions: buildSessionCompletions(workingDir),
            taskCompletions: Object.fromEntries(['view', 'continue', 'stop', 'model', 'login'].map((action) =>
                [action, buildTaskActionCompletions(workingDir, action)])) });
    if (result.commands) {
        const skills = result.commands.find((command) => command.name === '/skills');
        if (skills) Object.assign(skills, { usage: '/skills [list | use <skillsets or set/skill>]',
            description: 'Select allowed robot skillsets for this session.', subCommands: [
                { name: 'list', usage: '/skills list', description: 'List allowed robot skillsets' },
                { name: 'use', usage: '/skills use <names|none>', description: 'Select session skills',
                    argCompletions: [{ value: 'none', label: 'none' }, ...sets.flatMap((set) => [
                        { value: set.name, label: set.name, description: set.description },
                        ...set.skills.map((skill) => ({ value: skill.id, label: skill.id, description: skill.description }))])] },
            ] });
    }
    process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) { console.error(error.message); process.exitCode = 1; }

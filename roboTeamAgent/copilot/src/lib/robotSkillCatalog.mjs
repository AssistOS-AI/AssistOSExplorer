import fs from 'node:fs/promises';
import { createAnthropicSkillCatalog } from './anthropicSkillCatalog.mjs';
import { publicSkillsets, individualSkillRepositories, selectionNames } from '../../../server/robot-skillsets.mjs';
import { acquireExecutionLease } from './workspaceStateLock.mjs';

export function createRobotSkillCatalog({ context, sessionStore, workingDir, discoverTaskSkills }) {
    let current = null;
    let currentSelection = [];
    async function select(sessionId, input) {
        const robot = await context.store.get(context.robot.id);
        if (!robot) throw new Error('Robot was deleted.');
        if (robot.name === 'default') input = { ...input, skillSets: [...new Set(['copilot', ...selectionNames(input.skillSets)])] };
        return context.skillsets.start(robot, input, async (_robot, skillSelection) => {
            await sessionStore.updateSession(sessionId, (session) => { session.skillSelection = skillSelection; });
            return skillSelection;
        });
    }
    return {
        async refresh(sessionId) {
            sessionId ||= (await sessionStore.ensureCurrentSession()).sessionId;
            let selection = sessionStore.loadSession(sessionId).skillSelection;
            if (!selection) selection = await select(sessionId, { skillSets: context.robot.name === 'default' ? ['copilot'] : [] });
            const file = await context.skillsets.catalogPath(context.robot.id, selection);
            const paths = JSON.parse(await fs.readFile(file, 'utf8'));
            currentSelection = selection.paths
                ? paths.map(path => selection.resolvedSkills[selection.paths.indexOf(path)])
                : selection.resolvedSkills;
            const catalog = await createAnthropicSkillCatalog({ workingDir,
                roots: paths.map(path => ({ path, builtIn: true })), discoverTaskSkills });
            current = catalog;
            return { catalogPath: file, skills: catalog.getSkills().map((skill) => ({ ...skill, enabled: true })),
                taskRepositories: catalog.getSkills().map((skill) => skill.skillDir),
                robotCatalog: context.robot.name === 'default' ? (await context.store.list()).map(robot => ({
                    name: robot.name, description: robot.specialization, skillsets: publicSkillsets(robot),
                    skillRepositories: individualSkillRepositories(robot),
                })) : undefined };
        },
        async command(sessionId, args) {
            const input = args.trim();
            if (input && input !== 'list') {
                if (!input.startsWith('use ')) throw new Error('Usage: /skills [list | use copilot,set/skill | use none]');
                const values = input.slice(4).split(/[\s,]+/).filter(Boolean);
                const release = await acquireExecutionLease(workingDir, `session:${sessionId}`);
                try {
                    await select(sessionId, { skillSets: values.filter((name) => name !== 'none' && !name.includes('/')),
                        skills: values.filter((name) => name.includes('/')) });
                } finally { await release(); }
            }
            await this.refresh(sessionId);
            const robot = await context.store.get(context.robot.id);
            return { output: `Selected: ${currentSelection.join(', ') || 'none'}\n\nAvailable skillsets:\n`
                + publicSkillsets(robot).map((set) => `${set.description} [${set.id}]\n`
                    + `  Skills: ${set.skills.join(', ')}`).join('\n')
                + individualSkillRepositories(robot).map(repo => '\n' + repo.skills.map(skill => `  ${repo.id}/${skill.name}: ${skill.description}`).join('\n')).join('')
                + '\n\nUse /skills use copilot,repository-id/skill or /skills use none.' };
        },
        getSkills: () => current?.getSkills() || [],
        getSkill: (name) => current?.getSkill(name),
        resolveSelectedSkill: (name) => current?.resolveSelectedSkill(name),
        getEnabledSkillDirectories: () => current?.getEnabledSkillDirectories() || [],
        readSkill: (name) => current?.readSkill(name),
        removeSkill: () => { throw new Error('Manage allowed skillsets in RoboTeam; use /skills use to select skills for this session.'); },
    };
}

import { createAnthropicSkillCatalog } from './anthropicSkillCatalog.mjs';
import { publicSkillsets } from '../../../server/robot-skillsets.mjs';
import { acquireExecutionLease } from './workspaceStateLock.mjs';

export function createRobotSkillCatalog({ context, sessionStore, workingDir, discoverTaskSkills }) {
    let current = null;
    async function select(sessionId, input) {
        const robot = await context.store.get(context.robot.id);
        if (!robot) throw new Error('Robot was deleted.');
        return context.skillsets.start(robot, input, async (_robot, skillSelection) => {
            await sessionStore.updateSession(sessionId, (session) => { session.skillSelection = skillSelection; });
            return skillSelection;
        });
    }
    return {
        async refresh(sessionId) {
            sessionId ||= (await sessionStore.ensureCurrentSession()).sessionId;
            let selection = sessionStore.loadSession(sessionId).skillSelection;
            if (!selection) selection = await select(sessionId, {});
            const directory = await context.skillsets.catalogPath(context.robot.id, selection);
            const catalog = await createAnthropicSkillCatalog({ workingDir,
                roots: selection.resolvedSkills.length ? [{ path: directory, builtIn: true }] : [], discoverTaskSkills });
            current = catalog;
            return { catalogPath: directory, skills: catalog.getSkills().map((skill) => ({ ...skill, enabled: true })),
                taskRepositories: catalog.getSkills().map((skill) => skill.skillDir) };
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
            const selection = sessionStore.loadSession(sessionId).skillSelection;
            return { output: `Selected: ${selection.resolvedSkills.join(', ') || 'none'}\n\nAvailable skillsets:\n`
                + publicSkillsets(robot).map((set) => `${set.name}: ${set.description}\n`
                    + set.skills.map((skill) => `  ${skill.id}: ${skill.description}`).join('\n')).join('\n')
                + '\n\nUse /skills use copilot,set/skill or /skills use none.' };
        },
        getSkills: () => current?.getSkills() || [],
        getSkill: (name) => current?.getSkill(name),
        resolveSelectedSkill: (name) => current?.resolveSelectedSkill(name),
        getEnabledSkillDirectories: () => current?.getEnabledSkillDirectories() || [],
        readSkill: (name) => current?.readSkill(name),
        removeSkill: () => { throw new Error('Manage allowed skillsets in RoboTeam; use /skills use to select skills for this session.'); },
    };
}

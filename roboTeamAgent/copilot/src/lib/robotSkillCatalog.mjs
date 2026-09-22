import { installLiveSkills } from '../../../server/live-skill-install.mjs';
import { WorkflowRegistry, workflowCatalogEntry } from '../../../server/roboflow/workflow-registry.mjs';
import { readSkillTree } from '../../../server/skill-files.mjs';

export function createRobotSkillCatalog({ context, sessionStore, workingDir, initialSessionId }) {
    const catalogs = new Map();
    const workflows = new WorkflowRegistry();
    const workflowCatalog = async () => {
        try {
            return (await workflows.list()).map(workflowCatalogEntry);
        } catch {
            return [];
        }
    };
    async function policyFor(sessionId) {
        const session = sessionStore.loadSession(sessionId);
        const robot = await context.store.get(context.robot.id);
        if (!robot) throw new Error('Robot was deleted.');
        const policyId = session.skillPolicyRef || sessionId;
        const policy = await context.skillsets.policies.ensure(robot, policyId, { legacy: session.skillSelection });
        if (!session.skillPolicyRef || session.skillSelection) {
            await sessionStore.updateSession(sessionId, (record) => {
                record.skillPolicyRef = policyId;
                if (record.skillSelection) { record.legacySkillSelection = record.skillSelection; delete record.skillSelection; }
            });
        }
        return { robot, policyId, policy, cwd: session.engine?.cwd || session.cwd || workingDir };
    }
    const api = {
        async refresh(sessionId = initialSessionId, { execution = false, cwd } = {}) {
            sessionId ||= (await sessionStore.ensureCurrentSession()).sessionId;
            const resolved = await policyFor(sessionId);
            let snapshot;
            try { snapshot = resolved.policy.mode === 'pinned' ? await context.skillsets.pinnedInventory(resolved.robot, resolved.policy)
                : await context.skillsets.inventory(resolved.robot, { ...resolved, cwd: cwd || resolved.cwd });
            } catch (error) {
                if (execution) throw error;
                snapshot = { skills: [], policy: resolved.policy, policyVersion: resolved.policy.policyVersion, diagnostics: [{ state: 'unavailable', message: error.message }] };
            }
            catalogs.set(sessionId, snapshot.skills);
            const workflowCatalogEntries = context.robot.name === 'default' ? await workflowCatalog() : undefined;
            if (!execution) return { ...snapshot, workflowCatalog: workflowCatalogEntries };
            const captured = await installLiveSkills({ service: context.skillsets, robot: resolved.robot, policyId: resolved.policyId, cwd: cwd || resolved.cwd });
            const skills = captured.entries.map((entry) => ({ ...entry, enabled: true, type: 'anthropic',
                skillDir: entry.sourcePath, skillFile: `${entry.sourcePath}/SKILL.md` }));
            const { release, ...record } = captured;
            await sessionStore.updateSession(sessionId, (session) => {
                session.previousSkillExecution = session.skillExecution;
                session.skillExecution = { ...record, active: true };
            }).catch(async (error) => { await release(); throw error; });
            catalogs.set(sessionId, skills);
            return { ...captured, skills, workflowCatalog: workflowCatalogEntries, taskRepositories: skills.map((entry) => entry.skillDir),
                release: async () => {
                    try {
                        await sessionStore.updateSession(sessionId, (session) => {
                            if (session.skillExecution?.revision === captured.revision) session.skillExecution.active = false;
                        });
                    } finally {
                        await release();

                    }
                } };
        },
        forSession: (sessionId) => ({ ...api,
            refresh: (id = sessionId, options) => api.refresh(id, options),
            resolveSelectedSkill: (name) => api.resolveSelectedSkill(name, sessionId),
            getEnabledSkillDirectories: () => api.getEnabledSkillDirectories(sessionId),
            getSkills: () => api.getSkills(sessionId), getSkill: (name) => api.getSkill(name, sessionId),
            readSkill: (name) => api.readSkill(name, sessionId) }),
        getSkills: (sessionId = initialSessionId) => catalogs.get(sessionId) || [],
        getSkill: (name, sessionId = initialSessionId) => api.getSkills(sessionId).find((entry) => entry.name === name && entry.enabled),
        resolveSelectedSkill: (name, sessionId = initialSessionId) => api.getSkill(name, sessionId),
        getEnabledSkillDirectories: (sessionId = initialSessionId) => api.getSkills(sessionId).filter((entry) => entry.enabled).map((entry) => entry.skillDir),
        readSkill: async (name, sessionId = initialSessionId) => {
            const skill = api.getSkill(name, sessionId);
            if (!skill) throw new Error('Skill is missing, disabled or ambiguous.');
            const descriptor = (await readSkillTree(skill.skillDir, { skipDependencies: true })).find((entry) => entry.path === 'SKILL.md' && entry.type === 'file');
            if (!descriptor) throw new Error('Skill descriptor is unavailable.');
            return descriptor.data.toString('utf8');
        },
    };
    return api;
}

import { readSkillTree } from '../../../server/skill-files.mjs';
import { acquireExecutionLease } from './workspaceStateLock.mjs';

export function createRobotSkillCatalog({ context, sessionStore, workingDir, initialSessionId }) {
    const catalogs = new Map();
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
            if (!execution) return snapshot;
            const captured = await context.skillsets.live.capture(resolved.robot, resolved.policyId, cwd || resolved.cwd);
            const skills = captured.entries.map((entry) => ({ ...entry, enabled: true, type: 'anthropic',
                skillDir: `${captured.catalogPath}/${entry.name}`, skillFile: `${captured.catalogPath}/${entry.name}/SKILL.md` }));
            const { release, ...record } = captured;
            await sessionStore.updateSession(sessionId, (session) => {
                session.previousSkillExecution = session.skillExecution;
                session.skillExecution = { ...record, active: true };
            }).catch(async (error) => { await release(); throw error; });
            catalogs.set(sessionId, skills);
            return { ...captured, skills, taskRepositories: skills.map((entry) => entry.skillDir),
                release: async () => {
                    try {
                        await sessionStore.updateSession(sessionId, (session) => {
                            if (session.skillExecution?.revision === captured.revision) session.skillExecution.active = false;
                        });
                    } finally {
                        await release();
                        await context.skillsets.live.collect(context.robot.id);
                    }
                } };
        },
        async command(sessionId, args) {
            const input = args.trim();
            if (input && input !== 'list') {
                const release = await acquireExecutionLease(workingDir, `session:${sessionId}`);
                try {
                    const { robot, policyId, policy, cwd } = await policyFor(sessionId);
                    if (input.startsWith('use ')) {
                        const values = input.slice(4).split(/[\s,]+/).filter(Boolean);
                        if (values.includes('none') && values.length !== 1) throw new Error('Use none alone.');
                        let next = await context.skillsets.policies.make(robot, {
                            skillSets: values.filter((name) => name !== 'none' && (!name.includes('/') || name.startsWith('workspace:'))),
                            skills: values.filter((name) => !name.startsWith('workspace:') && name.includes('/')),
                        });
                        // workspace:<path> matching a skill is individual; a catalog path is a source selector.
                        const inventory = await context.skillsets.inventory(robot, { policy: { ...next, scopeRoot: policy.scopeRoot, selectors: { skillSets: ['workspace', 'copilot'], skills: [] } }, cwd });
                        for (const value of values.filter((name) => name.startsWith('workspace:'))) {
                            if (inventory.skills.some((entry) => entry.identity === value)) {
                                next.selectors.skillSets = next.selectors.skillSets.filter((name) => name !== value);
                                next.selectors.skills.push(value);
                            }
                        }
                        Object.assign(next, { scopeRoot: policy.scopeRoot, excludedNames: policy.excludedNames, excludedSkills: policy.excludedSkills, excludedSources: policy.excludedSources, overrides: policy.overrides, excludedNameIdentities: policy.excludedNameIdentities, importedSkillNames: policy.importedSkillNames, ...(policy.legacyRecovery ? { legacyRecovery: policy.legacyRecovery } : {}) });
                        next = await context.skillsets.policies.rememberNameExclusions(robot, next, cwd, inventory.skills);
                        await context.skillsets.live.resolve(robot, next, cwd);
                        await context.skillsets.policies.update(robot.id, policyId, policy.policyVersion, () => next);
                    } else if (input === 'pin' || input === 'live') {
                        const previous = sessionStore.loadSession(sessionId).skillExecution || policy.legacyRecovery;
                        if (input === 'pin' && !previous) throw new Error('Execute a catalog before pinning it.');
                        if (input === 'pin') await context.skillsets.catalogPath(robot.id, previous);
                        await context.skillsets.policies.update(robot.id, policyId, policy.policyVersion, (next) => {
                            next.mode = input === 'pin' ? 'pinned' : 'live';
                            next.pinnedCatalog = input === 'pin' ? previous : null;
                            return next;
                        });
                    } else if (input.startsWith('allow-name ') || input.startsWith('deny-name ')) {
                        const name = input.slice(input.indexOf(' ') + 1).trim();
                        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Use a native skill name.');
                        let next = structuredClone(policy);
                        next.excludedNames = next.excludedNames.filter((value) => value !== name);
                        if (input.startsWith('deny-name ')) next.excludedNames.push(name);
                        next = await context.skillsets.policies.rememberNameExclusions(robot, next, cwd);
                        await context.skillsets.policies.update(robot.id, policyId, policy.policyVersion, () => next);
                    } else if (input.startsWith('override ')) {
                        const [source, local] = input.slice(9).split(/\s+/);
                        if (!robot.skillsets?.some((set) => set.name === source && set.source.startsWith('https://')) || !local?.startsWith('workspace:')) {
                            throw new Error('Usage: /skills override <remote-set> <workspace:catalog-path>');
                        }
                        const inventory = await context.skillsets.live.resolve(robot, { ...policy, selectors: { skillSets: ['workspace'], skills: [] } }, cwd);
                        if (!inventory.entries.some((entry) => entry.sourceId === local && entry.state !== 'invalid')) throw new Error('Local override catalog is unavailable or invalid.');
                        await context.skillsets.policies.update(robot.id, policyId, policy.policyVersion, (next) => {
                            next.overrides[source] = local;
                            if (!next.selectors.skillSets.includes(local)) next.selectors.skillSets.push(local);
                            next.mode = 'live'; next.pinnedCatalog = null;
                            return next;
                        });
                    } else throw new Error('Usage: /skills [list | use workspace,copilot,set/skill | use none | pin | live | allow-name <name> | deny-name <name> | override <remote-set> <workspace:catalog>]');
                } finally { await release(); }
            }
            const snapshot = await api.refresh(sessionId);
            return { output: `Next execution (${snapshot.policy.mode}, policy ${snapshot.policyVersion}):\n`
                + snapshot.skills.map((skill) => `${skill.state} ${skill.identity}: ${skill.description || skill.error || ''}`).join('\n')
                + '\n' + snapshot.diagnostics.map((item) => `${item.state}: ${item.message}`).join('\n') };
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
        removeSkill: () => { throw new Error('Use /skills use to select this conversation\'s skills.'); },
    };
    return api;
}

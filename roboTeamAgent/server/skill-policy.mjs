import { findProjectRecord } from './project-storage.mjs';
import { availableRepositories, availableSkillsets, resolveSkillsetSelector } from './copilot-skillset.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hashValue, inside, skillError } from './skill-files.mjs';

export function selectorNames(value, individual = false) {
    if (value === undefined || value === null) return [];
    const values = typeof value === 'string' ? value.split(',').filter((item) => item.trim()) : value;
    if (!Array.isArray(values) || values.length > 100) throw skillError('skills must be a string or an array of at most 100 names');
    return [...new Set(values.map((item) => {
        if (typeof item !== 'string') throw skillError('invalid skill selector');
        const name = item.trim();
        if (!(individual ? /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/ : /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[^/\x00-\x1f][^\x00-\x1f]{0,99})?$/).test(name)) {
            throw skillError('invalid skillset or qualified skill selector');
        }
        return name;
    }))];
}

export class SkillPolicies {
    constructor(service) { this.service = service; }
    directory(robotId) { return path.join(this.service.robotStore.robotPath(robotId), 'runtime', 'skill-policies'); }
    file(robotId, id) {
        if (!/^(?:[a-f0-9-]{36}|defaults-[a-f0-9]{64})$/.test(id)) throw skillError('invalid skill policy reference');
        return path.join(this.directory(robotId), `${id}.json`);
    }
    async read(robotId, id) {
        try {
            const handle = await fs.open(this.file(robotId, id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
                const policy = JSON.parse(await handle.readFile('utf8'));
                if (policy.version !== 2 || !Number.isSafeInteger(policy.policyVersion) || policy.policyVersion < 1
                    || !['live', 'pinned'].includes(policy.mode) || !path.isAbsolute(policy.scopeRoot)
                    || !policy.selectors || !Array.isArray(policy.selectors.skillSets) || !Array.isArray(policy.selectors.skills)
                    || !policy.bindings || typeof policy.bindings !== 'object' || Array.isArray(policy.bindings)
                    || !policy.overrides || typeof policy.overrides !== 'object' || Array.isArray(policy.overrides)
                    || !Array.isArray(policy.excludedSources) || !Array.isArray(policy.excludedSkills) || !Array.isArray(policy.excludedNames)) {
                    throw skillError('invalid stored skill policy');
                }
                selectorNames(policy.selectors.skillSets);
                selectorNames(policy.selectors.skills, true);
                if (![...policy.excludedSources, ...policy.excludedSkills, ...policy.excludedNames].every((value) => typeof value === 'string')) throw skillError('invalid stored skill exclusions');
                return policy;
            } finally { await handle.close(); }
        } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    async scope() {
        const workspace = await fs.realpath(this.service.workspaceRoot);
        const scope = await fs.realpath(this.service.scopeRoot || workspace);
        if (!inside(workspace, scope)) throw skillError('trusted skill scope is outside the workspace');
        return scope;
    }
    async make(robot, input = {}, legacy = null) {
        const scopeRoot = await this.scope();
        const explicit = ['skillSets', 'skillset', 'skills'].some((key) => input[key] !== undefined);
        let sets = selectorNames(legacy?.skillSets ?? input.skillSets);
        sets = [...new Set([...sets, ...selectorNames(input.skillset)])];
        let skills = selectorNames(legacy?.skills ?? input.skills, true);
        const diagnostics = [];
        // The default robot always mounts the copilot skillset (bash and
        // launch-gpt-researcher). WebChat adds list-workflows and launch-workflow.
        if (!legacy && !explicit && robot.name === 'default') { sets = ['copilot']; skills = []; }
        let excludedNames = [];
        try {
            const settings = JSON.parse(await fs.readFile(path.join(this.service.robotStore.robotPath(robot.id), 'copilot', 'settings.json'), 'utf8'));
            excludedNames = (settings.disabledSkills || []).filter((name) => typeof name === 'string');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const bindings = {};
        const repositories = availableRepositories(robot);
        const definitions = availableSkillsets(robot);
        const requested = [
            ...sets.map(selector => ({
                selector, repository: resolveSkillsetSelector(repositories, definitions, selector).repository,
            })),
            ...skills.map(identity => {
                const selector = identity.split('/')[0];
                return { selector, repository: repositories.find(repo => repo.name === selector) };
            }),
        ];
        for (const { selector, repository: set } of requested) {
            if (set?.builtin) continue;
            const name = set?.name || selector;
            const proof = legacy?.sourceBindings?.[name];
            if (!set || (legacy && (!legacy.revisions?.[name] || legacy.revisions[name] !== (set.revision || set.digest)
                || !proof || proof.source !== set.source || proof.generation !== set.generation))) {
                if (!legacy) throw skillError(`skillset is not available for this robot: ${selector}`);
                bindings[name] = { unavailable: true };
                diagnostics.push({ state: 'migration-required', message: `Original source for ${name} cannot be proven; reselect a source or explicitly pin the recovery catalog.` });
            } else bindings[name] = { source: set.source, generation: set.generation };
        }
        const policy = { ...(input?.allowsHumanInput === true ? { allowsHumanInput: true } : {}), ...(input?.workflowCreator === true ? { workflowCreator: true } : {}), version: 2, policyVersion: 1, mode: 'live', scopeRoot, selectors: { skillSets: sets, skills }, bindings,
            excludedSkills: [], excludedSources: [], excludedNames, overrides: {}, diagnostics,
            ...(legacy ? { legacyRecovery: structuredClone(legacy) } : {}) };
        return policy;
    }
    async ensure(robot, id, { input, legacy, useDefaults = true } = {}) {
        const existing = await this.read(robot.id, id);
        if (existing) return existing;
        // The saved conversation outranks a copied terminal-task request during lazy migration.
        try {
            const file = /^[a-f0-9-]{36}$/.test(id) && findProjectRecord({ dataDir: this.service.robotStore.dataDir, workspaceRoot: this.service.workspaceRoot }, 'session', id);
            if (!file) throw Object.assign(new Error('Conversation not found'), { code: 'ENOENT' });
            const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try { const session = JSON.parse(await handle.readFile('utf8')); legacy = session.skillSelection || session.legacySkillSelection || legacy; }
            finally { await handle.close(); }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        let policy;
        if (useDefaults && !legacy && !input) policy = await this.read(robot.id, `defaults-${hashValue(await this.scope())}`);
        policy = policy ? { ...policy, policyVersion: 1 } : await this.make(robot, input, legacy);
        return this.service.robotStore.withRobot(robot.id, async () => {
            const current = await this.read(robot.id, id);
            if (current) return current;
            await fs.mkdir(this.directory(robot.id), { recursive: true, mode: 0o700 });
            await atomicJson(this.file(robot.id, id), policy);
            return policy;
        });
    }
    async update(robotId, id, expected, change) {
        return this.service.robotStore.withRobot(robotId, async () => {
            const current = await this.read(robotId, id);
            if (!current || current.policyVersion !== expected) throw Object.assign(skillError('skill policy changed; reload before updating'), { statusCode: 409 });
            const updated = await change(structuredClone(current));
            updated.policyVersion = current.policyVersion + 1;
            await atomicJson(this.file(robotId, id), updated);
            return updated;
        });
    }
}

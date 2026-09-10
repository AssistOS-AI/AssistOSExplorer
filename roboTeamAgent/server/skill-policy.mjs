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
        if (name.startsWith('workspace:')) {
            const relative = name.slice(10);
            if (!relative || relative.length > 2048 || relative.startsWith('/') || relative.includes('\\')
                || relative.split('/').some((part) => !part || part === '.' || part === '..') || /[\x00-\x1f]/.test(relative)) {
                throw skillError('invalid workspace skill selector');
            }
        } else if (!(individual ? /^[a-z0-9-]+\/[a-z0-9-]+$/ : /^[a-z0-9]+(?:-[a-z0-9]+)*$/).test(name)) {
            throw skillError('invalid skillset or qualified skill selector');
        }
        return name;
    }))];
}

function validateExcludedNameIdentities(policy) {
    const identities = policy.excludedNameIdentities;
    if (identities === undefined) return;
    if (!identities || typeof identities !== 'object' || Array.isArray(identities)
        || Object.entries(identities).some(([identity, name]) => {
            if (!identity.startsWith('workspace:') || typeof name !== 'string'
                || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !policy.excludedNames.includes(name)) return true;
            try { selectorNames([identity], true); return false; } catch { return true; }
        })) throw skillError('invalid stored name-exclusion identity provenance');
}

function validateImportedSkillNames(policy) {
    const sources = policy.importedSkillNames;
    if (sources === undefined) return;
    const invalid = () => { throw skillError('invalid stored imported skill name provenance'); };
    if (!sources || typeof sources !== 'object' || Array.isArray(sources) || Object.keys(sources).length > 32) invalid();
    let count = 0;
    for (const [name, proof] of Object.entries(sources)) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || ['workspace', 'copilot'].includes(name)
            || !proof || typeof proof !== 'object' || Array.isArray(proof)
            || Object.keys(proof).sort().join(',') !== 'generation,names,source'
            || typeof proof.source !== 'string' || proof.source.length > 2048 || /[\x00-\x1f]/.test(proof.source)
            || !path.isAbsolute(proof.source) || path.resolve(proof.source) !== proof.source
            || typeof proof.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(proof.generation)
            || !proof.names || typeof proof.names !== 'object' || Array.isArray(proof.names)) invalid();
        for (const [directory, nativeName] of Object.entries(proof.names)) {
            if (++count > 5000 || directory.length > 2048 || directory.includes('\\') || /[\x00-\x1f]/.test(directory)
                || (directory !== '' && (directory.startsWith('/') || directory.split('/').some(part => !part || part === '.' || part === '..')))
                || typeof nativeName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nativeName)) invalid();
        }
    }
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
                validateExcludedNameIdentities(policy);
                validateImportedSkillNames(policy);
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
    // Record only names proven by a valid descriptor during an explicit policy
    // mutation. Inventory reads never write state. Workspace identities encode
    // folder paths; imported names also need their source generation and directory
    // to remain identifiable when a live descriptor is temporarily malformed.
    async rememberNameExclusions(robot, policy, cwd, entries) {
        const next = { ...policy };
        const remembered = Object.fromEntries(Object.entries(policy.excludedNameIdentities || {})
            .filter(([, name]) => policy.excludedNames.includes(name)));
        if (policy.excludedNames.length || policy.excludedSkills.some(identity => !identity.startsWith('workspace:'))
            || policy.importedSkillNames) {
            entries ||= (await this.service.live.resolve(robot, {
                ...policy, selectors: { skillSets: [], skills: [] },
            }, cwd)).entries;
        }
        if (entries) {
            for (const entry of entries) {
                if (entry.source !== 'workspace' || entry.error || !entry.fingerprint) continue;
                if (policy.excludedNames.includes(entry.name)) remembered[entry.identity] = entry.name;
                else delete remembered[entry.identity];
            }
        }
        if (Object.keys(remembered).length) next.excludedNameIdentities = remembered;
        else delete next.excludedNameIdentities;
        const imported = [];
        for (const set of robot.skillsets || []) {
            if (!path.isAbsolute(set.source)) continue;
            const previous = policy.importedSkillNames?.[set.name];
            const names = new Map(Object.entries(previous?.source === set.source && previous.generation === set.generation ? previous.names : {}));
            for (const entry of entries || []) {
                if (entry.source !== set.name || entry.error || !entry.fingerprint || !inside(set.source, entry.sourcePath)) continue;
                names.set(path.relative(set.source, entry.sourcePath).split(path.sep).join('/'), entry.name);
            }
            if (names.size) imported.push([set.name, { source: set.source, generation: set.generation, names: Object.fromEntries(names) }]);
        }
        if (imported.length) next.importedSkillNames = Object.fromEntries(imported);
        else delete next.importedSkillNames;
        validateImportedSkillNames(next);
        return next;
    }
    async make(robot, input = {}, legacy = null) {
        const scopeRoot = await this.scope();
        const explicit = ['skillSets', 'skillset', 'skills'].some((key) => input[key] !== undefined);
        let sets = selectorNames(legacy?.skillSets ?? input.skillSets);
        sets = [...new Set([...sets, ...selectorNames(input.skillset)])];
        const skills = selectorNames(legacy?.skills ?? input.skills, true);
        const diagnostics = [];
        if (!legacy && !explicit && robot.name === 'default') sets = ['copilot', 'workspace'];
        if (legacy && robot.name === 'default' && sets.length === 1 && sets[0] === 'copilot' && skills.length === 0) {
            sets.push('workspace');
            diagnostics.push({ state: 'migration', message: 'Legacy nonempty copilot-only selection now includes workspace skills. Implicit and explicit bundled-only intent were historically identical; use /skills use copilot to opt out.' });
        }
        let excludedNames = [];
        try {
            const settings = JSON.parse(await fs.readFile(path.join(this.service.robotStore.robotPath(robot.id), 'copilot', 'settings.json'), 'utf8'));
            excludedNames = (settings.disabledSkills || []).filter((name) => typeof name === 'string');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const bindings = {};
        for (const name of new Set([...sets, ...skills.filter((item) => !item.startsWith('workspace:')).map((item) => item.split('/')[0])])) {
            if (name === 'copilot' || name === 'workspace' || name.startsWith('workspace:')) continue;
            const set = (robot.skillsets || []).find((entry) => entry.name === name);
            const proof = legacy?.sourceBindings?.[name];
            if (!set || (legacy && (!legacy.revisions?.[name] || legacy.revisions[name] !== (set.revision || set.digest)
                || !proof || proof.source !== set.source || proof.generation !== set.generation))) {
                if (!legacy) throw skillError(`skillset is not available for this robot: ${name}`);
                bindings[name] = { unavailable: true };
                diagnostics.push({ state: 'migration-required', message: `Original source for ${name} cannot be proven; reselect a source or explicitly pin the recovery catalog.` });
            } else bindings[name] = { source: set.source, generation: set.generation };
        }
        const policy = { version: 2, policyVersion: 1, mode: 'live', scopeRoot, selectors: { skillSets: sets, skills }, bindings,
            excludedSkills: [], excludedSources: [], excludedNames, overrides: {}, diagnostics,
            ...(legacy ? { legacyRecovery: structuredClone(legacy) } : {}) };
        return this.rememberNameExclusions(robot, policy, scopeRoot);
    }
    async ensure(robot, id, { input, legacy, useDefaults = true } = {}) {
        const existing = await this.read(robot.id, id);
        if (existing) return existing;
        // The saved conversation outranks a copied terminal-task request during lazy migration.
        try {
            const handle = await fs.open(path.join(this.service.robotStore.robotPath(robot.id), 'copilot', 'sessions', `${id}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
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

import { requireWorkspaceRoot } from './workspace-root.mjs';
import { repositoryClient } from './repository-client.mjs';
import { discoverTaskSkills } from './skill-descriptor.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { availableRepositories, availableSkillsets, copilotSkillsRoot, resolveSkillsetSelector } from './copilot-skillset.mjs';
import { skillsetMDParser } from './skillsetMDParser.mjs';
import { resolveAlaCommand } from './ala-command.mjs';
import { SkillPolicies, selectorNames } from './skill-policy.mjs';
import { LiveSkillCatalog } from './live-skill-catalog.mjs';
import { readSkillTree, catalogDigest, hashValue } from './skill-files.mjs';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[a-f0-9-]{36}$/;
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });

export const selectionNames = selectorNames;

async function treeDigest(root) {
    const hash = crypto.createHash('sha256');
    async function visit(directory) {
        for (const name of (await fs.readdir(directory)).sort()) {
            const file = path.join(directory, name);
            const stat = await fs.lstat(file);
            if (stat.isSymbolicLink()) throw invalid('skill catalog contains a symbolic link');
            hash.update(JSON.stringify([path.relative(root, file), stat.isDirectory() ? 'dir' : 'file', stat.mode & 0o111]));
            if (stat.isDirectory()) await visit(file);
            else if (stat.isFile()) hash.update(await fs.readFile(file));
            else throw invalid('skill catalog contains a special file');
        }
    }
    await visit(root);
    return hash.digest('hex');
}

export async function readSkillsetDefinitions(directory, skills) {
    let source;
    try { source = await fs.readFile(path.join(directory, 'skillsets.md'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return skillsetMDParser(source, skills);
}

export class RobotSkillsets {
    constructor({ robotStore, workspaceRoot = requireWorkspaceRoot(), scopeRoot = process.env.PLOINKY_SKILL_SCOPE, alaCommand = resolveAlaCommand(), discoverSkills, repositoriesClient = null }) {
        Object.assign(this, { robotStore, workspaceRoot, scopeRoot, alaCommand, discoverSkills });
        this.repositoriesClient = repositoriesClient;
        this.policies = new SkillPolicies(this);
        this.live = new LiveSkillCatalog(this);
    }

    async discover(directory) {
        if (!this.discoverSkills) this.discoverSkills = discoverTaskSkills;
        try { return await this.discoverSkills([directory]); }
        catch { throw invalid('skillset must contain valid, uniquely named Anthropic SKILL.md descriptors'); }
    }

    async add(robotId, input) {
        const name = input.name === undefined ? `repo-${crypto.randomUUID()}` : selectionNames([input.name])[0];
        if (!NAME.test(name) || name === 'copilot') throw invalid('invalid or reserved skill source name');
        const description = String(input.description || '').trim();
        const requestedSource = String(input.source || '').trim();
        const source = requestedSource;
        if (!source || source.length > 2048) throw invalid('invalid skillset source or description');
        const local = await this.resolveLiveRepository(source);
        const workspace = await fs.realpath(this.workspaceRoot);
        if (!local.startsWith(`${workspace}${path.sep}`)) throw invalid('skillset source must be inside the workspace');
        const dataRoot = await fs.realpath(this.robotStore.dataDir);
        if (local === dataRoot || local.startsWith(`${dataRoot}${path.sep}`) || dataRoot.startsWith(`${local}${path.sep}`)) throw invalid('skillset source cannot contain robot private data');
        await readSkillTree(local, { skipDependencies: true });
        const records = await this.discover(local);
        if (!records.length || records.length > 100) throw invalid('skillset must contain 1 to 100 skills');
        const skills = records.map(skill => ({ name: skill.name, description: skill.description,
            directory: path.relative(local, skill.directoryPath) }));
        const definitions = await readSkillsetDefinitions(local, skills);
        return this.robotStore.withRobot(robotId, async (robot, save) => {
            const available = robot.skillsets || [];
            if (available.some(set => set.name === name || set.source === local)) throw invalid('repository already exists');
            if (available.length >= 32) throw invalid('robot allows at most 32 skillsets');
            const record = { name, description, source: local, revision: null, digest: null,
                generation: crypto.randomUUID(), skills, definitions };
            const candidate = { ...robot, skillsets: [...available, record] };
            const repositories = availableRepositories(candidate);
            for (const repository of repositories) resolveSkillsetSelector(repositories, availableSkillsets(candidate), repository.name);
            await save(candidate);
            return record;
        });
    }

    async resolveLiveRepository(source) {
        if (path.isAbsolute(source)) {
            if (path.dirname(source) === path.join(this.workspaceRoot, '.ploinky', 'repos')) {
                const client = this.repositoriesClient || await repositoryClient();
                const repo = (await client.listRepositories()).find(entry => entry.name === path.basename(source));
                if (!repo || repo.origin === 'remote') throw invalid('repository is unavailable');
                return fs.realpath(repo.source);
            }
            return fs.realpath(source);
        }
        const url = new URL(source);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw invalid('use a credential-free HTTPS Git URL');
        const client = this.repositoriesClient || await repositoryClient();
        let repositories = await client.listRepositories();
        const matches = entry => entry.url?.replace(/\.git$/, '') === source.replace(/\.git$/, '');
        let repo = repositories.find(matches);
        if (!repo || repo.origin === 'remote') {
            repositories = await client.prepareRepository({ url: source, name: path.basename(url.pathname).replace(/\.git$/, '') });
            repo = repositories.find(matches);
        }
        if (!repo || repo.origin === 'remote') throw invalid('repository is unavailable');
        return fs.realpath(repo.source);
    }

    async setSkillsetEnabled(robotId, { id, enabled }) {
        if (typeof id !== 'string' || typeof enabled !== 'boolean') throw invalid('skillset id and boolean enabled are required');
        return this.robotStore.withRobot(robotId, async (robot, save) => {
            if (!availableSkillsets(robot).some(set => set.id === id)) throw invalid('skillset not found');
            const disabled = new Set(robot.disabledSkillsets || []);
            if (enabled) disabled.delete(id);
            else disabled.add(id);
            await save({ ...robot, disabledSkillsets: [...disabled] });
        });
    }

    async remove(robotId, name) {
        if (name === 'copilot') throw invalid('copilot is a reserved skill source');
        selectionNames([name]);
        return this.robotStore.withRobot(robotId, async (robot, save) => {
            const record = (robot.skillsets || []).find((set) => set.name === name);
            if (!record) throw invalid('skillset not found');
            await save({ ...robot, skillsets: robot.skillsets.filter((set) => set.name !== name) });
            // Live policies fail if they still require this source; pinned catalogs keep their captured bytes.
            if (UUID.test(record.generation)) await fs.rm(path.join(this.robotStore.robotPath(robotId), 'skillsets', record.generation), { recursive: true, force: true });
        });
    }

    // Submission stores intent only. The wrapper captures bytes under its execution lease after dequeue.
    async start(robot, input, enqueue) {
        const current = await this.robotStore.get(robot.id);
        if (!current) throw invalid('robot not found');
        const policyId = crypto.randomUUID();
        const explicit = ['skillSets', 'skillset', 'skills'].some((key) => input[key] !== undefined);
        const policy = await this.policies.ensure(current, policyId, { input: explicit ? input : { skillSets: [], skills: [] }, useDefaults: false });
        try {
            await this.live.resolve(current, policy, input.cwd || policy.scopeRoot);
            return await enqueue(current, { policyId, version: 2 });
        } catch (error) {
            await fs.rm(this.policies.file(robot.id, policyId), { force: true });
            throw error;
        }
    }

    async inventory(robot, { policyId, cwd, policy } = {}) {
        policy ||= await this.policies.read(robot.id, policyId);
        if (!policy) throw invalid('skill policy is unavailable');
        const result = await this.live.resolve(robot, policy, cwd);
        return { skills: result.entries.map((entry) => ({ ...entry, key: entry.identity, id: entry.identity,
            skillDir: entry.sourcePath, isInternal: Boolean(entry.builtin) })), diagnostics: result.diagnostics,
            policyVersion: policy.policyVersion, policy, scopeRoot: result.scopeRoot, cwd: result.cwd };
    }

    async pinnedInventory(robot, policy) {
        const directory = await this.catalogPath(robot.id, policy.pinnedCatalog);
        const entries = policy.pinnedCatalog.entries || (policy.pinnedCatalog.resolvedSkills?.length === 0 ? [] : await this.discover(directory)).map((entry) => ({ identity: `pinned/${entry.name}`, name: entry.name, description: entry.description }));
        return { skills: entries.map((entry) => ({ ...entry, enabled: true, state: 'pinned', type: 'anthropic',
            skillDir: path.join(directory, entry.name), sourcePath: path.join(directory, entry.name) })),
            policy, policyVersion: policy.policyVersion, diagnostics: policy.pinnedCatalog.diagnostics || [] };
    }

    async defaults(robot) {
        const policyId = `defaults-${hashValue(await this.policies.scope())}`;
        const policy = await this.policies.read(robot.id, policyId) || await this.policies.make(robot);
        return { policyId, policy };
    }

    async setEnabled(robot, policyId, policyVersion, identity, enabled, cwd) {
        if (typeof enabled !== 'boolean') throw invalid('enabled must be a boolean');
        const inventory = await this.inventory(robot, { policyId, cwd });
        if (inventory.policyVersion !== policyVersion) throw Object.assign(invalid('skill policy changed; reload before updating'), { statusCode: 409 });
        if (inventory.policy.mode === 'pinned') throw invalid('pinned catalogs are immutable; use /skills live before changing selection');
        const entry = inventory.skills.find((skill) => skill.identity === identity);
        if (!entry) throw invalid('skill identity is unavailable');
        let policy = structuredClone(inventory.policy);
        policy.excludedSkills = policy.excludedSkills.filter((name) => name !== identity);
        if (!enabled) policy.excludedSkills.push(identity);
        else {
            if (entry.state === 'invalid') throw invalid(entry.error || 'skill is invalid');
            if (policy.excludedSources.includes(entry.source) || policy.excludedSources.includes(entry.sourceId) || Object.hasOwn(policy.overrides, entry.source)) throw invalid('source is excluded or overridden; change the source policy explicitly');
            if (policy.excludedNames.includes(entry.name)) throw invalid('legacy name exclusion applies; remove it explicitly with /skills allow-name');
            if ((entry.state === 'conflict' || entry.state === 'shadowed' || (!policy.selectors.skillSets.includes(entry.source) && !policy.selectors.skillSets.includes(entry.sourceId)))
                && !policy.selectors.skills.includes(identity)) policy.selectors.skills.push(identity);
            if (!entry.builtin && entry.source !== 'copilot') {
                const set = robot.skillsets.find((item) => item.name === entry.source);
                if (set) policy.bindings[entry.source] = { source: set.source, generation: set.generation };
            }
        }
        // Resolve the proposed selection before committing it. Discovery and hashing
        // stay outside the registry lock; update rechecks the version under the lock.
        policy = await this.policies.rememberNameExclusions(robot, policy, cwd, inventory.skills);
        const next = await this.inventory(robot, { policy, cwd });
        const saved = await this.policies.update(robot.id, policyId, policyVersion, () => policy);
        return { ...next, policy: saved, policyVersion: saved.policyVersion };
    }

    async catalogPath(robotId, selection) {
        if (!selection || !(/^[a-f0-9]{64}$/.test(selection.catalogId) || UUID.test(selection.catalogId))) throw invalid('task has no saved skill catalog');
        const directory = path.join(this.robotStore.robotPath(robotId), 'runtime', 'skill-catalogs', selection.catalogId);
        if (await (/^[a-f0-9]{64}$/.test(selection.catalogId) ? catalogDigest(directory) : treeDigest(directory)) !== selection.digest) throw invalid('saved task skill catalog changed');
        return directory;
    }

}

export function publicSkillsets(robot, { includeDisabled = false } = {}) {
    const disabled = new Set(robot.disabledSkillsets || []);
    return availableSkillsets(robot).filter(set => includeDisabled || !disabled.has(set.id)).map(({ id, name, description, repository, skills }) => ({
        id, name, description, repositoryId: repository.name, builtin: Boolean(repository.builtin),
        ...(includeDisabled ? { enabled: !disabled.has(id) } : {}),
        skills: skills.map(skill => skill.name),
    }));
}

export function publicRepositories(robot) {
    const sets = publicSkillsets(robot, { includeDisabled: true });
    return availableRepositories(robot).map(repo => ({
        id: repo.name, source: repo.source, builtin: Boolean(repo.builtin),
        skills: repo.skills.map(({ name, description }) => ({ name, description, id: `${repo.name}/${name}` })),
        skillsets: sets.filter(set => set.repositoryId === repo.name),
    }));
}

export function individualSkillRepositories(robot) {
    return availableRepositories(robot).filter(repo => !(repo.definitions || []).length).map(repo => ({
        id: repo.name,
        skills: repo.skills.map(({ name, description }) => ({ name, description })),
    }));
}

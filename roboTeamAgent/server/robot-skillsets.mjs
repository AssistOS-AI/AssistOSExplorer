import { requireWorkspaceRoot } from './workspace-root.mjs';
import { repositoryClient } from './repository-client.mjs';
import { discoverTaskSkills } from './skill-descriptor.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { availableRepositories, availableSkillsets, skillIsActive } from './copilot-skillset.mjs';
import { resolveAlaCommand } from './ala-command.mjs';
import { SkillPolicies, selectorNames } from './skill-policy.mjs';
import { LiveSkillCatalog } from './live-skill-catalog.mjs';
import { readSkillTree, catalogDigest, hashValue } from './skill-files.mjs';

const CATALOG_TTL_MS = 2000;
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

async function skillDescription(skillPath) {
    const text = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8').catch(() => '');
    return text.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') || '';
}

// The live view of a saved robot: everything except the saved names comes from the Ploinky repository listing.
async function repositoryView(entry, repositories) {
    const repo = repositories.find(item => item.name === entry.name);
    const generation = hashValue(entry.name).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    if (!repo || repo.origin === 'remote' || !Array.isArray(repo.skills)) return { name: entry.name, source: '', generation, unavailable: true, active: entry.skills, skills: [], definitions: [] };
    const source = path.join(repo.source, 'skills');
    const skills = await Promise.all(repo.skills.map(async name => ({ name, directory: name,
        description: entry.skills.includes(name) ? await skillDescription(path.join(source, name)) : '' })));
    return { name: entry.name, source, generation, active: entry.skills, skills, definitions: repo.skillsets || [] };
}

export class RobotSkillsets {
    constructor({ robotStore, workspaceRoot = requireWorkspaceRoot(), scopeRoot = process.env.PLOINKY_SKILL_SCOPE, alaCommand = resolveAlaCommand(), discoverSkills, repositoriesClient = null }) {
        Object.assign(this, { robotStore, workspaceRoot, scopeRoot, alaCommand, discoverSkills });
        this.repositoriesClient = repositoriesClient;
        this.policies = new SkillPolicies(this);
        this.live = new LiveSkillCatalog(this);
        robotStore.hydrate = robots => this.hydrate(robots);
    }

    async discover(directory) {
        if (!this.discoverSkills) this.discoverSkills = discoverTaskSkills;
        try { return await this.discoverSkills([directory]); }
        catch { throw invalid('skillset must contain valid, uniquely named Anthropic SKILL.md descriptors'); }
    }

    async repositories({ fresh = false } = {}) {
        if (!fresh && this.listing?.expires > Date.now()) return this.listing.repositories;
        const repositories = (this.repositoriesClient || await repositoryClient()).listRepositories();
        const listing = { repositories, expires: Date.now() + CATALOG_TTL_MS };
        this.listing = listing;
        repositories.catch(() => { if (this.listing === listing) this.listing = null; });
        return repositories;
    }

    async hydrate(robots) {
        const repositories = robots.some(robot => robot.repositories?.length) ? await this.repositories().catch(() => []) : [];
        return Promise.all(robots.map(async ({ disabledSkillsets, ...robot }) => ({ ...robot, // eslint-disable-line no-unused-vars
            skillsets: await Promise.all((robot.repositories || []).filter(entry => entry.name !== 'copilot').map(entry => repositoryView(entry, repositories))) })));
    }

    // A repository is named by Ploinky. The source may be that name, its URL or its checkout path.
    async resolveRepository(source) {
        const client = this.repositoriesClient || await repositoryClient();
        const bareUrl = value => String(value || '').replace(/\.git$/, '');
        const matches = entry => entry.name === source || entry.source === source || bareUrl(entry.url) === bareUrl(source);
        let repo = (await client.listRepositories()).find(matches);
        if ((!repo || repo.origin === 'remote') && !path.isAbsolute(source)) {
            let url;
            try { url = new URL(repo?.url || source); } catch { throw invalid('repository is unavailable'); }
            if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw invalid('use a credential-free HTTPS Git URL');
            repo = (await client.prepareRepository({ url: url.href, name: repo?.name || path.basename(url.pathname).replace(/\.git$/, '') })).find(matches);
        }
        if (!repo || repo.origin === 'remote') throw invalid('repository is unavailable');
        return repo;
    }

    async add(robotId, input) {
        const source = String(input.source || '').trim();
        if (!source || source.length > 2048) throw invalid('invalid repository source');
        const repo = await this.resolveRepository(source);
        if (repo.name === 'copilot') throw invalid('copilot is a reserved skill source');
        if (!['skills', 'mixed'].includes(repo.kind) || !repo.skills?.length) throw invalid('repository has no skills');
        const local = await fs.realpath(repo.source);
        const workspace = await fs.realpath(this.workspaceRoot);
        if (!local.startsWith(`${workspace}${path.sep}`)) throw invalid('skillset source must be inside the workspace');
        const dataRoot = await fs.realpath(this.robotStore.dataDir);
        if (local === dataRoot || local.startsWith(`${dataRoot}${path.sep}`) || dataRoot.startsWith(`${local}${path.sep}`)) throw invalid('skillset source cannot contain robot private data');
        const sets = repo.skillsets || [];
        const skills = sets.length ? [...new Set(sets.flatMap(set => set.skills))] : repo.skills;
        this.listing = null;
        return this.robotStore.withRobot(robotId, async (robot, save) => {
            const available = robot.repositories || [];
            if (available.some(entry => entry.name === repo.name)) throw invalid('repository already exists');
            if (available.length >= 32) throw invalid('robot allows at most 32 repositories');
            const record = { name: repo.name, skills: [...skills].sort() };
            await save({ ...robot, repositories: [...available, record] });
            return record;
        });
    }

    // repo/set for a repository that declares skillsets, repo/skill for one that does not.
    async setSkillsetEnabled(robotId, { id, enabled }) {
        if (typeof id !== 'string' || typeof enabled !== 'boolean' || !id.includes('/')) throw invalid('selection id and boolean enabled are required');
        const separator = id.indexOf('/');
        const repoName = id.slice(0, separator), member = id.slice(separator + 1);
        const [view] = await this.hydrate([await this.robotStore.withRobot(robotId, async robot => robot)]);
        const repo = availableRepositories(view).find(item => item.name === repoName);
        if (!repo) throw invalid('repository not found');
        let members;
        if (repo.definitions?.length) {
            members = repo.definitions.find(set => set.name === member)?.skills;
            if (!members) throw invalid('skillset not found; use skillset controls for this repository');
        } else {
            if (!repo.skills.some(skill => skill.name === member)) throw invalid('skill not found');
            members = [member];
        }
        return this.robotStore.withRobot(robotId, async (robot, save) => {
            const saved = robot.repositories || [];
            const entry = saved.find(item => item.name === repoName);
            const current = new Set(entry ? entry.skills : repo.skills.map(skill => skill.name));
            for (const name of members) { if (enabled) current.add(name); else current.delete(name); }
            const record = { name: repoName, skills: [...current].sort() };
            await save({ ...robot, repositories: entry ? saved.map(item => item === entry ? record : item) : [...saved, record] });
        });
    }

    async remove(robotId, name) {
        if (name === 'copilot') throw invalid('copilot is a reserved skill source');
        return this.robotStore.withRobot(robotId, async (robot, save) => {
            if (!(robot.repositories || []).some(entry => entry.name === name)) throw invalid('repository not found');
            await save({ ...robot, repositories: robot.repositories.filter(entry => entry.name !== name) });
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

    async inventory(robot, { policyId, cwd, policy, workflowSkills = false, workflowExecution = false } = {}) {
        policy ||= await this.policies.read(robot.id, policyId);
        if (!policy) throw invalid('skill policy is unavailable');
        const result = await this.live.resolve(robot, policy, cwd, { workflowSkills, workflowExecution });
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
        if (entry.required || entry.readOnly) throw invalid('Required skills are read-only');
        let policy = structuredClone(inventory.policy);
        delete policy.importedSkillNames;
        policy.excludedSkills = policy.excludedSkills.filter((name) => name !== identity);
        if (!enabled) policy.excludedSkills.push(identity);
        else {
            if (entry.state === 'invalid') throw invalid(entry.error || 'skill is invalid');
            if (policy.excludedSources.includes(entry.source) || policy.excludedSources.includes(entry.sourceId) || Object.hasOwn(policy.overrides, entry.source)) throw invalid('source is excluded or overridden; change the source policy explicitly');
            if (policy.excludedNames.includes(entry.name)) throw invalid('legacy name exclusion applies; remove it explicitly with /skills allow-name');
            if ((entry.state === 'conflict' || entry.state === 'shadowed' || (!policy.selectors.skillSets.includes(entry.source) && !policy.selectors.skillSets.includes(entry.sourceId)))
                && !policy.selectors.skills.includes(identity)) policy.selectors.skills.push(identity);
            if (!entry.builtin && entry.source !== 'copilot') {
                const set = (robot.skillsets || []).find((item) => item.name === entry.source);
                if (set) policy.bindings[entry.source] = { source: set.source, generation: set.generation };
            }
        }
        // Resolve the proposed selection before committing it. Discovery and hashing
        // stay outside the registry lock; update rechecks the version under the lock.
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
    return availableSkillsets(robot).filter(set => includeDisabled || set.enabled).map(({ id, name, description, repository, skills, enabled, partial }) => ({
        id, name, description, repositoryId: repository.name, builtin: Boolean(repository.builtin),
        ...(includeDisabled ? { enabled, partial } : {}),
        skills: skills.map(skill => skill.name),
    }));
}

export function publicRepositories(robot) {
    const sets = publicSkillsets(robot, { includeDisabled: true });
    return availableRepositories(robot).map(repo => ({
        id: repo.name, source: repo.source, builtin: Boolean(repo.builtin),
        skills: repo.skills.map(({ name, description }) => ({ name, description, id: `${repo.name}/${name}`, enabled: skillIsActive(repo, name) })),
        skillsets: sets.filter(set => set.repositoryId === repo.name),
    }));
}

export function individualSkillRepositories(robot) {
    return availableRepositories(robot).filter(repo => !(repo.definitions || []).length).map(repo => ({
        id: repo.name,
        skills: repo.skills.filter(skill => skillIsActive(repo, skill.name)).map(({ name, description }) => ({ name, description })),
    }));
}

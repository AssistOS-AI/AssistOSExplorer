import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { availableSkillsets, copilotSkillsRoot } from './copilot-skillset.mjs';
import { workspaceSkills, inspectSkill, locality, explicitSkillDirectories } from './workspace-skill-source.mjs';
import { atomicJson, inside, hashValue, readSkillTree, treeFingerprint, writeSkillTree, catalogDigest, skillError } from './skill-files.mjs';

async function owner() {
    const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
    return { pid: process.pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
        boot: (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() };
}

async function alive(record) {
    try {
        if ((await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== record.boot) return false;
        const stat = await fs.readFile(`/proc/${record.pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === record.start;
    } catch (error) { if (error.code === 'ENOENT') return false; return true; }
}

function identitySource(identity) {
    if (identity.startsWith('workspace:')) return { identity, source: 'workspace', sourceId: path.posix.dirname(identity) };
    const [source, name] = identity.split('/');
    return { identity, source, sourceId: source, name };
}

function suppression(policy, entry) {
    const rememberedName = !entry.fingerprint || entry.error
        ? policy.excludedNameIdentities?.[entry.identity] : null;
    const nativeName = entry.error && (entry.source === 'workspace' || entry.unprovenIdentity) ? null : entry.name;
    if ((!entry.unprovenIdentity && policy.excludedSkills.includes(entry.identity)) || policy.excludedNames.includes(nativeName)
        || (rememberedName && policy.excludedNames.includes(rememberedName))
        || policy.excludedSources.includes(entry.source) || policy.excludedSources.includes(entry.sourceId)) return 'disabled';
    if (Object.hasOwn(policy.overrides, entry.source)) return 'shadowed';
    return null;
}

function importedRecord(set, policy, root, directoryPath) {
    const directory = path.relative(root, directoryPath).split(path.sep).join('/');
    const proof = policy.importedSkillNames?.[set.name];
    const remembered = proof?.source === set.source && proof.generation === set.generation
        && Object.hasOwn(proof.names, directory) ? proof.names[directory] : null;
    const registered = set.skills.find(skill => path.resolve(root, skill.directory) === directoryPath);
    return { name: remembered || registered?.name || path.basename(directoryPath), directoryPath,
        unprovenIdentity: !remembered && !registered };
}

export class LiveSkillCatalog {
    constructor(service) { this.service = service; }
    root(robotId) { return path.join(this.service.robotStore.robotPath(robotId), 'runtime', 'skill-catalogs'); }

    async resolve(robot, policy, cwd) {
        const workspace = await fs.realpath(this.service.workspaceRoot);
        const scope = await fs.realpath(policy.scopeRoot);
        if (scope !== path.resolve(policy.scopeRoot) || !inside(workspace, scope)) throw skillError('saved skill scope is outside the workspace');
        cwd = await fs.realpath(cwd || scope);
        if (!inside(workspace, cwd)) throw skillError('execution cwd is outside the workspace');
        const result = await workspaceSkills({ scopeRoot: scope, cwd, discover: (dir) => this.service.discover(dir),
            excludePaths: [this.service.robotStore.dataDir] });
        const entries = result.entries;
        const diagnostics = [...(policy.diagnostics || []), ...result.diagnostics];
        for (const set of availableSkillsets(robot)) {
            const needed = !suppression(policy, { source: set.name, sourceId: set.name })
                && (policy.selectors.skillSets.includes(set.name) || policy.selectors.skills.some((identity) =>
                    identity.startsWith(`${set.name}/`) && !suppression(policy, identitySource(identity))));
            const binding = policy.bindings[set.name];
            if (!set.builtin && needed && (!binding || binding.unavailable || binding.generation !== set.generation || binding.source !== set.source)) {
                throw skillError(`Original source for ${set.name} is unavailable; explicit reselection is required`);
            }
            try {
                const local = !set.builtin && path.isAbsolute(set.source);
                const root = await fs.realpath(set.builtin ? copilotSkillsRoot : local ? set.source
                    : path.join(this.service.robotStore.robotPath(robot.id), 'skillsets', set.generation));
                if (local && (root !== path.resolve(set.source) || !inside(scope, root) || inside(this.service.robotStore.dataDir, root))) {
                    if (needed) throw skillError(`local skillset ${set.name} is outside launch scope or its original path changed`);
                    continue;
                }
                const records = local ? (await explicitSkillDirectories(root)).map(directoryPath => importedRecord(set, policy, root, directoryPath)) : set.skills.map((skill) => ({ ...skill, directoryPath: path.resolve(root, skill.directory) }));
                for (const record of records) {
                    const sourcePath = await fs.realpath(record.directoryPath);
                    if (!inside(root, sourcePath)) throw skillError('invalid stored skill path');
                    const base = { identity: `${set.name}/${record.name}`, source: set.name, sourceId: set.name,
                        sourcePath, owner: root, name: record.name, description: record.description, type: 'anthropic', builtin: Boolean(set.builtin),
                        ...(record.unprovenIdentity ? { unprovenIdentity: true } : {}) };
                    try {
                        const inspected = await inspectSkill(sourcePath, (dir) => this.service.discover(dir));
                        const { unprovenIdentity, ...proven } = base;
                        entries.push({ ...proven, ...inspected, identity: `${set.name}/${inspected.name}`, state: 'available' });
                    }
                    catch (error) { entries.push({ ...base, state: 'invalid', error: error.message }); }
                }
            } catch (error) {
                if (needed) throw error;
                diagnostics.push({ source: set.name, state: 'invalid', message: error.message });
            }
        }
        for (const set of policy.selectors.skillSets) {
            if (suppression(policy, { source: set.startsWith('workspace:') ? 'workspace' : set, sourceId: set })) continue;
            if (set === 'workspace' || set === 'copilot') continue;
            if (set.startsWith('workspace:')) {
                if (!result.roots.some((root) => `workspace:${path.relative(scope, root).split(path.sep).join('/')}` === set)) throw skillError(`selected skill source is unavailable: ${set}`);
            } else if (!(robot.skillsets || []).some((entry) => entry.name === set)) throw skillError(`skillset is not available for this robot: ${set}`);
        }
        for (const identity of policy.selectors.skills) {
            const entry = entries.find((item) => item.identity === identity && !item.unprovenIdentity);
            if (suppression(policy, entry || identitySource(identity))) continue;
            if (!entry) throw skillError(`explicitly selected skill is unavailable: ${identity}`);
            if (entry.state === 'invalid') throw skillError(`explicitly selected skill ${identity}: ${entry.error}`);
        }
        for (const entry of entries) {
            entry.explicit = !entry.unprovenIdentity && policy.selectors.skills.includes(entry.identity);
            entry.enabled = false;
            const suppressed = suppression(policy, entry);
            if (suppressed) {
                entry.state = suppressed;
                if (suppressed === 'shadowed') entry.reason = `overridden by ${policy.overrides[entry.source]}`;
                continue;
            }
            if (entry.state === 'invalid') {
                if (entry.explicit || policy.selectors.skillSets.includes(entry.sourceId) || (entry.source !== 'workspace' && policy.selectors.skillSets.includes(entry.source))) throw skillError(`selected skill ${entry.identity}: ${entry.error}`);
                diagnostics.push({ identity: entry.identity, state: 'invalid', message: entry.error }); continue; }
            const selected = entry.explicit || policy.selectors.skillSets.includes(entry.source) || policy.selectors.skillSets.includes(entry.sourceId);
            if (!selected) continue;
            entry.state = 'selected'; entry.enabled = true;
        }
        const groups = new Map();
        for (const entry of entries.filter((item) => item.enabled)) {
            const key = entry.name.normalize('NFC').toLowerCase();
            groups.set(key, [...(groups.get(key) || []), entry]);
        }
        for (const group of groups.values()) {
            if (group.length < 2) continue;
            const explicit = group.filter((entry) => entry.explicit);
            const top = Math.max(...group.map((entry) => locality(entry, scope, cwd)));
            const local = group.filter((entry) => locality(entry, scope, cwd) === top);
            // Only workspace locality or a qualified choice settles a duplicate. No lexical winner.
            const winner = explicit.length === 1 ? explicit[0] : explicit.length === 0 && group.every((entry) => entry.source === 'workspace') && top > 0 && local.length === 1 ? local[0] : null;
            if (!winner && (explicit.length || group.some((entry) => !['workspace', 'copilot'].includes(entry.source) || (entry.source === 'workspace' && policy.selectors.skillSets.includes(entry.sourceId))))) throw skillError(`selected skills have duplicate native name: ${group[0].name}`);
            for (const entry of group) {
                if (entry === winner) continue;
                entry.enabled = false; entry.state = winner ? 'shadowed' : 'conflict';
                entry.reason = winner ? winner.identity : group.map((item) => item.identity).join(', ');
                diagnostics.push({ identity: entry.identity, state: entry.state, message: entry.reason });
            }
        }
        return { ...result, entries, diagnostics, cwd, policyVersion: policy.policyVersion };
    }

    async capture(robot, policyId, cwd) {
        const { service } = this;
        const parent = this.root(robot.id);
        const token = crypto.randomUUID();
        const leaseFile = path.join(parent, `.lease-${token}.json`);
        const reservation = { owner: await owner(), policyId, catalogId: null, stage: `.prepare-${token}` };
        await service.robotStore.withRobot(robot.id, async () => {
            await fs.mkdir(parent, { recursive: true, mode: 0o700 });
            await atomicJson(leaseFile, reservation);
        });
        let stage;
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                robot = await service.robotStore.get(robot.id);
                if (!robot) throw skillError('robot not found');
                const policy = await service.policies.read(robot.id, policyId);
                if (!policy) throw skillError('missing conversation skill policy');
                if (policy.mode === 'pinned') {
                    if (!policy.pinnedCatalog) throw skillError('pinned policy has no catalog');
                    await service.robotStore.withRobot(robot.id, async () => {
                        reservation.catalogId = policy.pinnedCatalog.catalogId;
                        await atomicJson(leaseFile, reservation);
                    });
                    const directory = await service.catalogPath(robot.id, policy.pinnedCatalog);
                    const records = policy.pinnedCatalog.entries || (policy.pinnedCatalog.resolvedSkills?.length === 0 ? [] : await service.discover(directory));
                    return { ...policy.pinnedCatalog, policyId, policyVersion: policy.policyVersion, revision: policy.pinnedCatalog.revision || policy.pinnedCatalog.digest, entries: policy.pinnedCatalog.entries || records.map((entry) => ({ identity: `pinned/${entry.name}`, name: entry.name, description: entry.description })), catalogPath: directory, release: () => fs.rm(leaseFile, { force: true }) };
                }
                const inventory = await this.resolve(robot, policy, cwd);
                stage = path.join(parent, reservation.stage);
                await fs.mkdir(stage, { mode: 0o700 });
                const captured = [];
                const budget = { bytes: 0, files: 0 };
                for (const entry of inventory.entries.filter((item) => item.enabled)) {
                    const tree = await readSkillTree(entry.sourcePath, { budget, skipDependencies: true });
                    await writeSkillTree(tree, path.join(stage, entry.name));
                    const staged = await inspectSkill(path.join(stage, entry.name), (dir) => service.discover(dir));
                    if (staged.fingerprint !== treeFingerprint(tree) || staged.name !== entry.name || staged.description !== entry.description) throw skillError('skill changed during capture');
                    captured.push({ identity: entry.identity, name: entry.name, description: entry.description, fingerprint: treeFingerprint(tree) });
                }
                const after = await this.resolve(await service.robotStore.get(robot.id), policy, cwd);
                const state = (value) => ({ entries: value.entries.map(({ identity, name, state, enabled, error }) => [identity, name, state, enabled, error]), diagnostics: value.diagnostics });
                if (hashValue(state(inventory)) !== hashValue(state(after)) || hashValue(inventory.roots) !== hashValue(after.roots)
                    || captured.some((entry) => entry.fingerprint !== after.entries.find((item) => item.identity === entry.identity)?.fingerprint)) {
                    await fs.rm(stage, { recursive: true, force: true }); stage = null; continue;
                }
                const revision = hashValue({ policy, cwd: inventory.cwd, roots: inventory.roots, captured, diagnostics: inventory.diagnostics });
                await fs.writeFile(path.join(stage, '.catalog.json'), JSON.stringify({ version: 1, revision,
                    policyVersion: policy.policyVersion, entries: captured, diagnostics: inventory.diagnostics }), { flag: 'wx', mode: 0o400 });
                const selection = { catalogId: revision, digest: await catalogDigest(stage), revision,
                    policyId, policyVersion: policy.policyVersion, resolvedSkills: captured.map((entry) => entry.identity),
                    diagnostics: inventory.diagnostics, entries: captured, cwd: inventory.cwd };
                let reused = false;
                const directory = path.join(parent, revision);
                // A preparing reservation prevents collection while reuse is verified outside the registry lock.
                try { reused = (await fs.lstat(directory)).isDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                if (reused && await catalogDigest(directory) !== selection.digest) throw skillError('stored skill revision changed');
                const published = await service.robotStore.withRobot(robot.id, async () => {
                    const current = await service.policies.read(robot.id, policyId);
                    if (current.policyVersion !== policy.policyVersion) return false;
                    if (!reused) {
                        try { await fs.rename(stage, directory); stage = null; }
                        catch (error) {
                            if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
                            // Another capture won publication; validate it after releasing the registry lock.
                            reused = true;
                        }
                    }
                    reservation.catalogId = revision;
                    await atomicJson(leaseFile, reservation);
                    return true;
                });
                if (published) {
                    if (reused && await catalogDigest(directory) !== selection.digest) throw skillError('stored skill revision changed');
                    if (stage) await fs.rm(stage, { recursive: true, force: true });
                    stage = null;
                    return { ...selection, catalogPath: path.join(parent, revision), release: () => fs.rm(leaseFile, { force: true }) };
                }
                await fs.rm(stage, { recursive: true, force: true }); stage = null;
                } catch (error) {
                    if (stage) await fs.rm(stage, { recursive: true, force: true });
                    stage = null;
                    if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code) && !/skill (?:root )?changed/.test(error.message)) throw error;
                }
            }
            throw skillError('skill sources or policy changed during capture; retry the execution');
        } catch (error) {
            if (stage) await fs.rm(stage, { recursive: true, force: true });
            await fs.rm(leaseFile, { force: true });
            throw error;
        }
    }

    async active(robotId, policyId, catalogId) {
        const root = this.root(robotId);
        for (const name of await fs.readdir(root).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
            if (!/^\.lease-[a-f0-9-]{36}\.json$/.test(name)) continue;
            try {
                const lease = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
                if (lease.policyId === policyId && lease.catalogId === catalogId && await alive(lease.owner)) return true;
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return false;
    }

    async collect(robotId, { maxAgeMs = 3600000, keep = 2 } = {}) {
        const garbage = [];
        await this.service.robotStore.withRobot(robotId, async () => {
            const parent = this.root(robotId);
            const entries = await fs.readdir(parent, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
            const protectedIds = new Set();
            for (const entry of entries.filter((item) => item.name.startsWith('.lease-'))) {
                const file = path.join(parent, entry.name);
                let lease;
                try { lease = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return; }
                if (await alive(lease.owner)) {
                    if (!lease.catalogId) return; // Preparing publication excludes collection.
                    protectedIds.add(lease.catalogId);
                } else {
                    if (/^\.prepare-[a-f0-9-]{36}$/.test(lease.stage)) garbage.push(path.join(parent, lease.stage));
                    await fs.rm(file, { force: true });
                }
            }
            for (const file of await fs.readdir(this.service.policies.directory(robotId)).catch(() => [])) {
                if (!file.endsWith('.json')) continue;
                const policy = await this.service.policies.read(robotId, file.slice(0, -5));
                for (const catalog of [policy.pinnedCatalog, policy.legacyRecovery]) if (catalog?.catalogId) protectedIds.add(catalog.catalogId);
            }
            // Keep the last two revisions of every conversation, including the one /skills pin would select.
            const sessions = path.join(this.service.robotStore.robotPath(robotId), 'copilot', 'sessions');
            for (const file of await fs.readdir(sessions).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
                if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
                let session;
                try { session = JSON.parse(await fs.readFile(path.join(sessions, file), 'utf8')); } catch { return; }
                for (const value of [session.skillExecution, session.previousSkillExecution, session.skillSelection, session.legacySkillSelection]) if (value?.catalogId) protectedIds.add(value.catalogId);
            }
            const candidates = [];
            for (const entry of entries) {
                if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
                candidates.push({ id: entry.name, mtime: (await fs.stat(path.join(parent, entry.name))).mtimeMs });
            }
            candidates.sort((a, b) => b.mtime - a.mtime);
            for (const candidate of candidates.slice(keep)) {
                if (!protectedIds.has(candidate.id) && Date.now() - candidate.mtime > maxAgeMs) {
                    const retired = path.join(parent, `.collect-${crypto.randomUUID()}`);
                    await fs.rename(path.join(parent, candidate.id), retired);
                    garbage.push(retired);
                    if (garbage.length >= 10) break;
                }
            }
        });
        for (const directory of garbage) await fs.rm(directory, { recursive: true, force: true });
    }
}

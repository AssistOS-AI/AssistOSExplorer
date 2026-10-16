import { copilotSkillsRoot } from './copilot-skillset.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { repositoryClient } from './repository-client.mjs';
import { sessionDirectory } from '../copilot/src/lib/storage/sessionPaths.mjs';
import { assertSafeAchillesPrivatePath } from '../copilot/src/lib/storage/privateDataRoot.mjs';

const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

async function legacyRobotLinks(cwd) {
    const record = path.join(cwd, '.agents', '.roboteam-links.json');
    try {
        if (!(await fs.lstat(record)).isFile()) throw new Error('Invalid robot skill installation record');
        const entries = JSON.parse(await fs.readFile(record, 'utf8'));
        if (!Array.isArray(entries)) throw new Error('Invalid robot skill installation record');
        return new Map(entries.filter(entry => typeof entry.destination === 'string' && typeof entry.linkTarget === 'string'
            && path.dirname(entry.destination) === path.join(cwd, '.agents', 'skills'))
            .map(entry => [entry.destination, entry.linkTarget]));
    } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
}

// The execution lease serializes publication for one session. Different sessions
// publish into different directories and never change the project's skill links.
export async function installLiveSkills({ service, robot, policyId, sessionId, cwd, client, workflowSkills = false, workflowExecution = false }) {
    client ||= service.repositoriesClient || await repositoryClient();
    const policy = await service.policies.read(robot.id, policyId);
    if (!policy) throw new Error('Missing conversation skill policy');
    if (policy.mode === 'pinned') throw new Error('Pinned snapshots cannot be mounted as live skills; select current skills first');
    const inventory = await service.live.resolve(robot, policy, cwd, { workflowSkills, workflowExecution });
    const repositories = await client.listRepositories();
    const entries = inventory.entries.filter(entry => entry.enabled).map(entry => ({ ...entry }));
    const options = service.workspaceRoot ? { env: { PLOINKY_WORKSPACE_ROOT: service.workspaceRoot } } : {};
    const directory = sessionDirectory(cwd, sessionId, options);
    const skillsDirectory = assertSafeAchillesPrivatePath(cwd, `sessions/${sessionId}/skills`, { ...options, type: 'directory' });
    const projectSkills = path.join(cwd, '.agents', 'skills');
    const selected = new Map();
    const legacy = await legacyRobotLinks(cwd);
    // Retain skills already supplied by the project, including directory symlinks.
    for (const name of await fs.readdir(projectSkills).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    })) {
        const file = path.join(projectSkills, name);
        // Old shared robot links are not project-authored skills. Leave them on
        // disk, but do not inherit another robot's selection into this session.
        if (legacy.has(file) && (await fs.lstat(file)).isSymbolicLink()
            && await fs.readlink(file) === legacy.get(file)) continue;
        const source = await fs.realpath(file);
        if ((await fs.stat(source)).isDirectory()) selected.set(name, source);
    }
    // A robot's explicit selection wins a name collision in its own session only.
    for (const entry of entries) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) throw new Error('Invalid robot skill name');
        let source = await fs.realpath(entry.sourcePath);
        if (entry.builtin) {
            const repository = repositories.find(repo => repo.name === 'AchillesCLI' && repo.origin !== 'remote');
            if (repository) source = await fs.realpath(path.join(repository.source, 'roboTeamAgent/copilot/src/skills',
                path.relative(entry.owner || copilotSkillsRoot, source)));
        }
        if (!(await fs.stat(source)).isDirectory()) throw new Error(`Skill source is not a directory: ${entry.name}`);
        entry.sourcePath = source;
        if (entry.executionOnly) continue;
        selected.set(entry.name, source);
    }
    const mounts = [];
    const links = [];
    const sources = new Map();
    for (const [name, source] of selected) {
        let target = sources.get(source);
        if (!target) {
            // Sources hidden by the skills overlay or private-data mask need a
            // separate sandbox path. Other links retain their canonical paths.
            target = inside(projectSkills, source) || inside(path.join(cwd, '.claude', 'skills'), source)
                || inside(path.join(cwd, '.roboteam'), source)
                ? `/workspace/roboteam-skill-${sources.size}` : source;
            sources.set(source, target);
            mounts.push({ source, target, expose: true });
        }
        links.push({ name, source, target });
    }
    const stage = await fs.mkdtemp(path.join(directory, '.skills-'));
    try {
        for (const { name, target } of links) await fs.symlink(target, path.join(stage, name), 'dir');
        // Only private session-owned files are replaced, under the execution lease.
        await fs.rm(skillsDirectory, { recursive: true, force: true });
        await fs.rename(stage, skillsDirectory);
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
    const revision = crypto.createHash('sha256').update(JSON.stringify(links)).digest('hex');
    return { entries, revision, skillsDirectory, mounts, policyVersion: policy.policyVersion,
        diagnostics: inventory.diagnostics, release: async () => {}, live: true };
}

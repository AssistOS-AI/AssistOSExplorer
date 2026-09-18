import { copilotSkillsRoot } from './copilot-skillset.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { repositoryClient } from './repository-client.mjs';

// Selection belongs to RoboTeam. Ploinky alone publishes/removes filesystem links.
export async function installLiveSkills({ service, robot, policyId, cwd, client }) {
    client ||= service.repositoriesClient || await repositoryClient();
    const policy = await service.policies.read(robot.id, policyId);
    if (!policy) throw new Error('Missing conversation skill policy');
    if (policy.mode === 'pinned') throw new Error('Pinned snapshots cannot be mounted as live skills; select current skills first');
    const inventory = await service.live.resolve(robot, policy, cwd);
    const repositories = await client.listRepositories();
    const entries = inventory.entries.filter(entry => entry.enabled);
    const repos = [];
    const sources = new Map();
    const skipped = [];
    for (const entry of entries) {
        let source = await fs.realpath(entry.sourcePath);
        if (entry.builtin) {
            const repository = repositories.find(repo => repo.name === 'AchillesCLI' && repo.origin !== 'remote');
            if (repository) {
                source = await fs.realpath(path.join(repository.source, 'roboTeamAgent/copilot/src/skills', path.relative(entry.owner || copilotSkillsRoot, source)));
                entry.sourcePath = source;
            }
        }
        if (source === path.join(cwd, '.agents', 'skills', entry.name)) continue;
        const candidates = repositories.filter(repo => repo.origin !== 'remote' && source.startsWith(`${repo.source}${path.sep}`))
            .sort((left, right) => right.source.length - left.source.length);
        const repository = candidates[0];
        // Authoring skills can live directly under the workspace `.agents/skills`
        // directory without belonging to a Ploinky repository. The client owns
        // every link it publishes, so those sources cannot be installed and are
        // reported instead of failing the whole execution.
        if (!repository) { skipped.push(entry.name); continue; }
        sources.set(path.join(cwd, '.agents', 'skills', entry.name), source);
        repos.push({ repoName: repository.name, sourcePath: path.relative(repository.source, source),
            destination: path.join(cwd, '.agents', 'skills', entry.name) });
    }
    const stateFile = path.join(cwd, '.agents', '.roboteam-links.json');
    let previous = [];
    try {
        const stat = await fs.lstat(stateFile);
        if (!stat.isFile()) throw new Error('Invalid robot skill installation record');
        previous = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        if (!Array.isArray(previous)) throw new Error('Invalid robot skill installation record');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const wanted = new Map(repos.map(entry => [entry.destination, entry]));
    const obsolete = [];
    for (const entry of previous) {
        if (typeof entry.destination !== 'string' || path.dirname(entry.destination) !== path.join(cwd, '.agents', 'skills')) throw new Error('Invalid robot skill link destination');
        const next = wanted.get(entry.destination);
        if (next && next.repoName === entry.repoName && next.sourcePath === entry.sourcePath
            && path.resolve(path.dirname(entry.destination), entry.linkTarget) === sources.get(entry.destination)) continue;
        try {
            const target = await fs.readlink(entry.destination);
            if (target === entry.linkTarget) obsolete.push(entry.destination);
        } catch (error) { if (!['ENOENT', 'EINVAL'].includes(error.code)) throw error; }
    }
    if (obsolete.length) {
        const removed = await client.remove(obsolete);
        if (removed.conflicts.length) throw new Error('Robot skill removal conflicts with existing files');
    }
    // An empty skill selection still prepares the standard directory and .claude alias.
    const result = await client.install({ repos, skillRepos: [{ destination: cwd, repoName: repositories.find(repo => repo.origin !== 'remote')?.name, skills: [] }] });
    if (result.conflicts.length) throw new Error(`Robot skill installation conflicts: ${result.conflicts.map(entry => entry.destination).join(', ')}`);
    const installed = await Promise.all(repos.map(async entry => ({ ...entry, linkTarget: await fs.readlink(entry.destination) })));
    const temporary = `${stateFile}.${crypto.randomUUID()}`;
    await fs.writeFile(temporary, JSON.stringify(installed), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, stateFile);
    const revision = crypto.createHash('sha256').update(JSON.stringify(installed)).digest('hex');
    const diagnostics = [...inventory.diagnostics];
    if (skipped.length) {
        const message = `Skills without a Ploinky repository were not installed: ${skipped.join(', ')}`;
        console.warn(`[roboTeamAgent] ${message}`);
        diagnostics.push({ state: 'unavailable', message });
    }
    return { entries, revision, policyVersion: policy.policyVersion, diagnostics,
        release: async () => {}, live: true };
}

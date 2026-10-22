import fs from 'node:fs/promises';
import path from 'node:path';
import { copilotSkillsRoot } from './copilot-skillset.mjs';
import { catalogDigest, hashValue, inside, readSkillTree, skillError, treeFingerprint, writeSkillTree } from './skill-files.mjs';

export async function recoverPathCatalog(service, robotId, selection) {
    if (!/^[a-f0-9-]{36}$/.test(selection.catalogId) || selection.digest !== undefined
        || !Array.isArray(selection.paths) || !Array.isArray(selection.resolvedSkills)
        || selection.paths.length !== selection.resolvedSkills.length) throw skillError('invalid legacy path catalog');
    const file = path.join(service.robotStore.robotPath(robotId), 'runtime', 'tasks', selection.catalogId, 'skill-catalog.json');
    const readManifest = async () => {
        const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { return await handle.readFile('utf8'); } finally { await handle.close(); }
    };
    const original = await readManifest();
    const paths = JSON.parse(original);
    if (!Array.isArray(paths) || new Set(paths).size !== paths.length || new Set(selection.paths).size !== selection.paths.length
        || paths.some(source => typeof source !== 'string' || !path.isAbsolute(source)
            || path.resolve(source) !== source || !selection.paths.includes(source))) throw skillError('legacy path catalog changed');
    const importedRoot = path.join(await fs.realpath(service.robotStore.robotPath(robotId)), 'skillsets');
    const builtinRoot = await fs.realpath(copilotSkillsRoot);
    const parent = service.live.root(robotId);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const stage = await fs.mkdtemp(path.join(parent, '.recover-'));
    const entries = [];
    const budget = { bytes: 0, files: 0 };
    try {
        for (const source of paths) {
            if (await fs.realpath(source) !== source) throw skillError('legacy skill path changed');
            const identity = selection.resolvedSkills[selection.paths.indexOf(source)];
            if (typeof identity !== 'string' || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(identity)) throw skillError('invalid legacy skill identity');
            const [repository, name] = identity.split('/');
            const relative = path.relative(importedRoot, source).split(path.sep);
            if (repository === 'copilot' ? source !== path.join(builtinRoot, name)
                : !inside(importedRoot, source) || !/^[a-f0-9-]{36}$/.test(relative[0])) throw skillError('legacy skill path is outside its permitted source');
            if (entries.some(entry => entry.name === name)) throw skillError('duplicate legacy skill name');
            const records = await service.discover(source);
            if (records.length !== 1 || records[0].name !== name || records[0].directoryPath !== source) throw skillError('legacy skill identity changed');
            const tree = await readSkillTree(source, { budget, skipDependencies: true });
            const fingerprint = treeFingerprint(tree);
            await writeSkillTree(tree, path.join(stage, name));
            const copied = await service.discover(path.join(stage, name));
            if (copied.length !== 1 || copied[0].name !== name || copied[0].description !== records[0].description) throw skillError('legacy skill changed during recovery');
            entries.push({ identity, name, description: records[0].description, fingerprint });
        }
        for (let index = 0; index < paths.length; index++) {
            if (treeFingerprint(await readSkillTree(paths[index], { skipDependencies: true })) !== entries[index].fingerprint) throw skillError('legacy skill changed during recovery');
        }
        if (await readManifest() !== original) throw skillError('legacy path catalog changed during recovery');
        const revision = hashValue({ recovery: selection.catalogId, entries });
        await fs.writeFile(path.join(stage, '.catalog.json'), JSON.stringify({ version: 1, revision, policyVersion: 1, entries, diagnostics: [] }), { flag: 'wx', mode: 0o400 });
        const digest = await catalogDigest(stage);
        const target = path.join(parent, revision);
        try { await fs.rename(stage, target); }
        catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
        if (await catalogDigest(target) !== digest) throw skillError('stored recovery catalog changed');
        return { catalogId: revision, revision, digest, entries, resolvedSkills: entries.map(entry => entry.identity), diagnostics: [] };
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

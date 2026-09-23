import fs from 'node:fs/promises';
import path from 'node:path';
import { skillError, readSkillTree, treeFingerprint } from './skill-files.mjs';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function exists(file) {
    try { return await fs.lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function inspectSkill(directory, discover) {
    const tree = await readSkillTree(directory, { skipDependencies: true });
    const descriptors = tree.filter((entry) => path.basename(entry.path) === 'SKILL.md');
    if (descriptors.length !== 1 || descriptors[0].path !== 'SKILL.md') throw skillError('nested skill descriptors are unsupported');
    const records = await discover(directory);
    if (records.length !== 1 || !NAME.test(records[0].name)) throw skillError('invalid Anthropic SKILL.md descriptor');
    return { name: records[0].name, description: records[0].description, fingerprint: treeFingerprint(tree) };
}

// An administrator's explicit imported root may have arbitrary repository layout.
// Stop at a descriptor boundary: inspectSkill rejects any descriptor nested within it.
export async function explicitSkillDirectories(root) {
    const result = [];
    let visited = 0;
    const deadline = Date.now() + 15000;
    async function visit(directory, depth = 0) {
        if (++visited > 50000 || Date.now() > deadline) throw skillError('explicit skill source exceeded its discovery budget');
        if (depth > 32) throw skillError('skillset directory nesting exceeds 32');
        if (await exists(path.join(directory, 'SKILL.md'))) { result.push(directory); return; }
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (['.git', 'node_modules'].includes(entry.name)) continue;
            if (entry.isSymbolicLink()) throw skillError('skillset cannot contain symbolic links');
            if (entry.isDirectory()) await visit(path.join(directory, entry.name), depth + 1);
        }
    }
    await visit(root);
    return result;
}

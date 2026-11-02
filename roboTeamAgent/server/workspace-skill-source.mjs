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

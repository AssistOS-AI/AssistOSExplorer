import fs from 'node:fs/promises';
import path from 'node:path';
import { inside, skillError, readSkillTree, treeFingerprint } from './skill-files.mjs';

const PRUNED = new Set(['node_modules', 'globalDeps', 'vendor', '__pycache__', 'dist', 'build', 'coverage', 'output', 'target']);
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

// Only conventional catalogs establish intent; arbitrary SKILL.md files do not.
export async function workspaceSkills({ scopeRoot, cwd, discover, excludePaths = [] }) {
    const scope = await fs.realpath(scopeRoot);
    const excluded = excludePaths.map((item) => path.resolve(item));
    const entries = [], diagnostics = [], roots = new Set();
    let visited = 0;
    const deadline = Date.now() + 15000;
    async function catalog(owner, relative) {
        const alias = path.join(owner, relative);
        let root;
        try {
            if (!await exists(alias)) return;
            root = await fs.realpath(alias);
            if (!inside(scope, root) || excluded.some((item) => inside(item, root))
                || path.relative(scope, root).split(path.sep).some((part) => ['.ploinky', '.data', '.git', 'node_modules', 'globalDeps', '.worktrees', '.cache'].includes(part))) throw skillError('catalog alias is outside skill scope');
            if (!(await fs.stat(root)).isDirectory()) throw skillError('catalog must be a directory');
            if (roots.has(root)) return;
            const children = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
            roots.add(root);
            for (const child of children) {
                if (!child.isDirectory() && !child.isSymbolicLink()) continue;
                const directory = path.join(root, child.name);
                const identity = `workspace:${path.relative(scope, directory).split(path.sep).join('/')}`;
                const base = { identity, source: 'workspace', sourcePath: directory, owner, name: child.name,
                    sourceId: `workspace:${path.relative(scope, root).split(path.sep).join('/')}`, type: 'anthropic' };
                try {
                    if (child.isSymbolicLink()) throw skillError('skill folders cannot be symbolic links');
                    if (!await exists(path.join(directory, 'SKILL.md'))) continue;
                    entries.push({ ...base, ...await inspectSkill(directory, discover), state: 'available' });
                } catch (error) {
                    entries.push({ ...base, state: 'invalid', error: error.message });
                    diagnostics.push({ identity, state: 'invalid', message: error.message });
                }
            }
        } catch (error) {
            diagnostics.push({ sourcePath: alias, state: 'invalid', message: error.message });
        }
    }
    async function walk(directory) {
        if (++visited > 50000 || Date.now() > deadline) throw skillError('workspace skill discovery exceeded its directory/time budget');
        if (excluded.some((item) => inside(item, directory))) return;
        let children;
        try {
            if (await fs.realpath(directory) !== directory) throw skillError('workspace directory changed during discovery');
            children = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (directory === scope || !['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
            diagnostics.push({ sourcePath: directory, state: 'unavailable', message: `Workspace directory excluded: ${error.code}` });
            return;
        }
        await catalog(directory, '.agents/skills');
        await catalog(directory, '.claude/skills');
        const boundary = directory === scope || children.some((entry) =>
            ['.git', 'manifest.json', 'package.json', 'ploinky-skills-manifest.json'].includes(entry.name));
        if (boundary) await catalog(directory, 'skills');
        for (const child of children) {
            if (!child.isDirectory() || child.name.startsWith('.') || PRUNED.has(child.name) || child.name === 'skills') continue;
            await walk(path.join(directory, child.name));
        }
    }
    await walk(scope);
    return { entries, diagnostics, roots: [...roots].sort(), scopeRoot: scope, cwd, visited };
}

export function locality(entry, scope, cwd) {
    if (entry.source !== 'workspace') return -1;
    if (inside(entry.owner, cwd)) return path.relative(scope, entry.owner).split(path.sep).filter(Boolean).length + 1;
    return 0;
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

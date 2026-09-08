import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getManagedRepoSkillRoot } from './repoManager.mjs';

export const builtInSkillsDir = fileURLToPath(new URL('../skills', import.meta.url));

function isDirectory(candidate) {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}

function containsDescriptor(directory) {
    if (!isDirectory(directory)) return false;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'SKILL.md') return true;
        if (entry.isDirectory() && containsDescriptor(path.join(directory, entry.name))) return true;
    }
    return false;
}

export function collectPloinkyRepoSkillRoots(workingDir = process.cwd(), env = process.env, logger = null) {
    const candidates = new Set();
    for (const value of [env.PLOINKY_WORKSPACE_ROOT, env.PLOINKY_CWD, workingDir, env.WORKSPACE_PATH]) {
        if (!String(value || '').trim()) continue;
        let current = path.resolve(value);
        for (let depth = 0; depth < 12; depth += 1) {
            candidates.add(current);
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    }
    const roots = new Set();
    for (const workspace of candidates) {
        const directory = path.join(workspace, '.ploinky', 'repos');
        if (!isDirectory(directory)) continue;
        let entries;
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
        catch (error) { logger?.warn?.(`Failed to read Ploinky repo skill roots: ${error.message}`); continue; }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const root = path.join(directory, entry.name, 'achilles-skills');
            if (isDirectory(root)) roots.add(root);
        }
    }
    return [...roots];
}

function collectPackageSkillRoots() {
    const nodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url));
    if (!isDirectory(nodeModules)) return [];
    const roots = [];
    const addPackage = (directory) => {
        for (const suffix of ['skills', 'src/skills']) {
            const root = path.join(directory, suffix);
            if (isDirectory(root)) roots.push(root);
        }
    };
    for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'achillesAgentLib' || entry.name.startsWith('.')) continue;
        const directory = path.join(nodeModules, entry.name);
        if (!entry.name.startsWith('@')) addPackage(directory);
        else for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
            if (child.isDirectory()) addPackage(path.join(directory, child.name));
        }
    }
    return roots;
}

export function resolveSkillCatalogRoots(workingDir, { skillRoots = [], env = process.env } = {}) {
    const roots = [{ path: builtInSkillsDir, builtIn: true }];
    const automatic = (values) => roots.push(...values.filter(containsDescriptor).map((root) => ({ path: root, builtIn: false })));
    automatic([path.join(workingDir, 'skills'), getManagedRepoSkillRoot(workingDir)]);
    roots.push(...skillRoots.map((root) => ({ path: path.resolve(root), builtIn: false })));
    automatic(collectPackageSkillRoots());
    automatic(collectPloinkyRepoSkillRoots(workingDir, env));
    const seen = new Set();
    return roots.filter((root) => {
        const key = path.resolve(root.path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

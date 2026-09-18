import { requireWorkspaceRoot } from '../../../server/workspace-root.mjs';
import { repositoryClient } from '../../../server/repository-client.mjs';
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
    const candidates = [requireWorkspaceRoot(env)];
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

// The Ploinky marketplace owns repository discovery. Only local skill repositories
// are mounted; remote sources stay unresolved until Ploinky checks them out.
export async function collectMarketplaceSkillRoots(logger = null) {
    let repositories;
    try {
        const client = await repositoryClient();
        repositories = await client.listRepositories();
    } catch (error) {
        logger?.warn?.(`Failed to read Ploinky marketplace repositories: ${error.message}`);
        return [];
    }
    const roots = new Set();
    for (const repository of Array.isArray(repositories) ? repositories : []) {
        if (!repository || repository.origin === 'remote' || typeof repository.source !== 'string') continue;
        if (!['skills', 'mixed'].includes(String(repository.kind || ''))) continue;
        for (const relative of ['achilles-skills', 'skills']) {
            const root = path.join(repository.source, relative);
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

export async function resolveSkillCatalogRoots(workingDir, { skillRoots = [], env = process.env } = {}) {
    const roots = [{ path: builtInSkillsDir, builtIn: true }];
    const automatic = (values) => roots.push(...values.filter(containsDescriptor).map((root) => ({ path: root, builtIn: false })));
    automatic([path.join(workingDir, 'skills'), getManagedRepoSkillRoot(workingDir)]);
    roots.push(...skillRoots.map((root) => ({ path: path.resolve(root), builtIn: false })));
    automatic(collectPackageSkillRoots());
    automatic(collectPloinkyRepoSkillRoots(workingDir, env));
    automatic(await collectMarketplaceSkillRoots());
    const seen = new Set();
    return roots.filter((root) => {
        const key = path.resolve(root.path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

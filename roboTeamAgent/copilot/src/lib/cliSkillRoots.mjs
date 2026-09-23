import { repositoryClient } from '../../../server/repository-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export async function resolveSkillCatalogRoots(workingDir, { skillRoots = [], env = process.env } = {}) {
    // RoboTeam does not scan the workspace, package folders or local checkouts for
    // skills. Automatic sources are the bundled catalog and the repositories that
    // Ploinky exposes through its marketplace endpoint; callers may still pass
    // explicit roots.
    const roots = [{ path: builtInSkillsDir, builtIn: true }];
    const automatic = (values) => roots.push(...values.filter(containsDescriptor).map((root) => ({ path: root, builtIn: false })));
    roots.push(...skillRoots.map((root) => ({ path: path.resolve(root), builtIn: false })));
    automatic(await collectMarketplaceSkillRoots());
    const seen = new Set();
    return roots.filter((root) => {
        const key = path.resolve(root.path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

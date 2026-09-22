import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The Explorer repository is installed by Ploinky under this alias.
export const EXPLORER_REPO_ALIAS = 'AchillesIDE';
export const EXPLORER_REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const enableTokens = (entry) => (typeof entry === 'string' ? entry : entry?.agent || '').trim().split(/\s+/);

// The production resolver adds the enable list of the active profile (or of
// the default profile) to `enable`. Any profile can be the active one, so
// every profile's list is walked. No manifest in the current graph declares a
// profile-level enable list, so the runtime totals still equal the resolver's.
export function enableEntries(manifest) {
    const entries = [...(manifest.enable || [])];
    for (const profile of Object.values(manifest.profiles || {})) {
        if (Array.isArray(profile?.enable)) entries.push(...profile.enable);
    }
    return entries;
}

function readManifest(file, label) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`Cannot read manifest for ${label} at ${file}: ${error.message}`);
    }
}

// Walks every manifest reachable from explorer/manifest.json. Qualified refs
// (`repo/agent`) resolve to a sibling checkout of the Explorer repository,
// except the Explorer alias, which resolves to the Explorer repository itself.
// Bare refs resolve inside the repository of the manifest that enables them.
// An edge for which `isRetired(ref)` is true is reported and not followed.
export function resolveExplorerGraph({
    explorerRepo = EXPLORER_REPO_ROOT,
    siblingsRoot = path.resolve(explorerRepo, '..'),
    isRetired = () => false,
} = {}) {
    const runtimes = new Map();
    const violations = [];
    const repoDir = (repo, enabledBy) => {
        if (repo === EXPLORER_REPO_ALIAS) return explorerRepo;
        const dir = path.join(siblingsRoot, repo);
        if (!fs.existsSync(dir)) {
            throw new Error(`Sibling repository "${repo}" enabled by ${enabledBy} is missing at ${dir}; `
                + 'check it out next to the Explorer repository before running this graph test');
        }
        return dir;
    };
    function visit(ref, fromRepo, fromRepoDir, flags, enabledBy) {
        const parts = ref.split('/');
        assert.ok(parts.length === 1 || parts.length === 2, `${enabledBy} enables unsupported ref "${ref}"`);
        const [repo, agent] = parts.length === 2 ? parts : [fromRepo, parts[0]];
        const dir = parts.length === 2 ? repoDir(repo, enabledBy) : fromRepoDir;
        const key = `${repo === EXPLORER_REPO_ALIAS ? EXPLORER_REPO_ALIAS : repo}/${agent}`;
        const known = runtimes.get(key);
        if (known) {
            flags.forEach((flag) => known.flags.add(flag));
            return;
        }
        const manifestFile = path.join(dir, agent, 'manifest.json');
        if (!fs.existsSync(manifestFile)) {
            throw new Error(`Agent "${ref}" enabled by ${enabledBy} has no manifest at ${manifestFile}`);
        }
        const manifest = readManifest(manifestFile, key);
        runtimes.set(key, { flags: new Set(flags), manifestFile });
        for (const entry of enableEntries(manifest)) {
            const [childRef, ...childFlags] = enableTokens(entry);
            assert.ok(childRef, `${key} has an empty enable entry`);
            if (isRetired(childRef)) {
                violations.push(`${key} (${manifestFile}) enables ${childRef}`);
                continue;
            }
            visit(childRef, repo, dir, childFlags, key);
        }
    }
    visit('explorer', EXPLORER_REPO_ALIAS, explorerRepo, [], 'the Explorer root');
    return { runtimes, violations };
}

export function noWaitRuntimes(runtimes) {
    return [...runtimes].filter(([, value]) => value.flags.has('no-wait')).map(([key]) => key);
}

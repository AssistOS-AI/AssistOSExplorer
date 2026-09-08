/**
 * repoManager - Manages cloned repositories within .data/achilles-cli/repos/.
 *
 * Provides add, list, and remove operations for git repositories.
 * Repositories are cloned into .data/achilles-cli/repos/<name>/ and are
 * discovered through the ALA-backed Anthropic catalog.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    assertSafeAchillesPrivatePath,
    ensureSafeAchillesPrivateDirectory,
} from './privateDataRoot.mjs';

const REPOS_SUBDIR = 'repos';

/**
 * Ensure the AchillesCLI private repository structure exists.
 * Creates .data/achilles-cli/ and .data/achilles-cli/repos/ if they do not exist.
 *
 * @param {string} [baseDir=process.cwd()] - Selected workspace directory
 * @returns {{ achillesCliDir: string, reposDir: string }}
 */
export function ensureAchillesCliDir(baseDir = process.cwd()) {
    const reposDir = ensureSafeAchillesPrivateDirectory(baseDir, REPOS_SUBDIR, {
        label: 'AchillesCLI repositories directory',
    });
    const achillesCliDir = path.dirname(reposDir);

    return { achillesCliDir, reposDir };
}

/**
 * Get the repos directory path.
 *
 * @param {string} [baseDir=process.cwd()]
 * @returns {string}
 */
export function getReposDir(baseDir = process.cwd()) {
    const { reposDir } = ensureAchillesCliDir(baseDir);
    return reposDir;
}

export function getManagedRepoSkillRoot(baseDir = process.cwd()) {
    return assertSafeAchillesPrivatePath(baseDir, REPOS_SUBDIR, {
        label: 'AchillesCLI repositories directory',
        type: 'directory',
    });
}


/**
 * Extract a repo name from a git URL.
 * Strips .git suffix and takes the last path segment.
 *
 * @param {string} url - Git repository URL
 * @returns {string}
 */
export function extractRepoNameFromUrl(url) {
    const trimmed = url.replace(/\/+$/, '');
    const parts = trimmed.split('/');
    let name = parts[parts.length - 1];
    if (name.endsWith('.git')) {
        name = name.slice(0, -4);
    }
    return name;
}

/**
 * Add (clone) a repository into .data/achilles-cli/repos/.
 *
 * @param {string} url - Git repository URL
 * @param {string} [name] - Optional name for the repo directory (derived from URL if not provided)
 * @param {string} [baseDir=process.cwd()] - Selected workspace directory
 * @returns {{ status: string, path: string, name: string }}
 */
export function addRepo(url, name, baseDir = process.cwd()) {
    if (!url || !url.trim()) {
        throw new Error('Missing repository URL.');
    }

    const repoUrl = url.trim();
    const repoName = (name && name.trim()) || extractRepoNameFromUrl(repoUrl);

    if (!repoName) {
        throw new Error('Could not determine repository name. Provide a name explicitly.');
    }
    if (repoName !== path.basename(repoName) || repoName === '.' || repoName === '..') {
        throw new Error('Repository name must be one directory name.');
    }

    ensureAchillesCliDir(baseDir);
    const repoPath = assertSafeAchillesPrivatePath(baseDir, path.join(REPOS_SUBDIR, repoName), {
        label: 'AchillesCLI repository',
        type: 'directory',
    });

    if (fs.existsSync(repoPath)) {
        const stat = fs.lstatSync(repoPath);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error('AchillesCLI repository entry is unsafe.');
        }
        return { status: 'exists', path: repoPath, name: repoName };
    }

    console.log(`Cloning ${repoUrl} into ${repoName}...`);
    execFileSync('git', ['clone', '--quiet', '--', repoUrl, repoPath], { stdio: 'inherit' });

    console.log(`✓ Repository '${repoName}' cloned.`);
    return { status: 'cloned', path: repoPath, name: repoName };
}

/**
 * List all cloned repositories in .data/achilles-cli/repos/.
 *
 * @param {string} [baseDir=process.cwd()]
 * @returns {Array<{name: string, path: string, url: string|null}>}
 */
export function listRepos(baseDir = process.cwd()) {
    const { reposDir } = ensureAchillesCliDir(baseDir);
    const entries = fs.readdirSync(reposDir, { withFileTypes: true });

    const repos = [];
    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            throw new Error('AchillesCLI repository entry is unsafe.');
        }
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
        }

        const repoPath = path.join(reposDir, entry.name);
        let remoteUrl = null;
        try {
            remoteUrl = execSync('git remote get-url origin', {
                cwd: repoPath,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        } catch {
            // Not a git repo or no remote
        }

        repos.push({
            name: entry.name,
            path: repoPath,
            url: remoteUrl,
        });
    }

    return repos;
}

/**
 * Remove a cloned repository from .data/achilles-cli/repos/.
 *
 * @param {string} name - Repository name (directory name)
 * @param {string} [baseDir=process.cwd()]
 * @returns {{ status: string, path: string }}
 */
export function removeRepo(name, baseDir = process.cwd()) {
    if (!name || !name.trim()) {
        throw new Error('Missing repository name.');
    }

    const { reposDir } = ensureAchillesCliDir(baseDir);
    const normalizedName = name.trim();
    if (normalizedName !== path.basename(normalizedName) || normalizedName === '.' || normalizedName === '..') {
        throw new Error('Repository name must be one directory name.');
    }
    const repoPath = path.join(reposDir, normalizedName);

    if (!fs.existsSync(repoPath)) {
        throw new Error(`Repository '${name}' not found in .data/achilles-cli/repos/.`);
    }
    const stat = fs.lstatSync(repoPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('AchillesCLI repository entry is unsafe.');
    }

    fs.rmSync(repoPath, { recursive: true, force: true });
    console.log(`✓ Repository '${name}' removed.`);
    return { status: 'removed', path: repoPath };
}

function getGitErrorOutput(error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    const stdout = error?.stdout ? String(error.stdout).trim() : '';
    const message = String(error?.message || '').trim();
    return stderr || stdout || message || 'git pull failed';
}

function formatUpdateRepoFailures(failures) {
    const details = failures
        .map((failure) => `${failure.name}: ${failure.error}`)
        .join('\n');
    return `failed to update repos:\n${details}`;
}

/**
 * Update all cloned repositories in .data/achilles-cli/repos/ with git pull.
 *
 * @param {string} [baseDir=process.cwd()]
 * @returns {{ status: string, updated: Array<{ name: string, path: string, output: string }> }}
 */
export function updateRepos(baseDir = process.cwd()) {
    const { reposDir } = ensureAchillesCliDir(baseDir);
    const entries = fs.readdirSync(reposDir, { withFileTypes: true });
    const updated = [];
    const failures = [];

    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            throw new Error('AchillesCLI repository entry is unsafe.');
        }
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
        }

        const repoPath = path.join(reposDir, entry.name);
        try {
            const output = execFileSync('git', ['pull'], {
                cwd: repoPath,
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            updated.push({
                name: entry.name,
                path: repoPath,
                output,
            });
        } catch (error) {
            failures.push({
                name: entry.name,
                error: getGitErrorOutput(error),
            });
        }
    }

    if (failures.length > 0) {
        const error = new Error(formatUpdateRepoFailures(failures));
        error.failures = failures;
        error.updated = updated;
        throw error;
    }

    return { status: 'updated', updated };
}

export default {
    ensureAchillesCliDir,
    getReposDir,
    getManagedRepoSkillRoot,
    addRepo,
    listRepos,
    removeRepo,
    updateRepos,
    extractRepoNameFromUrl,
};

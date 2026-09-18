import { callAgentTool, parseToolResult } from "/explorer/services/infrastructure/explorerApi.js";
import { beginRepositoryLoader, endRepositoryLoader } from "../git-tool-button/components/git-repository-modal-shared/repository-loader.js";

async function callGitTool(name, args) {
    const raw = await callAgentTool('gitAgent', name, args, { raw: true });
    return parseToolResult(raw);
}

function normalizeRepositoryName(value) {
    return String(value || '').trim();
}

async function openAddRepositoryModal(basePath, { submoduleMode = false } = {}) {
    return assistOS.UI.showModal('git-add-repository-modal', { basePath, submoduleMode }, true);
}

function parseGithubTarget(remoteUrl, owner, name) {
    const raw = String(remoteUrl || '').trim();
    if (raw) {
        const trimmed = raw.replace(/\/+$/g, '').replace(/\.git$/i, '');
        const repoMatch = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i);
        if (repoMatch) {
            return { owner: repoMatch[1], repo: repoMatch[2] };
        }
        const ownerMatch = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)$/i);
        if (ownerMatch && name) {
            return { owner: ownerMatch[1], repo: name };
        }
        return null;
    }
    if (owner && name) {
        return { owner, repo: name };
    }
    return null;
}

function resolveSubmoduleRemoteUrl(remoteUrl, owner, name) {
    const raw = String(remoteUrl || '').trim();
    const normalized = raw.replace(/\/+$/g, '').replace(/\.git$/i, '');
    const ownerOnly = normalized.match(/^https?:\/\/github\.com\/([^/\s]+)$/i);
    if (ownerOnly) {
        return name ? `https://github.com/${ownerOnly[1]}/${name}.git` : raw;
    }
    if (raw) {
        return raw;
    }
    if (owner && name) {
        return `https://github.com/${owner}/${name}.git`;
    }
    return '';
}

async function executeAddRepository({ context, host }) {
    const basePath = String(context?.currentFsPath || context?.currentDirectory || context?.currentPath || '').trim();
    if (!basePath) {
        throw new Error('Missing target directory for repository creation.');
    }
    let submoduleMode = false;
    let result = null;
    beginRepositoryLoader();
    try {
        const parentRepoInfo = await callGitTool('git_info', { path: basePath });
        submoduleMode = Boolean(parentRepoInfo?.ok && parentRepoInfo?.repoPath);
        result = await openAddRepositoryModal(basePath, { submoduleMode });
    } finally {
        endRepositoryLoader();
    }
    if (!result || typeof result !== 'object') {
        return;
    }
    const name = normalizeRepositoryName(result.name);
    const localName = normalizeRepositoryName(result.localName || result.name);
    const owner = String(result.owner || '').trim();
    const remoteUrl = String(result.remoteUrl || '').trim();
    if (!name) {
        throw new Error('Repository name is required.');
    }

    beginRepositoryLoader();
    try {
        if (submoduleMode) {
            const submoduleUrl = resolveSubmoduleRemoteUrl(remoteUrl, owner, name);
            if (!submoduleUrl) {
                throw new Error('Remote URL is required.');
            }
            const addResult = await callGitTool('git_submodule_add', {
                path: basePath,
                name: localName,
                remoteUrl: submoduleUrl
            });
            if (!addResult?.ok) {
                throw new Error(addResult?.error || 'Failed to add Git submodule.');
            }
            host?.showStatus?.(`Added Git submodule: ${addResult.submodulePath || addResult.name || localName}.`);
            await host?.refreshDirectory?.();
            return;
        }

        const githubTarget = parseGithubTarget(remoteUrl, owner, name);
        if (githubTarget) {
            const createResult = await callGitTool('git_create_github_repository', {
                path: basePath,
                owner: githubTarget.owner,
                name: githubTarget.repo,
                localName: localName || githubTarget.repo,
                visibility: result.visibility === 'public' ? 'public' : 'private',
                remote: result.remote || 'origin'
            });
            if (!createResult?.ok) {
                throw new Error(createResult?.error || 'Failed to create GitHub repository.');
            }
            const fullName = createResult.repository?.fullName || `${githubTarget.owner}/${githubTarget.repo}`;
            host?.showStatus?.(`Created GitHub repository: ${fullName}.`);
            await host?.refreshDirectory?.();
            return;
        }

        if (!remoteUrl) {
            throw new Error('Remote URL is required.');
        }
        const initResult = await callGitTool('git_init_repository', {
            path: basePath,
            name: localName,
            remote: result.remote || 'origin',
            remoteUrl
        });
        if (!initResult?.ok) {
            host?.showStatus?.(initResult?.error || 'Failed to create repository.', true);
            return;
        }
        host?.showStatus?.(`Created repository: ${initResult.name || localName} with ${initResult.remote || 'origin'}.`);
        await host?.refreshDirectory?.();
    } finally {
        endRepositoryLoader();
    }
}

function shouldOfferAddToGitignore(context) {
    if (!context || context.isConfidential) {
        return false;
    }
    if (!context.selectedPath || !context.selectedName) {
        return false;
    }
    if (context.selectedName === '.gitignore') {
        return false;
    }
    return context.isFile || context.isDirectory;
}

function getRepoProbePath(context) {
    const selectedPath = String(context?.selectedFsPath || context?.selectedPath || '').trim();
    if (!selectedPath) {
        return '';
    }
    return selectedPath;
}

export async function getMenuItems({ context, plugin }) {
    if (context?.slot === 'file-exp:new-menu') {
        if (context?.isConfidential || !context?.currentFsPath) {
            return [];
        }
        return [{
            id: 'git:add-repository',
            label: 'Add new repository',
            icon: plugin?.icon || '',
            action: 'add-repository'
        }];
    }

    if (!shouldOfferAddToGitignore(context)) {
        return [];
    }

    const selectedPath = getRepoProbePath(context);
    if (!selectedPath) {
        return [];
    }

    const repoInfo = await callGitTool('git_info', { path: selectedPath });
    if (!repoInfo?.ok || !repoInfo.repoPath || !repoInfo.repoRelativePath) {
        return [];
    }

    const ignorePayload = await callGitTool('git_check_ignore', {
        path: repoInfo.repoPath,
        files: [repoInfo.repoRelativePath]
    });
    const isIgnored = Array.isArray(ignorePayload?.matches) && ignorePayload.matches.length > 0;

    return [{
        id: isIgnored ? 'git:remove-from-gitignore' : 'git:add-to-gitignore',
        label: isIgnored ? 'Remove from .gitignore' : 'Add to .gitignore',
        icon: plugin?.icon || '',
        action: isIgnored ? 'remove-from-gitignore' : 'add-to-gitignore'
    }];
}

export async function executeMenuAction({ action, context, host }) {
    if (action === 'add-repository') {
        await executeAddRepository({ context, host });
        return;
    }

    const targetPath = String(context?.selectedFsPath || context?.selectedPath || '').trim();
    if (!targetPath) {
        throw new Error('Missing target path for gitignore action.');
    }
    if (action === 'add-to-gitignore') {
        const result = await callGitTool('git_add_ignore', { path: targetPath });
        if (!result?.ok) {
            throw new Error(result?.error || 'Failed to update .gitignore.');
        }

        const added = Array.isArray(result.added) ? result.added : [];
        const alreadyPresent = Array.isArray(result.alreadyPresent) ? result.alreadyPresent : [];
        if (added.length) {
            host?.showStatus?.(`Added ${added[0]} to .gitignore.`);
        } else if (alreadyPresent.length) {
            host?.showStatus?.(`${alreadyPresent[0]} is already in .gitignore.`);
        } else {
            host?.showStatus?.('Updated .gitignore.');
        }
    } else if (action === 'remove-from-gitignore') {
        const result = await callGitTool('git_remove_ignore', { path: targetPath });
        if (!result?.ok) {
            throw new Error(result?.error || 'Failed to update .gitignore.');
        }
        if (result.removed && result.retracked) {
            host?.showStatus?.('Removed from .gitignore and restored tracking.');
        } else if (result.removed) {
            host?.showStatus?.('Removed from .gitignore.');
        } else {
            host?.showStatus?.('No ignore rule was found.');
        }
    } else {
        return;
    }
    await host?.refreshDirectory?.();
}

export async function activateMenuItem({ context, host }) {
    const action = context?.slot === 'file-exp:new-menu'
        ? 'add-repository'
        : 'add-to-gitignore';
    return executeMenuAction({ action, context, host });
}

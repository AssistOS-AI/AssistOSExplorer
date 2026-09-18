import { callAgentTool, parseToolResult } from "/explorer/services/infrastructure/explorerApi.js";
import { beginRepositoryLoader, endRepositoryLoader } from "../git-tool-button/components/git-repository-modal-shared/repository-loader.js";

async function callGitTool(name, args) {
    const raw = await callAgentTool('gitAgent', name, args, { raw: true });
    return parseToolResult(raw);
}

async function openCloneRepositoryModal(basePath, { submoduleMode = false } = {}) {
    return assistOS.UI.showModal('git-clone-repository-modal', { basePath, submoduleMode }, true);
}

export async function getMenuItems({ context, plugin }) {
    if (context?.slot !== 'file-exp:new-menu') {
        return [];
    }
    if (context?.isConfidential || !context?.currentFsPath) {
        return [];
    }
    return [{
        id: 'git:clone-repository',
        label: 'Clone repository',
        icon: plugin?.icon || '',
        action: 'clone-repository'
    }];
}

export async function executeMenuAction({ action, context, host }) {
    if (action !== 'clone-repository') {
        return;
    }

    const basePath = String(context?.currentFsPath || context?.currentDirectory || context?.currentPath || '').trim();
    if (!basePath) {
        throw new Error('Missing target directory for repository clone.');
    }
    let submoduleMode = false;
    let result = null;
    beginRepositoryLoader();
    try {
        const parentRepoInfo = await callGitTool('git_info', { path: basePath });
        submoduleMode = Boolean(parentRepoInfo?.ok && parentRepoInfo?.repoPath);
        result = await openCloneRepositoryModal(basePath, { submoduleMode });
    } finally {
        endRepositoryLoader();
    }
    if (!result || typeof result !== 'object') {
        return;
    }
    const name = String(result.name || '').trim();
    const localName = String(result.localName || result.name || '').trim();
    const remoteUrl = String(result.remoteUrl || '').trim();
    if (!remoteUrl) {
        throw new Error('Remote URL is required.');
    }

    beginRepositoryLoader();
    try {
        if (submoduleMode) {
            const addResult = await callGitTool('git_submodule_add', {
                path: basePath,
                name: localName || name,
                remoteUrl
            });
            if (!addResult?.ok) {
                throw new Error(addResult?.error || 'Failed to add Git submodule.');
            }
            host?.showStatus?.(`Added Git submodule: ${addResult.submodulePath || addResult.name || localName}.`);
            await host?.refreshDirectory?.();
            return;
        }

        const cloneResult = await callGitTool('git_clone_repository', {
            path: basePath,
            name: localName || name,
            remote: result.remote || 'origin',
            remoteUrl
        });
        if (!cloneResult?.ok) {
            host?.showStatus?.(cloneResult?.error || 'Failed to clone repository.', true);
            return;
        }
        const fullName = result.repository?.fullName || name;
        host?.showStatus?.(`Cloned repository: ${fullName}.`);
        await host?.refreshDirectory?.();
    } finally {
        endRepositoryLoader();
    }
}

export async function activateMenuItem({ context, host }) {
    return executeMenuAction({ action: 'clone-repository', context, host });
}

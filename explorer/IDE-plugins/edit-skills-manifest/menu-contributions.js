import { buildSkillsManifestPath } from './skills-manifest-utils.mjs';

function normalizePath(value) {
    return String(value || '').trim();
}

async function openEditSkillsManifestModal(context) {
    const folderPath = normalizePath(context?.selectedFsPath || context?.selectedPath);
    if (!folderPath) {
        throw new Error('Missing folder path for skills manifest editing.');
    }

    const manifestPath = buildSkillsManifestPath(folderPath);
    return assistOS.UI.showModal('edit-skills-manifest-modal', {
        folderPath,
        manifestPath,
        'folder-path': folderPath,
        'manifest-path': manifestPath
    }, true);
}

export async function getMenuItems({ context, plugin }) {
    if (!context?.isDirectory || !normalizePath(context?.selectedFsPath)) {
        return [];
    }

    return [{
        id: 'achilles-ide:edit-skills-manifest',
        label: 'Manage skills',
        icon: plugin?.icon || '',
        action: 'edit-skills-manifest'
    }];
}

export async function executeMenuAction({ action, context, host }) {
    if (action !== 'edit-skills-manifest') {
        return;
    }

    const result = await openEditSkillsManifestModal(context);
    if (!result?.changed) {
        return;
    }

    const count = Number.isFinite(result.count) ? result.count : 0;
    host?.showStatus?.(`Updated skills manifest with ${count} installed ${count === 1 ? 'skill' : 'skills'}.`);
    await host?.refreshDirectory?.({ invalidateDescendants: true });
}

export async function activateMenuItem({ context, host }) {
    return executeMenuAction({ action: 'edit-skills-manifest', context, host });
}

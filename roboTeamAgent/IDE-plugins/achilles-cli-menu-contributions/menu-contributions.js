import { buildCopilotUrl } from '../achilles-cli-tool-button/copilot-launch.js';

function normalizePath(value) {
    return String(value || '').trim();
}

export async function getMenuItems({ context, plugin }) {
    if (!context?.isDirectory || !normalizePath(context?.selectedFsPath)) {
        return [];
    }
    return [{
        id: 'achilles-cli:open-copilot-here',
        label: 'Open Copilot here',
        icon: plugin?.icon || '',
        action: 'open-copilot-here'
    }];
}

export async function executeMenuAction({ action, context }) {
    if (action !== 'open-copilot-here') {
        return;
    }
    const targetUrl = buildCopilotUrl(context);
    if (!targetUrl) {
        throw new Error('Missing file context for Copilot launch.');
    }
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
}

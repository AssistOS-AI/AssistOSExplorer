const COPILOT_LAUNCH_EXTENSION_SLOT = 'file-exp:copilot-launch-extension';

function normalize(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeRoot(value) {
    const normalized = normalize(value).replace(/\/+$/g, '');
    return normalized === '/' ? '' : normalized;
}

function getRuntimeApplicationPlugins() {
    const runtimePlugins = globalThis.window?.assistOS?.runtimePlugins?.application;
    if (runtimePlugins && typeof runtimePlugins === 'object' && !Array.isArray(runtimePlugins)) {
        return runtimePlugins;
    }
    const workspacePlugins = globalThis.window?.assistOS?.workspace?.appPlugins;
    return workspacePlugins && typeof workspacePlugins === 'object' && !Array.isArray(workspacePlugins)
        ? workspacePlugins
        : {};
}

export function getCopilotLaunchExtensions() {
    const entries = getRuntimeApplicationPlugins()[COPILOT_LAUNCH_EXTENSION_SLOT];
    return Array.isArray(entries)
        ? entries.filter((entry) => entry?.copilotLaunch && typeof entry.copilotLaunch === 'object')
        : [];
}

function applyExtensionQuery(params, extensions) {
    for (const extension of extensions) {
        const query = extension?.copilotLaunch?.query;
        if (!query || typeof query !== 'object' || Array.isArray(query)) {
            continue;
        }
        for (const [key, value] of Object.entries(query)) {
            const normalizedKey = normalize(key);
            const normalizedValue = normalize(value);
            if (normalizedKey && normalizedValue) {
                params.set(normalizedKey, normalizedValue);
            }
        }
    }
}

function getWorkspaceDirParam(extensions) {
    for (const extension of extensions) {
        const configured = normalize(extension?.copilotLaunch?.workspaceDirParam);
        if (configured) {
            return configured;
        }
    }
    return '';
}

function toWorkspaceRelativeParam(fsPath, workspaceRoot) {
    const root = normalizeRoot(workspaceRoot);
    const raw = normalize(fsPath);
    if (!root || !raw || (raw !== root && !raw.startsWith(`${root}/`))) {
        return '';
    }
    const relative = raw.slice(root.length).replace(/^\/+/, '');
    if (relative.includes('\0') || relative.split('/').some((segment) => segment === '..')) {
        return '';
    }
    return relative || '.';
}

function getWorkspaceRoot(context) {
    return normalizeRoot(
        context?.workspaceRoot
        || context?.workspaceFsRoot
        || globalThis.window?.assistOS?.workspace?.workspaceRoot
        || globalThis.window?.assistOS?.workspace?.workspaceFsRoot
        || ''
    );
}

function getWorkingDirectory(context) {
    const selectedFsPath = normalize(context?.selectedFsPath);
    if (context?.isDirectory && selectedFsPath) {
        return selectedFsPath;
    }
    return normalize(context?.currentFsPath || context?.workspaceFsRoot || '');
}

export function buildCopilotUrl(context = {}) {
    const params = new URLSearchParams({ agent: 'roboTeamAgent', robot: 'default' });
    const extensions = getCopilotLaunchExtensions();
    applyExtensionQuery(params, extensions);

    const workingDir = getWorkingDirectory(context);
    if (workingDir) {
        const workspaceDirParam = getWorkspaceDirParam(extensions);
        const relativeDir = workspaceDirParam
            ? toWorkspaceRelativeParam(workingDir, getWorkspaceRoot(context))
            : '';
        if (workspaceDirParam && relativeDir) {
            params.set(workspaceDirParam, relativeDir);
        } else {
            params.set('dir', workingDir);
        }
    }

    return `/webchat?${params.toString()}`;
}

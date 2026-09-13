import { getApplicationPluginsForSlot } from "./file-exp-application-plugins.js";
import { DPU_SECRETS_PATH, isDpuManagedPath } from "./file-exp-dpu-provider.js";
import { resolveExplorerPathToFilesystemPath } from "../../../services/infrastructure/explorerApi.js";
import { isAdminUser } from "../../../services/auth/adminUser.js";

export const FILE_EXP_MENU_SLOTS = Object.freeze({
    contextFile: 'file-exp:context-menu:file',
    contextDirectory: 'file-exp:context-menu:directory',
    newMenu: 'file-exp:new-menu'
});

const MENU_CONTRIBUTION_TYPE = 'menu';
const menuModuleCache = new Map();
const menuModuleFailures = new Map();
let menuModuleImportSequence = 0;

function normalizePath(value) {
    return String(value || '').trim();
}

function encodeMenuPluginError(plugin, error) {
    const pluginId = typeof plugin?.id === 'string' ? plugin.id.trim() : 'unknown-plugin';
    const message = error?.message || String(error || 'Unknown error');
    return `[menu plugin:${pluginId}] ${message}`;
}

async function loadMenuContributionModule(plugin) {
    const moduleUrl = typeof plugin?.menuModuleUrl === 'string' ? plugin.menuModuleUrl.trim() : '';
    if (!moduleUrl) {
        throw new Error('Missing menuModuleUrl.');
    }
    if (!menuModuleCache.has(moduleUrl)) {
        const failureCount = menuModuleFailures.get(moduleUrl) || 0;
        const requestUrl = failureCount > 0
            ? `${moduleUrl}${moduleUrl.includes('?') ? '&' : '?'}runtimeMenuImport=${Date.now().toString(36)}-${++menuModuleImportSequence}`
            : moduleUrl;
        const request = import(requestUrl).then((module) => {
            menuModuleFailures.delete(moduleUrl);
            return module;
        }).catch((error) => {
            if (menuModuleCache.get(moduleUrl) === request) {
                menuModuleCache.delete(moduleUrl);
            }
            menuModuleFailures.set(moduleUrl, failureCount + 1);
            throw error;
        });
        menuModuleCache.set(moduleUrl, request);
    }
    return menuModuleCache.get(moduleUrl);
}

async function loadMenuPluginDependencies(plugin) {
    const dependencies = Array.isArray(plugin?.dependencies) ? plugin.dependencies : [];
    if (!dependencies.length) return;
    const ensureComponentRegistered = window.assistOS?.webSkel?.ensureComponentRegistered
        || window.UI?.ensureComponentRegistered;
    if (typeof ensureComponentRegistered !== 'function') return;
    await Promise.all(dependencies.map((dependency) => {
        const component = normalizePath(dependency?.component || dependency?.name);
        return component ? ensureComponentRegistered(component) : null;
    }));
}

function getPluginMenuItems(slot, target = null) {
    const plugins = getApplicationPluginsForSlot(slot, { contributionType: MENU_CONTRIBUTION_TYPE });
    return plugins.map((plugin) => ({
        id: `plugin:${normalizePath(plugin?.agent)}:${normalizePath(plugin?.id)}`,
        label: normalizePath(plugin?.label) || normalizePath(plugin?.id) || 'Plugin',
        title: normalizePath(plugin?.tooltip),
        icon: normalizePath(plugin?.icon),
        slot,
        entryPath: normalizePath(target?.path),
        entryType: normalizePath(target?.type) || 'file',
        entryName: normalizePath(target?.name),
        source: 'plugin',
        pluginId: normalizePath(plugin?.id),
        pluginAgent: normalizePath(plugin?.agent)
    }));
}

function getNewFileLabel(fileExp) {
    return fileExp.normalizePath(fileExp.state.path || '/') === DPU_SECRETS_PATH
        ? 'New Secret'
        : 'New File';
}

export async function buildFileExpMenuContext(fileExp, slot, target = null) {
    const currentPath = fileExp.normalizePath(fileExp.state.path || '/');
    if (slot === FILE_EXP_MENU_SLOTS.newMenu) {
        return {
            slot,
            currentPath,
            currentDirectory: currentPath,
            currentFsPath: await resolveExplorerPathToFilesystemPath(currentPath),
            isConfidential: isDpuManagedPath(currentPath)
        };
    }

    const entryPath = fileExp.normalizePath(target?.path || fileExp.state.selectedPath || '');
    const entryType = String(target?.type || '').trim().toLowerCase() || 'file';
    const entryName = String(target?.name || (entryPath ? entryPath.split('/').pop() : '') || '').trim();
    return {
        slot,
        currentPath,
        currentFsPath: await resolveExplorerPathToFilesystemPath(currentPath),
        selectedPath: entryPath,
        selectedFsPath: await resolveExplorerPathToFilesystemPath(entryPath),
        selectedName: entryName,
        selectedType: entryType,
        isFile: entryType === 'file',
        isDirectory: entryType === 'directory',
        isConfidential: isDpuManagedPath(entryPath)
    };
}

export function getBuiltInNewMenuItems(fileExp) {
    const currentPath = fileExp.normalizePath(fileExp.state.path || '/');
    const managedByDpu = isDpuManagedPath(currentPath);
    const capabilities = fileExp.state.currentDpuCapabilities || null;
    const allowNewDirectory = managedByDpu ? Boolean(capabilities?.canCreateDirectories) : true;
    const allowNewFile = managedByDpu ? Boolean(capabilities?.canCreateFiles) : true;
    const newFileLabel = getNewFileLabel(fileExp);

    return [
        {
            id: 'host:new-directory',
            source: 'host',
            slot: FILE_EXP_MENU_SLOTS.newMenu,
            action: 'newDirectory',
            label: 'New Folder',
            icon: './assets/icons/folder-with-letter.svg',
            disabled: !allowNewDirectory,
            title: allowNewDirectory ? 'Create folder' : 'Folders are not allowed in this location.'
        },
        {
            id: 'host:new-file',
            source: 'host',
            slot: FILE_EXP_MENU_SLOTS.newMenu,
            action: 'newFile',
            label: newFileLabel,
            icon: './assets/icons/document.svg',
            disabled: !allowNewFile,
            title: allowNewFile
                ? (newFileLabel === 'New Secret' ? 'Create secret' : 'Create file')
                : 'Files are not allowed in this location.'
        }
    ].filter((item) => item.disabled !== true);
}

export function getBuiltInContextMenuItems(fileExp, target) {
    const entryPath = fileExp.normalizePath(target?.path || '');
    const type = String(target?.type || 'file');
    const clipboard = fileExp.state.clipboard || null;
    const isManaged = Boolean(target?.virtualProvider === 'dpu' || isDpuManagedPath(entryPath));
    const canWrite = isManaged ? Boolean(target?.dpuCanWrite) : true;
    const canCreateChildren = isManaged ? Boolean(target?.dpuCanCreateChildren) : true;
    const immutableRoot = isManaged ? Boolean(target?.dpuImmutableRoot) : false;
    const canRename = isManaged
        ? (Object.prototype.hasOwnProperty.call(target || {}, 'dpuCanRename') ? Boolean(target?.dpuCanRename) : (canWrite && !immutableRoot))
        : true;
    const canDelete = isManaged
        ? (Object.prototype.hasOwnProperty.call(target || {}, 'dpuCanDelete') ? Boolean(target?.dpuCanDelete) : (canWrite && !immutableRoot))
        : true;
    const canPasteInto = Boolean(clipboard) && type === 'directory' && (!isManaged || canCreateChildren);

    const items = [
        {
            id: 'host:rename',
            source: 'host',
            slot: type === 'directory' ? FILE_EXP_MENU_SLOTS.contextDirectory : FILE_EXP_MENU_SLOTS.contextFile,
            action: 'renameEntry',
            label: 'Rename',
            entryPath,
            entryType: type,
            icon: './assets/icons/edit.svg',
            disabled: !canRename
        },
        {
            id: 'host:copy',
            source: 'host',
            slot: type === 'directory' ? FILE_EXP_MENU_SLOTS.contextDirectory : FILE_EXP_MENU_SLOTS.contextFile,
            action: 'copyEntry',
            label: 'Copy',
            entryPath,
            entryType: type,
            icon: './assets/icons/copy.svg',
            disabled: isManaged
        },
        {
            id: 'host:cut',
            source: 'host',
            slot: type === 'directory' ? FILE_EXP_MENU_SLOTS.contextDirectory : FILE_EXP_MENU_SLOTS.contextFile,
            action: 'cutEntry',
            label: 'Cut',
            entryPath,
            entryType: type,
            icon: './assets/icons/cut.svg',
            disabled: isManaged
        }
    ];

    if (type === 'file') {
        items.push({
            id: 'host:open-in-new-tab',
            source: 'host',
            slot: FILE_EXP_MENU_SLOTS.contextFile,
            action: 'openEntryInNewTab',
            label: 'Open in new tab',
            entryPath,
            entryType: type,
            icon: './assets/icons/document.svg',
            disabled: false
        });
    }

    if (type === 'directory') {
        if (isAdminUser(globalThis.window?.assistOS?.user)) {
            items.push({
                id: 'host:open-terminal-here',
                source: 'host',
                slot: FILE_EXP_MENU_SLOTS.contextDirectory,
                action: 'openTerminalHere',
                label: 'Open Terminal Here',
                entryPath,
                entryType: type,
                targetPath: entryPath,
                icon: './assets/icons/terminal.svg',
                disabled: false
            });
        }
        items.push(
            {
                id: 'host:upload-here',
                source: 'host',
                slot: FILE_EXP_MENU_SLOTS.contextDirectory,
                action: 'uploadHere',
                label: 'Upload here',
                entryPath,
                entryType: type,
                targetPath: entryPath,
                icon: './assets/icons/upload.svg',
                disabled: isManaged ? !canCreateChildren : false
            }
        );
        if (canPasteInto) {
            items.push({
                id: 'host:paste-into',
                source: 'host',
                slot: FILE_EXP_MENU_SLOTS.contextDirectory,
                action: 'pasteClipboard',
                label: 'Paste into',
                entryPath,
                entryType: type,
                targetPath: entryPath,
                icon: './assets/icons/paste.svg'
            });
        }
    }

    if (isManaged && !immutableRoot && canWrite) {
        items.push({
            id: 'host:permissions',
            source: 'host',
            slot: type === 'directory' ? FILE_EXP_MENU_SLOTS.contextDirectory : FILE_EXP_MENU_SLOTS.contextFile,
            action: 'openDpuPermissions',
            label: 'Permissions',
            entryPath,
            entryType: type,
            icon: './assets/icons/keys.svg'
        });
    }

    items.push({
        id: 'host:delete',
        source: 'host',
        slot: type === 'directory' ? FILE_EXP_MENU_SLOTS.contextDirectory : FILE_EXP_MENU_SLOTS.contextFile,
        action: 'deleteEntry',
        label: 'Delete',
        entryPath,
        entryType: type,
        icon: './assets/icons/trash-can.svg',
        destructive: true,
        disabled: !canDelete
    });

    return items.filter((item) => item.disabled !== true);
}

export function resolveFileExpMenuItems(slot, target = null, builtInItems = []) {
    const pluginItems = getPluginMenuItems(slot, target);
    return [
        ...(Array.isArray(builtInItems) ? builtInItems : []),
        ...pluginItems
    ];
}

export async function executeFileExpMenuItem(fileExp, item, context = null, options = {}) {
    const pluginId = normalizePath(item?.pluginId);
    const pluginAgent = normalizePath(item?.pluginAgent);
    const slot = normalizePath(item?.slot);
    if (!pluginId || !slot) {
        return false;
    }
    const plugin = getApplicationPluginsForSlot(slot, { contributionType: MENU_CONTRIBUTION_TYPE })
        .find((entry) => (
            normalizePath(entry?.id) === pluginId
            && (!pluginAgent || normalizePath(entry?.agent) === pluginAgent)
        ));
    if (!plugin) {
        return false;
    }

    const [module, effectiveContext] = await Promise.all([
        loadMenuContributionModule(plugin),
        context ? Promise.resolve(context) : buildFileExpMenuContext(fileExp, slot, {
            path: item?.entryPath || '',
            type: item?.entryType || '',
            name: item?.entryName || ''
        }),
        loadMenuPluginDependencies(plugin)
    ]);
    await options.onReady?.();

    const activation = {
        item,
        context: effectiveContext,
        plugin,
        host: {
            refreshDirectory: async ({ invalidateDescendants = false } = {}) => {
                if (invalidateDescendants) {
                    for (const cachedPath of fileExp.caches.dirListing.keys()) {
                        fileExp.caches.dirListing.invalidate(fileExp, cachedPath);
                    }
                }
                await fileExp.refresh();
            },
            showStatus: (message, isError = false) => {
                fileExp.showStatus(message, isError);
            }
        }
    };
    if (typeof module?.activateMenuItem === 'function') {
        await module.activateMenuItem(activation);
        return true;
    }
    if (typeof module?.getMenuItems === 'function' && typeof module?.executeMenuAction === 'function') {
        const resolvedItems = await module.getMenuItems({ slot, context: effectiveContext, plugin });
        const resolvedItem = Array.isArray(resolvedItems) ? resolvedItems[0] : null;
        if (!resolvedItem) return false;
        await module.executeMenuAction({ ...activation, action: resolvedItem.action, item: resolvedItem });
        return true;
    }
    console.error(encodeMenuPluginError(plugin, new Error('Missing activateMenuItem().')));
    return false;
}

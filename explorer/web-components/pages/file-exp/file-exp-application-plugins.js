import { openToolbarPluginWithFeedback, isToolbarPluginOpening } from "../../../shared/ui/toolbar-plugin-feedback.js";
const APP_PLUGIN_SLOTS = Object.freeze({
    toolbar: 'file-exp:toolbar',
    toolbarPluginsDropdown: 'file-exp:toolbar-plugins-dropdown',
    rightBar: 'file-exp:right-bar',
    internal: 'file-exp:internal',
    global: 'file-exp:global',
    accountMenu: 'file-exp:account-menu'
});

const MOUNT_CONTRIBUTION_TYPE = 'mount';

import { sortRuntimePluginEntries, getRuntimePluginPolicyKey } from "../../../utils/pluginUtils.core.js";
import { emitPluginMountedAudit } from "../../../services/audit/auditService.js";
import { resolveExplorerPathToFilesystemPath } from "../../../services/infrastructure/explorerApi.js";
import { isAdminUser } from "../../../services/auth/adminUser.js";
import { openExpandedModal } from "../../../shared/ui/expanded-modal.js";

function getPluginSettingsMap() {
    const settings = window.assistOS?.pluginSettings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return {};
    }
    return settings;
}

function getPluginKey(plugin) {
    return getRuntimePluginPolicyKey(plugin);
}

function isPluginEnabled(plugin) {
    const key = getPluginKey(plugin);
    if (!key) {
        return true;
    }
    const settings = getPluginSettingsMap();
    const entry = settings[key];
    return !entry || entry.enabled !== false;
}

export function getApplicationPluginsForSlot(slot, { contributionType = null } = {}) {
    const appPlugins = window.assistOS?.workspace?.appPlugins;
    const plugins = appPlugins && typeof appPlugins === 'object' && !Array.isArray(appPlugins)
        ? appPlugins[slot]
        : null;
    const filteredPlugins = Array.isArray(plugins)
        ? plugins.filter((plugin) => {
            if (!plugin || !isPluginEnabled(plugin) || (plugin.adminOnly === true && !isAdminUser(window.assistOS?.user))) {
                return false;
            }
            if (!contributionType) {
                return true;
            }
            return String(plugin.contributionType || MOUNT_CONTRIBUTION_TYPE).trim() === contributionType;
        })
        : [];
    return filteredPlugins.length
        ? sortRuntimePluginEntries(filteredPlugins)
        : [];
}

function encodeContext(context) {
    try {
        return encodeURIComponent(JSON.stringify(context || {}));
    } catch {
        return encodeURIComponent('{}');
    }
}

export function buildPluginContext(fileExp, slot, { currentFsPath = '', workspaceFsRoot = '' } = {}) {
    return {
        slot,
        currentPath: fileExp.normalizePath(fileExp.state.path || '/'),
        currentFsPath,
        workspaceFsRoot,
        selectedPath: fileExp.normalizePath(fileExp.state.selectedPath || ''),
        workspaceVersion: Number.isFinite(fileExp.state.workspaceVersion) ? fileExp.state.workspaceVersion : 0
    };
}

function getContainerOrientation(container, slot) {
    if (slot === APP_PLUGIN_SLOTS.toolbarPluginsDropdown) {
        return 'dropdown';
    }
    if (container?.classList?.contains('app-toolbar-slot')) {
        return 'horizontal';
    }
    if (container?.classList?.contains('app-plugin-bar')) {
        return 'vertical';
    }
    if (container?.classList?.contains('app-plugin-global-slot')) {
        return 'overlay';
    }
    return slot === APP_PLUGIN_SLOTS.toolbar ? 'horizontal' : 'vertical';
}

function isMobileToolbarLayout() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }
    return window.matchMedia('(max-width: 720px)').matches;
}

function mergeUniquePlugins(...pluginLists) {
    const plugins = [];
    const seen = new Set();
    for (const pluginList of pluginLists) {
        if (!Array.isArray(pluginList)) {
            continue;
        }
        for (const plugin of pluginList) {
            const key = getPluginKey(plugin);
            if (!key || seen.has(key)) {
                continue;
            }
            seen.add(key);
            plugins.push(plugin);
        }
    }
    return plugins;
}

async function ensureRuntimeComponent(componentName) {
    const ensureComponentRegistered = window.assistOS?.webSkel?.ensureComponentRegistered || window.UI?.ensureComponentRegistered;
    if (typeof ensureComponentRegistered === 'function') {
        await ensureComponentRegistered(componentName);
    }
}

function updateMountedPluginElement(pluginElement, plugin, context) {
    if (!pluginElement) {
        return;
    }
    const label = typeof plugin?.label === 'string' && plugin.label.trim()
        ? plugin.label.trim()
        : typeof plugin?.tooltip === 'string' && plugin.tooltip.trim()
            ? plugin.tooltip.trim()
            : typeof plugin?.component === 'string' && plugin.component.trim()
                ? plugin.component.trim()
                : 'Plugin';
    const tooltip = typeof plugin?.tooltip === 'string' && plugin.tooltip.trim()
        ? plugin.tooltip.trim()
        : label;
    const encodedContext = encodeContext(context);
    pluginElement.setAttribute('data-context', encodedContext);
    pluginElement.setAttribute('data-plugin-label', label);
    pluginElement.setAttribute('data-plugin-tooltip', tooltip);
    pluginElement.setAttribute('data-plugin-icon', typeof plugin?.icon === 'string' ? plugin.icon : '');
    pluginElement.setAttribute('data-plugin-agent', typeof plugin?.agent === 'string' ? plugin.agent : '');
    if (typeof context?.slot === 'string' && context.slot.trim()) {
        pluginElement.setAttribute('data-host-slot', context.slot.trim());
    } else {
        pluginElement.removeAttribute('data-host-slot');
    }
    if (typeof context?.orientation === 'string' && context.orientation.trim()) {
        pluginElement.setAttribute('data-host-orientation', context.orientation.trim());
    } else {
        pluginElement.removeAttribute('data-host-orientation');
    }
    const presenter = pluginElement.webSkelPresenter;
    if (typeof presenter?.updateHostContext === 'function') {
        presenter.updateHostContext({
            ...(context || {}),
            pluginAgent: typeof plugin?.agent === 'string' ? plugin.agent : '',
            pluginLabel: label,
            pluginTooltip: tooltip,
            pluginIcon: typeof plugin?.icon === 'string' ? plugin.icon : '',
            pluginToolbarModal: plugin?.toolbarModal && typeof plugin.toolbarModal === 'object' && !Array.isArray(plugin.toolbarModal)
                ? plugin.toolbarModal
                : null
        });
    }
}

function collectExistingMounts(container) {
    const mounts = new Map();
    const nodes = Array.from(container.querySelectorAll('[data-app-plugin-key]'));
    for (const node of nodes) {
        const key = node.getAttribute('data-app-plugin-key');
        if (!key) {
            continue;
        }
        if (mounts.has(key)) {
            node.remove();
            continue;
        }
        mounts.set(key, node);
    }
    return mounts;
}

function getPluginPresentation(plugin) {
    const label = typeof plugin?.label === 'string' && plugin.label.trim()
        ? plugin.label.trim()
        : typeof plugin?.tooltip === 'string' && plugin.tooltip.trim()
            ? plugin.tooltip.trim()
            : typeof plugin?.component === 'string' && plugin.component.trim()
                ? plugin.component.trim()
                : 'Plugin';
    const tooltip = typeof plugin?.tooltip === 'string' && plugin.tooltip.trim()
        ? plugin.tooltip.trim()
        : label;
    return { label, tooltip };
}

function openPluginToolbarModal(plugin) {
    const descriptor = plugin?.toolbarModal;
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
        return;
    }
    const { label } = getPluginPresentation(plugin);
    return openExpandedModal({ ...descriptor, title: descriptor.title || label });
}

function markPluginLoadingFailed(mount, plugin, error) {
    const pluginElement = mount?.querySelector?.('[data-app-plugin-loading]');
    if (!pluginElement) return;
    const { label } = getPluginPresentation(plugin);
    pluginElement.classList.add('is-error');
    pluginElement.removeAttribute('aria-busy');
    pluginElement.setAttribute('aria-disabled', 'true');
    pluginElement.setAttribute('aria-label', `${label} unavailable`);
    pluginElement.title = error?.message || `${label} could not be loaded`;
}

function createPluginMount(key, slot) {
    const mount = document.createElement('div');
    mount.className = 'app-plugin-mount';
    mount.setAttribute('data-app-plugin-key', key);
    mount.setAttribute('data-app-plugin-slot', slot);
    return mount;
}

function createLazyPluginButton(plugin, key) {
    const { label, tooltip } = getPluginPresentation(plugin);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-plugin-tool-button app-plugin-lazy-trigger';
    button.setAttribute('data-app-plugin-trigger', key);
    button.setAttribute('data-plugin-label', label);
    button.setAttribute('aria-label', label);
    button.title = tooltip;

    const icon = document.createElement('span');
    icon.className = 'app-plugin-tool-icon';
    icon.setAttribute('aria-hidden', 'true');
    const iconImage = document.createElement('img');
    iconImage.className = 'app-plugin-tool-icon-image';
    iconImage.alt = '';
    iconImage.loading = 'lazy';
    iconImage.src = typeof plugin?.icon === 'string' ? plugin.icon : '';
    icon.appendChild(iconImage);

    const labelElement = document.createElement('span');
    labelElement.className = 'app-plugin-tool-label';
    labelElement.textContent = label;
    button.append(icon, labelElement);
    return button;
}

function getPluginLoadingClasses(container) {
    if (container?.classList?.contains('app-plugin-account-slot')) {
        return ['toolbar-dropdown-item', 'action-menu-item'];
    }
    if (
        container?.classList?.contains('app-toolbar-slot')
        || container?.classList?.contains('app-menu-list')
        || container?.classList?.contains('app-plugin-bar')
    ) {
        return ['app-plugin-tool-button'];
    }
    return [];
}

function orderSlotMounts(container, plugins, mounts) {
    let anchor = container?.firstElementChild || null;
    for (const plugin of plugins) {
        const mount = mounts.get(getPluginKey(plugin));
        if (!mount) continue;
        if (mount === anchor) {
            anchor = anchor.nextElementSibling;
            continue;
        }
        container.insertBefore(mount, anchor);
    }
}

export async function waitForPluginPresenterRender(pluginElement) {
    if (pluginElement?.presenterReadyPromise?.then) {
        await pluginElement.presenterReadyPromise;
    }
    // WebSkel replaces the constructor-time render promise after presenter
    // initialization. Yield once, then wait for that active render, including
    // the presenter's afterRender listener registration.
    await Promise.resolve();
    if (pluginElement?.renderCompletePromise?.then) {
        await pluginElement.renderCompletePromise;
    }
}

function stageSlotMounts(container, slot, plugins, { deferMount = false } = {}) {
    if (!container) return new Map();

    container.classList.toggle('is-empty', plugins.length === 0);
    const loadingClasses = getPluginLoadingClasses(container);
    const showLoadingPlaceholder = loadingClasses.length > 0;
    const existingMounts = collectExistingMounts(container);
    const stagedMounts = new Map();
    const seen = new Set();

    for (const plugin of plugins) {
        const key = getPluginKey(plugin);
        if (!key) continue;
        seen.add(key);

        let mount = existingMounts.get(key);
        if (!mount && showLoadingPlaceholder) mount = createPluginMount(key, slot);
        if (!mount) continue;

        const expectedComponent = typeof plugin?.component === 'string' ? plugin.component.trim() : '';
        const mountedComponent = expectedComponent ? mount.querySelector(expectedComponent) : null;
        if (deferMount && expectedComponent && !mountedComponent) {
            const existingTrigger = mount.querySelector('[data-app-plugin-trigger]');
            if (!existingTrigger) {
                mount.replaceChildren(createLazyPluginButton(plugin, key));
            }
            stagedMounts.set(key, mount);
            continue;
        }
        if (showLoadingPlaceholder && expectedComponent && !mountedComponent) {
            const { label, tooltip } = getPluginPresentation(plugin);
            const pluginElement = document.createElement(expectedComponent);
            pluginElement.setAttribute('data-presenter', expectedComponent);
            pluginElement.classList.add(...loadingClasses, 'app-plugin-loading-state');
            pluginElement.setAttribute('data-app-plugin-loading', '');
            pluginElement.setAttribute('data-plugin-label', label);
            pluginElement.setAttribute('aria-label', `Loading ${label}`);
            pluginElement.setAttribute('aria-busy', 'true');
            pluginElement.title = `Loading ${tooltip}`;
            mount.replaceChildren(pluginElement);
        }
        stagedMounts.set(key, mount);
    }

    for (const [key, node] of existingMounts.entries()) {
        if (!seen.has(key)) node.remove();
    }
    orderSlotMounts(container, plugins, stagedMounts);

    return stagedMounts;
}

function stageApplicationPluginPlaceholders(fileExp) {
    const toolbarContainer = fileExp?.element?.querySelector?.('#fileExpToolbarPlugins');
    const toolbarPluginsDropdownContainer = fileExp?.element?.querySelector?.('#fileExpToolbarPluginsDropdown');
    const rightBarContainer = fileExp?.element?.querySelector?.('#fileExpPluginBar');
    const accountMenuContainer = fileExp?.element?.querySelector?.('#fileExpAccountMenuPlugins');
    const toolbarPlugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.toolbar, {
        contributionType: MOUNT_CONTRIBUTION_TYPE
    });
    const toolbarDropdownPlugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.toolbarPluginsDropdown, {
        contributionType: MOUNT_CONTRIBUTION_TYPE
    });
    const useMobileToolbar = isMobileToolbarLayout();
    const visibleToolbarPlugins = useMobileToolbar ? [] : toolbarPlugins;
    const visibleToolbarDropdownPlugins = useMobileToolbar
        ? mergeUniquePlugins(toolbarPlugins, toolbarDropdownPlugins)
        : toolbarDropdownPlugins;
    const rightBarPlugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.rightBar, {
        contributionType: MOUNT_CONTRIBUTION_TYPE
    });
    const accountMenuPlugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.accountMenu, {
        contributionType: MOUNT_CONTRIBUTION_TYPE
    });
    stageSlotMounts(toolbarContainer, APP_PLUGIN_SLOTS.toolbar, visibleToolbarPlugins, { deferMount: true });
    stageSlotMounts(toolbarPluginsDropdownContainer, APP_PLUGIN_SLOTS.toolbarPluginsDropdown, visibleToolbarDropdownPlugins);
    stageSlotMounts(rightBarContainer, APP_PLUGIN_SLOTS.rightBar, rightBarPlugins);
    stageSlotMounts(accountMenuContainer, APP_PLUGIN_SLOTS.accountMenu, accountMenuPlugins);
}

async function mountSlot(container, slot, plugins, context, { onlyKey = '', componentsReady = false, cancelled = () => false, background = false } = {}) {
    if (!container) {
        return;
    }

    const contextWithOrientation = {
        ...(context || {}),
        orientation: getContainerOrientation(container, slot)
    };
    const loadingClasses = getPluginLoadingClasses(container);
    const showLoadingPlaceholder = loadingClasses.length > 0;
    const stagedMounts = stageSlotMounts(container, slot, plugins, { deferMount: Boolean(onlyKey) });

    for (const plugin of plugins) {
        const key = getPluginKey(plugin);
        if (onlyKey && key !== onlyKey) continue;
        let mount = key ? stagedMounts.get(key) : null;
        if (!key) continue;

        let pluginElement = mount?.querySelector?.(plugin.component) || null;
        if (pluginElement && !pluginElement.hasAttribute('data-app-plugin-loading')) {
            updateMountedPluginElement(pluginElement, plugin, contextWithOrientation);
            continue;
        }

        if (!componentsReady) {
            try {
                await ensureRuntimeComponent(plugin.component);
            } catch (error) {
                console.error(`[app-plugins] Failed to load ${key}:`, error);
                if (showLoadingPlaceholder) markPluginLoadingFailed(mount, plugin, error);
                continue;
            }
        }

        if (!mount) {
            mount = createPluginMount(key, slot);
            stagedMounts.set(key, mount);
            container.appendChild(mount);
        }
        if (cancelled()) throw new Error('Panel closed');
        pluginElement ||= document.createElement(plugin.component);
        if (!pluginElement.hasAttribute('data-presenter')) {
            pluginElement.setAttribute('data-presenter', plugin.component);
        }
        updateMountedPluginElement(pluginElement, plugin, contextWithOrientation);
        if (!pluginElement.isConnected) {
            if (showLoadingPlaceholder && !background) {
                pluginElement.classList.add(...loadingClasses, 'app-plugin-loading-state');
                pluginElement.setAttribute('data-app-plugin-loading', '');
                pluginElement.setAttribute('aria-busy', 'true');
            }
            if (background) {
                pluginElement.style.setProperty('display', 'none', 'important');
                mount.appendChild(pluginElement);
            } else if (mount.querySelector('[data-app-plugin-trigger]')) {
                mount.replaceChildren(pluginElement);
            } else {
                mount.appendChild(pluginElement);
            }
        }
        try {
            const ownsLoadingState = pluginElement.hasAttribute('data-app-plugin-loading');
            if (ownsLoadingState || background) {
                await waitForPluginPresenterRender(pluginElement);
                if (cancelled()) throw new Error('Panel closed');
            }
            updateMountedPluginElement(pluginElement, plugin, contextWithOrientation);
            if (ownsLoadingState) {
                pluginElement.classList.remove(...loadingClasses, 'app-plugin-loading-state', 'is-error');
                pluginElement.removeAttribute('data-app-plugin-loading');
                pluginElement.removeAttribute('aria-busy');
                pluginElement.removeAttribute('aria-disabled');
                pluginElement.removeAttribute('aria-label');
                pluginElement.removeAttribute('title');
            }
            if (background) {
                mount.querySelector('[data-app-plugin-trigger]')?.remove();
                pluginElement.style.removeProperty('display');
            }
            void emitPluginMountedAudit(key, contextWithOrientation);
        } catch (error) {
            if (cancelled()) {
                pluginElement.remove();
                throw error;
            }
            if (background) {
                pluginElement.remove();
                throw error;
            }
            markPluginLoadingFailed(mount, plugin, error);
            console.error(`[app-plugins] Failed to render ${key}:`, error);
        }
    }

    orderSlotMounts(container, plugins, stagedMounts);
}

async function loadToolbarPluginOnDemand(fileExp, trigger) {
    const key = String(trigger?.getAttribute?.('data-app-plugin-trigger') || '').trim();
    if (!key || trigger.getAttribute('aria-busy') === 'true') return;
    const toolbarContainer = fileExp?.element?.querySelector?.('#fileExpToolbarPlugins');
    if (!toolbarContainer?.contains?.(trigger)) return;
    const plugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.toolbar, {
        contributionType: MOUNT_CONTRIBUTION_TYPE
    });
    const plugin = plugins.find((entry) => getPluginKey(entry) === key);
    if (!plugin) return;

    const opening = openToolbarPluginWithFeedback(trigger, () => openPluginToolbarModal(plugin));
    if (opening?.opened && !await opening.opened) return;

    const cancelled = () => opening?.isClosed?.() === true;
    fileExp.__toolbarPluginLoadPromises ||= new Map();
    let loadPromise = fileExp.__toolbarPluginLoadPromises.get(key);
    if (!loadPromise) {
        if (!plugin.toolbarModal) {
            trigger.setAttribute('data-app-plugin-loading', '');
            trigger.setAttribute('aria-busy', 'true');
            trigger.setAttribute('aria-disabled', 'true');
            trigger.disabled = true;
        }

        loadPromise = (async () => {
            const currentPath = fileExp.normalizePath(fileExp.state.path || '/');
            const [, currentFsPath, workspaceFsRoot] = await Promise.all([
                ensureRuntimeComponent(plugin.component),
                resolveExplorerPathToFilesystemPath(currentPath),
                resolveExplorerPathToFilesystemPath('/')
            ]);
            if (cancelled()) throw new Error('Panel closed');
            const context = buildPluginContext(fileExp, APP_PLUGIN_SLOTS.toolbar, {
                currentFsPath,
                workspaceFsRoot
            });
            await mountSlot(toolbarContainer, APP_PLUGIN_SLOTS.toolbar, plugins, context, {
                onlyKey: key,
                componentsReady: true,
                background: Boolean(plugin.toolbarModal),
                cancelled
            });
            const mount = Array.from(toolbarContainer.querySelectorAll('[data-app-plugin-key]'))
                .find((entry) => entry.getAttribute('data-app-plugin-key') === key);
            const pluginElement = mount?.querySelector?.(plugin.component);
            if (!pluginElement || pluginElement.hasAttribute('data-app-plugin-loading')) {
                throw new Error(`${getPluginPresentation(plugin).label} could not be loaded.`);
            }
            const actionTarget = pluginElement?.querySelector?.('button:not([disabled]), [role="button"]:not([aria-disabled="true"]), [data-local-action]')
                || pluginElement;
            // Descriptor panels are already open; replaying the click can reopen a
            // panel the user closed while the toolbar presenter was loading.
            if (!plugin.toolbarModal) actionTarget?.click?.();
        })().finally(() => {
            fileExp.__toolbarPluginLoadPromises?.delete(key);
        });
        fileExp.__toolbarPluginLoadPromises.set(key, loadPromise);
    }

    try {
        await loadPromise;
    } catch (error) {
        if (cancelled()) {
            const mount = Array.from(toolbarContainer.querySelectorAll('[data-app-plugin-key]'))
                .find(entry => entry.getAttribute('data-app-plugin-key') === key);
            mount?.replaceChildren(createLazyPluginButton(plugin, key));
            return;
        }
        console.error(`[app-plugins] Failed to activate ${key}:`, error);
        const mount = trigger.closest?.('[data-app-plugin-key]');
        if (mount) {
            const retryTrigger = createLazyPluginButton(plugin, key);
            retryTrigger.classList.add('is-error');
            retryTrigger.title = `${error?.message || getPluginPresentation(plugin).label}. Click to retry.`;
            mount.replaceChildren(retryTrigger);
        }
    }
}

function bindLazyToolbarPluginActions(fileExp, toolbarContainer) {
    if (!toolbarContainer || typeof fileExp?.setElementListener !== 'function') return;
    fileExp.setElementListener('toolbar-plugin-opening-feedback', toolbarContainer, 'click', (event) => {
        const button = event.target?.closest?.('button, [role="button"]');
        if (!button || !toolbarContainer.contains(button)) return;
        if (isToolbarPluginOpening(button)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        // Lazy controls apply the same feedback in their activation handler.
        if (button.hasAttribute('data-app-plugin-trigger')) return;
        const mount = button.closest('[data-app-plugin-key]');
        const key = mount?.getAttribute('data-app-plugin-key');
        const plugin = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.toolbar, {
            contributionType: MOUNT_CONTRIBUTION_TYPE
        }).find(entry => getPluginKey(entry) === key);
        if (!plugin?.toolbarModal) return;
        openToolbarPluginWithFeedback(button, () => openPluginToolbarModal(plugin));
    }, true);
    fileExp.setElementListener('lazy-toolbar-plugin-actions', toolbarContainer, 'click', (event) => {
        const trigger = event.target?.closest?.('[data-app-plugin-trigger]');
        if (!trigger || !toolbarContainer.contains(trigger)) return;
        event.preventDefault();
        event.stopPropagation();
        loadToolbarPluginOnDemand(fileExp, trigger);
    });
}

function updateLoadedToolbarPluginContexts(container, plugins, context) {
    if (!container) return;
    const contextWithOrientation = {
        ...(context || {}),
        orientation: getContainerOrientation(container, APP_PLUGIN_SLOTS.toolbar)
    };
    for (const plugin of plugins) {
        const key = getPluginKey(plugin);
        if (!key || !plugin?.component) continue;
        const mount = Array.from(container.querySelectorAll('[data-app-plugin-key]'))
            .find((entry) => entry.getAttribute('data-app-plugin-key') === key);
        const pluginElement = mount?.querySelector?.(plugin.component);
        if (pluginElement && !pluginElement.hasAttribute('data-app-plugin-loading')) {
            updateMountedPluginElement(pluginElement, plugin, contextWithOrientation);
        }
    }
}

async function performRenderApplicationPluginSlots(fileExp) {
    if (!fileExp?.element) {
        return;
    }

    const toolbarContainer = fileExp.element.querySelector('#fileExpToolbarPlugins');
    const toolbarPluginsDropdownContainer = fileExp.element.querySelector('#fileExpToolbarPluginsDropdown');
    const rightBarContainer = fileExp.element.querySelector('#fileExpPluginBar');
    const internalContainer = fileExp.element.querySelector('#fileExpInternalPlugins');
    const globalContainer = fileExp.element.querySelector('#fileExpGlobalPlugins');
    const accountMenuContainer = fileExp.element.querySelector('#fileExpAccountMenuPlugins');
    const toolbarPlugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.toolbar, { contributionType: MOUNT_CONTRIBUTION_TYPE });
    const toolbarPluginsDropdownPlugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.toolbarPluginsDropdown, { contributionType: MOUNT_CONTRIBUTION_TYPE });
    const useMobileToolbar = isMobileToolbarLayout();
    const visibleToolbarPlugins = useMobileToolbar ? [] : toolbarPlugins;
    const visibleToolbarDropdownPlugins = useMobileToolbar
        ? mergeUniquePlugins(toolbarPlugins, toolbarPluginsDropdownPlugins)
        : toolbarPluginsDropdownPlugins;
    const rightBarPlugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.rightBar, { contributionType: MOUNT_CONTRIBUTION_TYPE });
    const internalPlugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.internal, { contributionType: MOUNT_CONTRIBUTION_TYPE });
    const globalPlugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.global, { contributionType: MOUNT_CONTRIBUTION_TYPE });
    const accountMenuPlugins = getApplicationPluginsForSlot(APP_PLUGIN_SLOTS.accountMenu, { contributionType: MOUNT_CONTRIBUTION_TYPE });
    stageApplicationPluginPlaceholders(fileExp);
    bindLazyToolbarPluginActions(fileExp, toolbarContainer);
    const currentPath = fileExp.normalizePath(fileExp.state.path || '/');
    const [currentFsPath, workspaceFsRoot] = await Promise.all([
        resolveExplorerPathToFilesystemPath(currentPath),
        resolveExplorerPathToFilesystemPath('/')
    ]);
    const filesystemContext = { currentFsPath, workspaceFsRoot };
    const toolbarContext = buildPluginContext(fileExp, APP_PLUGIN_SLOTS.toolbar, filesystemContext);
    const toolbarPluginsDropdownContext = buildPluginContext(fileExp, APP_PLUGIN_SLOTS.toolbarPluginsDropdown, filesystemContext);
    const rightBarContext = buildPluginContext(fileExp, APP_PLUGIN_SLOTS.rightBar, filesystemContext);
    const internalContext = buildPluginContext(fileExp, APP_PLUGIN_SLOTS.internal, filesystemContext);
    const globalContext = buildPluginContext(fileExp, APP_PLUGIN_SLOTS.global, filesystemContext);
    const accountMenuContext = buildPluginContext(fileExp, APP_PLUGIN_SLOTS.accountMenu, filesystemContext);

    updateLoadedToolbarPluginContexts(toolbarContainer, visibleToolbarPlugins, toolbarContext);
    await mountSlot(toolbarPluginsDropdownContainer, APP_PLUGIN_SLOTS.toolbarPluginsDropdown, visibleToolbarDropdownPlugins, toolbarPluginsDropdownContext);
    await mountSlot(rightBarContainer, APP_PLUGIN_SLOTS.rightBar, rightBarPlugins, rightBarContext);
    await mountSlot(internalContainer, APP_PLUGIN_SLOTS.internal, internalPlugins, internalContext);
    await mountSlot(globalContainer, APP_PLUGIN_SLOTS.global, globalPlugins, globalContext);
    await mountSlot(accountMenuContainer, APP_PLUGIN_SLOTS.accountMenu, accountMenuPlugins, accountMenuContext);
}

export async function renderApplicationPluginSlots(fileExp) {
    if (!fileExp?.element) {
        return;
    }

    const previousRender = fileExp.__appPluginRenderPromise || Promise.resolve();
    const nextRender = previousRender
        .catch(() => {})
        .then(() => performRenderApplicationPluginSlots(fileExp));

    fileExp.__appPluginRenderPromise = nextRender;

    try {
        await nextRender;
    } finally {
        if (fileExp.__appPluginRenderPromise === nextRender) {
            fileExp.__appPluginRenderPromise = null;
        }
    }
}

export function attachApplicationPluginHost(fileExp) {
    const refreshPluginMenuMetadata = ({ preserveOpenMenu = false } = {}) => {
        fileExp.toolbarMenuItems = [];
        if (!preserveOpenMenu && typeof fileExp.closeActionMenu === 'function') {
            fileExp.closeActionMenu(false);
        }
        if (typeof fileExp.renderEntries === 'function') {
            fileExp.renderEntries();
        }
        if (typeof fileExp.refreshToolbarMenuItems === 'function') {
            try {
                fileExp.refreshToolbarMenuItems();
            } catch (error) {
                console.error('[app-plugins] Failed to refresh toolbar menu items', error);
            }
        }
    };
    const renderPluginSlots = () => {
        renderApplicationPluginSlots(fileExp).catch((error) => {
            console.error('[app-plugins] Failed to render application plugin slots', error);
        });
    };
    const rerender = () => {
        refreshPluginMenuMetadata();
        renderPluginSlots();
    };
    const rerenderForToolbarViewport = () => {
        const nextMobileToolbarLayout = isMobileToolbarLayout();
        if (fileExp.__appPluginMobileToolbarLayout === nextMobileToolbarLayout) {
            return;
        }
        fileExp.__appPluginMobileToolbarLayout = nextMobileToolbarLayout;
        renderApplicationPluginSlots(fileExp).catch((error) => {
            console.error('[app-plugins] Failed to render application plugin slots after viewport change', error);
        });
    };
    const handleRuntimePluginsUpdated = (event) => {
        if (event?.detail?.phase === 'discovered') {
            stageApplicationPluginPlaceholders(fileExp);
            refreshPluginMenuMetadata({ preserveOpenMenu: true });
            return;
        }
        if (event?.detail?.phase === 'ready') {
            renderPluginSlots();
            return;
        }
        rerender();
    };

    fileExp.__appPluginMobileToolbarLayout = isMobileToolbarLayout();
    fileExp.setWindowListener?.('file-exp-app-plugins-settings', 'assistos:plugin-settings-updated', rerender);
    fileExp.setWindowListener?.('file-exp-runtime-plugins', 'assistos:runtime-plugins-updated', handleRuntimePluginsUpdated);
    fileExp.setWindowListener?.('file-exp-app-plugins-toolbar-viewport', 'resize', rerenderForToolbarViewport, {
        passive: true
    });
    fileExp.registerCleanup?.(() => {
        const toolbarContainer = fileExp.element?.querySelector?.('#fileExpToolbarPlugins');
        const toolbarPluginsDropdownContainer = fileExp.element?.querySelector?.('#fileExpToolbarPluginsDropdown');
        const rightBarContainer = fileExp.element?.querySelector?.('#fileExpPluginBar');
        const internalContainer = fileExp.element?.querySelector?.('#fileExpInternalPlugins');
        const globalContainer = fileExp.element?.querySelector?.('#fileExpGlobalPlugins');
        if (toolbarContainer) {
            toolbarContainer.replaceChildren();
        }
        if (toolbarPluginsDropdownContainer) {
            toolbarPluginsDropdownContainer.replaceChildren();
        }
        if (rightBarContainer) {
            rightBarContainer.replaceChildren();
        }
        if (internalContainer) {
            internalContainer.replaceChildren();
        }
        if (globalContainer) {
            globalContainer.replaceChildren();
        }
        fileExp.__appPluginRenderPromise = null;
        fileExp.__toolbarPluginLoadPromises = null;
        fileExp.__appPluginMobileToolbarLayout = null;
    });
}

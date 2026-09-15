let nextEditorHostId = 0;

// Native connection, recovery and session-expiry warnings retire an editor
// just like onError. Ordinary document warnings do not end its editing cycle.
const INACTIVE_EDITOR_WARNINGS = new Set([-100, -101, -104, -120, -121, -122]);

function ensureRuntimeState(host) {
    if (!host.__onlyOfficeRuntime) {
        host.__onlyOfficeRuntime = {
            editor: null,
            containerId: '',
            scriptUrl: '',
            configKey: '',
            renderGeneration: 0,
            inactiveRenderGeneration: 0,
            statusAssetPromise: null,
            statusAssetError: null,
        };
    }
    if (!Number.isSafeInteger(host.__onlyOfficeRuntime.renderGeneration)
        || host.__onlyOfficeRuntime.renderGeneration < 0) {
        host.__onlyOfficeRuntime.renderGeneration = 0;
    }
    if (!Number.isSafeInteger(host.__onlyOfficeRuntime.inactiveRenderGeneration)
        || host.__onlyOfficeRuntime.inactiveRenderGeneration < 0) {
        host.__onlyOfficeRuntime.inactiveRenderGeneration = 0;
    }
    return host.__onlyOfficeRuntime;
}

function getWindowObject() {
    if (typeof window === 'undefined') {
        throw new Error('OnlyOffice editor is not available outside the browser.');
    }
    return window;
}

async function loadScript(documentServerUrl) {
    const win = getWindowObject();
    const normalizedBase = String(documentServerUrl || '').replace(/\/+$/g, '');
    if (!normalizedBase) {
        throw new Error('OnlyOffice Document Server URL is not configured.');
    }
    const scriptUrl = `${normalizedBase}/web-apps/apps/api/documents/api.js`;

    if (win.DocsAPI?.DocEditor) {
        return { scriptUrl, DocsAPI: win.DocsAPI };
    }

    if (!win.__onlyOfficeScriptPromises) {
        win.__onlyOfficeScriptPromises = new Map();
    }
    if (!win.__onlyOfficeScriptPromises.has(scriptUrl)) {
        const scriptPromise = new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[data-onlyoffice-src="${scriptUrl}"]`);
            if (existing) {
                existing.addEventListener('load', () => resolve(win.DocsAPI), { once: true });
                existing.addEventListener('error', () => reject(new Error('Failed to load OnlyOffice API script.')), { once: true });
                return;
            }

            const script = document.createElement('script');
            script.src = scriptUrl;
            script.async = true;
            script.dataset.onlyofficeSrc = scriptUrl;
            script.addEventListener('load', () => resolve(win.DocsAPI), { once: true });
            script.addEventListener('error', () => reject(new Error('Failed to load OnlyOffice API script.')), { once: true });
            document.head.appendChild(script);
        }).then((docsApi) => {
            if (!docsApi?.DocEditor) {
                throw new Error('OnlyOffice API loaded without DocsAPI.DocEditor.');
            }
            return docsApi;
        });
        win.__onlyOfficeScriptPromises.set(scriptUrl, scriptPromise);
    }

    return {
        scriptUrl,
        DocsAPI: await win.__onlyOfficeScriptPromises.get(scriptUrl)
    };
}

function destroyEditor(host) {
    const runtime = host?.__onlyOfficeRuntime;
    if (!runtime) {
        return;
    }
    if (runtime.editor && typeof runtime.editor.destroyEditor === 'function') {
        try {
            runtime.editor.destroyEditor();
        } catch (error) {
            console.warn('OnlyOffice editor destroy failed', error);
        }
    }
    runtime.editor = null;
}

function cloneConfigValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => cloneConfigValue(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, cloneConfigValue(item)])
        );
    }
    return value;
}

export function buildConfigKey(config) {
    if (!config || typeof config !== 'object') {
        return '';
    }
    // The server store mints document.key for one exact session. It is the
    // editor/remount identity; a fresh session intentionally gets a fresh key
    // even when it names the same file and version. Transport URLs remain out
    // of this comparison because they are not browser UI identity fields.
    return JSON.stringify({
        documentKey: config.document?.key || '',
        title: config.document?.title || '',
        fileType: config.document?.fileType || '',
        permissions: config.document?.permissions || null,
        mode: config.editorConfig?.mode || '',
        userId: config.editorConfig?.user?.id || '',
        documentServerUrl: config.documentServerUrl || ''
    });
}

function findEditorContainer(host) {
    if (typeof host?.querySelector !== 'function') {
        return null;
    }
    // Before instantiation the container is the .onlyoffice-editor-frame div;
    // DocsAPI.DocEditor then replaces that div with the editor iframe
    // (observed: <iframe name="frameEditor">), so accept either as proof the
    // editor DOM is still mounted in this host.
    return host.querySelector('.onlyoffice-editor-frame') || host.querySelector('iframe');
}

export function isOnlyOfficeEditorActive(host, config) {
    const runtime = host?.__onlyOfficeRuntime;
    if (!runtime?.editor) {
        return false;
    }
    if (runtime.inactiveRenderGeneration === runtime.renderGeneration) {
        return false;
    }
    if (host.isConnected === false) {
        // A full page re-render replaces the preview DOM; a detached host may
        // still hold a runtime but its editor is gone with the old subtree.
        return false;
    }
    const configKey = buildConfigKey(config);
    return Boolean(configKey) && runtime.configKey === configKey && Boolean(findEditorContainer(host));
}

function ensureContainer(host, runtime) {
    if (!runtime.containerId) {
        runtime.containerId = `onlyoffice-editor-${++nextEditorHostId}`;
    }
    let container = host.querySelector('.onlyoffice-editor-frame');
    if (!container) {
        host.textContent = '';
        container = document.createElement('div');
        container.className = 'onlyoffice-editor-frame';
        host.appendChild(container);
    }
    container.id = runtime.containerId;
    return container;
}

export async function preloadOnlyOfficeStatusAsset(host, documentServerUrl, {
    createImage = () => new window.Image(),
    timeoutMs = 10000,
} = {}) {
    const frame = host.querySelector('iframe');
    if (!frame?.src) return;
    const base = new URL(documentServerUrl);
    const frameUrl = new URL(frame.src, base);
    const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
    const suffix = frameUrl.pathname.slice(prefix.length);
    if (frameUrl.origin !== base.origin || !frameUrl.pathname.startsWith(prefix)
        || !/^(?:\d+(?:\.\d+){1,3}-[A-Za-z0-9._-]+\/)?web-apps\/apps\//.test(suffix)) {
        throw new Error('OnlyOffice editor frame is outside its configured route.');
    }
    const versionPrefix = suffix.slice(0, suffix.indexOf('web-apps/'));
    const assetUrl = new URL(`${prefix}${versionPrefix}web-apps/apps/common/main/resources/img/controls/warnings_s.svg`, base.origin);
    // The native disconnect dialog needs this image after its owner route has
    // retired. Load the immutable versioned asset while the editor is active.
    await new Promise((resolve, reject) => {
        const image = createImage();
        const finish = error => {
            clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => finish(new Error('OnlyOffice status image timed out.')), timeoutMs);
        image.onload = () => finish();
        image.onerror = () => finish(new Error('OnlyOffice status image could not load.'));
        image.src = assetUrl.href;
    });
}

export async function renderOnlyOfficeEditor(host, config) {
    if (!host) return;
    // Presenter state can change while script loading yields. Keep the key,
    // transport, and event handlers bound to one synchronous mount snapshot.
    config = cloneConfigValue(config);
    const runtime = ensureRuntimeState(host);
    const nextConfigKey = buildConfigKey(config);
    if (isOnlyOfficeEditorActive(host, config)) {
        await runtime.statusAssetPromise;
        return;
    }
    if (runtime.inactiveRenderGeneration === runtime.renderGeneration
        && runtime.configKey === nextConfigKey) {
        // A render pass with the same failed session is not an explicit retry.
        // Only a fresh session/config key may replace this inactive generation.
        if (runtime.statusAssetError) throw runtime.statusAssetError;
        return;
    }

    const renderGeneration = ++runtime.renderGeneration;
    runtime.inactiveRenderGeneration = 0;
    runtime.statusAssetError = null;
    runtime.statusAssetPromise = null;
    destroyEditor(host);
    const { scriptUrl, DocsAPI } = await loadScript(config?.documentServerUrl || '');
    if (runtime.renderGeneration !== renderGeneration || host.isConnected === false) {
        return;
    }
    const container = ensureContainer(host, runtime);

    runtime.scriptUrl = scriptUrl;
    runtime.configKey = nextConfigKey;
    const callerOnError = typeof config?.events?.onError === 'function'
        ? config.events.onError
        : null;
    const callerOnWarning = typeof config?.events?.onWarning === 'function'
        ? config.events.onWarning
        : null;
    const mountConfig = {
        ...cloneConfigValue(config),
        events: {
            ...(config?.events && typeof config.events === 'object' ? config.events : {}),
            onError(...args) {
                if (runtime.renderGeneration === renderGeneration) {
                    runtime.inactiveRenderGeneration = renderGeneration;
                }
                return callerOnError?.apply(this, args);
            },
            onWarning(...args) {
                if (runtime.renderGeneration === renderGeneration
                    && INACTIVE_EDITOR_WARNINGS.has(args[0]?.data?.warningCode)) {
                    runtime.inactiveRenderGeneration = renderGeneration;
                }
                return callerOnWarning?.apply(this, args);
            }
        }
    };
    runtime.editor = new DocsAPI.DocEditor(container.id, mountConfig);
    runtime.statusAssetPromise = preloadOnlyOfficeStatusAsset(host, config.documentServerUrl)
        .catch(error => {
            if (runtime.renderGeneration !== renderGeneration || host.isConnected === false) return;
            runtime.inactiveRenderGeneration = renderGeneration;
            runtime.statusAssetError = error;
            destroyEditor(host);
            throw error;
        }).finally(() => {
            if (runtime.renderGeneration === renderGeneration) runtime.statusAssetPromise = null;
        });
    await runtime.statusAssetPromise;
}

export function clearOnlyOfficeEditor(host) {
    if (!host) return;
    const runtime = ensureRuntimeState(host);
    runtime.renderGeneration += 1;
    destroyEditor(host);
    host.textContent = '';
    runtime.configKey = '';
    runtime.inactiveRenderGeneration = 0;
    runtime.statusAssetError = null;
    runtime.statusAssetPromise = null;
}

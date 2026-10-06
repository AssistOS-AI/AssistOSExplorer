import { fetchTextOrThrow } from '../../utils/pluginUtils.core.js';
import { withRetry } from '../utils/retry.js';
import { isTransientAssetLoadError } from './bootstrapRecovery.js';

const INSTALL_MARKER = Symbol('explorerResourceLoaderInstalled');
const DEFAULT_RETRY_OPTIONS = Object.freeze({
    retries: 2,
    delayMs: 250,
    shouldRetry: isTransientAssetLoadError
});

function resolveComponentAssetUrl(webSkel, component, extension) {
    const configs = webSkel?.configs || {};
    const root = configs.rootDir || configs.webComponentsRootDir || '';
    const directory = component?.directory ? `/${component.directory}` : '';
    const base = root
        ? `${root}${directory}`
        : `${directory || ''}`;
    return `${base}/${component.type}/${component.name}/${component.name}.${extension}`;
}

export function installExplorerResourceLoader(webSkel, options = {}) {
    const resourceManager = webSkel?.ResourceManager;
    if (!resourceManager || typeof resourceManager.loadComponent !== 'function') {
        throw new Error('Explorer resource loader requires a WebSkel ResourceManager.');
    }
    if (resourceManager[INSTALL_MARKER]) return;

    const retryOptions = {
        ...DEFAULT_RETRY_OPTIONS,
        ...(options.retryOptions || {})
    };
    const importModule = typeof options.importModule === 'function'
        ? options.importModule
        : (url) => import(/* webpackIgnore: true */ url);
    const originalLoadComponent = resourceManager.loadComponent.bind(resourceManager);
    // Loads that are still running, by component name. WebSkel registers a component only when its own
    // loadComponent starts, so overlapping calls would each fetch the assets before WebSkel could share them.
    const inFlight = new Map();

    // WebSkel imports the presenter only after the template and stylesheets arrive. Starting the import with them
    // removes that serial step; WebSkel then registers the module it is handed instead of importing it again.
    // Only absolute paths are imported here, because a relative one would resolve against this module, not WebSkel's.
    // A failed early import is not reported: WebSkel then imports the presenter itself and reports its own error.
    const startPresenterImport = (component, url) => {
        if (!component.presenterClassName || component.presenterModule || !url.startsWith('/')) {
            return null;
        }
        try {
            return Promise.resolve(importModule(url)).catch(() => null);
        } catch (_) {
            return null;
        }
    };

    const loadFresh = async (component) => {
        const hasLoadedTemplate = typeof component.loadedTemplate === 'string';
        const hasLoadedStylesheets = Array.isArray(component.loadedCSSs);
        const templateUrl = resolveComponentAssetUrl(webSkel, component, 'html');
        const stylesheetUrl = resolveComponentAssetUrl(webSkel, component, 'css');
        const presenterImport = startPresenterImport(component, resolveComponentAssetUrl(webSkel, component, 'js'));
        const [loadedTemplate, loadedCSSs, presenterModule] = await Promise.all([
            hasLoadedTemplate
                ? component.loadedTemplate
                : withRetry(
                    () => fetchTextOrThrow(
                        templateUrl,
                        `[explorer] Failed to load template for ${component.name}`
                    ),
                    retryOptions
                ),
            hasLoadedStylesheets
                ? component.loadedCSSs
                : withRetry(
                    () => fetchTextOrThrow(
                        stylesheetUrl,
                        `[explorer] Failed to load stylesheet for ${component.name}`
                    ).then(stylesheet => [stylesheet]),
                    retryOptions
                ),
            presenterImport
        ]);

        return originalLoadComponent({
            ...component,
            loadedTemplate,
            loadedCSSs,
            ...(presenterModule ? { presenterModule } : {})
        });
    };

    resourceManager.loadComponent = (component) => {
        if (!component) {
            return originalLoadComponent(component);
        }

        const hasLoadedTemplate = typeof component.loadedTemplate === 'string';
        const hasLoadedStylesheets = Array.isArray(component.loadedCSSs);
        if (hasLoadedTemplate && hasLoadedStylesheets) {
            return originalLoadComponent(component);
        }
        // WebSkel already holds this component, loaded or loading, and ignores any assets passed with a later call.
        if (resourceManager.components?.[component.name]) {
            return originalLoadComponent(component);
        }

        const running = inFlight.get(component.name);
        if (running) return running;
        const request = loadFresh(component).finally(() => {
            inFlight.delete(component.name);
        });
        inFlight.set(component.name, request);
        return request;
    };
    resourceManager[INSTALL_MARKER] = true;
}

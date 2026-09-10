const DEFAULT_PAGE_NAME = 'file-exp';

export function completeInitialApplicationRoute({ webSkel, presenter, windowRef = globalThis.window }) {
    windowRef.webSkel = webSkel;
    // Modal requests need the mounted application's tool clients and must not delay bootstrap until the user closes it.
    return presenter?.openConversationSettingsFromLocation?.();
}

export function resolveInitialHashedRoute(hashValue) {
    const hash = String(hashValue || '');
    if (!hash || hash === '#') {
        return null;
    }

    const url = hash.slice(1);
    const pageName = url.split('/')[0].split('?')[0];
    if (!pageName) {
        return null;
    }

    return Object.freeze({
        pageName,
        url,
        preserveHash: true
    });
}

export async function mountInitialApplicationRoute({
    webSkel,
    pageContent,
    route
}) {
    const pageName = String(route?.pageName || DEFAULT_PAGE_NAME);
    const url = String(route?.url || pageName);
    const preserveHash = route?.preserveHash === true;

    await webSkel.changeToDynamicPage(pageName, url, null, preserveHash);

    if (pageName !== DEFAULT_PAGE_NAME) {
        return null;
    }

    const pageElement = pageContent?.querySelector?.(DEFAULT_PAGE_NAME);
    const presenter = pageElement?.webSkelPresenter;
    if (!presenter || typeof presenter.applyInitialLocationRoute !== 'function') {
        throw new Error('Explorer route presenter is not ready after page mount.');
    }

    if (presenter.initialLocationRouteApplied !== true) {
        await presenter.applyInitialLocationRoute();
    }
    if (pageElement.renderCompletePromise?.then) {
        await pageElement.renderCompletePromise;
    }
    return presenter;
}

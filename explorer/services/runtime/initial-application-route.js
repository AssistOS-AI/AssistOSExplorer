const DEFAULT_PAGE_NAME = 'file-exp';

// WebSkel's changeToDynamicPage always inserts `<tag data-presenter="tag">` as the page element.
export function isWebSkelPageElement(element) {
    return Boolean(element && typeof element.hasAttribute === 'function' && element.hasAttribute('data-presenter'));
}

// When the route policy denies the initial page, bootstrap falls back to the file explorer and cleans the
// address. A newer navigation that already mounted a page keeps its page and its address: the initial mount
// then defers to it.
export function resolveDeniedAdminRoute({ route, pageContent, windowRef = globalThis.window }) {
    if (isWebSkelPageElement(pageContent?.firstElementChild)) {
        return route;
    }
    windowRef.history.replaceState(null, '', `${windowRef.location.pathname}${windowRef.location.search}`);
    return Object.freeze({
        pageName: DEFAULT_PAGE_NAME,
        url: DEFAULT_PAGE_NAME,
        preserveHash: false
    });
}

export function completeInitialApplicationRoute({ webSkel, windowRef = globalThis.window }) {
    windowRef.webSkel = webSkel;
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

    // A newer navigation already mounted a page, possibly one that is still mounting. Bootstrap mounts its
    // route only into an empty page root, so it never joins that mount and never overrides it.
    if (isWebSkelPageElement(pageContent?.firstElementChild)) {
        return null;
    }

    await webSkel.changeToDynamicPage(pageName, url, null, preserveHash);

    if (pageName !== DEFAULT_PAGE_NAME) {
        return null;
    }

    const pageElement = pageContent?.querySelector?.(DEFAULT_PAGE_NAME);
    const mountedPage = pageContent?.firstElementChild || null;
    if (!pageElement && isWebSkelPageElement(mountedPage) && mountedPage.localName !== DEFAULT_PAGE_NAME) {
        // A newer navigation replaced the initial page while it was mounting.
        return null;
    }
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

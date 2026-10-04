// Explorer-side guards around WebSkel page changes. This module has no imports on purpose, so it can be
// loaded standalone by the deployment-free navigation model. The vendored WebSkel bundle stays unmodified
// (DS001); both guards are instance overrides, like explorerResourceLoader.js. Remove the render guard once a
// refreshed WebSkel bundle skips descendants that are not connected to the document.

const RENDER_GUARD_MARKER = Symbol('explorerDetachedRenderGuardInstalled');
const PAGE_CHANGE_GUARD_MARKER = Symbol('explorerPageChangeGuardInstalled');

// WebSkel creates `renderCompletePromise` in the element constructor and settles it only from the presenter
// lifecycle that starts in `connectedCallback`. A child built inside a detached host is constructed but never
// connected, so waiting for it never returns and the loader tokens of the host's renders stay held.
export function installDetachedRenderGuard(webSkel) {
    const resourceManager = webSkel?.ResourceManager;
    if (!resourceManager || typeof resourceManager.waitForDescendantRenders !== 'function') {
        throw new Error('Explorer render guard requires a WebSkel ResourceManager.');
    }
    if (resourceManager[RENDER_GUARD_MARKER]) {
        return;
    }
    resourceManager.waitForDescendantRenders = async (host) => {
        await Promise.resolve();
        const pending = [...host.querySelectorAll('[data-presenter]')]
            .filter((element) => element !== host && element.isConnected === true)
            .map((element) => element.renderCompletePromise)
            .filter((promise) => promise && typeof promise.then === 'function');
        if (pending.length) {
            await Promise.allSettled(pending);
        }
    };
    resourceManager[RENDER_GUARD_MARKER] = true;
}

function hasNoPageData(dataObject) {
    return dataObject === null || dataObject === undefined;
}

// A same-page history navigation (address-bar hash change, Back, Forward) reaches WebSkel's popstate handler
// while the page element has no presenter yet, and WebSkel would mount a second copy of that page. Such a
// request joins the mount that is still pending instead: the mounting presenter reads the current location when
// it initializes. Every other request keeps today's behaviour: register the component, then change the page.
// No request ever waits for another page change, so page changes cannot deadlock or queue behind each other.
export function installPageChangeGuard(webSkel, { ensureComponentRegistered, getPageRoot } = {}) {
    const original = webSkel?.changeToDynamicPage;
    if (typeof original !== 'function') {
        return;
    }
    if (webSkel[PAGE_CHANGE_GUARD_MARKER]) {
        return;
    }
    if (typeof ensureComponentRegistered !== 'function') {
        throw new TypeError('Explorer page-change guard requires ensureComponentRegistered.');
    }
    if (typeof getPageRoot !== 'function') {
        throw new TypeError('Explorer page-change guard requires getPageRoot.');
    }

    let pending = null;
    // Page changes between their registration start and their WebSkel call. While one is in flight, a join could
    // attach to a mount that the in-flight request is about to replace, and the last request would lose.
    let registering = 0;

    webSkel.changeToDynamicPage = async (componentName, ...args) => {
        const [, dataObject, preserveHash] = args;
        const element = pending?.element;
        if (registering === 0
            && preserveHash === true
            && hasNoPageData(dataObject)
            && pending
            && !pending.settled
            && pending.componentName === componentName
            && pending.dataless
            && element
            && element === getPageRoot()?.firstElementChild
            && !element.webSkelPresenter) {
            return undefined;
        }

        registering += 1;
        try {
            await ensureComponentRegistered(componentName);
        } finally {
            registering -= 1;
        }

        const result = original.call(webSkel, componentName, ...args);
        // WebSkel inserts the page element before its first await, so the element is observable here.
        const mounted = getPageRoot()?.firstElementChild || null;
        const entry = {
            componentName,
            dataless: hasNoPageData(dataObject),
            element: mounted && mounted.localName === componentName ? mounted : null,
            settled: false
        };
        pending = entry;
        const settle = () => {
            entry.settled = true;
        };
        Promise.resolve(result).then(settle, settle);
        return result;
    };
    webSkel[PAGE_CHANGE_GUARD_MARKER] = true;
}

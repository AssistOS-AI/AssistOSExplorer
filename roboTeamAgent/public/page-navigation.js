const stateKey = 'roboteamNavigation';
const returnParameter = '_rtReturn';

export function restoreNavigationFocus(element, keyboardFocus = false) {
    if (!element) return;
    element.classList.toggle('pointer-restored-focus', !keyboardFocus);
    if (!keyboardFocus) {
        const clear = () => element.classList.remove('pointer-restored-focus');
        element.addEventListener('blur', clear, { once: true });
        element.addEventListener('keydown', clear, { once: true });
    }
    element.focus({ preventScroll: true });
}

export function initPageNavigation({ windowRef = window, root = document, fallbackUrl, captureView = () => null } = {}) {
    let departing = false;
    const boundLinks = new WeakSet();
    const current = () => windowRef.history.state?.[stateKey] || {};
    const replace = (value, url) => windowRef.history.replaceState({ ...windowRef.history.state, [stateKey]: value }, '', url);
    const validateReturn = value => {
        if (!value || !Number.isInteger(value.depth) || value.depth < 1) return null;
        try {
            const url = new URL(value.url, windowRef.location.href);
            return url.origin === windowRef.location.origin ? { ...value, url: url.href } : null;
        } catch { return null; }
    };
    const safeReturn = () => validateReturn(current().returnTo);
    const pageUrl = new URL(windowRef.location.href);
    if (pageUrl.searchParams.has(returnParameter)) {
        let returnTo;
        try { returnTo = validateReturn(JSON.parse(pageUrl.searchParams.get(returnParameter))); } catch { returnTo = null; }
        pageUrl.searchParams.delete(returnParameter);
        replace({ ...current(), ...(returnTo ? { returnTo } : {}) }, pageUrl.href);
    }
    const saveView = () => {
        if (departing) return;
        const view = captureView();
        if (view) replace({ ...current(), view });
    };
    const navigate = href => {
        const url = new URL(href, windowRef.location.href);
        if (url.origin !== windowRef.location.origin) throw new Error('RoboTeam navigation must stay on the same origin.');
        saveView();
        const parent = safeReturn();
        const returnTo = parent ? { ...parent, depth: parent.depth + 1 } : { url: windowRef.location.href, depth: 1 };
        departing = true;
        // Transfer only the return route through normal document navigation; consume it into frame history on arrival.
        url.searchParams.set(returnParameter, JSON.stringify(returnTo));
        windowRef.location.assign(url.href);
    };
    const returnToOrigin = () => {
        const target = safeReturn();
        if (target) windowRef.history.go(-target.depth);
        else windowRef.location.assign(fallbackUrl);
    };
    const plainClick = event => !event.defaultPrevented && event.button === 0
        && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
    const bindLink = link => {
        if (!link || boundLinks.has(link)) return;
        boundLinks.add(link);
        link.addEventListener('click', event => {
            if (!plainClick(event) || (link.target && link.target !== '_self')) return;
            event.preventDefault();
            navigate(link.href);
        });
    };
    for (const link of root.querySelectorAll('[data-return-control]')) {
        link.href = safeReturn()?.url || fallbackUrl;
        link.addEventListener('click', event => {
            if (!plainClick(event)) return;
            event.preventDefault();
            returnToOrigin();
        });
    }
    windowRef.addEventListener('pagehide', saveView);
    windowRef.addEventListener('pageshow', () => { departing = false; });
    return { bindLink, navigate, returnToOrigin, saveView, get view() { return current().view; } };
}

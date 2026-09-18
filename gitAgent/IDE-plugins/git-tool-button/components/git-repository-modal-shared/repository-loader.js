function getWebSkel() {
    return typeof window !== 'undefined' ? window.webSkel : null;
}

function getLoaderState() {
    if (typeof window === 'undefined') {
        return { depth: 0, id: null };
    }
    window.__gitRepositoryLoaderState ??= { depth: 0, id: null };
    return window.__gitRepositoryLoaderState;
}

export function beginRepositoryLoader() {
    const webSkel = getWebSkel();
    if (!webSkel?.showLoading || !webSkel?.hideLoading) return;
    const state = getLoaderState();
    if (state.depth === 0) {
        state.id = webSkel.showLoading();
    }
    state.depth += 1;
}

export function endRepositoryLoader() {
    const state = getLoaderState();
    if (state.depth <= 0) return;
    state.depth -= 1;
    if (state.depth === 0) {
        const webSkel = getWebSkel();
        webSkel?.hideLoading?.(state.id);
        state.id = null;
    }
}

export function hideRepositoryLoader() {
    const state = getLoaderState();
    if (state.depth === 0 && !state.id) return;
    state.depth = 0;
    const webSkel = getWebSkel();
    webSkel?.hideLoading?.(state.id);
    state.id = null;
}

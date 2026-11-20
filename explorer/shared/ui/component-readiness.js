// WebSkel replaces renderCompletePromise when a render starts. Await the replacement too before reading initialLoad.
async function waitForRender(node, cancelled) {
    while (!cancelled()) {
        const rendering = node.renderCompletePromise;
        await rendering;
        if (rendering === node.renderCompletePromise) return !cancelled();
    }
    return false;
}

export async function waitForComponentReady(node, cancelled = () => false) {
    if (!node) throw new Error('The panel could not be mounted.');
    await node.presenterReadyPromise;
    if (!await waitForRender(node, cancelled)) return false;
    await node.webSkelPresenter?.initialLoad;
    return waitForRender(node, cancelled);
}

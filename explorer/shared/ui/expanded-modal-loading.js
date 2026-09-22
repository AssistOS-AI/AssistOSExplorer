// Route Explorer loading indicators into the active shared panel. Tokens retain
// their original host so finishing an old operation cannot affect a new panel.
export function installExpandedModalLoading(ui) {
    const showLoading = ui.showLoading.bind(ui);
    const hideLoading = ui.hideLoading.bind(ui);
    const tokens = new WeakSet();
    ui.showLoading = () => {
        const panel = document.querySelector('dialog.expanded-modal-dialog expanded-modal');
        if (!panel) return showLoading();
        const token = { panel };
        tokens.add(token);
        panel.expandedLoaderCount = (panel.expandedLoaderCount || 0) + 1;
        panel.webSkelPresenter?.renderLoadingState();
        return token;
    };
    ui.hideLoading = (token) => {
        if (token && typeof token === 'object' && tokens.has(token)) {
            if (token.finished) return;
            token.finished = true;
            const panel = token.panel;
            panel.expandedLoaderCount = Math.max(0, (panel.expandedLoaderCount || 0) - 1);
            if (panel.isConnected) panel.webSkelPresenter?.renderLoadingState();
            return;
        }
        hideLoading(token);
    };
}

(() => {
    const keys = ['assistosExplorerTheme', 'webchat_theme'];
    const system = window.matchMedia?.('(prefers-color-scheme: dark)');
    function storedTheme() {
        try {
            for (const key of keys) {
                const value = window.localStorage.getItem(key);
                if (value) return ['dark', 'obsidian'].includes(value.toLowerCase()) ? 'dark' : 'light';
            }
        } catch (_) {
            // Storage may be unavailable; the browser preference remains usable.
        }
        return null;
    }
    function applyTheme() {
        const theme = storedTheme() || (system?.matches ? 'dark' : 'light');
        document.documentElement.dataset.theme = theme;
        document.documentElement.classList.toggle('theme-dark', theme === 'dark');
        document.documentElement.classList.toggle('theme-light', theme === 'light');
    }
    applyTheme();
    window.addEventListener('storage', (event) => {
        if (event.key === null || keys.includes(event.key)) applyTheme();
    });
    window.addEventListener('explorer-theme-change', applyTheme);
    window.addEventListener('pageshow', applyTheme);
    system?.addEventListener?.('change', applyTheme);
})();

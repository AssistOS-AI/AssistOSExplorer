// Pre-paint theme bootstrap for the Soul Gateway dashboard.
// Mirrors Explorer's stored theme so the first frame matches before CSS paints.
(function () {
    var EXPLORER_THEME_KEY = 'assistosExplorerTheme';
    var WEBCHAT_THEME_KEY = 'webchat_theme';

    function readStoredTheme(key) {
        try {
            var value = window.localStorage.getItem(key);
            return value ? String(value).toLowerCase() : '';
        } catch (_) {
            return '';
        }
    }

    function normalizeTheme(value) {
        if (value === 'dark' || value === 'obsidian') return 'dark';
        if (value === 'light') return 'light';
        return '';
    }

    var stored = normalizeTheme(readStoredTheme(EXPLORER_THEME_KEY))
        || normalizeTheme(readStoredTheme(WEBCHAT_THEME_KEY));
    var prefersDark = false;
    try {
        prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (_) {}
    var theme = stored || (prefersDark ? 'dark' : 'light');

    var root = document.documentElement;
    root.classList.toggle('theme-dark', theme === 'dark');
    root.classList.toggle('theme-light', theme === 'light');
    root.setAttribute('theme', theme);
    root.setAttribute('data-theme', theme);
})();

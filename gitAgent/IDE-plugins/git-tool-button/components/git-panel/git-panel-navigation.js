export function gitPanelPropsFromNavigation(props = {}, workspaceRoot) {
    const path = props.panelNavigation?.path;
    if (!path) return props;
    const root = String(workspaceRoot || '').replace(/\/+$/, '');
    if (!root || typeof path !== 'string' || path.length > 4096 || !path.startsWith(`${root}/`)
        || /[\x00-\x1f\x7f\\]/.test(path) || path.includes('//')
        || path.split('/').some(segment => segment === '.' || segment === '..')) {
        throw new Error('The selected repository is outside this workspace or its path is invalid.');
    }
    // Treat the link as navigation only; credentials and operations remain server-authorized.
    return { ...props, repoPath: path, selectedRepoPath: path };
}

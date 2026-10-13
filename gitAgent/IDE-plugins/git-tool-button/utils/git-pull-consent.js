export async function requestPullStashConsent({ repoPath, behind }) {
    const result = await assistOS.UI.showModal('git-pull-warning-modal', {
        repoPath: btoa(unescape(encodeURIComponent(String(repoPath)))),
        incoming: String(behind)
    }, true);
    return result?.policy === 'stash';
}

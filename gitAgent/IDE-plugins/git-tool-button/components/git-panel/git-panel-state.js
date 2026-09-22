import { createStore } from "/explorer/services/ui/store.js";
import {
    getRememberedGitIdentity,
    getRememberedGitAuthMethod,
    getRememberedGithubConnection,
    getAutocommitSettings,
    getShowAgentReposSetting
} from "./git-panel-utils.js";
import { getReposRoot } from "/explorer/utils/reposRoot.js";

export function createGitCommitState(props = {}) {
    const rememberedIdentity = getRememberedGitIdentity();
    const rememberedAuthMethod = getRememberedGitAuthMethod();
    const rememberedGithubConnection = getRememberedGithubConnection();
    const autocommitSettings = getAutocommitSettings();
    const showAgentRepos = getShowAgentReposSetting();
    const reposRoot = getReposRoot();
    const initialState = {
        // Default to the multi-repo root so opening the modal immediately loads all repos under it.
        repoPath: props.repoPath || reposRoot,
        reposRoot,
        branch: null,
        upstream: null,
        remotes: [],
        repoInfoOk: null,
        repoOverviews: [],
        showAgentRepos,
        repoOverviewsLoading: false,
        repoOverviewsLoaded: false,
        suppressInlineLoading: false,
        repoTreeExpanded: {},
        repoChangesExpanded: {},
        treeExpandedByRepo: {},
        selectedFilesByRepo: {},
        selectedRepoPath: props.selectedRepoPath || null,
        selectedPath: null,
        selectedSection: null, // 'staged' | 'unstaged' | 'untracked' | 'conflicted'
        commitMessage: '',
        mergeMessageSource: null,
        commitMode: 'commit', // 'commit' | 'commitPush'
        actionsMenuOpen: false,
        pullMode: 'merge', // 'ffOnly' | 'rebase' | 'merge'
        credentialsOpen: false,
        credentialsGate: false,
        credentialsValidated: false,
        credentialsDirty: false,
        credentialsBaseline: null,
        autocommitDirty: false,
        autocommitDraft: null,
        autoresolveDirty: false,
        autoresolveDraft: null,
        pullBlocked: null,
        autoStash: null,
        manualConflicts: [],
        hasConflicts: false,
        conflictCount: 0,
        conflictFocus: false,
        pendingAction: null,
        conflictHelper: {
            selected: null,
            ours: '',
            theirs: '',
            oursConflictRanges: [],
            theirsConflictRanges: [],
            choice: '',
            status: '',
            loading: false,
            requestKey: null
        },
        identityPrompt: {
            visible: false,
            repoPath: null,
            pendingAction: null,
            name: rememberedIdentity.name,
            email: rememberedIdentity.email
        },
        authPrompt: {
            visible: false,
            repoPath: null,
            pendingAction: null,
            token: '',
            authMethod: rememberedAuthMethod
        },
        githubAuth: {
            configured: Boolean(rememberedGithubConnection),
            connected: false,
            tokenStored: false,
            connection: rememberedGithubConnection || null,
            pending: null,
            setup: null,
            error: ''
        },
        lastStatusLine: '',
        lastStatusIsError: false
    };

    const store = createStore({ initialState });
    return {
        state: store.state,
        dispatch: store.dispatch,
        subscribe: store.subscribe,
        getState: store.getState,
        getSelectedReposForBatch: () => getSelectedReposForBatch(store.getState())
    };
}
export function getSelectedReposForBatch(state) {
    return Array.from(new Set([
        ...Object.entries(state.selectedFilesByRepo || {})
            .filter(([, entry]) => (entry?.files && entry.files.size > 0) || (entry?.prefixes && entry.prefixes.size > 0))
            .map(([repoPath]) => repoPath)
    ]));
}

import {
    normalizeErrorMessage,
    isReposRootPath,
    isGitAuthError,
    isGitIdentityError,
    isGitConflictError,
    isGitPullBlockedError,
    getRememberedGitIdentity,
    getRememberedGitAuthMethod,
    getAutocommitSettings,
    getShowAgentReposSetting,
    normalizeGitAuthMethod,
    setRememberedGitIdentity,
    setRememberedGitAuthMethod,
    setAutocommitSettings,
    setShowAgentReposSetting,
    getConflictAutoresolveSetting,
    setConflictAutoresolveSetting
} from "./git-panel-utils.js";
import { AUTOCOMMIT_SETTINGS_CHANGED_EVENT } from "/explorer/utils/appEvents.js";

export function createCredentialsActions(ctx) {
    const {
        getState,
        applyState,
        service,
        setStatusLine,
        updateCommitButtons,
        updateIdentityPrompt,
        updateAuthPrompt,
        refreshAll,
        refreshAfterGitOperation,
        pullRepos,
        pullSelectedRepos,
        push,
        pushRepos,
        syncSelectedRepos,
        commitSelectedRepos,
        getSelectedReposForBatch,
        getExplicitActionRepoPaths,
        getPrimaryExplicitActionRepoPath
    } = ctx;

    const resolveIdentityRepoPath = async () => {
        const state = getState();
        const explicit = typeof getPrimaryExplicitActionRepoPath === 'function'
            ? getPrimaryExplicitActionRepoPath()
            : '';
        if (explicit) {
            return explicit;
        }
        const selectedRepo = state.selectedRepoPath;
        if (selectedRepo && !isReposRootPath(selectedRepo, state.reposRoot)) return selectedRepo;
        return '';
    };

    const getExplicitRepoPaths = () => {
        if (typeof getExplicitActionRepoPaths === 'function') {
            return getExplicitActionRepoPaths();
        }
        const selected = getSelectedReposForBatch();
        if (selected.length) return selected;
        const state = getState();
        const selectedRepo = state.selectedRepoPath;
        if (selectedRepo && !isReposRootPath(selectedRepo, state.reposRoot)) return [selectedRepo];
        if (state.repoPath && !isReposRootPath(state.repoPath, state.reposRoot)) return [state.repoPath];
        return [];
    };

    const getGithubIdentityFallback = (state = getState()) => {
        const githubUser = state?.githubAuth?.connection?.user || {};
        return {
            name: String(githubUser?.login || githubUser?.name || '').trim(),
            email: String(githubUser?.email || '').trim()
        };
    };

    const getDisplayedAuthMethod = (state = getState()) => {
        const rawAuthMethod = normalizeGitAuthMethod(state.authPrompt?.authMethod || getRememberedGitAuthMethod());
        const currentToken = String(state.authPrompt?.token || '').trim();
        const githubConnected = Boolean(
            state.githubAuth?.connected
            && state.githubAuth?.connection?.source === 'github'
        );
        const tokenStored = Boolean(state.githubAuth?.tokenStored);
        if (githubConnected && !currentToken && !state.credentialsDirty) {
            return 'github';
        }
        if (tokenStored && !currentToken && !state.credentialsDirty && rawAuthMethod === 'token') {
            return 'token';
        }
        return rawAuthMethod;
    };

    const getAuthMethod = (state = getState()) => {
        return getDisplayedAuthMethod(state);
    };

    const showGitAuthPrompt = (repoPath, pendingAction, { message = '', authMethod = null } = {}) => {
        const state = getState();
        const nextAuthMethod = normalizeGitAuthMethod(authMethod || getAuthMethod());
        const tokenStored = Boolean(state.githubAuth?.tokenStored);
        setRememberedGitAuthMethod(nextAuthMethod);
        applyState({
            pendingAction: pendingAction || null,
            authPrompt: {
                visible: true,
                repoPath,
                pendingAction: pendingAction || null,
                token: '',
                authMethod: nextAuthMethod
            },
            credentialsBaseline: {
                name: String(state.identityPrompt?.name || getRememberedGitIdentity().name || '').trim(),
                email: String(state.identityPrompt?.email || getRememberedGitIdentity().email || '').trim(),
                authMethod: nextAuthMethod
            }
        });
        updateAuthPrompt({ 
            focus: nextAuthMethod === 'token' ? 'token' : undefined,
            activeTab: 'authentication'
        });
        updateCommitButtons();
        let statusMessage = message;
        if (!statusMessage) {
            if (nextAuthMethod === 'github' && !state.githubAuth?.configured) {
                statusMessage = 'GitHub sign-in is not available in this workspace.';
            } else if (nextAuthMethod === 'github') {
                statusMessage = 'Authentication required. Connect GitHub to continue.';
            } else if (tokenStored) {
                statusMessage = 'A token is already saved. You can replace it, or switch to GitHub instead.';
            } else {
                statusMessage = 'Authentication required. Enter a token or switch to GitHub.';
            }
        }
        setStatusLine(statusMessage, true);
    };

    const openGitTokenPrompt = () => {
        const state = getState();
        const repoPath = getExplicitRepoPaths()[0] || null;
        if (!repoPath) {
            setStatusLine('Select a file, folder, or repository first.', true);
            return;
        }
        showGitAuthPrompt(repoPath, null, { message: '', authMethod: 'token' });
    };

    const openGitIdentityPrompt = async () => {
        const state = getState();
        const repoPath = await resolveIdentityRepoPath();
        if (!repoPath) {
            setStatusLine('Select a file, folder, or repository first.', true);
            return;
        }

        const remembered = getRememberedGitIdentity();
        const githubIdentity = getGithubIdentityFallback(state);
        const name = remembered.name || state.identityPrompt?.name || githubIdentity.name;
        const email = remembered.email || state.identityPrompt?.email || githubIdentity.email;
        applyState({
            identityPrompt: {
                visible: true,
                repoPath,
                pendingAction: null,
                name,
                email
            },
            credentialsBaseline: {
                name,
                email,
                authMethod: getAuthMethod(state)
            }
        });
        updateIdentityPrompt({ focus: !name ? 'name' : (!email ? 'email' : 'name') });
        updateCommitButtons();
    };

    const cancelGitToken = () => {
        const state = getState();
        applyState({
            authPrompt: {
                visible: false,
                repoPath: null,
                pendingAction: null,
                token: '',
                authMethod: getAuthMethod(state)
            },
            credentialsOpen: state.credentialsOpen && !state.credentialsGate ? false : state.credentialsOpen,
            pendingAction: null
        });
        updateCommitButtons();
        setStatusLine('Cancelled.', true);
    };

    const cancelGitIdentity = () => {
        const state = getState();
        if (state.credentialsGate) {
            applyState({
                identityPrompt: {
                    ...state.identityPrompt,
                    visible: true
                }
            });
            updateIdentityPrompt({ focus: state.identityPrompt?.name ? 'email' : 'name' });
            updateCommitButtons();
            setStatusLine('Set name and email to continue.', true);
            return;
        }
        applyState({
            identityPrompt: { visible: false, repoPath: null, pendingAction: null, name: '', email: '' },
            credentialsOpen: state.credentialsOpen && !state.credentialsGate ? false : state.credentialsOpen
        });
        updateCommitButtons();
        setStatusLine('Cancelled.', true);
    };

    const cancelGitCredentials = () => {
        const state = getState();
        const rememberedIdentity = getRememberedGitIdentity();
        const rememberedAuthMethod = getRememberedGitAuthMethod();
        const autocommit = getAutocommitSettings();
        const showAgentRepos = getShowAgentReposSetting();
        const autoresolve = getConflictAutoresolveSetting();
        applyState({
            identityPrompt: {
                visible: false,
                repoPath: null,
                pendingAction: null,
                name: rememberedIdentity.name || '',
                email: rememberedIdentity.email || ''
            },
            authPrompt: {
                visible: false,
                repoPath: null,
                pendingAction: null,
                token: '',
                authMethod: normalizeGitAuthMethod(rememberedAuthMethod)
            },
            credentialsOpen: false,
            credentialsGate: false,
            pendingAction: null,
            credentialsDirty: false,
            showAgentRepos,
            autocommitDirty: false,
            autocommitDraft: {
                intervalMinutes: Number(autocommit.intervalMinutes || 15),
                repos: Array.isArray(autocommit.repos) ? autocommit.repos : []
            },
            autoresolveDirty: false,
            autoresolveDraft: { enabled: Boolean(autoresolve) }
        });
        updateCommitButtons();
        updateIdentityPrompt();
        setStatusLine('');
        return true;
    };

    const saveGitToken = async (payload = {}) => {
        const state = getState();
        const pending = state.pendingAction || state.authPrompt?.pendingAction;
        const authMethod = 'token';
        const token = String(payload.token ?? state.authPrompt?.token ?? '').trim();
        setRememberedGitAuthMethod(authMethod);
        applyState({
            authPrompt: {
                ...state.authPrompt,
                token,
                authMethod
            }
        }, { silent: true });
        if (!token) {
            applyState({
                authPrompt: {
                    ...state.authPrompt,
                    visible: true,
                    token: '',
                    authMethod
                }
            });
            updateAuthPrompt({ focus: 'token' });
            updateCommitButtons();
            setStatusLine('Enter a token to continue.', true);
            return;
        }
        const tokenResponse = await service.storeManualGitToken(token);
        const github = tokenResponse?.github || null;

        applyState({
            githubAuth: github
                ? {
                    ...state.githubAuth,
                    ...github,
                    error: ''
                }
                : state.githubAuth,
            authPrompt: {
                visible: false,
                repoPath: null,
                pendingAction: null,
                token: '',
                authMethod
            }
        });
        updateAuthPrompt();
        updateCommitButtons();
        await refreshAll({ force: true });
        if (pending?.type === 'sync') {
            setStatusLine('Retrying sync…');
        } else {
            setStatusLine(pending?.type === 'pull' ? 'Retrying pull…' : 'Retrying push…');
        }
        try {
            if (pending?.type === 'sync') {
                const list = Array.isArray(pending.repoPaths) ? pending.repoPaths : null;
                await syncSelectedRepos?.({ token, repoPaths: list });
            } else if (pending?.type === 'push') {
                if (pending.mode === 'batch') {
                    const list = Array.isArray(pending.repoPaths) ? pending.repoPaths : [];
                    await pushRepos(list, { token });
                    await refreshAfterGitOperation({ keepStatus: true });
                } else {
                    await push({ silent: false, token });
                }
            } else if (pending?.type === 'pull') {
                const list = Array.isArray(pending.repoPaths) ? pending.repoPaths : [];
                await pullRepos(list, { token });
                await refreshAfterGitOperation({ keepStatus: true });
            }
        } catch (error) {
            setStatusLine(normalizeErrorMessage(error), true);
        }
    };

    const collectCredentialsDraft = (state, payload = {}) => {
        const authMethod = normalizeGitAuthMethod(payload.authMethod ?? getAuthMethod(state));
        return {
            name: String(payload.name ?? state.identityPrompt?.name ?? '').trim(),
            email: String(payload.email ?? state.identityPrompt?.email ?? '').trim(),
            authMethod,
            token: String(payload.token ?? state.authPrompt?.token ?? '').trim(),
            showAgentRepos: typeof payload.showAgentRepos === 'boolean'
                ? payload.showAgentRepos
                : Boolean(state.showAgentRepos),
            usingGithub: authMethod === 'github',
            validateOnly: Boolean(payload.validateOnly),
            autocommitIntervalMinutes: payload.autocommitIntervalMinutes,
            autocommitRepos: Array.isArray(payload.autocommitRepos) ? payload.autocommitRepos : [],
            autoresolveConflicts: typeof payload.autoresolveConflicts === 'boolean'
                ? payload.autoresolveConflicts
                : getConflictAutoresolveSetting()
        };
    };

    const getCredentialsBaselineState = (state, draft) => {
        const rememberedIdentity = getRememberedGitIdentity();
        const rememberedAuthMethod = normalizeGitAuthMethod(getRememberedGitAuthMethod());
        const credentialsBaseline = state.credentialsBaseline || null;
        const baselineName = String(credentialsBaseline?.name ?? rememberedIdentity.name ?? '').trim();
        const baselineEmail = String(credentialsBaseline?.email ?? rememberedIdentity.email ?? '').trim();
        const baselineAuthMethod = normalizeGitAuthMethod(
            credentialsBaseline?.authMethod ?? getDisplayedAuthMethod(state) ?? rememberedAuthMethod
        );
        const hasIdentityChange = draft.name !== baselineName || draft.email !== baselineEmail;
        const hasAuthMethodChange = draft.authMethod !== baselineAuthMethod;
        const hasTokenChange = draft.usingGithub ? false : Boolean(draft.token);
        return {
            hasPersistableChanges: hasIdentityChange || hasAuthMethodChange || hasTokenChange
        };
    };

    const getCredentialsRuntimeState = (state, draft) => {
        const tokenStored = Boolean(state.githubAuth?.tokenStored);
        const githubConnected = Boolean(
            state.githubAuth?.connected
            && state.githubAuth?.connection?.source === 'github'
        );
        const githubConfigured = Boolean(state.githubAuth?.configured || githubConnected);
        const pending = state.pendingAction || state.authPrompt?.pendingAction || state.identityPrompt?.pendingAction;
        const identityRequired = Boolean(state.credentialsGate || state.identityPrompt?.visible);
        const authRequired = Boolean(state.authPrompt?.visible);
        const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
        const identityValid = Boolean(draft.name && draft.email && emailPattern.test(draft.email));
        const hasInputToken = Boolean(String(draft.token || '').trim());
        const authValid = draft.usingGithub
            ? Boolean(githubConnected)
            : Boolean(hasInputToken || tokenStored);
        const canSaveGithubSetup = draft.usingGithub
            && githubConfigured
            && !githubConnected
            && !pending?.type
            && !draft.validateOnly;
        return {
            githubConnected,
            githubConfigured,
            pending,
            identityRequired,
            authRequired,
            identityValid,
            hasInputToken,
            authValid,
            canSaveGithubSetup
        };
    };

    const applyCredentialsDraft = (state, draft) => {
        setRememberedGitAuthMethod(draft.authMethod);
        applyState({
            identityPrompt: {
                ...state.identityPrompt,
                name: draft.name,
                email: draft.email
            },
            authPrompt: {
                ...state.authPrompt,
                token: draft.token,
                authMethod: draft.authMethod
            }
        }, { silent: true });
    };

    const closeCredentialsWithoutChanges = (draft) => {
        applyState({
            identityPrompt: { visible: false, repoPath: null, pendingAction: null, name: '', email: '' },
            authPrompt: {
                visible: false,
                repoPath: null,
                pendingAction: null,
                token: '',
                authMethod: draft.authMethod
            },
            credentialsOpen: false
        });
        updateCommitButtons();
        setStatusLine('');
        return true;
    };

    const ensureIdentityIsValid = (state, draft, runtimeState) => {
        if (runtimeState.identityValid) {
            return true;
        }
        applyState({
            identityPrompt: {
                ...state.identityPrompt,
                visible: true,
                name: draft.name,
                email: draft.email
            }
        });
        updateIdentityPrompt({ focus: !draft.name ? 'name' : 'email' });
        updateCommitButtons();
        setStatusLine(!draft.name || !draft.email ? 'Enter name and email.' : 'Enter a valid email address.', true);
        return false;
    };

    const ensureAuthIsReady = (state, draft, runtimeState) => {
        if (runtimeState.authValid || runtimeState.canSaveGithubSetup) {
            return true;
        }
        applyState({
            authPrompt: {
                ...state.authPrompt,
                visible: true,
                token: '',
                authMethod: draft.authMethod
            }
        });
        updateAuthPrompt(draft.authMethod === 'token' ? { focus: 'token' } : {});
        updateCommitButtons();
        setStatusLine(
            draft.authMethod === 'github'
                ? (state.githubAuth?.configured ? 'Connect GitHub to continue.' : 'GitHub sign-in is not available in this workspace.')
                : 'Enter a token to continue.',
            true
        );
        return false;
    };

    const persistSettingsOnly = (draft) => {
        setAutocommitSettings({
            intervalMinutes: draft.autocommitIntervalMinutes,
            repos: draft.autocommitRepos
        });
        setShowAgentReposSetting(Boolean(draft.showAgentRepos));
        setConflictAutoresolveSetting(draft.autoresolveConflicts);
        try {
            window.dispatchEvent(new CustomEvent(AUTOCOMMIT_SETTINGS_CHANGED_EVENT));
        } catch {
            // ignore dispatch errors
        }
        applyState({
            showAgentRepos: Boolean(draft.showAgentRepos),
            autocommitDirty: false,
            autocommitDraft: {
                intervalMinutes: draft.autocommitIntervalMinutes,
                repos: draft.autocommitRepos
            },
            autoresolveDirty: false,
            autoresolveDraft: { enabled: draft.autoresolveConflicts }
        });
        updateCommitButtons();
        setStatusLine('Settings saved.');
        return true;
    };

    const validateCredentialsForSave = async (state, draft, runtimeState) => {
        let validationRepoPath = state.identityPrompt?.repoPath || state.authPrompt?.repoPath;
        if (!validationRepoPath) {
            validationRepoPath = await resolveIdentityRepoPath();
        }
        if (!validationRepoPath) {
            setStatusLine('Select a file, folder, or repository first.', true);
            return false;
        }
        if (!runtimeState.authValid) {
            setStatusLine(
                draft.authMethod === 'github'
                    ? (state.githubAuth?.configured ? 'Connect GitHub to validate credentials.' : 'GitHub sign-in is not available in this workspace.')
                    : 'Enter a token to validate credentials.',
                true
            );
            return false;
        }
        setStatusLine('Validating credentials...');
        try {
            await service.gitPull({
                path: validationRepoPath,
                rebase: false,
                ffOnly: false
            });
        } catch (error) {
            const msg = normalizeErrorMessage(error);
            const lower = msg.toLowerCase();
            if (isGitAuthError(msg) || lower.includes('repository not found')) {
                setStatusLine(
                    draft.usingGithub
                        ? 'GitHub validation failed. Reconnect GitHub or use a token.'
                        : 'Token validation failed. Check your token and repo access.',
                    true
                );
                return false;
            }
            if (lower.includes('remote is not https')) {
                setStatusLine(msg, true);
                return false;
            }
            if (isGitIdentityError(msg)) {
                setStatusLine('Author identity is not valid for git. Update name/email and retry.', true);
                return false;
            }
            if (!isGitPullBlockedError(msg) && !isGitConflictError(msg)) {
                setStatusLine(msg || 'Unable to validate credentials.', true);
                return false;
            }
        }
        applyState({ credentialsValidated: true });
        updateCommitButtons();
        setStatusLine('Credentials validated. Select autocommit repositories and save.');
        await refreshAll({ force: true });
        updateIdentityPrompt();
        return false;
    };

    const persistCredentialsDraft = async (state, draft, runtimeState) => {
        let identitySaved = false;
        let tokenSaved = false;
        if (runtimeState.identityValid) {
            setRememberedGitIdentity({ name: draft.name, email: draft.email });
            identitySaved = true;
        }

        if (!draft.usingGithub && runtimeState.authValid) {
            if (runtimeState.hasInputToken) {
                const storeResponse = await service.storeManualGitToken(String(draft.token || '').trim());
                let github = storeResponse?.github || null;
                if (!github) {
                    const statusResponse = await service.githubAuthStatus();
                    github = statusResponse?.github || null;
                }
                if (github) {
                    applyState({
                        githubAuth: {
                            ...state.githubAuth,
                            ...github,
                            error: ''
                        }
                    }, { silent: true });
                }
            }
            tokenSaved = true;
        } else if (draft.usingGithub && runtimeState.authValid) {
            tokenSaved = true;
        }

        setAutocommitSettings({
            intervalMinutes: draft.autocommitIntervalMinutes,
            repos: draft.autocommitRepos
        });
        setShowAgentReposSetting(Boolean(draft.showAgentRepos));
        setConflictAutoresolveSetting(draft.autoresolveConflicts);
        try {
            window.dispatchEvent(new CustomEvent(AUTOCOMMIT_SETTINGS_CHANGED_EVENT));
        } catch {
            // ignore dispatch errors
        }
        applyState({
            showAgentRepos: Boolean(draft.showAgentRepos),
            autocommitDirty: false,
            autocommitDraft: {
                intervalMinutes: draft.autocommitIntervalMinutes,
                repos: draft.autocommitRepos
            },
            autoresolveDirty: false,
            autoresolveDraft: { enabled: draft.autoresolveConflicts },
            credentialsDirty: false
        }, { silent: true });
        return { identitySaved, tokenSaved };
    };

    const finalizeCredentialsSave = (state, draft, runtimeState, persisted) => {
        const wasGate = state.credentialsGate;
        const gateCleared = persisted.identitySaved && persisted.tokenSaved && state.credentialsGate;
        applyState({
            identityPrompt: persisted.identitySaved
                ? { visible: false, repoPath: null, pendingAction: null, name: '', email: '' }
                : state.identityPrompt,
            authPrompt: (persisted.tokenSaved || runtimeState.authRequired)
                ? {
                    visible: false,
                    repoPath: null,
                    pendingAction: null,
                    token: '',
                    authMethod: draft.authMethod
                }
                : state.authPrompt,
            credentialsGate: gateCleared ? false : state.credentialsGate,
            credentialsOpen: state.credentialsOpen && !state.credentialsGate ? false : state.credentialsOpen
        });
        updateCommitButtons();
        return { wasGate };
    };

    const resumePendingGitAction = async (pending) => {
        if (!pending?.type) return false;
        if (pending.type === 'pull') {
            setStatusLine('Retrying pull…');
        } else if (pending.type === 'push') {
            setStatusLine('Retrying push…');
        } else if (pending.type === 'sync') {
            setStatusLine('Retrying sync…');
        } else if (pending.type === 'commit') {
            setStatusLine('Retrying commit…');
        }
        try {
            if (pending.type === 'commit') {
                await commitSelectedRepos();
            } else if (pending.type === 'sync') {
                const list = Array.isArray(pending.repoPaths) ? pending.repoPaths : null;
                await syncSelectedRepos?.({ repoPaths: list });
            } else if (pending.type === 'push') {
                if (pending.mode === 'batch') {
                    const list = Array.isArray(pending.repoPaths) ? pending.repoPaths : [];
                    await pushRepos(list);
                    await refreshAfterGitOperation({ keepStatus: true });
                } else {
                    await push({ silent: false });
                }
            } else if (pending.type === 'pull') {
                if (pending.mode === 'batch') {
                    const list = Array.isArray(pending.repoPaths) ? pending.repoPaths : [];
                    await pullRepos(list);
                    await refreshAfterGitOperation({ keepStatus: true });
                } else {
                    await pullSelectedRepos();
                }
            }
        } catch (error) {
            setStatusLine(normalizeErrorMessage(error), true);
        }
        return true;
    };

    const applySavedStatus = (draft, runtimeState, persisted) => {
        if (persisted.identitySaved && persisted.tokenSaved) {
            setStatusLine('Credentials saved.');
        } else if (persisted.identitySaved && draft.usingGithub) {
            setStatusLine(runtimeState.githubConnected ? 'Identity saved. GitHub is ready.' : 'Identity saved. Finish GitHub sign-in when you need Git operations.');
        } else if (persisted.identitySaved) {
            setStatusLine('Identity saved.');
        } else if (persisted.tokenSaved) {
            setStatusLine('Token saved.');
        } else if (draft.usingGithub && runtimeState.githubConnected) {
            setStatusLine('GitHub authentication ready.');
        } else if (draft.usingGithub && runtimeState.githubConfigured) {
            setStatusLine('Saved. Finish GitHub sign-in when you need Git operations.');
        }
    };

    const saveGitCredentials = async (payload = {}) => {
        try {
            const state = getState();
            const draft = collectCredentialsDraft(state, payload);
            const baselineState = getCredentialsBaselineState(state, draft);
            const runtimeState = getCredentialsRuntimeState(state, draft);

            if (
                !state.credentialsDirty
                && !state.autocommitDirty
                && !state.autoresolveDirty
                && !state.credentialsGate
                && !state.pendingAction
                && !baselineState.hasPersistableChanges
            ) {
                return closeCredentialsWithoutChanges(draft);
            }

            applyCredentialsDraft(state, draft);

            if (!ensureIdentityIsValid(state, draft, runtimeState)) {
                return false;
            }

            if (!ensureAuthIsReady(state, draft, runtimeState)) {
                return false;
            }

            if (!state.credentialsValidated && !state.credentialsDirty && (state.autocommitDirty || state.autoresolveDirty) && !draft.validateOnly) {
                return persistSettingsOnly(draft);
            }

            if (!runtimeState.pending?.type && !draft.validateOnly) {
                const persisted = await persistCredentialsDraft(state, draft, runtimeState);
                if (!persisted) {
                    return false;
                }
                const finalizeState = finalizeCredentialsSave(state, draft, runtimeState, persisted);
                applySavedStatus(draft, runtimeState, persisted);
                if (finalizeState.wasGate && persisted.identitySaved) {
                    await refreshAll({ force: true });
                }
                return true;
            }

            if (!state.credentialsValidated && runtimeState.pending?.type && runtimeState.identityValid && runtimeState.authValid && !draft.validateOnly) {
                applyState({ credentialsValidated: true });
            } else if (!state.credentialsValidated && !runtimeState.authValid && !draft.validateOnly && !runtimeState.canSaveGithubSetup) {
                applyState({ credentialsValidated: false }, { silent: true });
            } else if (!state.credentialsValidated && !runtimeState.canSaveGithubSetup) {
                return validateCredentialsForSave(state, draft, runtimeState);
            }
            if (draft.validateOnly) {
                setStatusLine('Credentials already validated.');
                return false;
            }

            const persisted = await persistCredentialsDraft(state, draft, runtimeState);
            if (!persisted) {
                return false;
            }
            const finalizeState = finalizeCredentialsSave(state, draft, runtimeState, persisted);

            if (await resumePendingGitAction(runtimeState.pending)) {
                return true;
            }

            applySavedStatus(draft, runtimeState, persisted);

            if (finalizeState.wasGate && persisted.identitySaved) {
                await refreshAll({ force: true });
            }
            return true;
        } catch (error) {
            setStatusLine(normalizeErrorMessage(error) || 'Unable to save credentials.', true);
            return false;
        }
    };

    const ensureGitIdentityOrPrompt = async (repoPath, pendingAction) => {
        if (!repoPath) return false;
        const state = getState();
        const remembered = getRememberedGitIdentity();
        
        const github = state.githubAuth || {};
        const githubUser = github.connection?.user || {};
        const githubName = String(githubUser?.login || githubUser?.name || '').trim();
        const githubEmail = String(githubUser?.email || '').trim();
        const name = remembered.name || githubName || '';
        const email = remembered.email || githubEmail || '';
        const hasIdentity = Boolean(name && email);

        const authMethod = normalizeGitAuthMethod(state.authPrompt?.authMethod || getRememberedGitAuthMethod());
        const githubConnected = Boolean(github.connected && github.connection?.source === 'github');
        const tokenStored = Boolean(github.tokenStored);
        const hasAuth = authMethod === 'github' ? githubConnected : tokenStored;

        if (hasIdentity && hasAuth) {
            return true;
        }

        applyState({
            identityPrompt: {
                ...state.identityPrompt,
                visible: true,
                repoPath,
                pendingAction: pendingAction || null,
                name,
                email
            },
            authPrompt: {
                ...state.authPrompt,
                visible: !hasAuth,
                authMethod
            },
            pendingAction: pendingAction || null
        });

        updateIdentityPrompt({ 
            focus: !name ? 'name' : (!email ? 'email' : (authMethod === 'token' && !tokenStored ? 'token' : 'name')),
            activeTab: 'authentication'
        });
        updateCommitButtons();
        
        let statusMsg = 'Set name, email and authentication to continue.';
        if (!hasIdentity && hasAuth) statusMsg = 'Set name and email to continue.';
        if (hasIdentity && !hasAuth) statusMsg = authMethod === 'github' ? 'Connect GitHub to continue.' : 'Enter a token to continue.';
        
        setStatusLine(statusMsg, true);
        return false;
    };

    const saveGitIdentity = async (payload = {}) => {
        const state = getState();
        const repoPath = state.identityPrompt?.repoPath;
        if (!repoPath) return;
        const name = String(payload.name ?? state.identityPrompt?.name ?? '').trim();
        const email = String(payload.email ?? state.identityPrompt?.email ?? '').trim();
        applyState({
            identityPrompt: {
                ...state.identityPrompt,
                name,
                email
            }
        }, { silent: true });
        if (!name || !email) {
            applyState({
                identityPrompt: {
                    ...state.identityPrompt,
                    visible: true,
                    name,
                    email
                }
            });
            updateIdentityPrompt({ focus: !name ? 'name' : 'email' });
            updateCommitButtons();
            setStatusLine('Enter name and email.', true);
            return;
        }
        setRememberedGitIdentity({ name, email });
        const pending = state.pendingAction || state.identityPrompt?.pendingAction;
        const wasGate = state.credentialsGate;
        applyState({
            identityPrompt: { visible: false, repoPath: null, pendingAction: null, name: '', email: '' },
            credentialsGate: false,
            pendingAction: null
        });
        updateCommitButtons();
        setStatusLine('Identity saved locally. Git config unchanged.');

        if (wasGate && !pending?.type) {
            await refreshAll({ force: true });
        }
        if (pending?.type === 'commit') {
            if (pending.mode === 'batch') await commitSelectedRepos();
            else await commitSelectedRepos();
        } else if (pending?.type === 'push') {
            await push({ silent: false });
        } else if (pending?.type === 'pull') {
            await pullSelectedRepos();
        } else if (pending?.type === 'sync') {
            await syncSelectedRepos?.();
        }
    };

    return {
        showGitAuthPrompt,
        openGitTokenPrompt,
        openGitIdentityPrompt,
        cancelGitToken,
        cancelGitIdentity,
        cancelGitCredentials,
        saveGitToken,
        saveGitCredentials,
        ensureGitIdentityOrPrompt,
        saveGitIdentity,
        resolveIdentityRepoPath
    };
}

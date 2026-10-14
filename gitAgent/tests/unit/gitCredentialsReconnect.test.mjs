import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as utils from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-utils.js';

const base = new URL('../../IDE-plugins/git-tool-button/components/git-panel/', import.meta.url);
const stripImports = (source) => source.replace(/^import[\s\S]*?from [^;]+;\n/gm, '');
const panelSource = stripImports(await fs.readFile(new URL('git-panel.js', base), 'utf8'))
    .replace('export class GitPanel', 'class GitPanel');
const actionsSource = stripImports(await fs.readFile(new URL('git-panel-actions-credentials.js', base), 'utf8'))
    .replace('export function createCredentialsActions', 'function createCredentialsActions');
const uiSource = stripImports(await fs.readFile(new URL('git-panel-ui.js', base), 'utf8'))
    .replace('export function createGitCommitUI', 'function createGitCommitUI');
const promptSource = (await fs.readFile(new URL('../git-credentials-prompt/git-credentials-prompt.js', base), 'utf8'))
    .replace('export class GitCredentialsPrompt', 'class GitCredentialsPrompt');

function fixture({ method = 'github', configured = true, identity, clearError, beginError, storeError, unloadOnClear = false } = {}) {
    const calls = [];
    const clearedTimers = [];
    let rememberedConnection = { source: 'github', user: { login: 'test-user' } };
    let shownCode = '';
    let savedMethod = method;
    let savedIdentity = identity || { name: 'Test User', email: 'test@example.test' };
    const writes = [];
    const statuses = [];
    const context = vm.createContext({
        ...utils,
        getRememberedGitIdentity: () => ({ ...savedIdentity }),
        setRememberedGitIdentity: (identity) => { savedIdentity = identity; writes.push('identity'); },
        getRememberedGitAuthMethod: () => savedMethod,
        setRememberedGitAuthMethod: (value) => { savedMethod = value; writes.push('method'); },
        getAutocommitSettings: () => ({ intervalMinutes: 15, repos: [] }),
        setAutocommitSettings: () => writes.push('autocommit'),
        getShowAgentReposSetting: () => false,
        setShowAgentReposSetting: () => writes.push('visibility'),
        getConflictAutoresolveSetting: () => false,
        setConflictAutoresolveSetting: () => writes.push('autoresolve'),
        getRememberedGithubConnection: () => rememberedConnection,
        setRememberedGithubConnection: (connection) => { rememberedConnection = connection; },
        clearRememberedGithubConnection: () => { rememberedConnection = null; calls.push('clear-cache'); },
        clearTimeout: (timer) => clearedTimers.push(timer),
        setTimeout: () => 9,
    });
    const GitPanel = vm.runInContext(`${panelSource}\nGitPanel;`, context);
    const createCredentialsActions = vm.runInContext(`${actionsSource}\ncreateCredentialsActions;`, context);
    const panel = Object.create(GitPanel.prototype);
    panel.state = {
        githubAuth: { configured, connected: true, tokenStored: true, connection: rememberedConnection },
        authPrompt: { authMethod: method },
        identityPrompt: { ...savedIdentity },
        credentialsOpen: true,
    };
    panel.githubPollTimer = 5;
    panel.unloaded = false;
    panel.setState = (patch) => Object.assign(panel.state, patch);
    panel.syncStaticUI = () => {};
    panel.ui = { getCredentialsPromptPresenter: () => null, toggleCredentials: () => { panel.state.credentialsOpen = !panel.state.credentialsOpen; } };
    panel.updateAuthPrompt = () => { shownCode = panel.state.githubAuth.pending?.userCode || ''; };
    panel.updateIdentityPrompt = panel.updateAuthPrompt;
    panel.closeCredentials = () => { panel.state.credentialsOpen = false; };
    panel.updateCommitButtons = () => {};
    panel.getPrimaryExplicitActionRepoPath = () => '';
    panel.refreshAll = async () => calls.push('refresh');
    panel.setStatusLine = (message, error) => statuses.push({ message, error: Boolean(error) });
    panel.service = {
        async disconnectGithubAuth() {
            calls.push('disconnect');
            if (clearError) throw clearError;
            if (unloadOnClear) panel.unloaded = true;
            return { github: { configured, connected: false, tokenStored: false, connection: null, pending: null } };
        },
        async startGithubDeviceFlow() {
            calls.push('begin');
            assert.equal(panel.githubPollTimer, null, 'Old polling must be stopped');
            if (beginError) throw beginError;
            return { github: {
                configured, connected: false, tokenStored: false, connection: null,
                pending: { userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', interval: 5 },
            } };
        },
        async storeManualGitToken() {
            calls.push('store-token');
            if (storeError) throw storeError;
            return { github: { configured, connected: false, tokenStored: true, connection: { source: 'manual-token' }, pending: null } };
        },
        async githubAuthStatus() { return { github: panel.state.githubAuth }; },
    };
    panel.actions = createCredentialsActions({
        getState: () => panel.state,
        applyState: panel.setState,
        service: panel.service,
        setStatusLine: panel.setStatusLine,
        updateAuthPrompt: panel.updateAuthPrompt,
        updateIdentityPrompt: panel.updateIdentityPrompt,
        updateCommitButtons: panel.updateCommitButtons,
        refreshAll: panel.refreshAll,
        push: async () => calls.push('push'),
    });
    return {
        panel, calls, clearedTimers, statuses, writes, context,
        shownCode: () => shownCode, remembered: () => rememberedConnection,
        savedMethod: () => savedMethod, savedIdentity: () => savedIdentity,
        save: (payload = {}) => panel.saveGitCredentials({ autocommitIntervalMinutes: 15, autocommitRepos: [], ...payload }),
    };
}


const disconnected = () => ({ configured: true, connected: false, tokenStored: false, connection: null, pending: null });
const authorized = (email = 'oauth@example.test') => ({ configured: true, connected: true, tokenStored: true, pending: null,
    connection: { source: 'github', user: { login: 'oauth-user', email } } });

test('disconnect stays visibly busy until the fresh device code arrives and rejects duplicate clicks', async () => {
    const f = fixture();
    let finishDisconnect;
    let finishBegin;
    let began;
    const beginStarted = new Promise((resolve) => { began = resolve; });
    f.panel.service.disconnectGithubAuth = () => new Promise((resolve) => { finishDisconnect = resolve; });
    f.panel.service.startGithubDeviceFlow = () => {
        began();
        return new Promise((resolve) => { finishBegin = resolve; });
    };
    const reconnecting = f.panel.disconnectGithubAuth();
    assert.equal(f.panel.state.githubAuthLoading, 'disconnecting');
    assert.equal(await f.panel.disconnectGithubAuth(), false);
    finishDisconnect({ github: disconnected() });
    await beginStarted;
    assert.equal(f.panel.state.githubAuthLoading, 'preparing');
    assert.equal(f.shownCode(), '');
    finishBegin({ github: { ...disconnected(), pending: {
        userCode: 'NEW-CODE', verificationUri: 'https://github.com/login/device', interval: 5,
    } } });
    assert.equal(await reconnecting, true);
    assert.equal(f.panel.state.githubAuthLoading, '');
    assert.equal(f.shownCode(), 'NEW-CODE');
});

for (const [option, message] of [
    ['clearError', 'Unable to clear credentials'],
    ['beginError', 'Device authorization unavailable'],
]) {
    test('loading stops when ' + option + ' occurs', async () => {
        const f = fixture({ [option]: new Error(message) });
        await f.panel.disconnectGithubAuth();
        assert.equal(f.panel.state.githubAuthLoading, '');
        if (option === 'beginError') {
            assert.match(f.panel.state.githubAuth.error, /Could not prepare GitHub sign-in/);
            assert.ok(f.panel.state.githubAuth.error.includes(message));
        }
        else assert.ok(f.statuses.some((status) => status.message === message && status.error));
    });
}

test('the prompt shows a spinner and disables repeated actions while disconnecting or preparing', () => {
    const f = fixture();
    const Prompt = vm.runInContext(promptSource + '\nGitCredentialsPrompt;', f.context);
    const prompt = new Prompt({ classList: { toggle() {} } }, () => {});
    prompt.githubLoadingSpinner = { hidden: true };
    prompt.githubStatus = { textContent: '' };
    prompt.githubPending = { hidden: true };
    prompt.githubAuth = { dataset: {} };
    prompt.githubDisconnectButton = { hidden: false, disabled: false };
    prompt.clearButton = { hidden: false, disabled: false };
    prompt.applyState({ githubAuthLoading: 'disconnecting', githubConnected: true });
    assert.equal(prompt.githubLoadingSpinner.hidden, false);
    assert.equal(prompt.githubStatus.textContent, 'Disconnecting GitHub…');
    assert.equal(prompt.githubDisconnectButton.disabled, true);
    assert.equal(prompt.clearButton.disabled, true);
    assert.equal(prompt.githubAuth.dataset.state, 'loading');
    prompt.applyState({ githubAuthLoading: 'preparing', githubConnected: false });
    assert.equal(prompt.githubStatus.textContent, 'Preparing GitHub sign-in…');
    assert.equal(prompt.githubPending.hidden, true);
    prompt.applyState({ githubAuthLoading: '', githubConfigured: true, githubPending: true });
    assert.equal(prompt.githubLoadingSpinner.hidden, true);
    assert.equal(prompt.githubStatus.textContent, 'Complete sign-in in GitHub.');
    assert.equal(prompt.githubPending.hidden, false);
    assert.equal(prompt.clearButton.disabled, false);
});

test('the parent forwards loading state to the credentials presenter', () => {
    const f = fixture();
    let detail;
    const createUI = vm.runInContext(uiSource + '\ncreateGitCommitUI;', f.context);
    const ui = createUI({ state: f.panel.state, element: { querySelector: (selector) => selector === 'git-credentials-prompt'
        ? { webSkelPresenter: { setState: (next) => { detail = next; } } } : null } });
    f.panel.state.githubAuthLoading = 'preparing';
    ui.updateCredentialsPrompt();
    assert.equal(detail.githubAuthLoading, 'preparing');
});

test('selecting disconnected GitHub immediately displays a code, without Save', async () => {
    const f = fixture({ method: 'token' });
    f.panel.state.githubAuth = disconnected();
    f.panel.handleCredentialsChange({ authMethod: 'github', credentialsDirty: true });
    await f.panel.githubStartPromise;
    assert.equal(f.shownCode(), 'TEST-CODE');
    assert.deepEqual(f.calls, ['begin']);
    assert.deepEqual(f.writes, []);
    assert.equal(f.savedMethod(), 'token');
});

test('switching from staged Token removal to GitHub discards only the removal draft and shows a code', async () => {
    const f = fixture({ method: 'token' });
    f.panel.state.githubAuth = { ...disconnected(), tokenStored: true, connection: { source: 'token' } };
    await f.panel.clearGitCredentials();
    assert.equal(f.panel.state.credentialsAuthAction, 'clear');
    f.panel.handleCredentialsChange({ authMethod: 'github', credentialsDirty: true });
    await f.panel.githubStartPromise;
    assert.equal(f.panel.state.credentialsAuthAction, null);
    assert.equal(f.shownCode(), 'TEST-CODE');
    assert.deepEqual(f.calls, ['begin'], 'Switching methods must not delete the saved Token');
    assert.deepEqual(f.writes, []);
});

for (const serverError of [false, true]) {
    test('a stale Token-removal flag cannot hide GitHub ' + (serverError ? 'errors' : 'codes'), () => {
        const f = fixture();
        f.panel.state.credentialsAuthAction = 'clear';
        f.panel.state.githubAuth = { ...disconnected(),
            error: serverError ? 'Could not prepare GitHub sign-in. Authorization service unavailable.' : '',
            pending: serverError ? null : { userCode: 'SERVER-CODE', verificationUri: 'https://github.com/login/device' },
        };
        let detail;
        const createUI = vm.runInContext(uiSource + '\ncreateGitCommitUI;', f.context);
        const ui = createUI({ state: f.panel.state, element: { querySelector: (selector) => selector === 'git-credentials-prompt'
            ? { webSkelPresenter: { setState: (next) => { detail = next; } } } : null } });
        ui.updateCredentialsPrompt();
        assert.equal(detail.credentialsAuthAction, null);
        const Prompt = vm.runInContext(promptSource + '\nGitCredentialsPrompt;', f.context);
        const prompt = new Prompt({ classList: { toggle() {} } }, () => {});
        prompt.githubStatus = { textContent: '' };
        prompt.githubAuth = { dataset: {} };
        prompt.githubPending = { hidden: true };
        prompt.githubCode = { textContent: '' };
        prompt.applyState(detail);
        if (serverError) {
            assert.match(prompt.githubStatus.textContent, /Could not prepare GitHub sign-in/);
            assert.equal(prompt.githubAuth.dataset.state, 'error');
        } else {
            assert.equal(prompt.githubStatus.textContent, 'Complete sign-in in GitHub.');
            assert.equal(prompt.githubPending.hidden, false);
            assert.equal(prompt.githubCode.textContent, 'SERVER-CODE');
        }
    });
}

test('a successful HTTP response without a code produces an actionable error rather than an idle panel', async () => {
    const f = fixture();
    f.panel.state.githubAuth = disconnected();
    f.panel.service.startGithubDeviceFlow = async () => ({ github: disconnected() });
    await assert.rejects(f.panel.ensureGithubDeviceFlow({ silent: true }), /did not return a sign-in code/);
    assert.match(f.panel.state.githubAuth.error, /did not return a sign-in code.*Close and reopen/);
    assert.equal(f.panel.state.githubAuthLoading, '');
    assert.equal(f.panel.githubPollTimer, null);
});

test('selecting already connected GitHub applies the method directly without requesting a new code', async () => {
    const f = fixture({ method: 'token' });
    f.panel.handleCredentialsChange({ authMethod: 'github', credentialsDirty: true });
    await Promise.resolve();
    assert.equal(f.savedMethod(), 'github');
    assert.ok(!f.calls.includes('begin'));
    assert.ok(!f.writes.includes('autocommit'));
});

test('opening disconnected GitHub immediately requests authorization', async () => {
    const f = fixture();
    f.panel.state.credentialsOpen = false;
    f.panel.state.githubAuth = disconnected();
    await f.panel.toggleCredentials();
    assert.equal(f.panel.state.credentialsOpen, true);
    assert.equal(f.shownCode(), 'TEST-CODE');
    assert.deepEqual(f.calls, ['begin']);
});

test('opening an existing authorization code resumes polling without another begin', async () => {
    const f = fixture();
    f.panel.state.githubAuth = { ...disconnected(), pending: {
        userCode: 'EXISTING-CODE', verificationUri: 'https://github.com/login/device', interval: 5,
    } };
    await f.panel.ensureGithubDeviceFlow({ silent: true });
    assert.equal(f.shownCode(), 'EXISTING-CODE');
    assert.equal(f.panel.githubPollTimer, 9);
    assert.deepEqual(f.calls, []);
});

for (const pendingPush of [false, true]) {
    test('GitHub approval applies directly without saving preferences: pending push=' + pendingPush, async () => {
        const f = fixture({ identity: {} });
        f.panel.state.githubAuth = disconnected();
        f.panel.state.credentialsGate = true;
        f.panel.state.credentialsOpen = false;
        f.panel.state.autocommitDirty = true;
        if (pendingPush) f.panel.state.pendingAction = { type: 'push' };
        await f.panel.ensureGithubDeviceFlow({ silent: true });
        f.panel.service.pollGithubDeviceFlow = async () => ({ github: authorized() });
        await f.panel.pollGithubAuth({ silent: true });
        assert.equal(f.savedMethod(), 'github');
        assert.equal(f.savedIdentity().name, 'oauth-user');
        assert.equal(f.savedIdentity().email, 'oauth@example.test');
        assert.equal(f.panel.state.githubAuth.connected, true);
        assert.equal(f.panel.state.credentialsGate, false);
        assert.equal(f.panel.state.credentialsOpen, true, 'Successful sign-in keeps the gate container open');
        assert.equal(f.calls.filter((call) => call === 'push').length, pendingPush ? 1 : 0);
        assert.ok(!f.calls.includes('store-token'));
        assert.ok(!f.writes.includes('autocommit'));
        assert.ok(!f.writes.includes('visibility'));
        assert.equal(f.panel.state.autocommitDirty, true);
        await f.panel.ensureGithubDeviceFlow({ silent: true });
        assert.equal(f.calls.filter((call) => call === 'push').length, pendingPush ? 1 : 0);
    });
}

test('an already authorized begin response completes the direct GitHub flow', async () => {
    const f = fixture({ identity: {} });
    f.panel.state.githubAuth = disconnected();
    f.panel.service.startGithubDeviceFlow = async () => ({ github: authorized() });
    await f.panel.ensureGithubDeviceFlow({ silent: true });
    assert.equal(f.savedMethod(), 'github');
    assert.equal(f.savedIdentity().email, 'oauth@example.test');
    assert.equal(f.panel.githubPollTimer, null);
});

test('missing profile email keeps Git operations gated; entering email completes directly on blur', async () => {
    const f = fixture({ identity: {} });
    f.panel.state.githubAuth = disconnected();
    f.panel.state.pendingAction = { type: 'push' };
    f.panel.state.credentialsGate = true;
    f.panel.service.pollGithubDeviceFlow = async () => ({ github: authorized('') });
    await f.panel.pollGithubAuth({ silent: true });
    assert.equal(f.panel.state.githubAuth.connected, true);
    assert.ok(!f.calls.includes('push'));
    assert.equal(f.panel.state.credentialsGate, true);
    f.panel.handleCredentialsChange({ email: 'provided@example.test', credentialsDirty: true, finalizeIdentity: true });
    await Promise.resolve();
    assert.equal(f.savedIdentity().email, 'provided@example.test');
    assert.equal(f.calls.filter((call) => call === 'push').length, 1);
});

for (const action of ['clearGitCredentials', 'disconnectGithubAuth']) {
    test(action + ' in GitHub mode clears directly and displays a fresh code', async () => {
        const f = fixture();
        assert.equal(await f.panel[action](), true);
        assert.deepEqual(f.calls, ['disconnect', 'refresh', 'clear-cache', 'begin']);
        assert.equal(f.shownCode(), 'TEST-CODE');
        assert.equal(f.panel.state.githubAuth.connected, false);
        assert.equal(f.remembered(), null);
        assert.equal(f.panel.state.credentialsAuthAction, null);
        assert.deepEqual(f.writes, []);
    });
}

test('failed GitHub disconnect preserves active state and does not start authorization', async () => {
    const f = fixture({ clearError: new Error('Unable to clear credentials') });
    assert.equal(await f.panel.clearGitCredentials(), false);
    assert.deepEqual(f.calls, ['disconnect']);
    assert.equal(f.panel.state.githubAuth.connected, true);
    assert.ok(f.remembered());
});

test('unavailable GitHub setup does not request authorization after direct disconnect', async () => {
    const f = fixture({ configured: false });
    assert.equal(await f.panel.clearGitCredentials(), true);
    assert.ok(!f.calls.includes('begin'));
});

test('a closed panel does not start authorization after direct disconnect', async () => {
    const f = fixture({ unloadOnClear: true });
    assert.equal(await f.panel.clearGitCredentials(), true);
    assert.ok(!f.calls.includes('begin'));
});

test('a reconnect error is displayed without undoing a completed GitHub disconnect', async () => {
    const f = fixture({ beginError: new Error('Device authorization unavailable') });
    assert.equal(await f.panel.clearGitCredentials(), true);
    assert.match(f.panel.state.githubAuth.error, /Could not prepare GitHub sign-in.*Device authorization unavailable/);
    assert.equal(f.panel.state.githubAuth.tokenStored, false);
});

test('Token Clear remains a draft; Cancel preserves active credentials', async () => {
    const f = fixture({ method: 'token' });
    await f.panel.clearGitCredentials();
    assert.deepEqual(f.calls, []);
    assert.equal(f.panel.state.githubAuth.tokenStored, true);
    f.panel.cancelGitCredentials();
    assert.equal(f.panel.state.credentialsAuthAction, null);
    assert.equal(f.panel.state.githubAuth.tokenStored, true);
    assert.deepEqual(f.writes, []);
});

test('Token Clear applies only at Save and never requests a GitHub code', async () => {
    const f = fixture({ method: 'token' });
    await f.panel.clearGitCredentials();
    assert.equal(await f.save(), true);
    assert.deepEqual(f.calls, ['disconnect', 'clear-cache']);
    assert.equal(f.panel.state.githubAuth.tokenStored, false);
});

test('typing a Token or blurring its field never applies it; Cancel discards edits', async () => {
    const f = fixture({ method: 'token' });
    f.panel.handleCredentialsChange({ name: 'Edited User', email: 'edited@example.test', token: 'fixture-token',
        credentialsDirty: true, finalizeIdentity: true });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.writes, []);
    f.panel.cancelGitCredentials();
    assert.equal(f.panel.state.identityPrompt.name, 'Test User');
    assert.equal(f.panel.state.authPrompt.token, '');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.writes, []);
});

test('a manual replacement is stored only on Save without deleting the previous token first', async () => {
    const f = fixture({ method: 'token' });
    await f.panel.clearGitCredentials();
    f.panel.handleCredentialsChange({ token: 'fixture-token', credentialsDirty: true });
    assert.deepEqual(f.calls, []);
    assert.equal(await f.save(), true);
    assert.deepEqual(f.calls, ['store-token', 'clear-cache']);
    assert.equal(f.panel.state.githubAuth.tokenStored, true);
});

test('an unsuccessful Token Save preserves saved identity and method; Cancel discards edits', async () => {
    const f = fixture({ method: 'github', storeError: new Error('Token storage unavailable') });
    f.panel.handleCredentialsChange({ authMethod: 'token', name: 'Edited User', token: 'fixture-token', credentialsDirty: true });
    assert.equal(await f.save(), false);
    assert.deepEqual(f.writes, []);
    assert.equal(f.savedMethod(), 'github');
    assert.equal(f.savedIdentity().name, 'Test User');
    f.panel.cancelGitCredentials();
    assert.equal(f.panel.state.authPrompt.authMethod, 'github');
});

test('an invalid identity prevents Token Save from applying a pending clear', async () => {
    const f = fixture({ method: 'token' });
    await f.panel.clearGitCredentials();
    assert.equal(await f.save({ email: 'invalid' }), false);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.writes, []);
});

test('a late GitHub poll after switching to Token cannot save the Token draft or resume Git', async () => {
    const f = fixture();
    f.panel.state.githubAuth = disconnected();
    f.panel.state.pendingAction = { type: 'push' };
    let finish;
    f.panel.service.pollGithubDeviceFlow = () => new Promise((resolve) => { finish = resolve; });
    const polling = f.panel.pollGithubAuth({ silent: true });
    f.panel.handleCredentialsChange({ authMethod: 'token', token: 'fixture-token', credentialsDirty: true });
    finish({ github: authorized() });
    await polling;
    assert.equal(f.panel.state.authPrompt.token, 'fixture-token');
    assert.equal(f.panel.state.authPrompt.authMethod, 'token');
    assert.deepEqual(f.writes, []);
    assert.ok(!f.calls.includes('push'));
    assert.ok(!f.calls.includes('store-token'));
});

test('a response after the panel closes does not restart polling or resume Git', async () => {
    const f = fixture();
    f.panel.state.githubAuth = disconnected();
    const priorAuth = f.panel.state.githubAuth;
    let finish;
    f.panel.service.pollGithubDeviceFlow = () => new Promise((resolve) => { finish = resolve; });
    const polling = f.panel.pollGithubAuth({ silent: true });
    f.panel.unloaded = true;
    finish({ github: authorized() });
    await polling;
    assert.equal(f.panel.state.githubAuth, priorAuth);
    assert.deepEqual(f.writes, []);
});

test('Save and Cancel are hidden only for GitHub Authentication, not Token or Preferences', () => {
    const f = fixture();
    const Prompt = vm.runInContext(promptSource + '\nGitCredentialsPrompt;', f.context);
    const prompt = Object.create(Prompt.prototype);
    prompt.credentialsButtons = { hidden: false };
    prompt.closeButton = { hidden: true };
    for (const [authMethod, activeTab, hidden] of [
        ['github', 'authentication', true],
        ['token', 'authentication', false],
        ['github', 'preferences', false],
        ['token', 'preferences', false],
    ]) {
        prompt.state = { authMethod, activeTab };
        prompt.updateCredentialsButtons();
        assert.equal(prompt.credentialsButtons.hidden, hidden);
        assert.equal(prompt.closeButton.hidden, !hidden);
    }
});

test('Close dismisses GitHub credentials without disconnecting or saving preferences', async () => {
    const f = fixture();
    f.panel.state.credentialsOpen = false;
    f.panel.state.credentialsGate = true;
    await f.panel.actions.completeGithubAuthentication();
    assert.equal(f.panel.state.credentialsOpen, true);
    const activeConnection = f.panel.state.githubAuth;
    const priorWrites = [...f.writes];
    f.panel.state.autocommitDirty = true;
    const Prompt = vm.runInContext(promptSource + '\nGitCredentialsPrompt;', f.context);
    const prompt = new Prompt({}, () => {});
    prompt.getParentPresenter = () => f.panel;
    prompt.closeGitCredentials();
    assert.equal(f.panel.state.credentialsOpen, false);
    assert.equal(f.panel.state.credentialsGate, false);
    assert.equal(f.panel.state.githubAuth, activeConnection);
    assert.equal(f.panel.state.githubAuth.connected, true);
    assert.equal(f.savedMethod(), 'github');
    assert.equal(f.panel.state.autocommitDirty, false);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.writes, priorWrites);
});

test('Close while preparing a code dismisses the container and ignores a late UI response', async () => {
    const f = fixture();
    f.panel.state.githubAuth = disconnected();
    let finish;
    f.panel.service.startGithubDeviceFlow = () => new Promise((resolve) => { finish = resolve; });
    const preparing = f.panel.ensureGithubDeviceFlow({ silent: true });
    const Prompt = vm.runInContext(promptSource + '\nGitCredentialsPrompt;', f.context);
    const prompt = new Prompt({}, () => {});
    prompt.getParentPresenter = () => f.panel;
    prompt.closeGitCredentials();
    finish({ github: authorized() });
    await preparing;
    assert.equal(f.panel.state.credentialsOpen, false);
    assert.equal(f.panel.state.githubAuthLoading, '');
    assert.equal(f.panel.state.githubAuth.connected, false);
    assert.equal(f.panel.githubPollTimer, null);
    assert.deepEqual(f.writes, []);
});

test('Preferences Save never applies an unsaved Token or pending credential clear', async () => {
    const f = fixture({ method: 'token' });
    f.panel.handleCredentialsChange({ token: 'fixture-token', credentialsDirty: true });
    await f.panel.clearGitCredentials();
    assert.equal(await f.save({ preferencesOnly: true }), true);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.writes, ['autocommit', 'visibility', 'autoresolve']);
    assert.equal(f.panel.state.githubAuth.tokenStored, true);
    assert.equal(f.savedMethod(), 'token');
});

test('the dialog previews staged Token removal without changing active credentials', async () => {
    const f = fixture({ method: 'token' });
    let detail;
    const createUI = vm.runInContext(uiSource + '\ncreateGitCommitUI;', f.context);
    const ui = createUI({ state: f.panel.state, element: { querySelector: (selector) => selector === 'git-credentials-prompt'
        ? { webSkelPresenter: { setState: (next) => { detail = next; } } } : null } });
    await f.panel.clearGitCredentials();
    ui.updateCredentialsPrompt();
    assert.equal(detail.tokenStored, false);
    assert.equal(detail.credentialsAuthAction, 'clear');
    assert.equal(f.panel.state.githubAuth.tokenStored, true);
    f.panel.cancelGitCredentials();
    ui.updateCredentialsPrompt();
    assert.equal(detail.tokenStored, true);
    assert.equal(detail.credentialsAuthAction, null);
});

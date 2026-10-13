import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

import * as utils from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-utils.js';
import { createStore } from '../../../explorer/services/ui/store.js';

const base = new URL('../../IDE-plugins/git-tool-button/components/git-panel/', import.meta.url);
const stripImports = (source) => source.replace(/^import[\s\S]*?from [^;]+;\n/gm, '');
const panelSource = stripImports(await fs.readFile(new URL('git-panel.js', base), 'utf8'))
    .replace('export class GitPanel', 'class GitPanel');
const actionsSource = stripImports(await fs.readFile(new URL('git-panel-actions-credentials.js', base), 'utf8'))
    .replace('export function createCredentialsActions', 'function createCredentialsActions');
const stateSource = stripImports(await fs.readFile(new URL('git-panel-state.js', base), 'utf8'))
    .replace(/^export /gm, '');
const uiSource = stripImports(await fs.readFile(new URL('git-panel-ui.js', base), 'utf8'))
    .replace('export function createGitCommitUI', 'function createGitCommitUI');

function fixture(t, saved) {
    const previousStorage = globalThis.localStorage;
    const values = new Map();
    const writes = [];
    globalThis.localStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem(key, value) { values.set(key, String(value)); writes.push(key); },
        removeItem(key) { values.delete(key); writes.push(key); },
    };
    t.after(() => {
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
    });
    utils.setShowAgentReposSetting(saved);
    utils.setRememberedGitIdentity({ name: 'Test User', email: 'test@example.test' });
    utils.setRememberedGitAuthMethod('token');
    writes.length = 0;

    const events = [];
    const context = vm.createContext({
        ...utils,
        createStore,
        getReposRoot: () => '/workspace',
        window: { dispatchEvent: (event) => events.push(event.type) },
        CustomEvent: class { constructor(type) { this.type = type; } },
        AUTOCOMMIT_SETTINGS_CHANGED_EVENT: 'autocommit-settings-changed',
    });
    const GitPanel = vm.runInContext(`${panelSource}\nGitPanel;`, context);
    const createCredentialsActions = vm.runInContext(`${actionsSource}\ncreateCredentialsActions;`, context);
    const createGitCommitState = vm.runInContext(`${stateSource}\ncreateGitCommitState;`, context);
    const createGitCommitUI = vm.runInContext(`${uiSource}\ncreateGitCommitUI;`, context);
    const panel = Object.create(GitPanel.prototype);
    panel.stateStore = createGitCommitState();
    panel.state = panel.stateStore.state;
    Object.assign(panel.state, {
        credentialsOpen: true,
        identityPrompt: { name: 'Test User', email: 'test@example.test', visible: false },
        authPrompt: { authMethod: 'token', token: '', visible: false },
        githubAuth: { tokenStored: true },
        repoOverviews: [
            { path: '/workspace/project' },
            { path: '/workspace/.ploinky/repos/agent' },
        ],
    });
    let visibleRepos = [];
    let checkbox = saved;
    const treeStates = [];
    const presenters = {
        'git-repo-tree': { setState(detail) {
            visibleRepos = detail.repos;
            treeStates.push({ count: detail.repos.length, saved: utils.getShowAgentReposSetting() });
        } },
        'git-credentials-prompt': { setState(detail) { checkbox = detail.showAgentRepos; } },
    };
    panel.ui = createGitCommitUI({
        state: panel.state,
        element: { querySelector: (selector) => presenters[selector] ? { webSkelPresenter: presenters[selector] } : null },
    });
    panel.ui.syncStaticUI = () => panel.ui.updateRepoTree();
    panel.applyDefaultRepoTreeExpansion = () => {};
    panel.updateCommitButtons = () => {};
    panel.setStatusLine = () => {};
    panel.closeCredentials = () => { panel.state.credentialsOpen = false; };
    panel.actions = createCredentialsActions({
        getState: () => panel.state,
        applyState: panel.setState.bind(panel),
        service: {},
        setStatusLine: panel.setStatusLine,
        updateCommitButtons: panel.updateCommitButtons,
        updateIdentityPrompt: panel.updateIdentityPrompt.bind(panel),
        updateAuthPrompt: panel.ui.updateAuthPrompt,
    });
    panel.ui.updateRepoTree();
    panel.ui.updateCredentialsPrompt();
    return {
        panel, writes, events, treeStates, createGitCommitState,
        toggle(value) {
            panel.handleCredentialsChange({
                showAgentRepos: value, autocommitDirty: true,
                autocommitIntervalMinutes: 15, autocommitRepos: [],
            });
        },
        visibleCount: () => visibleRepos.length,
        checkbox: () => checkbox,
    };
}

for (const saved of [false, true]) {
    test(`Cancel restores saved repository visibility ${saved} without writing the preference`, (t) => {
        const f = fixture(t, saved);
        f.toggle(!saved);
        assert.equal(f.checkbox(), !saved, 'Only the dialog displays the draft');
        assert.equal(f.visibleCount(), saved ? 2 : 1, 'The changes list must retain saved visibility');
        f.panel.syncStaticUI();
        f.panel.ui.updateCredentialsPrompt();
        assert.equal(f.checkbox(), !saved, 'Dialog refreshes preserve the draft');
        assert.equal(f.panel.state.showAgentRepos, saved);
        assert.equal(f.visibleCount(), saved ? 2 : 1, 'Background refreshes must not apply the draft');
        assert.equal(utils.getShowAgentReposSetting(), saved, 'Toggling must not persist');
        assert.deepEqual(f.writes, []);
        assert.equal(f.panel.cancelGitCredentials(), true);
        assert.equal(f.panel.state.showAgentRepos, saved);
        assert.equal(f.checkbox(), saved);
        assert.equal(f.visibleCount(), saved ? 2 : 1);
        assert.equal(f.panel.state.autocommitDirty, false);
        assert.equal(f.panel.state.credentialsOpen, false);
        assert.equal(f.createGitCommitState().state.showAgentRepos, saved, 'Reopening uses the saved preference');
        assert.deepEqual(f.writes, []);
        assert.deepEqual(f.events, []);
    });

    test(`Save persists changed repository visibility from ${saved} to ${!saved}`, async (t) => {
        const f = fixture(t, saved);
        f.toggle(!saved);
        assert.equal(utils.getShowAgentReposSetting(), saved);
        assert.equal(f.visibleCount(), saved ? 2 : 1);
        assert.equal(await f.panel.saveGitCredentials({
            showAgentRepos: !saved, autocommitIntervalMinutes: 15, autocommitRepos: [],
        }), true);
        assert.equal(utils.getShowAgentReposSetting(), !saved);
        assert.equal(f.panel.state.autocommitDirty, false);
        assert.equal(f.visibleCount(), saved ? 1 : 2);
        assert.equal(f.createGitCommitState().state.showAgentRepos, !saved);
        assert.deepEqual(f.events, ['autocommit-settings-changed']);
        assert.ok(f.treeStates.every(({ count, saved: stored }) => count === (stored ? 2 : 1)),
            'Every tree render must match the persisted preference');
    });
}

test('repeated toggles remain a draft until Cancel', (t) => {
    const f = fixture(t, false);
    for (const value of [true, false, true]) f.toggle(value);
    f.panel.syncStaticUI();
    assert.equal(f.visibleCount(), 1);
    assert.equal(utils.getShowAgentReposSetting(), false);
    assert.deepEqual(f.writes, []);
    f.panel.cancelGitCredentials();
    assert.equal(f.checkbox(), false);
    assert.equal(f.visibleCount(), 1);
});

test('Save without an explicit visibility payload persists the dialog draft', async (t) => {
    const f = fixture(t, false);
    f.toggle(true);
    assert.equal(await f.panel.saveGitCredentials({ autocommitIntervalMinutes: 15, autocommitRepos: [] }), true);
    assert.equal(utils.getShowAgentReposSetting(), true);
    assert.equal(f.visibleCount(), 2);
});

test('an unsuccessful Save does not persist the visibility draft', async (t) => {
    const f = fixture(t, false);
    f.toggle(true);
    f.panel.state.identityPrompt.email = 'invalid';
    assert.equal(await f.panel.saveGitCredentials({
        showAgentRepos: true, autocommitIntervalMinutes: 15, autocommitRepos: [],
    }), false);
    assert.equal(utils.getShowAgentReposSetting(), false);
    f.panel.syncStaticUI();
    assert.equal(f.visibleCount(), 1, 'An unsuccessful Save must not update the changes list');
    f.panel.cancelGitCredentials();
    assert.equal(f.checkbox(), false);
    assert.equal(f.visibleCount(), 1);
});

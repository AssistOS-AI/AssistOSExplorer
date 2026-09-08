import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {getVisibleMarketplaceCatalog} from '../../IDE-plugins/marketplace/components/marketplace-modal/marketplaceVisibility.js';
import {loadMarketplaceModal} from '../helpers/marketplaceModal.js';
import {marketplaceCatalog, hiddenRepositoryNames, visibleRepositoryNames, visibleAgentRefs} from '../helpers/marketplaceCatalog.js';

class Element {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.dataset = {};
        this.textContent = '';
        this.className = '';
        this.classList = {toggle() {}};
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    set innerHTML(value) { this.children = []; this.textContent = value; }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    toggleAttribute(name, value) { this[name] = value; }
    querySelectorAll(selector) {
        return this.children.flatMap(elements).filter(element => {
            if (selector.startsWith('.')) return element.className.split(' ').includes(selector.slice(1));
            const attribute = selector.match(/^\[data-([a-z-]+)\]$/);
            if (!attribute) return false;
            const key = attribute[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
            return key in element.dataset;
        });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function elements(root) {
    return [root, ...root.children.flatMap(elements)];
}

function renderedRefs(modal) {
    return elements(modal.agentsEl).map(row => row.dataset.marketplaceAgentRef).filter(Boolean);
}

function renderedRepos(modal, tab) {
    const className = tab === 'agents' ? 'marketplace-repo-title' : 'marketplace-title';
    return elements(tab === 'agents' ? modal.agentsEl : modal.repositoriesEl)
        .filter(row => row.className.split(' ').includes(className)).map(row => row.textContent);
}

async function createModal(t) {
    const originalDocument = globalThis.document;
    globalThis.document = {createElement: tag => new Element(tag)};
    const {MarketplaceModal} = await loadMarketplaceModal();
    const modal = new MarketplaceModal({querySelector() {}}, () => {});
    modal.repositoriesEl = new Element('div');
    modal.agentsEl = new Element('div');
    modal.state.marketplace = marketplaceCatalog();
    modal.state.expandedAgentRepos = Object.fromEntries([
        ...modal.state.marketplace.repositories.map(repo => repo.name), 'AllowedOrphan', '__no_repo__',
    ].map(name => [name, true]));
    modal.state.agentSettingsItems = [{
        key: 'worker-settings', available: true, ownerAgent: 'AchillesIDE/worker', settingsComponent: 'worker-settings',
    }];
    t.after(() => {
        clearTimeout(modal.agentStatusRefreshTimer);
        clearTimeout(modal.agentSearchTimer);
        if (originalDocument === undefined) delete globalThis.document;
        else globalThis.document = originalDocument;
    });
    return modal;
}

test('Marketplace visibility excludes every named repository, skill source, alias and associated agent without changing source state', () => {
    const source = marketplaceCatalog();
    const before = structuredClone(source);
    const visible = getVisibleMarketplaceCatalog(source);
    assert.deepEqual(visible.repositories.map(repo => repo.name), visibleRepositoryNames);
    assert.deepEqual(visible.agents.map(agent => agent.ref), visibleAgentRefs);
    assert.deepEqual(source, before);
    assert.equal(visible.agents[0], source.agents.find(agent => agent.ref === visibleAgentRefs[0]), 'preserve lifecycle identity');
    assert.equal(visible.repositories[0].activeAgentsCount, 1, 'counts exclude skill entries from the runtime registry');
    delete source.enabledAgents;
    assert.equal(getVisibleMarketplaceCatalog(source).repositories[0].activeAgentsCount, 1, 'active rows supply counts without registry data');
    assert.deepEqual(getVisibleMarketplaceCatalog({}), {repositories: [], agents: []});
});

test('Marketplace propagates skill source aliases regardless of order and filters orphaned hidden refs', () => {
    const source = marketplaceCatalog();
    source.repositories.reverse();
    assert.deepEqual(getVisibleMarketplaceCatalog(source).repositories.map(repo => repo.name), [...visibleRepositoryNames].reverse());
    source.repositories = [];
    assert.ok(!getVisibleMarketplaceCatalog(source).agents.some(agent => agent.ref === 'BASIC/orphan'));
    assert.ok(getVisibleMarketplaceCatalog(source).agents.some(agent => agent.ref === 'AllowedOrphan/worker'));
});

test('Marketplace resolves encoded Git source names and preserves unrelated names and malformed escapes', () => {
    const sources = [
        'https://github.com/AssistOS-AI/%42asic.git',
        'git+https://github.com/AssistOS-AI/%44ocumentationSkills.git#main',
        'ssh://git@github.com/PloinkyRepos/Container-Image-Builds.git/',
        'git@github.com:PloinkyRepos/CLOUD.git',
    ];
    const repositories = sources.map((url, index) => ({name: `encoded-alias-${index}`, url, kind: 'agents'}));
    repositories.push({name: 'basic-tools', kind: 'agents'}, {name: 'broken%escape', kind: 'unknown'});
    const agents = repositories.map(repo => ({repo: repo.name, name: 'worker', ref: `${repo.name}/worker`}));
    const visible = getVisibleMarketplaceCatalog({repositories, agents});
    assert.deepEqual(visible.repositories.map(repo => repo.name), ['basic-tools', 'broken%escape']);
    assert.deepEqual(visible.agents.map(agent => agent.ref), ['basic-tools/worker', 'broken%escape/worker']);
});

test('Marketplace enabled counts distinguish case-sensitive agent names from hidden skill entries', () => {
    const visible = getVisibleMarketplaceCatalog({
        repositories: [{name: 'allowed', kind: 'agents'}],
        agents: [
            {repo: 'allowed', name: 'Agent', ref: 'allowed/Agent', type: 'skill', active: true},
            {repo: 'allowed', name: 'agent', ref: 'allowed/agent', active: true},
        ],
        enabledAgents: [{repoName: 'allowed', agentName: 'Agent'}, {repoName: 'allowed', agentName: 'agent'}],
    });
    assert.deepEqual(visible.agents.map(agent => agent.name), ['agent']);
    assert.equal(visible.repositories[0].activeAgentsCount, 1);
});

test('Marketplace keeps distinct local repository groups, counts and lifecycle refs despite similar visibility identities', async (t) => {
    const modal = await createModal(t);
    const repositories = ['tools', 'tools.git', 'Tools'].map(name => ({name, kind: 'agents', installed: true}));
    const agents = repositories.map((repo, index) => ({
        repo: repo.name, name: 'worker', ref: `${repo.name}/worker`,
        active: index !== 1, status: index === 1 ? 'inactive' : 'running', running: index !== 1,
    }));
    const catalog = {repositories, agents, permissions: {canManage: true}};
    const counts = value => getVisibleMarketplaceCatalog(value).repositories.map(repo => [repo.name, repo.activeAgentsCount]);
    assert.deepEqual(counts(catalog), [['tools', 1], ['tools.git', 0], ['Tools', 1]]);
    catalog.enabledAgents = [{repoName: 'tools', agentName: 'worker'}, {repoName: 'Tools', agentName: 'worker'}];
    assert.deepEqual(counts(catalog), [['tools', 1], ['tools.git', 0], ['Tools', 1]]);
    assert.deepEqual(counts({
        ...catalog, enabledAgents: repositories.map(repo => ({repoName: repo.name, agentName: 'worker'})),
    }), [['tools', 1], ['tools.git', 1], ['Tools', 1]], 'one enabled record per distinct local repository');

    modal.state.marketplace = catalog;
    modal.state.expandedAgentRepos = Object.fromEntries(repositories.map(repo => [repo.name, true]));
    modal.renderState();
    const groups = modal.agentsEl.children.map(group => ({
        name: elements(group).find(row => row.className.includes('marketplace-repo-title')).textContent,
        refs: elements(group).map(row => row.dataset.marketplaceAgentRef).filter(Boolean),
    }));
    assert.deepEqual(groups, repositories.map(repo => ({name: repo.name, refs: [`${repo.name}/worker`]})));
    assert.deepEqual(modal.repositoriesEl.children.map(row => (
        elements(row).filter(child => child.className === 'marketplace-meta' && !child.hidden).length
    )), [1, 0, 1], 'each repository warning counts only its own enabled agents');

    const updatedRefs = [];
    modal.updateAgentRuntimeUi = agent => updatedRefs.push(agent.ref);
    const refreshed = structuredClone(catalog);
    Object.assign(refreshed.agents[1], {active: true, status: 'starting', running: false});
    modal.applyMarketplaceSnapshot(refreshed);
    assert.deepEqual(updatedRefs, ['tools/worker', 'tools.git/worker', 'Tools/worker']);
    assert.deepEqual(modal.state.marketplace.agents.map(agent => agent.status), ['running', 'starting', 'running']);
});

test('Marketplace renders only visible repositories and agents in both tabs and type filters', async (t) => {
    const modal = await createModal(t);
    modal.renderState();
    assert.deepEqual(renderedRefs(modal), visibleAgentRefs);
    assert.deepEqual(renderedRepos(modal, 'agents'), [...visibleRepositoryNames, 'AllowedOrphan', '(No repository)']);
    assert.deepEqual(renderedRepos(modal, 'repos'), visibleRepositoryNames.filter(name => name !== 'resources'));
    modal.switchRepoKindTab({currentTarget: {dataset: {repoKindTab: 'others'}}});
    assert.deepEqual(renderedRepos(modal, 'repos'), ['resources']);
    modal.switchRepoKindTab({currentTarget: {dataset: {repoKindTab: 'skills'}}});
    assert.equal(modal.state.activeRepoKindTab, 'agents', 'a stale skills selection returns to Agent Repos');
    assert.deepEqual(renderedRepos(modal, 'repos'), visibleRepositoryNames.filter(name => name !== 'resources'));
    const html = await fs.readFile(new URL('../../IDE-plugins/marketplace/components/marketplace-modal/marketplace-modal.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /Skills Repos|data-repo-kind-tab="skills"/);
    assert.match(elements(modal.repositoriesEl).map(row => row.textContent).join(' '), /1 enabled agent will be removed/);
    assert.doesNotMatch(elements(modal.repositoriesEl).map(row => row.textContent).join(' '), /99 enabled/);
});

test('Marketplace search cannot restore hidden groups or entries, while allowed matches remain searchable', async (t) => {
    const modal = await createModal(t);
    for (const query of [...hiddenRepositoryNames, 'alias-', 'custom-skills', 'mixed-source', 'hidden-skill', 'worker']) {
        modal.state.agentSearchQuery = query;
        modal.renderAgents();
        assert.ok(renderedRefs(modal).every(ref => visibleAgentRefs.includes(ref)), query);
        assert.ok(renderedRepos(modal, 'agents').every(name => [...visibleRepositoryNames, 'AllowedOrphan'].includes(name)), query);
    }
    t.mock.timers.enable({apis: ['setTimeout']});
    modal.handleAgentSearchInput({target: {value: 'allowedORPHAN'}});
    t.mock.timers.tick(500);
    assert.deepEqual(renderedRefs(modal), ['AllowedOrphan/worker']);
    modal.state.agentSearchQuery = 'hidden-skill';
    modal.renderAgents();
    assert.match(modal.agentsEl.textContent, /No agents or repositories match/);
});

test('Marketplace initial load and polling apply the same policy when repository metadata changes', async (t) => {
    const modal = await createModal(t);
    const catalog = marketplaceCatalog();
    catalog.permissions.canManage = false;
    modal.state.marketplace = null;
    modal.requestMarketplace = async () => structuredClone(catalog);
    await modal.loadMarketplace();
    assert.deepEqual(renderedRefs(modal), visibleAgentRefs);
    catalog.repositories.find(repo => repo.name === 'proxies').kind = 'mixed';
    await modal.refreshAgentStatuses();
    assert.ok(!renderedRefs(modal).includes('proxies/worker'));
    assert.ok(!renderedRepos(modal, 'repos').includes('proxies'), 'polling also refreshes the Repos tab');
    assert.ok(renderedRefs(modal).includes('AchillesCLI/worker'));
});

test('Marketplace catalog updates retain visible rows and never add hidden startups', async (t) => {
    const modal = await createModal(t);
    modal.renderState();
    const visibleRows = [...modal.agentsEl.children];
    const updatedRefs = [];
    modal.updateAgentRuntimeUi = agent => updatedRefs.push(agent.ref);
    const refreshed = structuredClone(modal.state.marketplace);
    for (const agent of refreshed.agents) Object.assign(agent, {active: true, status: 'starting', running: false});
    modal.applyMarketplaceSnapshot(refreshed);
    assert.ok(updatedRefs.includes('AchillesIDE/worker'));
    assert.ok(updatedRefs.every(ref => visibleAgentRefs.includes(ref)));
    assert.deepEqual(modal.agentsEl.children, visibleRows, 'catalog transitions preserve row controls');
    assert.ok(modal.agentStatusRefreshTimer);
    assert.deepEqual(renderedRefs(modal), visibleAgentRefs);
});

test('Marketplace snapshots preserve actual rows, runtime-mode choices, expansion and pending labels while refreshing counts', async (t) => {
    const modal = await createModal(t);
    modal.renderState();
    const agentRow = modal.agentsEl.querySelectorAll('[data-marketplace-agent-ref]')
        .find(row => row.dataset.marketplaceAgentRef === 'AchillesIDE/worker');
    const repoRow = modal.repositoriesEl.querySelectorAll('[data-marketplace-repo-name]')
        .find(row => row.dataset.marketplaceRepoName === 'AchillesIDE');
    const mode = agentRow.querySelector('[data-enable-mode-for]');
    const toggle = agentRow.querySelector('[data-agent-ref]');
    const status = agentRow.querySelector('.marketplace-agent-status');
    const note = repoRow.querySelector('.marketplace-meta');
    mode.value = 'global';
    const inactiveRow = modal.agentsEl.querySelectorAll('[data-marketplace-agent-ref]')
        .find(row => row.dataset.marketplaceAgentRef === 'AllowedOrphan/worker');
    const inactiveMode = inactiveRow.querySelector('[data-enable-mode-for]');
    inactiveMode.value = 'devel';
    const expanded = modal.state.expandedAgentRepos;
    modal.state.agentMutationBusyRef = 'AchillesIDE/worker';
    modal.state.agentMutationVerb = 'Disabling';
    const refreshed = structuredClone(modal.state.marketplace);
    const agent = refreshed.agents.find(item => item.ref === 'AchillesIDE/worker');
    Object.assign(agent, {active: false, status: 'inactive', running: false, statusDetail: 'Disabled by administrator.',
        pid: null, containerName: '', runtime: ''});
    refreshed.enabledAgents = refreshed.enabledAgents.filter(item => item.repoName !== 'AchillesIDE');
    modal.applyMarketplaceSnapshot(refreshed);
    assert.equal(modal.agentsEl.querySelectorAll('[data-marketplace-agent-ref]').find(row => row.dataset.marketplaceAgentRef === agent.ref), agentRow);
    assert.equal(modal.repositoriesEl.querySelectorAll('[data-marketplace-repo-name]').find(row => row.dataset.marketplaceRepoName === 'AchillesIDE'), repoRow);
    assert.equal(agentRow.querySelector('[data-enable-mode-for]'), mode);
    assert.equal(mode.value, 'global');
    assert.equal(modal.state.expandedAgentRepos, expanded);
    assert.equal(status.textContent, 'Disabled');
    assert.equal(status.title, 'Disabled by administrator.');
    assert.equal(toggle.textContent, 'Disabling...');
    assert.equal(toggle.disabled, true);
    assert.equal(note.hidden, true);
    assert.equal(note.textContent, '');
    assert.equal(modal.state.marketplace.enabledAgents, refreshed.enabledAgents);

    const enabled = structuredClone(refreshed);
    Object.assign(enabled.agents.find(item => item.ref === agent.ref), {active: true, status: 'starting', running: false,
        statusDetail: 'New startup.', pid: 4712, containerName: 'workspace-AchillesIDE-worker-generation', runtime: 'container', enableMode: 'isolated'});
    enabled.enabledAgents.push({repoName: 'AchillesIDE', agentName: 'worker'});
    modal.applyMarketplaceSnapshot(enabled);
    assert.equal(note.hidden, false);
    assert.equal(note.textContent, '1 enabled agent will be removed if this repo is uninstalled.');
    assert.equal(status.title, 'New startup.');
    assert.equal(status.textContent, 'Starting up');
    assert.equal(mode.value, 'isolated', 'an enabled agent shows its authoritative runtime mode');
    assert.equal(inactiveRow.querySelector('[data-enable-mode-for]'), inactiveMode);
    assert.equal(inactiveMode.value, 'devel', 'another inactive agent retains its selected mode through runtime replacement');
    assert.equal(modal.state.expandedAgentRepos, expanded);
});

for (const status of [401, 403]) {
    test(`Marketplace removes cached management controls after refresh authorization failure ${status}`, async (t) => {
        const modal = await createModal(t);
        modal.renderState();
        assert.ok(modal.agentsEl.querySelectorAll('[data-agent-ref]').length > 0);
        assert.ok(modal.agentsEl.querySelectorAll('[data-agent-settings-key]').length > 0);
        assert.ok(modal.repositoriesEl.querySelectorAll('[data-repo-name]').length > 0);
        if (status === 403) {
            modal.state.status = 'The previous agent mutation failed.';
            modal.state.statusType = 'error';
        }
        modal.requestMarketplace = async () => {
            throw Object.assign(new Error('Authentication is required.'), {status});
        };
        await modal.refreshAgentStatuses();
        assert.equal(modal.agentStatusRefreshStopped, true);
        assert.equal(modal.canManageMarketplace(), false);
        assert.deepEqual(modal.agentsEl.querySelectorAll('[data-agent-ref]'), []);
        assert.deepEqual(modal.agentsEl.querySelectorAll('[data-agent-settings-key]'), []);
        assert.deepEqual(modal.repositoriesEl.querySelectorAll('[data-repo-name]'), []);
        assert.ok(modal.agentsEl.querySelectorAll('[data-enable-mode-for]').every(select => select.disabled));
        assert.equal(modal.state.statusType, 'error');
        assert.equal(modal.state.status, status === 401
            ? 'Authentication is required.' : 'The previous agent mutation failed.');
        assert.deepEqual(renderedRefs(modal), visibleAgentRefs, 'read-only cached inventory remains visible');
    });
}

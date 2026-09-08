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
    querySelectorAll() { return []; }
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

test('Marketplace streams update visible agents without adding hidden rows or polling hidden startups', async (t) => {
    const modal = await createModal(t);
    modal.renderState();
    assert.equal(modal.hasTransitionalAgents(), false, 'hidden skill startups do not trigger refreshes');
    const visibleRows = [...modal.agentsEl.children];
    const updatedRefs = [];
    modal.updateAgentRuntimeUi = agent => updatedRefs.push(agent.ref);
    modal.handleRuntimeStatusUpdated({detail: {runtimes: [{
        repoName: 'AchillesIDE', agentName: 'worker', enabled: true, state: {status: 'starting', running: false},
    }, {repoName: 'basic', agentName: 'worker', enabled: true, state: {status: 'starting', running: false}}]}});
    assert.ok(updatedRefs.includes('AchillesIDE/worker'));
    assert.ok(updatedRefs.every(ref => visibleAgentRefs.includes(ref)));
    assert.deepEqual(modal.agentsEl.children, visibleRows, 'streamed transitions preserve row controls');
    assert.equal(modal.hasTransitionalAgents(), true);
    assert.ok(modal.agentStatusRefreshTimer);
    assert.deepEqual(renderedRefs(modal), visibleAgentRefs);
});

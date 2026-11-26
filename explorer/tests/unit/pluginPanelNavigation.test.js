import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPluginPanelUrl, readPluginPanelRequest, resolveExpandedPanelUrl, clearPluginPanelLocation } from '../../shared/ui/plugin-panel-navigation.js';
import { openPluginPanelFromLocation } from '../../services/runtime/pluginPanelRoute.js';
import { getPluginToolbarModalDescriptor, openPluginPanel } from '../../web-components/pages/file-exp/file-exp-application-plugins.js';

const location = { href: 'https://workspace.example/explorer/index.html?settings=theme&secret=omit#file-exp/demo' };

test('component links carry only plugin identity and a validated navigation path and survive refresh', () => {
    const url = buildPluginPanelUrl(location, 'gitAgent/git', { path: '/workspace/project', token: 'omit', props: { draft: 'omit' } });
    assert.equal(new URL(url).origin, 'https://workspace.example');
    assert.deepEqual([...new URL(url).searchParams.keys()], ['panel', 'panelPath']);
    assert.deepEqual(readPluginPanelRequest({ href: url }), { pluginKey: 'gitAgent/git', path: '/workspace/project' });
    assert.equal(new URL(url).hash, '#file-exp/');
    assert.equal(new URL(url).pathname, '/explorer/index.html');
});

test('malformed, duplicate and traversal navigation is refused', () => {
    for (const query of ['panel=other', 'panel=agent/id&panel=other/id', 'panel=agent/id&panelPath=/a/../b',
        'panel=agent/id&panelPath=https://outside.test', 'panel=agent/id&panelPath=/a&panelPath=/b', 'panel=agent/id&panelPath=//host/a']) {
        assert.throws(() => readPluginPanelRequest({ href: `https://workspace.example/?${query}` }));
    }
    assert.equal(readPluginPanelRequest(location), null);
    assert.throws(() => buildPluginPanelUrl(location, ''));
});

test('iframe opens its current page, or its declared page while loading or unreadable', () => {
    const options = { location, mode: 'iframe', frameUrl: '/agent/index.html', pluginKey: 'agent/id' };
    assert.equal(resolveExpandedPanelUrl({ ...options, frame: { contentWindow: { location: { href: 'https://workspace.example/agent/detail?id=2' } } } }), 'https://workspace.example/agent/detail?id=2');
    assert.equal(resolveExpandedPanelUrl({ ...options, frame: { contentWindow: { location: { href: 'about:blank' } } } }), 'https://workspace.example/agent/index.html');
    const frame = { get contentWindow() { throw new Error('Cross origin'); } };
    assert.equal(resolveExpandedPanelUrl({ ...options, frame }), 'https://workspace.example/agent/index.html');
    assert.equal(resolveExpandedPanelUrl(options), 'https://workspace.example/agent/index.html');
});

test('dedicated component URLs retain priority, and URL-less components use their plugin identity', () => {
    assert.equal(resolveExpandedPanelUrl({ location, mode: 'component', presenter: { getOpenInNewTabUrl: () => 'https://workspace.example/?settings=editor' } }), 'https://workspace.example/?settings=editor');
    for (const pluginKey of ['roboTeamAgent/observability', 'gitAgent/git', 'explorer/help', 'explorer/marketplace']) {
        const url = resolveExpandedPanelUrl({ location, mode: 'component', pluginKey });
        assert.equal(readPluginPanelRequest({ href: url }).pluginKey, pluginKey);
    }
});

test('boot opens only an active permitted plugin descriptor, never component names or generic URL props', async t => {
    const previous = globalThis.window;
    t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
    const plugin = { agent: 'gitAgent', id: 'git', component: 'git-tool-button', label: 'Git', toolbarModal: { mode: 'component', component: 'git-panel' } };
    globalThis.window = { assistOS: { user: { roles: ['user'] }, pluginSettings: {}, workspace: { appPlugins: { 'file-exp:toolbar': [plugin] } } } };
    const opened = [];
    const args = { location: { href: 'https://workspace.example/?panel=gitAgent/git&panelPath=/workspace/project&props=secret' }, openModal: descriptor => { opened.push(descriptor); return { opened: Promise.resolve() }; } };
    await openPluginPanelFromLocation(args);
    await openPluginPanelFromLocation(args); // A refresh resolves again through the current registry.
    assert.equal(opened.length, 2);
    assert.deepEqual(opened[0], { mode: 'component', component: 'git-panel', pluginKey: 'gitAgent/git', title: 'Git', panelNavigation: { path: '/workspace/project' }, props: { panelNavigation: { path: '/workspace/project' } } });
    assert.equal(getPluginToolbarModalDescriptor(plugin).pluginKey, 'gitAgent/git');
    window.assistOS.pluginSettings['gitAgent/git'] = { enabled: false };
    await assert.rejects(openPluginPanelFromLocation(args), /unavailable, disabled, or not permitted/);
    window.assistOS.pluginSettings = {};
    plugin.adminOnly = true;
    await assert.rejects(openPluginPanelFromLocation(args), /not permitted/);
    plugin.adminOnly = false;
    window.assistOS.workspace.appPlugins = {};
    await assert.rejects(openPluginPanelFromLocation(args), /unavailable/);
    assert.equal(opened.length, 2);
});


test('a component still loading retains only its explicit navigation descriptor', () => {
    const url = resolveExpandedPanelUrl({ location, mode: 'component', pluginKey: 'gitAgent/git', navigation: { path: '/workspace/project', draft: 'never' } });
    assert.deepEqual(readPluginPanelRequest({ href: url }), { pluginKey: 'gitAgent/git', path: '/workspace/project' });
    assert.equal(new URL(url).searchParams.has('draft'), false);
});


test('closing an addressed plugin removes only its panel query without navigation or a new history entry', () => {
    const location = { href: 'https://workspace.example/explorer/index.html?other=1&panel=gitAgent/git&panelPath=/workspace/project#file-exp/projects' };
    const calls = [];
    const state = { existing: true };
    const history = { state, replaceState: (...args) => calls.push(args) };
    clearPluginPanelLocation(location, history, 'explorer/help');
    assert.equal(calls.length, 0);
    clearPluginPanelLocation(location, history, 'gitAgent/git');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], state);
    assert.equal(calls[0][2], 'https://workspace.example/explorer/index.html?other=1#file-exp/projects');
    assert.equal(readPluginPanelRequest({ href: calls[0][2] }), null);
});


test('panel startup waits for the shell to open before completing', async t => {
    const previous = globalThis.window;
    t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
    globalThis.window = { assistOS: { pluginSettings: {}, workspace: { appPlugins: { 'file-exp:toolbar': [{
        agent: 'explorer', id: 'help', label: 'Help', toolbarModal: { mode: 'component', component: 'help-modal' },
    }] } } } };
    let opened;
    let completed = false;
    const opening = new Promise(resolve => { opened = resolve; });
    const startup = openPluginPanelFromLocation({
        location: { href: 'https://workspace.example/explorer/?panel=explorer/help' },
        openModal: () => ({ opened: opening }),
    }).then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    opened({});
    await startup;
    assert.equal(completed, true);
});


test('programmatic opening uses the same active descriptor and accepts context without overriding the panel', t => {
    const previous = globalThis.window;
    t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
    globalThis.window = { assistOS: { user: { roles: ['user'] }, pluginSettings: {}, workspace: { appPlugins: { 'file-exp:toolbar': [{
        agent: 'gitAgent', id: 'git', label: 'Git', toolbarModal: { mode: 'component', component: 'git-panel', fullscreen: true },
    }] } } } };
    const closed = Promise.resolve();
    closed.opened = Promise.resolve({});
    let descriptor;
    const returned = openPluginPanel('gitAgent/git', {
        panelNavigation: { path: '/workspace/project' }, props: { openConflictHelper: true },
        component: 'unregistered-panel', url: 'https://outside.example/',
    }, value => { descriptor = value; return closed; });
    assert.equal(returned, closed);
    assert.equal(returned.opened, closed.opened);
    assert.deepEqual(descriptor, {
        mode: 'component', component: 'git-panel', fullscreen: true, pluginKey: 'gitAgent/git', title: 'Git',
        panelNavigation: { path: '/workspace/project' },
        props: { openConflictHelper: true, panelNavigation: { path: '/workspace/project' } },
    });
    window.assistOS.pluginSettings['gitAgent/git'] = { enabled: false };
    assert.throws(() => openPluginPanel('gitAgent/git', {}, () => { throw new Error('Must not open'); }), /disabled/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    normalizeRuntimePluginPolicy, PAGE_COMPONENTS, PANEL_COMPONENT, startLiveSessionsPage,
} from '../../IDE-plugins/live-sessions/live-sessions-page.js';
import { aggregateIdePlugins } from '../../utils/ide-plugins.mjs';
import { createRuntimePluginLoader } from '../../services/runtime/runtimePluginLoader.js';
import { filterRuntimePluginsByPolicy, mergeRuntimePluginsIntoAssistOS } from '../../utils/pluginUtils.core.js';

const root = path.resolve(import.meta.dirname, '../..');
const pluginRoot = path.join(root, 'IDE-plugins/live-sessions');

const SOURCE = { pluginCategory: 'application', contributionType: 'live-sessions-source', location: 'live-sessions:source', agent: 'sample', id: 'sample-runs', label: 'Sample', liveSessions: { version: 1, base: '/base-agent-additional-server/sample/7000/live' } };
const catalog = () => ({
    normalized: {
        application: {
            'live-sessions:source': [SOURCE],
            'file-exp:toolbar': [{ id: 'live-sessions', component: 'live-sessions-tool-button', agent: 'explorer' }, { id: 'help', component: 'help-tool-button', agent: 'explorer' }],
        },
        document: {},
    },
});

function harness({ registered = { name: PANEL_COMPONENT }, user = { roles: ['admin'] }, manifest = { applicationPlugins: { help: false, 'live-sessions': true } }, failOn = null } = {}) {
    const log = [];
    const status = { textContent: 'Loading Live Sessions…', hidden: false };
    const root = {};
    const win = {};
    const assistOS = { workspace: { plugins: {}, appPlugins: {} } };
    const webSkel = { name: 'webSkel' };
    const presenter = { initialLoad: Promise.resolve() };
    const node = { presenterReadyPromise: Promise.resolve(), renderCompletePromise: Promise.resolve(), webSkelPresenter: presenter };
    webSkel.createElement = (...args) => { log.push(['createElement', ...args]); return { element: { deref: () => node } }; };
    const dependencies = {
        initializeTheme: () => log.push(['theme']),
        installAuthNavigationGuard: () => log.push(['auth-guard']),
        WebSkel: { initialise: async (config) => { log.push(['webskel', config]); if (failOn === 'webskel') throw new Error('boom'); return webSkel; } },
        installExplorerResourceLoader: (instance) => log.push(['resource-loader', instance === webSkel]),
        installDetachedRenderGuard: (instance) => log.push(['render-guard', instance === webSkel]),
        assistosSDK: { name: 'sdk' },
        createComponentRegistry: (instance) => { log.push(['registry', instance === webSkel]); return { name: 'registry' }; },
        createRuntimePluginLoader: (options) => {
            log.push(['loader', options.agentId, options.runtimePluginTool, options.assistosSDK.name, options.componentRegistry.name]);
            return {
                fetchRuntimePlugins: async () => { log.push(['catalog']); return catalog(); },
                mergeIntoAssistOS: (target, plugins) => { log.push(['merge', Object.keys(plugins.application['file-exp:toolbar'])]); mergeRuntimePluginsIntoAssistOS(target, plugins); },
                ensureComponentRegistered: async (name, plugins) => { log.push(['register', name, plugins === dependencies.lastPlugins]); return registered; },
            };
        },
        initialiseAssistOS: (options) => { log.push(['assistOS', options.ui === webSkel]); return assistOS; },
        fetchAuthenticatedUser: async () => { log.push(['user']); return user; },
        filterRuntimePluginsByPolicy: (plugins, policy) => { log.push(['policy', policy]); const filtered = filterRuntimePluginsByPolicy(plugins, policy); dependencies.lastPlugins = filtered; return filtered; },
        fetchImpl: async (url) => { log.push(['fetch', url]); return { ok: true, json: async () => manifest }; },
    };
    return { log, status, root, win, assistOS, webSkel, dependencies };
}

test('the page bootstraps WebSkel, the signed-in user and the source catalog, then mounts the panel into its root', async () => {
    const page = harness();
    const result = await startLiveSessionsPage({ root: page.root, status: page.status, win: page.win, dependencies: page.dependencies });
    assert.ok(result);
    assert.equal(page.win.ASSISTOS_AGENT_ID, 'explorer');
    const steps = page.log.map((entry) => entry[0]);
    assert.deepEqual(steps.slice(0, 7), ['theme', 'auth-guard', 'webskel', 'resource-loader', 'render-guard', 'registry', 'loader']);
    assert.deepEqual(page.log.find((entry) => entry[0] === 'webskel'), ['webskel', '/explorer/webskel.json']);
    assert.deepEqual(page.log.find((entry) => entry[0] === 'loader'), ['loader', 'explorer', 'collect_ide_plugins', 'sdk', 'registry']);
    assert.deepEqual(page.log.find((entry) => entry[0] === 'fetch'), ['fetch', '/explorer/manifest.json']);
    assert.equal(page.webSkel.appServices.name, 'sdk');

    // What the shell gave the panel: the user for isAdminUser, the sources for discoverLiveSessionSources, webSkel for createElement.
    assert.deepEqual(page.assistOS.user, { roles: ['admin'] });
    assert.equal(page.assistOS.webSkel, page.webSkel);
    assert.deepEqual(page.assistOS.workspace.appPlugins['live-sessions:source'], [SOURCE]);
    assert.deepEqual(page.log.find((entry) => entry[0] === 'policy'), ['policy', { help: false, 'live-sessions': true }]);

    assert.deepEqual(page.log.filter((entry) => entry[0] === 'register'), [
        ['register', 'live-sessions-modal', true], ['register', 'live-session-stream-view', true],
    ]);
    const created = page.log.find((entry) => entry[0] === 'createElement');
    assert.equal(created[1], 'live-sessions-modal');
    assert.equal(created[2], page.root);
    assert.deepEqual(created.slice(3), [{}, { 'data-presenter': 'live-sessions-modal' }, true]);
    assert.ok(steps.lastIndexOf('register') < steps.indexOf('createElement'), 'the components are registered before the panel is created');
    assert.equal(page.status.hidden, true);
    assert.equal(page.status.textContent, '');
});

test('the page keeps an unauthenticated user absent and still starts', async () => {
    const page = harness({ user: null });
    assert.ok(await startLiveSessionsPage({ root: page.root, status: page.status, win: page.win, dependencies: page.dependencies }));
    assert.equal(Object.hasOwn(page.assistOS, 'user'), false, 'isAdminUser then refuses shell rows');
});

test('a failed start shows a plain message and logs the cause instead of mounting', async (t) => {
    t.mock.method(console, 'error', () => {});
    for (const options of [{ registered: null }, { failOn: 'webskel' }]) {
        const page = harness(options);
        assert.equal(await startLiveSessionsPage({ root: page.root, status: page.status, win: page.win, dependencies: page.dependencies }), null);
        assert.equal(page.log.some((entry) => entry[0] === 'createElement'), false);
        assert.equal(page.status.textContent, 'Live Sessions could not be loaded. Reload to try again.');
        assert.equal(page.status.hidden, false);
    }
    const missing = harness();
    assert.equal(await startLiveSessionsPage({ root: null, status: missing.status, win: missing.win, dependencies: missing.dependencies }), null);
    assert.equal(missing.log.length, 0, 'nothing starts without a mount point');
});

test('the manifest policy keeps only boolean entries, as in the Explorer shell', () => {
    assert.deepEqual(normalizeRuntimePluginPolicy({ applicationPlugins: { git: true, ' help ': false, odd: 'yes', '': true, n: 1 } }), { git: true, help: false });
    for (const manifest of [null, {}, { applicationPlugins: [] }, { applicationPlugins: 'x' }]) assert.deepEqual(normalizeRuntimePluginPolicy(manifest), {});
});

test('the page document is served beside the plugin, shares the descriptor title and offers a full page', async () => {
    const config = JSON.parse(await fs.readFile(path.join(pluginRoot, 'config.json'), 'utf8'));
    const html = await fs.readFile(path.join(pluginRoot, 'live-sessions-page.html'), 'utf8');
    // The Explorer agent serves its own folder under /explorer, so the descriptor URL names a file of this plugin.
    assert.equal(config.toolbarModal.mode, 'iframe');
    assert.equal(config.toolbarModal.url, '/explorer/IDE-plugins/live-sessions/live-sessions-page.html');
    await fs.access(path.join(root, config.toolbarModal.url.replace(/^\/explorer\//, '')));
    // The expanded modal treats the frame as ready when its title equals readyTitle.
    assert.match(html, new RegExp(`<title>${config.toolbarModal.readyTitle}</title>`));
    assert.match(html, /<script type="module">[\s\S]*import \{ startLiveSessionsPage \} from '\.\/live-sessions-page\.js';[\s\S]*startLiveSessionsPage\(\);[\s\S]*<\/script>/);
    assert.match(html, /<main id="liveSessionsPage"/);
    assert.match(html, /id="liveSessionsPageStatus"[^>]*role="status"/);
    // "Open in new tab" is a top-level page: it has its own heading and a way back; the modal hides them.
    assert.match(html, /<a class="gray-button" href="\/explorer\/index\.html">Back to Explorer<\/a>/);
    assert.match(html, /classList\.toggle\('embedded', window\.parent !== window\)/);
    const css = await fs.readFile(path.join(pluginRoot, 'live-sessions-page.css'), 'utf8');
    assert.match(css, /body\.embedded \.live-sessions-page-header \{\s*display: none;/);
    // Every stylesheet and module the page names exists.
    for (const href of [...html.matchAll(/href="(\.[^"]+\.css)"/g)].map((match) => match[1])) {
        await fs.access(path.join(pluginRoot, href));
    }
});

test('the page imports only files of this repository that exist', async () => {
    const source = await fs.readFile(path.join(pluginRoot, 'live-sessions-page.js'), 'utf8');
    const specifiers = [...source.matchAll(/(?:from |import\()'(\.[^']+)'/g)].map((match) => match[1]);
    assert.ok(specifiers.length >= 9, String(specifiers.length));
    for (const specifier of specifiers) await fs.access(path.resolve(pluginRoot, specifier));
});

test('the real runtime loader registers the panel and the stream view from the real config.json, so Attach on an agent run can create it', async () => {
    const raw = await aggregateIdePlugins(path.resolve(root, '..'));
    const loaded = [];
    const registry = {
        loadComponent: async (meta) => { loaded.push(meta.componentName); return { name: meta.componentName }; },
        getCachedComponent: (meta) => (loaded.includes(meta.componentName) ? { name: meta.componentName } : undefined),
    };
    const page = harness();
    const dependencies = {
        ...page.dependencies,
        assistosSDK: { name: 'sdk', fetchRuntimePlugins: async () => raw },
        createComponentRegistry: () => registry,
        createRuntimePluginLoader,
        filterRuntimePluginsByPolicy,
    };
    assert.ok(await startLiveSessionsPage({ root: page.root, status: page.status, win: page.win, dependencies }));
    assert.deepEqual(PAGE_COMPONENTS, ['live-sessions-modal', 'live-session-stream-view']);
    for (const name of PAGE_COMPONENTS) assert.ok(loaded.includes(name), `${name} is registered`);
    // The modal creates the stream view by name when an agent run is watched; nothing but the page registers it here.
    assert.equal(loaded.includes('live-sessions-tool-button'), false, 'the toolbar button belongs to the shell');
});

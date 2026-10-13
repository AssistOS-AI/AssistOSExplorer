import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { SettingsModal } from '../../web-components/modals/settings-modal/settings-modal.js';
import { buildSettingsUrl, readSettingsTab, updateSettingsLocation } from '../../shared/ui/settings-navigation.js';
import { attachSearchController } from '../../web-components/pages/file-exp/file-exp-search.js';

test('Settings has no independent header, dialog styles or modal launcher', async () => {
    const root = new URL('../../', import.meta.url);
    const read = path => fs.readFile(new URL(path, root), 'utf8');
    const html = await read('web-components/modals/settings-modal/settings-modal.html');
    const css = await read('web-components/modals/settings-modal/settings-modal.css');
    const plugins = await read('plugins.css');
    const search = await read('web-components/pages/file-exp/file-exp-search.js');
    assert.doesNotMatch(html, /modal-header|modal-title|close-icon/);
    assert.doesNotMatch(css + plugins, /settings-modal-dialog/);
    assert.doesNotMatch(search, /createReactiveModal\('settings-modal'/);
    assert.match(search, /openExpandedModal\(\{[\s\S]*mode: 'component',[\s\S]*component: 'settings-modal',[\s\S]*fullscreen: true/);
});

test('Settings URLs retain origin, workspace route and other query parameters', () => {
    const location = { href: 'https://workspace.example/explorer/?other=1#file-exp/projects/demo' };
    const url = buildSettingsUrl(location, 'editor');
    assert.equal(url, 'https://workspace.example/explorer/?other=1&settings=editor#file-exp/projects/demo');
    assert.equal(readSettingsTab({ href: url }), 'editor');
    assert.equal(readSettingsTab(location), null);
    assert.equal(readSettingsTab({ href: 'https://workspace.example/?settings=unknown' }), 'agents');
    assert.equal(new URL(buildSettingsUrl({ href: 'https://workspace.example/#another-page' }, 'theme')).hash, '#file-exp/');
});

test('tab changes and close update only a Settings-addressed tab', () => {
    const calls = [];
    const history = { state: { retained: true }, replaceState: (...args) => calls.push(args) };
    updateSettingsLocation({ href: 'https://workspace.example/#file-exp/demo' }, history, 'theme');
    assert.equal(calls.length, 0);
    const location = { href: 'https://workspace.example/?other=1&settings=agents#file-exp/demo' };
    updateSettingsLocation(location, history, 'theme');
    assert.equal(calls[0][2], 'https://workspace.example/?other=1&settings=theme#file-exp/demo');
    assert.equal(calls[0][0], history.state);
    updateSettingsLocation(location, history, null);
    assert.equal(calls[1][2], 'https://workspace.example/?other=1#file-exp/demo');
});

function settings() {
    return new SettingsModal({ closest: () => null }, () => {}, {
        tab: 'editor', keymap: { findFile: 'Mod+P' }, theme: 'dark',
        editorAutoSaveEnabled: false, editorAutoSaveIntervalSeconds: 10
    });
}

test('close and reload protect unsaved preferences and hardware drafts', t => {
    const previous = globalThis.window;
    t.after(() => { globalThis.window = previous; });
    const prompts = [];
    globalThis.window = { confirm: message => { prompts.push(message); return false; } };
    const p = settings();
    assert.equal(p.confirmDiscardChanges('close'), true);
    p.state.editorAutoSaveEnabled = true;
    assert.equal(p.confirmDiscardChanges('close'), false);
    assert.equal(p.confirmDiscardChanges('reload'), false);
    p.state.editorAutoSaveEnabled = false;
    p.hardwareSection = { querySelector: () => ({ webSkelPresenter: { drafts: new Map([['x', { dirty: true }]]) } }) };
    assert.equal(p.confirmDiscardChanges('reload'), false);
    assert.equal(prompts.length, 3);
});

test('late Settings access replies cannot change the route after unload', () => {
    const p = settings();
    p.hardwareClosed = true;
    p.element.dataset = {};
    p.updateTabUI();
    assert.deepEqual(p.element.dataset, {});
});

test('Save forwards settings through the shell and persists editor preferences', t => {
    const previousWindow = globalThis.window;
    t.after(() => { globalThis.window = previousWindow; });
    const storage = new Map();
    globalThis.window = {
        dispatchEvent() {},
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }
    };
    const p = settings();
    let result;
    let cancelled = 0;
    const shell = { completeComponent: payload => { result = payload; }, closeModal: () => { cancelled++; } };
    p.element.closest = () => ({ webSkelPresenter: shell });
    p.state.editorAutoSaveEnabled = true;
    p.state.editorAutoSaveIntervalSeconds = 25;
    p.saveSettings();
    assert.equal(result.editorAutoSaveEnabled, true);
    assert.equal(result.editorAutoSaveIntervalSeconds, 25);
    assert.equal(result.keymap.findFile, 'Mod+P');
    assert.equal(storage.get('assistosExplorerEditorAutoSaveEnabled'), 'true');
    assert.equal(storage.get('assistosExplorerEditorAutoSaveIntervalSeconds'), '25');
    assert.equal(p.confirmDiscardChanges('close'), true);
    p.closeModal({ nodeType: 1 });
    assert.equal(cancelled, 1);
    assert.deepEqual(p.getReloadProps(), { tab: 'editor' });
    const reloaded = new SettingsModal(p.element, () => {}, p.getReloadProps());
    assert.equal(reloaded.state.editorAutoSaveEnabled, true);
    assert.equal(reloaded.state.editorAutoSaveIntervalSeconds, 25);
});

const source = (await fs.readFile(new URL('../../web-components/modals/expanded-modal/expanded-modal.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\n/gm, '').replace('export class ExpandedModal', 'class ExpandedModal');

function shell(content, { window = {}, closeModal = () => {} } = {}) {
    const context = vm.createContext({ window, console, AbortController, clearTimeout, assistOS: { UI: { closeModal } } });
    vm.runInContext(`${source}\nthis.Modal = ExpandedModal;`, context);
    const attrs = new Map();
    const p = new context.Modal({ setAttribute: (key, value) => attrs.set(key, value) }, () => {});
    p.mode = 'component';
    p.contentProxy = { element: { deref: () => ({ webSkelPresenter: content }) } };
    return { p, attrs };
}

test('component Open in new tab uses the mounted Settings URL', () => {
    const calls = [];
    const { p } = shell({ getOpenInNewTabUrl: () => 'https://workspace.example/?settings=theme#file-exp/' }, {
        window: { open: (...args) => calls.push(args) }
    });
    p.openInNewTab();
    assert.deepEqual(calls, [['https://workspace.example/?settings=theme#file-exp/', '_blank', 'noopener,noreferrer']]);
});

test('component reload respects cancellation and remounts with saved-state props', async () => {
    let allow = false;
    let removed = 0;
    let mounted = 0;
    const content = { confirmDiscardChanges: () => allow, getReloadProps: () => ({ tab: 'theme' }) };
    const { p, attrs } = shell(content);
    p.componentHost = { remove: () => { removed++; } };
    p.mountComponentContent = async () => { mounted++; };
    await p.reloadContent();
    assert.equal(removed, 0);
    allow = true;
    await p.reloadContent();
    assert.equal(removed, 1);
    assert.equal(mounted, 1);
    assert.equal(attrs.get('data-props'), '{"tab":"theme"}');
    assert.equal(p.reloading, false);
});

test('shell close respects the component guard, while Save returns its result once', async () => {
    const closes = [];
    const { p } = shell({ confirmDiscardChanges: () => false }, { closeModal: (...args) => closes.push(args) });
    await p.closeModal();
    assert.equal(p.closed, false);
    assert.equal(closes.length, 0);
    const result = { keymap: { findFile: 'Mod+P' } };
    p.completeComponent(result);
    p.completeComponent(result);
    assert.equal(closes.length, 1);
    assert.equal(closes[0][1], result);
    assert.equal(p.loadController.signal.aborted, true);
});

test('the shared header handles Settings Escape without intercepting nested dialogs', () => {
    const { p } = shell({ confirmDiscardChanges: () => true });
    p.dialog = {};
    let closes = 0;
    let prevented = 0;
    p.closeModal = () => { closes++; };
    const event = {
        key: 'Escape', defaultPrevented: false,
        target: { closest: () => ({ nested: true }) },
        preventDefault: () => { prevented++; }, stopPropagation() {}
    };
    p.handleComponentEscape(event);
    assert.equal(closes, 0);
    event.target.closest = () => p.dialog;
    p.handleComponentEscape(event);
    assert.equal(closes, 1);
    assert.equal(prevented, 1);
    event.defaultPrevented = true;
    p.handleComponentEscape(event);
    assert.equal(closes, 1);
});

test('Explorer launches the shared shell, awaits Save and restores its settings URL only once', async t => {
    const previousWindow = globalThis.window;
    const previousAssistOS = globalThis.assistOS;
    t.after(() => { globalThis.window = previousWindow; globalThis.assistOS = previousAssistOS; });
    const location = { href: 'https://workspace.example/?settings=editor#file-exp/demo' };
    const history = { state: null, replaceState: (_state, _title, url) => { location.href = url; } };
    globalThis.window = { location, history, localStorage: { getItem: () => null } };
    let opened;
    const opening = new Promise(resolve => { opened = resolve; });
    let launches = 0;
    let descriptor;
    const dialog = new EventTarget();
    const addEventListener = dialog.addEventListener.bind(dialog);
    dialog.addEventListener = (...args) => {
        addEventListener(...args);
        if (args[0] === 'close') opened();
    };
    dialog.querySelector = () => null;
    dialog.close = () => dialog.dispatchEvent(new Event('close'));
    dialog.remove = () => {};
    globalThis.assistOS = { UI: { showModal: async (name, props) => {
        launches++;
        assert.equal(name, 'expanded-modal');
        descriptor = props;
        return dialog;
    } } };
    const updates = [];
    const fileExp = {
        element: { isConnected: true, querySelector: () => null },
        state: { keymap: { findFile: 'Mod+P' }, editorAutoSaveEnabled: false, editorAutoSaveIntervalSeconds: 10 },
        setDocumentListener() {}, setWindowListener() {}, setSearchMenuOpen() {},
        setEditorAutoSaveSettings: (...args) => updates.push(args)
    };
    attachSearchController(fileExp);
    fileExp.setupSearchBindings();
    fileExp.setupSearchBindings();
    await opening;
    // Reuse the same open panel to await its result, without opening a second dialog.
    const saving = fileExp.openSettingsModal(null, 'editor');
    assert.equal(launches, 1);
    assert.equal(descriptor.component, 'settings-modal');
    assert.equal(descriptor.fullscreen, true);
    assert.equal(JSON.parse(descriptor.props).tab, 'editor');
    assert.equal(updates.length, 0);
    const event = new Event('close');
    event.data = { keymap: { findFile: 'Alt+P' }, editorAutoSaveEnabled: true, editorAutoSaveIntervalSeconds: 30 };
    dialog.dispatchEvent(event);
    await saving;
    assert.equal(fileExp.state.keymap.findFile, 'Alt+P');
    assert.ok(updates.every(args => args[0] === true && args[1] === 30));
    assert.equal(location.href, 'https://workspace.example/#file-exp/demo');
});

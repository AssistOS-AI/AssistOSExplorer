import assert from 'node:assert/strict';
import test from 'node:test';
import { initScheduleFolderPicker } from '../public/schedule-folder-picker.js';

function node(tag = 'div') {
    const listeners = new Map();
    return { tag, children: [], value: '', textContent: '', disabled: false, hidden: false,
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        get lastElementChild() { return this.children.at(-1); },
        setAttribute() {}, focus() { this.focused = true; }, reset() {},
        addEventListener: (name, handler) => listeners.set(name, handler),
        fire: (name, event) => listeners.get(name)?.(event),
        cloneNode: () => node(tag) };
}
const rootListing = { path: '', folder: '/workspace', folders: [{ name: 'Reports', path: 'Reports' }], defaultFolder: '/workspace/workflow-runs' };
const reports = { ...rootListing, path: 'Reports', folder: '/workspace/Reports', folders: [] };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(api = async route => {
    if (route.endsWith('path=workflow-runs')) throw Object.assign(new Error('Folder not found'), { status: 404 });
    return route.endsWith('path=Reports') ? reports : rootListing;
}) {
    const ids = ['cronFolderDialog', 'cronChangeFolder', 'cronFolderLabel', 'cronFolderList', 'cronFolderBreadcrumbs', 'cronFolderMessage', 'cronNewFolderForm', 'cronNewFolderName', 'cronFolderUse', 'cronDefaultFolder', 'cronFolderUp', 'cronFolderClose', 'cronFolderCancel', 'cronFolderNew', 'cronNewFolderCancel', 'cronFolderIcon'];
    const elements = Object.fromEntries(ids.map(id => [id, node(id.includes('FolderName') ? 'input' : id.includes('Dialog') ? 'dialog' : 'button')]));
    const dialog = elements.cronFolderDialog;
    dialog.querySelectorAll = () => Object.values(elements).filter(element => element.tag === 'button');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.fire('close'); };
    elements.cronFolderIcon.content = { firstElementChild: node('svg') };
    const root = { querySelector: selector => elements[selector.slice(1)], createElement: node };
    const input = node('input'), windowRef = node();
    const picker = initScheduleFolderPicker({ root, api, input, windowRef });
    return { ...elements, input, picker, windowRef };
}
test('missing default folder opens workspace without creating it; selection and reset use readable labels', async () => {
    const calls = [], f = fixture(async route => {
        calls.push(route);
        if (route.endsWith('path=workflow-runs')) throw Object.assign(new Error('Folder not found'), { status: 404 });
        return route.endsWith('path=Reports') ? reports : rootListing;
    });
    f.picker.setFolder(); assert.equal(f.cronFolderLabel.textContent, 'workflow-runs');
    f.cronChangeFolder.onclick(); await settle();
    assert.equal(f.cronFolderUse.disabled, false); assert.equal(f.cronFolderList.children.length, 1);
    f.cronFolderList.children[0].children[0].onclick(); await settle();
    f.cronFolderUse.onclick();
    assert.equal(f.input.value, '/workspace/Reports'); assert.equal(f.cronFolderLabel.textContent, 'Reports');
    assert.equal(f.cronFolderDialog.open, false); assert.equal(f.cronChangeFolder.focused, true);
    f.cronDefaultFolder.onclick(); assert.equal(f.input.value, ''); assert.equal(f.cronDefaultFolder.hidden, true);
    assert.ok(calls.every(route => route.startsWith('api/roboflow/schedule-folders')));
});
test('cancel and stale browsing responses never change the saved selection', async () => {
    let resolve;
    const f = fixture(() => new Promise(done => { resolve = done; }));
    f.picker.setFolder('/workspace/Reports', 'Reports');
    f.cronChangeFolder.onclick(); f.cronFolderCancel.onclick();
    resolve(rootListing); await settle();
    assert.equal(f.cronFolderDialog.open, false); assert.equal(f.cronFolderList.children.length, 0);
    assert.equal(f.input.value, '/workspace/Reports');
    f.cronChangeFolder.onclick(); f.windowRef.fire('pagehide'); resolve(rootListing); await settle();
    assert.equal(f.cronFolderDialog.open, false); assert.equal(f.input.value, '/workspace/Reports');
});
test('creation is explicit, cannot submit twice or dismiss while pending, and selection needs confirmation', async () => {
    let resolve, posts = 0;
    const f = fixture(async (route, options) => {
        if (options?.method === 'POST') { posts++; assert.deepEqual(options.body, { parent: '', name: 'New reports' }); return new Promise(done => { resolve = done; }); }
        return rootListing;
    });
    f.cronChangeFolder.onclick(); await settle();
    f.cronFolderNew.onclick(); f.cronNewFolderName.value = 'New reports';
    const event = { preventDefault() {} }; f.cronNewFolderForm.onsubmit(event); f.cronNewFolderForm.onsubmit(event);
    let prevented = false; f.cronFolderDialog.fire('cancel', { preventDefault() { prevented = true; } }); f.cronFolderCancel.onclick();
    assert.equal(posts, 1); assert.equal(prevented, true); assert.equal(f.cronFolderDialog.open, true);
    resolve({ ...reports, path: 'New reports', folder: '/workspace/New reports' }); await settle();
    assert.equal(f.input.value, ''); assert.equal(f.cronFolderUse.disabled, false);
    f.cronFolderUse.onclick(); assert.equal(f.input.value, '/workspace/New reports');
});
test('folder errors remain visible and cancellation preserves the form selection', async () => {
    const f = fixture(async () => { throw new Error('Workspace unavailable'); });
    f.picker.setFolder('/workspace/Reports', 'Reports'); f.cronChangeFolder.onclick(); await settle();
    assert.equal(f.cronFolderMessage.textContent, 'Workspace unavailable'); assert.equal(f.cronFolderUse.disabled, true);
    assert.equal(f.cronFolderCancel.disabled, false); f.cronFolderCancel.onclick();
    assert.equal(f.input.value, '/workspace/Reports');
});

test('the cron and workflow file pages provide every element id the folder picker uses', async () => {
    const { readFile } = await import('node:fs/promises');
    const picker = await readFile(new URL('../public/schedule-folder-picker.js', import.meta.url), 'utf8');
    const suffixes = [...new Set([...picker.matchAll(/element\(`\$\{prefix\}([A-Za-z]+)`\)/g)].map(match => match[1]))];
    assert.ok(suffixes.length > 10);
    for (const [page, prefix, optional] of [['index.html', 'cron', []], ['editor.html', 'flow', ['DefaultFolder', 'ChangeFolder', 'FolderLabel']]]) {
        const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
        for (const suffix of suffixes.filter(name => !optional.includes(name))) assert.match(html, new RegExp(`id="${prefix}${suffix}"`), `${page}: ${prefix}${suffix}`);
    }
    const editor = await readFile(new URL('../public/editor.html', import.meta.url), 'utf8');
    assert.match(editor, /id="flowLocation" type="hidden"[\s\S]*id="workflowSaveAsButton"[^>]*hidden>Save as…<\/button>\s*<button type="submit" id="workflowCreateButton" class="button primary">Save<\/button>/);
    assert.match(editor, /id="flowFolderUse" class="button primary" type="button" disabled>Save<\/button>/);
    assert.match(editor, /id="workflowSource"/);
});

test('a relative picker without a trigger opens on request, refuses the workspace root and reports the chosen folder', async () => {
    const ids = ['flowFolderDialog', 'flowFolderList', 'flowFolderBreadcrumbs', 'flowFolderMessage', 'flowNewFolderForm', 'flowNewFolderName', 'flowFolderUse', 'flowFolderUp', 'flowFolderClose', 'flowFolderCancel', 'flowFolderNew', 'flowNewFolderCancel', 'flowFolderIcon'];
    const elements = Object.fromEntries(ids.map(id => [id, node(id.includes('FolderName') ? 'input' : id.includes('Dialog') ? 'dialog' : 'button')]));
    const dialog = elements.flowFolderDialog;
    dialog.querySelectorAll = () => Object.values(elements).filter(element => element.tag === 'button');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.fire('close'); };
    elements.flowFolderIcon.content = { firstElementChild: node('svg') };
    const selected = [], saveAs = node('button'), input = node('input');
    const picker = initScheduleFolderPicker({ root: { querySelector: selector => elements[selector.slice(1)], createElement: node },
        api: async route => route.endsWith('path=Reports') ? reports : rootListing, input, windowRef: node(),
        prefix: 'flow', relative: true, returnFocus: saveAs, onSelect: folder => selected.push(folder) });
    picker.open(); await settle();
    assert.equal(elements.flowFolderUse.disabled, true, 'the workspace root itself cannot be chosen');
    elements.flowFolderList.children[0].children[0].onclick(); await settle();
    assert.equal(elements.flowFolderUse.disabled, false);
    elements.flowFolderUse.onclick();
    assert.deepEqual(selected, ['Reports']);
    assert.equal(input.value, 'Reports');
    assert.equal(dialog.open, false); assert.equal(saveAs.focused, true);
    // Cancelling reports nothing.
    picker.open(); await settle(); elements.flowFolderCancel.onclick();
    assert.deepEqual(selected, ['Reports']);
});

test('an asynchronous selection keeps the dialog open and busy, closes on success and shows a failure', async () => {
    const ids = ['flowFolderDialog', 'flowFolderList', 'flowFolderBreadcrumbs', 'flowFolderMessage', 'flowNewFolderForm', 'flowNewFolderName', 'flowFolderUse', 'flowFolderUp', 'flowFolderClose', 'flowFolderCancel', 'flowFolderNew', 'flowNewFolderCancel', 'flowFolderIcon'];
    const elements = Object.fromEntries(ids.map(id => [id, node(id.includes('FolderName') ? 'input' : id.includes('Dialog') ? 'dialog' : 'button')]));
    const dialog = elements.flowFolderDialog;
    dialog.querySelectorAll = () => Object.values(elements).filter(element => element.tag === 'button');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.fire('close'); };
    elements.flowFolderIcon.content = { firstElementChild: node('svg') };
    let finish;
    const picker = initScheduleFolderPicker({ root: { querySelector: selector => elements[selector.slice(1)], createElement: node },
        api: async route => route.endsWith('path=Reports') ? reports : rootListing, input: node('input'), windowRef: node(),
        prefix: 'flow', relative: true, onSelect: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }) });
    picker.open(); await settle();
    elements.flowFolderList.children[0].children[0].onclick(); await settle();
    elements.flowFolderUse.onclick(); await settle();
    assert.equal(dialog.open, true); assert.equal(elements.flowFolderUse.disabled, true);
    elements.flowFolderCancel.onclick(); assert.equal(dialog.open, true, 'the dialog cannot be dismissed while saving');
    finish.reject(new Error('workflow id already exists')); await settle();
    assert.equal(dialog.open, true);
    assert.equal(elements.flowFolderMessage.textContent, 'workflow id already exists');
    assert.equal(elements.flowFolderUse.disabled, false, 'another folder can be chosen after a failure');

    elements.flowFolderUse.onclick(); finish.resolve(); await settle();
    assert.equal(dialog.open, false);
});

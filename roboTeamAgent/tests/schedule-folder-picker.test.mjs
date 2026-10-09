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
const rootListing = { path: '', folder: '/workspace', folders: [{ name: 'Reports', path: 'Reports' }], defaultFolder: '/workspace/cron-jobs-results' };
const reports = { ...rootListing, path: 'Reports', folder: '/workspace/Reports', folders: [] };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(api = async route => {
    if (route.endsWith('path=cron-jobs-results')) throw Object.assign(new Error('Folder not found'), { status: 404 });
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
        if (route.endsWith('path=cron-jobs-results')) throw Object.assign(new Error('Folder not found'), { status: 404 });
        return route.endsWith('path=Reports') ? reports : rootListing;
    });
    f.picker.setFolder(); assert.equal(f.cronFolderLabel.textContent, 'Workspace / cron-jobs-results');
    f.cronChangeFolder.onclick(); await settle();
    assert.equal(f.cronFolderUse.disabled, false); assert.equal(f.cronFolderList.children.length, 1);
    f.cronFolderList.children[0].children[0].onclick(); await settle();
    f.cronFolderUse.onclick();
    assert.equal(f.input.value, '/workspace/Reports'); assert.equal(f.cronFolderLabel.textContent, 'Workspace / Reports');
    assert.equal(f.cronFolderDialog.open, false); assert.equal(f.cronChangeFolder.focused, true);
    f.cronDefaultFolder.onclick(); assert.equal(f.input.value, ''); assert.equal(f.cronDefaultFolder.hidden, true);
    assert.ok(calls.every(route => route.startsWith('api/roboflow/schedule-folders')));
});
test('cancel and stale browsing responses never change the saved selection', async () => {
    let resolve;
    const f = fixture(() => new Promise(done => { resolve = done; }));
    f.picker.setFolder('/workspace/Reports', 'Workspace / Reports');
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
    f.picker.setFolder('/workspace/Reports', 'Workspace / Reports'); f.cronChangeFolder.onclick(); await settle();
    assert.equal(f.cronFolderMessage.textContent, 'Workspace unavailable'); assert.equal(f.cronFolderUse.disabled, true);
    assert.equal(f.cronFolderCancel.disabled, false); f.cronFolderCancel.onclick();
    assert.equal(f.input.value, '/workspace/Reports');
});

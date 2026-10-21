import test from 'node:test';
import assert from 'node:assert/strict';
import { saveFile } from '../../web-components/pages/file-exp/file-exp-editor-controller.js';

function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
function host(markdown = false) {
    const textarea = { value: 'changed text' };
    return {
        state: { selectedPath: markdown ? '/notes.md' : '/notes.txt', path: '/', selectedIsMarkdown: markdown },
        element: { querySelector: selector => selector === '.code-input' ? textarea : null },
        setPreviewState(patch) { Object.assign(this.state, patch); },
        refreshPreviewUi() {}, showStatus() {}, normalizePath: p => p,
        refreshSelectedFileVersionInfo: async () => ({ versionKey: 'v1' }),
        tooling: {}, caches: { filePreview: { invalidateForPath() {} }, dirListing: { invalidate() {} } },
        isHtmlPreviewCandidate: () => false,
    };
}

test('Save is locked before Markdown flush, ignores repeated calls, and unlocks after an error', async t => {
    const h = host(true);
    const gate = deferred();
    let flushes = 0;
    const editor = { crdtDocumentId: 'doc-id', flushPendingCrdtChange() { flushes++; return gate.promise; } };
    const originalQuery = h.element.querySelector;
    h.element.querySelector = s => s === 'markdown-editor' ? { webSkelPresenter: editor } : originalQuery(s);
    t.mock.method(console, 'error', () => {});
    const first = saveFile(h);
    assert.equal(h.state.savePending, true);
    await saveFile(h);
    await saveFile(h, { autoSave: true, preserveEditing: true });
    assert.equal(flushes, 1);
    gate.reject(new Error('Flush failed'));
    await first;
    assert.equal(h.state.savePending, false);
    assert.equal(h._saveFileInProgress, false);
    assert.equal(h.state.lastSaveError, 'Flush failed');
    editor.flushPendingCrdtChange = async () => { flushes++; throw new Error('Retry failed'); };
    await saveFile(h);
    assert.equal(flushes, 2);
});

test('Save submits one write and stays locked through post-save version refresh', async t => {
    const h = host();
    const writeGate = deferred();
    const refreshGate = deferred();
    let writes = 0, refreshes = 0;
    h.tooling.writeFile = async () => { writes++; return writeGate.promise; };
    h.refreshSelectedFileVersionInfo = async () => ++refreshes === 1 ? { versionKey: 'v1' } : refreshGate.promise;
    const first = saveFile(h);
    await new Promise(setImmediate);
    await saveFile(h);
    assert.equal(writes, 1);
    writeGate.resolve();
    await new Promise(setImmediate);
    assert.equal(h.state.savePending, true);
    await saveFile(h);
    assert.equal(writes, 1);
    refreshGate.resolve({ versionKey: 'v2' });
    await first;
    assert.equal(h.state.savePending, false);
    assert.equal(h._saveFileInProgress, false);
    assert.equal(h.state.fileContent, 'changed text');
});

test('Save button exposes its native disabled and busy states until saving finishes', async t => {
    const { FileExp } = await import('../../web-components/pages/file-exp/file-exp.js');
    const previousWindow = globalThis.window;
    globalThis.window = {};
    t.after(() => { globalThis.window = previousWindow; });
    const attributes = new Map();
    const button = {
        classList: { toggle() {} },
        setAttribute: (key, value) => attributes.set(key, value),
        removeAttribute: key => attributes.delete(key),
    };
    const h = { state: { selectedPath: '/notes.txt', savePending: true }, element: { querySelector: s => s === '#saveButton' ? button : null } };
    FileExp.prototype.refreshPreviewUi.call(h);
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'Saving…');
    assert.equal(attributes.get('aria-busy'), 'true');
    h.state.savePending = false;
    FileExp.prototype.refreshPreviewUi.call(h);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Save');
    assert.equal(attributes.has('aria-busy'), false);
});

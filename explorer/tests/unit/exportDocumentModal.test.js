import test from 'node:test';
import assert from 'node:assert/strict';

let model;
let fail = false;
let reads = 0;
globalThis.assistOS = { loadModule: () => ({ getDocument: async () => {
    reads += 1;
    if (fail) throw new Error('private failure details');
    return model;
} }) };
const { ExportDocumentModal } = await import('../../web-components/modals/export-document-modal/export-document-modal.js');

test('DOCX action downloads a real Office package and recovers after a read failure', async (t) => {
    model = { title: 'Latest', chapters: [{ title: 'Chapter', paragraphs: [{ text: 'Unsaved text' }] }] };
    const links = [];
    const blobs = [];
    const messages = [];
    t.mock.method(URL, 'createObjectURL', (blob) => { blobs.push(blob); return 'blob:export'; });
    t.mock.method(URL, 'revokeObjectURL', () => {});
    t.mock.method(globalThis, 'setTimeout', (callback) => { callback(); });
    t.mock.method(globalThis, 'fetch', () => { throw new Error('DOCX must not use retired HTTP routes'); });
    globalThis.window = { showApplicationError: async (...args) => messages.push(args) };
    globalThis.document = {
        createElement: () => ({ click() { this.clicked = true; }, remove() { this.removed = true; } }),
        body: { appendChild: (link) => links.push(link) },
    };
    t.after(() => { delete globalThis.document; delete globalThis.window; });
    const modal = Object.assign(Object.create(ExportDocumentModal.prototype), { documentId: 'current-id', documentTitle: 'Current' });
    const button = { disabled: false };
    await Promise.all([modal.exportDOCX(button), modal.exportDOCX(button)]);
    assert.equal(reads, 1);
    assert.equal(links[0].download, 'Latest.docx');
    assert.equal(links[0].clicked, true);
    assert.equal(links[0].removed, true);
    assert.equal(blobs[0].type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.match(Buffer.from(await blobs[0].arrayBuffer()).toString(), /Unsaved text/);
    assert.equal(button.disabled, false);
    model = { chapters: [{ headingText: 'Verificare DOCX', paragraphs: [] }] };
    modal.documentTitle = 'undefined';
    await modal.exportDOCX(button);
    assert.equal(links[1].download, 'Verificare DOCX.docx');
    fail = true;
    await modal.exportDOCX(button);
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0].join(' '), /private failure details/);
    assert.equal(button.disabled, false);
    assert.equal(modal.docxExportInProgress, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentDocx } from '../../services/document/documentDocxExport.js';

function readParts(bytes) {
    const data = Buffer.from(bytes);
    const parts = {};
    let offset = 0;
    while (data.readUInt32LE(offset) === 0x04034b50) {
        assert.equal(data.readUInt16LE(offset + 8), 0);
        const size = data.readUInt32LE(offset + 18);
        const nameLength = data.readUInt16LE(offset + 26);
        const extraLength = data.readUInt16LE(offset + 28);
        const start = offset + 30 + nameLength + extraLength;
        const name = data.subarray(offset + 30, offset + 30 + nameLength).toString();
        parts[name] = data.subarray(start, start + size).toString();
        offset = start + size;
    }
    assert.equal(data.readUInt32LE(offset), 0x02014b50);
    return parts;
}

test('DOCX exports current structured text, headings, Unicode and line breaks without private metadata', () => {
    const parts = readParts(createDocumentDocx({
        title: 'Raport Științific',
        infoText: 'Overview',
        metadata: { secret: 'private-metadata-marker' },
        chapters: [{
            headingText: 'Résumé <one>',
            headingLevel: 3,
            commands: 'private-command-marker',
            paragraphs: [{ text: 'A & B\r\n  Țară 😀\t\u0001end', attachments: ['private-attachment-marker'] }],
        }],
    }));
    assert.deepEqual(Object.keys(parts), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    assert.match(parts['[Content_Types].xml'], /wordprocessingml.document.main\+xml/);
    assert.match(parts['_rels/.rels'], /Target="word\/document.xml"/);
    const xml = parts['word/document.xml'];
    assert.match(xml, /Raport Științific/);
    assert.match(xml, /Overview/);
    assert.match(xml, /Résumé &lt;one&gt;/);
    assert.match(xml, /w:outlineLvl w:val="2"/);
    assert.match(xml, /A &amp; B<\/w:t><w:br\/><w:t xml:space="preserve">  Țară 😀\tend/);
    assert.doesNotMatch(xml, /private-|\u0001/);
});

test('DOCX handles empty documents and rejects missing document models', () => {
    assert.match(readParts(createDocumentDocx({ chapters: [] }))['word/document.xml'], /<w:body><w:sectPr\/>/);
    assert.throws(() => createDocumentDocx(null), /structured document/);
});

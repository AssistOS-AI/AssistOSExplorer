import { buildStoredZip } from './storedZip.js';

function escapeXml(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function paragraph(text, headingLevel = 0) {
    const properties = headingLevel
        ? `<w:pPr><w:outlineLvl w:val="${headingLevel - 1}"/></w:pPr>`
        : '';
    const runProperties = headingLevel
        ? `<w:rPr><w:b/><w:sz w:val="${headingLevel === 1 ? 32 : 26}"/></w:rPr>`
        : '';
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const content = lines.map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`).join('<w:br/>');
    return `<w:p>${properties}<w:r>${runProperties}${content}</w:r></w:p>`;
}

// Export visible structured text only. Commands, private metadata and attachments
// are not executed, embedded or fetched when building an Office package.
export function createDocumentDocx(documentModel) {
    if (!documentModel || !Array.isArray(documentModel.chapters)) {
        throw new TypeError('A structured document is required for DOCX export.');
    }
    const blocks = [];
    if (documentModel.title) {
        blocks.push(paragraph(documentModel.title, 1));
    }
    if (documentModel.infoText || documentModel.abstract) {
        blocks.push(paragraph(documentModel.infoText || documentModel.abstract));
    }
    for (const chapter of documentModel.chapters) {
        const title = chapter.headingText ?? chapter.heading?.text ?? chapter.title;
        if (title) {
            const level = Number(chapter.headingLevel ?? chapter.heading?.level ?? 2);
            blocks.push(paragraph(title, Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2));
        }
        for (const item of chapter.paragraphs ?? []) {
            blocks.push(paragraph(item.text));
        }
    }
    const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    return buildStoredZip({
        '[Content_Types].xml': `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
        '_rels/.rels': `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
        'word/document.xml': `${declaration}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.join('')}<w:sectPr/></w:body></w:document>`,
    });
}

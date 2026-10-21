import { buildStoredZip } from '../document/storedZip.js';
import { getOnlyOfficeFileType } from './onlyoffice-file-types.js';

const BLANK_DOC_RTF = [
    '{\\rtf1\\ansi\\deff0',
    '{\\fonttbl{\\f0 Arial;}}',
    '\\viewkind4\\uc1\\pard\\f0\\fs22\\par',
    '}'
].join('');

const BLANK_DOCX_PARTS = Object.freeze({
    '[Content_Types].xml': [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '</Types>'
    ].join(''),
    '_rels/.rels': [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
        '</Relationships>'
    ].join(''),
    'word/document.xml': [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body><w:p/><w:sectPr/></w:body>',
        '</w:document>'
    ].join('')
});

function encodeBytesBase64(bytes) {
    if (globalThis.Buffer?.from) {
        return globalThis.Buffer.from(bytes).toString('base64');
    }

    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function encodeUtf8Base64(value) {
    return encodeBytesBase64(new TextEncoder().encode(value));
}

export function getNewFileInitialContent(fileName) {
    const officeType = getOnlyOfficeFileType(fileName);
    if (officeType?.extension === 'doc') {
        return {
            content: BLANK_DOC_RTF,
            dpuContent: encodeUtf8Base64(BLANK_DOC_RTF),
            mimeType: officeType.mimeType
        };
    }
    if (officeType?.extension === 'docx') {
        return {
            content: '',
            dpuContent: encodeBytesBase64(buildStoredZip(BLANK_DOCX_PARTS)),
            mimeType: officeType.mimeType
        };
    }

    return {
        content: '',
        dpuContent: '',
        mimeType: ''
    };
}

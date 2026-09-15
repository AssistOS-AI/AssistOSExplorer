import { createHmac } from 'node:crypto';

const FILE_TYPES = Object.freeze({
  csv: Object.freeze({ extension: 'csv', documentType: 'cell' }),
  doc: Object.freeze({ extension: 'doc', documentType: 'word' }),
  docx: Object.freeze({ extension: 'docx', documentType: 'word' }),
  odp: Object.freeze({ extension: 'odp', documentType: 'slide' }),
  ods: Object.freeze({ extension: 'ods', documentType: 'cell' }),
  odt: Object.freeze({ extension: 'odt', documentType: 'word' }),
  pdf: Object.freeze({ extension: 'pdf', documentType: 'pdf' }),
  ppt: Object.freeze({ extension: 'ppt', documentType: 'slide' }),
  pptx: Object.freeze({ extension: 'pptx', documentType: 'slide' }),
  xls: Object.freeze({ extension: 'xls', documentType: 'cell' }),
  xlsx: Object.freeze({ extension: 'xlsx', documentType: 'cell' }),
});

function fileTypeFor(name) {
  const match = String(name || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/i);
  return match ? FILE_TYPES[match[1]] || null : null;
}

export function signJwt(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const unsigned = `${header}.${body}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

export function buildDocumentKey(session) {
  const documentKey = String(session?.documentKey || '');
  if (!/^[0-9a-f]{32}$/.test(documentKey)) {
    throw new Error('OnlyOffice session requires its persisted v5 documentKey.');
  }
  return documentKey;
}

export function buildSignedOnlyOfficeConfig({
  session,
  config,
  authUser,
  documentUrl,
  callbackUrl,
  publicEditorBaseUrl,
  now = () => Date.now(),
} = {}) {
  const fileType = fileTypeFor(session?.fileName);
  if (!fileType) {
    throw new Error(`Unsupported OnlyOffice file type for ${session?.fileName || '<unknown>'}.`);
  }

  const issuedAt = Math.floor(Number(now()) / 1000);
  const ttlSeconds = Number(config?.configJwtTtlSeconds || 300);
  const baseConfig = {
    document: {
      title: session.fileName,
      fileType: fileType.extension,
      key: buildDocumentKey(session),
      url: documentUrl,
      permissions: {
        edit: Boolean(session.canWrite),
        comment: Boolean(session.canComment),
        review: Boolean(session.canWrite || session.canComment),
      },
    },
    documentType: fileType.documentType,
    editorConfig: {
      callbackUrl,
      mode: session.canWrite || session.canComment ? 'edit' : 'view',
      customization: {
        autosave: true,
        forcesave: Boolean(session.canWrite),
        plugins: false,
      },
      user: {
        id: String(authUser?.id || 'onlyoffice-user'),
        name: String(authUser?.username || authUser?.id || 'OnlyOffice User'),
      },
    },
  };

  return {
    ...baseConfig,
    token: signJwt({
      ...baseConfig,
      iat: issuedAt,
      nbf: issuedAt - 5,
      exp: issuedAt + ttlSeconds,
    }, config.onlyofficeJwtSecret),
    documentServerUrl: String(publicEditorBaseUrl || '').replace(/\/+$/, ''),
  };
}

export default {
  buildSignedOnlyOfficeConfig,
};

import path from 'node:path';

import { loadConfig } from '../config.mjs';
import { createSessionStore } from '../session-store.mjs';
import { verifyControlRouteAuth } from '../http-auth.mjs';
import { buildSignedOnlyOfficeConfig } from '../onlyoffice-config.mjs';
import { isConfidentialRequestPath as isConfidentialPath } from '../storage/dpu-paths.mjs';
import { resolveOnlyOfficeEditorService } from '../edge-topology.mjs';
import { resolveCanonicalEditorBrowserUrl } from '../public-editor-url.mjs';
import { ConfidentialDocumentError } from '../storage/confidential-document-error.mjs';

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}


function defaultResolveSessionDescriptor({ requestedPath }) {
  const cleanPath = String(requestedPath || '').trim();
  const fileName = path.posix.basename(cleanPath);
  if (!cleanPath || !fileName) {
    throw new Error('OnlyOffice session requires a file path.');
  }
  return {
    requestedPath: cleanPath,
    path: cleanPath,
    storageKind: isConfidentialPath(cleanPath) ? 'dpu' : 'workspace',
    storageId: cleanPath,
    fileName,
    canWrite: true,
    canComment: true,
    versionKey: `path:${cleanPath}`,
  };
}

function buildPreview(descriptor) {
  return {
    storageKind: String(descriptor?.storageKind || '').trim(),
    requestedPath: String(descriptor?.requestedPath || descriptor?.path || '').trim(),
    ...(descriptor?.objectId ? { objectId: String(descriptor.objectId).trim() } : {}),
    canWrite: Boolean(descriptor?.canWrite),
    canComment: Boolean(descriptor?.canComment),
  };
}

export function createStorageBackedSessionResolver({ storageRouter } = {}) {
  if (!storageRouter || typeof storageRouter.forSession !== 'function') {
    throw new Error('Storage-backed session resolver requires storageRouter.');
  }
  return async function resolveStorageBackedSessionDescriptor({
    requestedPath,
    authInfo,
    delegations = {},
    authUser = {},
  } = {}) {
    const base = defaultResolveSessionDescriptor({ requestedPath });
    const probeSession = {
      ...base,
      authUser,
      delegations,
      authInfo,
    };
    const metadata = await storageRouter.forSession(probeSession).metadata();
    const descriptor = {
      ...base,
      ...metadata,
      requestedPath: metadata?.requestedPath || base.requestedPath,
      path: metadata?.path || base.path,
      storageKind: metadata?.storageKind || base.storageKind,
      storageId: metadata?.storageId || base.storageId,
      fileName: metadata?.fileName || base.fileName,
      canWrite: Boolean(metadata?.canWrite),
      canComment: Boolean(metadata?.canComment),
      versionKey: metadata?.versionKey || base.versionKey,
    };
    return {
      ...descriptor,
      preview: buildPreview(descriptor),
    };
  };
}

function buildLoopbackStorageUrl(storagePort, routeName, token) {
  return `http://127.0.0.1:${storagePort}/internal/${routeName}/${encodeURIComponent(token)}`;
}

function normalizeDelegations(authInfo) {
  const source = authInfo?.delegations && typeof authInfo.delegations === 'object'
    ? authInfo.delegations
    : {};
  const out = {};
  if (source.dpuConfidential && typeof source.dpuConfidential === 'object') {
    const token = String(source.dpuConfidential.token || '').trim();
    const expiresAt = String(source.dpuConfidential.expiresAt || '').trim();
    if (token && expiresAt) {
      out.dpuConfidential = { token, expiresAt };
    }
  }
  return out;
}

export function createControlRouteHandler({
  env = process.env,
  config = loadConfig(env),
  sessionStore = createSessionStore({ idleTtlMs: loadConfig(env).sessionIdleTtlMs }),
  storageRouter = null,
  resolveSessionDescriptor = storageRouter
    ? createStorageBackedSessionResolver({ storageRouter })
    : defaultResolveSessionDescriptor,
  resolveEditorService = resolveOnlyOfficeEditorService,
} = {}) {
  return async function handleControlRoute(req, res, parsedUrl) {
    if (String(req.method || 'GET').toUpperCase() !== 'GET' || parsedUrl?.pathname !== '/control/office/session') {
      return false;
    }

    const verified = await verifyControlRouteAuth(req, { env, parsedUrl });
    if (!verified.ok) {
      sendJson(res, 401, { ok: false, error: 'invalid_http_service_auth', reason: verified.reason });
      return true;
    }

    const requestedPath = String(parsedUrl.searchParams.get('path') || '').trim();
    if (!requestedPath) {
      sendJson(res, 400, { ok: false, error: 'missing_path' });
      return true;
    }

    const delegations = normalizeDelegations(verified.authInfo);
    if (isConfidentialPath(requestedPath) && !delegations.dpuConfidential) {
      sendJson(res, 403, { ok: false, error: 'missing_confidential_delegation' });
      return true;
    }

    const authUser = verified.authInfo?.user && typeof verified.authInfo.user === 'object'
      ? verified.authInfo.user
      : {};
    let descriptor;
    try {
      descriptor = await resolveSessionDescriptor({
        requestedPath,
        authInfo: verified.authInfo,
        authUser,
        delegations,
      });
    } catch (error) {
      if (!(error instanceof ConfidentialDocumentError)) throw error;
      sendJson(res, error.statusCode, { ok: false, error: error.code });
      return true;
    }
    const editorService = await resolveEditorService({ req });
    const {
      browserUrl: editorBrowserUrl,
      prefix: editorBrowserPrefix,
    } = resolveCanonicalEditorBrowserUrl(editorService.activeBrowserUrl);
    const activeBrowserUrl = `${editorBrowserUrl.origin}${editorBrowserPrefix}`;
    const sessionDelegations = isConfidentialPath(requestedPath) ? delegations : {};
    const sessionInput = {
      ...descriptor,
      authUser,
      delegations: sessionDelegations,
      activeBrowserUrl,
    };
    if (sessionDelegations.dpuConfidential) {
      sessionStore.reauthorizeLoadedSessions?.(sessionInput);
    }
    const session = sessionStore.createSession(sessionInput);

    const documentUrl = buildLoopbackStorageUrl(config.storagePort, 'document', session.token);
    const callbackUrl = buildLoopbackStorageUrl(config.storagePort, 'callback', session.token);
    const editorConfig = buildSignedOnlyOfficeConfig({
      session,
      config,
      authUser,
      documentUrl,
      callbackUrl,
      publicEditorBaseUrl: session.activeBrowserUrl,
    });

    sendJson(res, 200, {
      ok: true,
      sessionId: session.token,
      preview: descriptor.preview || buildPreview(descriptor),
      config: editorConfig,
    });
    return true;
  };
}

export default {
  createControlRouteHandler,
};

import path from 'node:path';

import {
  DPU_MY_SPACE_PATH,
  DPU_SHARED_PATH,
  isDpuSecretPath,
  normalizeDpuPath
} from './dpu-paths.mjs';
import { resolveDpuConfidentialNodeAtPath } from './dpu-path-resolver.mjs';
import { ConfidentialDocumentError } from './confidential-document-error.mjs';

function requireCreateAgentClient(createAgentClient) {
  if (typeof createAgentClient !== 'function') {
    throw new Error('DPU store requires createAgentClient.');
  }
}

function toTimeMs(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const text = String(value || '').trim();
  if (!text) {
    return 0;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function assertDelegation(session, now) {
  const delegation = session?.delegations?.dpuConfidential;
  const token = delegation && typeof delegation === 'object'
    ? String(delegation.token || '').trim()
    : String(delegation || '').trim();
  if (!token) {
    throw new Error('Confidential session is missing DPU delegation token.');
  }

  const delegationExpiresAt = delegation && typeof delegation === 'object'
    ? toTimeMs(delegation.expiresAt)
    : toTimeMs(session?.delegationExpiresAt);
  const absoluteExpiresAt = toTimeMs(session?.absoluteExpiresAt);
  const effectiveExpiry = delegationExpiresAt > 0 && absoluteExpiresAt > 0
    ? Math.min(delegationExpiresAt, absoluteExpiresAt)
    : Math.max(delegationExpiresAt, absoluteExpiresAt);
  if (effectiveExpiry > 0 && now() >= effectiveExpiry) {
    throw new Error('Confidential session delegation expired.');
  }

  return token;
}

async function resolveDpuNodeForPath(client, requestedPath) {
  const normalizedPath = normalizeDpuPath(requestedPath);
  if (normalizedPath === DPU_MY_SPACE_PATH) {
    const roots = await client.callTool('dpu_workspace_roots', {});
    return {
      id: roots?.roots?.mySpace?.id || '',
      type: 'folder',
      name: 'My Space'
    };
  }

  if (normalizedPath === DPU_SHARED_PATH) {
    return {
      id: '',
      type: 'folder',
      name: 'Shared'
    };
  }

  return resolveDpuConfidentialNodeAtPath(normalizedPath, {
    getRoots: async () => (await client.callTool('dpu_workspace_roots', {}))?.roots || {},
    listConfidential: async (args) => client.callTool('dpu_confidential_list', args)
  });
}

function decodeContent(content) {
  return Buffer.from(String(content || ''), 'base64');
}

function buildMetadata({ requestedPath, node, objectRecord, session }) {
  const normalizedPath = normalizeDpuPath(requestedPath);
  return {
    storageKind: 'dpu',
    requestedPath: normalizedPath,
    objectId: String(objectRecord?.id || node?.id || session?.objectId || ''),
    fileName: String(objectRecord?.name || session?.fileName || path.basename(normalizedPath)),
    mimeType: String(objectRecord?.mimeType || session?.mimeType || 'application/octet-stream'),
    canWrite: Boolean(objectRecord?.canWrite ?? session?.canWrite),
    canComment: Boolean(objectRecord?.canComment ?? session?.canComment),
    versionKey: String(objectRecord?.updatedAt || objectRecord?.id || node?.id || session?.versionKey || '')
  };
}

async function resolveObjectRecord(session, client) {
  const requestedPath = normalizeDpuPath(session?.requestedPath || session?.path || '');
  if (isDpuSecretPath(requestedPath)) {
    throw new Error('OnlyOffice preview is not available for secrets.');
  }

  const node = session?.objectId
    ? { id: String(session.objectId) }
    : await resolveDpuNodeForPath(client, requestedPath);
  if (!node?.id) {
    throw new ConfidentialDocumentError('document_not_found');
  }

  const parsed = await client.callTool('dpu_confidential_get', { id: node.id });
  const objectRecord = parsed?.object || {};
  if (!objectRecord.contentVisible) {
    throw new ConfidentialDocumentError('document_forbidden');
  }

  return {
    node,
    objectRecord,
    metadata: buildMetadata({ requestedPath, node, objectRecord, session })
  };
}

export function createDpuStore({ createAgentClient, now = Date.now } = {}) {
  requireCreateAgentClient(createAgentClient);

  async function withClient(session, work) {
    const userDelegationToken = assertDelegation(session, now);
    const client = await createAgentClient('dpuAgent', { userDelegationToken });
    try {
      return await work(client);
    } finally {
      if (typeof client?.close === 'function') {
        await client.close();
      }
    }
  }

  async function metadata(session) {
    return withClient(session, async (client) => {
      const resolved = await resolveObjectRecord(session, client);
      return resolved.metadata;
    });
  }

  async function read(session) {
    return withClient(session, async (client) => {
      const resolved = await resolveObjectRecord(session, client);
      return {
        ...resolved.metadata,
        buffer: decodeContent(resolved.objectRecord.content)
      };
    });
  }

  async function write(session, buffer) {
    if (!session?.canWrite) {
      throw new Error('Document is read-only.');
    }

    return withClient(session, async (client) => {
      const resolved = await resolveObjectRecord(session, client);
      await client.callTool('dpu_confidential_update', {
        id: resolved.metadata.objectId,
        content: Buffer.from(buffer).toString('base64'),
        mimeType: resolved.metadata.mimeType
      });
      return resolved.metadata;
    });
  }

  return {
    metadata,
    read,
    write
  };
}

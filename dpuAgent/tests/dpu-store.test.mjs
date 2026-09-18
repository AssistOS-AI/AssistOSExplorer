import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpu-store-workspace-'));
const tempDpuDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpu-store-data-'));
const moduleSuffix = `?test=${Date.now()}`;
const storeUrl = new URL('../lib/dpu-store.mjs', import.meta.url);
const storageUrl = new URL('../lib/dpu-store-internal/storage.mjs', import.meta.url);
const {
  appendAuditClientEvent,
  getAuditConfig,
  getAuditEntry,
  searchAuditEntries,
  getWorkspaceRoots,
  listAuditEntries,
  addConfidentialComment,
  createConfidential,
  deleteConfidentialComment,
  getConfidentialById,
  getSecretByKey,
  getAgentPolicyForPrincipal,
  getWhoAmI,
  grantSecret,
  grantConfidential,
  putSecret,
  resolveActor,
  setAgentPolicyAllowedRoles,
  updateConfidential
} = await import(`${storeUrl.href}${moduleSuffix}`);
const { pruneExpiredAuditFiles } = await import(`${storageUrl.href}${moduleSuffix}`);

const previousWorkspaceRoot = process.env.DPU_WORKSPACE_ROOT;
const previousDpuDataRoot = process.env.DPU_DATA_ROOT;
const previousMasterKey = process.env.DPU_MASTER_KEY;

process.env.DPU_WORKSPACE_ROOT = tempWorkspaceDir;
process.env.DPU_DATA_ROOT = tempDpuDataDir;
process.env.DPU_MASTER_KEY = 'unit-test-master-key';

const authInfo = {
  user: {
    email: 'owner@example.com'
  }
};

const adminAuth = {
  user: {
    id: 'local:admin',
    username: 'admin',
    email: 'admin@example.com'
  }
};

async function getStoredObject(objectId) {
  const statePath = path.join(tempDpuDataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return state.confidentialObjects[objectId];
}

function getStoredState() {
  const statePath = path.join(tempDpuDataDir, 'state.json');
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function setStoredState(state) {
  const statePath = path.join(tempDpuDataDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function getBlobPath(objectId) {
  return path.join(tempDpuDataDir, 'blobs', objectId);
}

function getSecretsPath() {
  return path.join(tempDpuDataDir, 'secrets.json');
}

function getPermissionsManifestPath() {
  return path.join(tempDpuDataDir, 'permissions.manifest.json');
}

function getPermissionsManifest() {
  return JSON.parse(fs.readFileSync(getPermissionsManifestPath(), 'utf8'));
}

function getAuditDirPath() {
  return path.join(tempDpuDataDir, 'audit');
}

function writeAgentManifest(agentName, manifest) {
  const manifestPath = path.join(tempWorkspaceDir, '.ploinky', 'repos', 'TestSuite', agentName, 'manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

test.beforeEach(() => {
  fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  fs.rmSync(tempDpuDataDir, { recursive: true, force: true });
  fs.mkdirSync(tempWorkspaceDir, { recursive: true });
  fs.mkdirSync(tempDpuDataDir, { recursive: true });
});

test.after(() => {
  if (previousWorkspaceRoot === undefined) {
    delete process.env.DPU_WORKSPACE_ROOT;
  } else {
    process.env.DPU_WORKSPACE_ROOT = previousWorkspaceRoot;
  }
  if (previousDpuDataRoot === undefined) {
    delete process.env.DPU_DATA_ROOT;
  } else {
    process.env.DPU_DATA_ROOT = previousDpuDataRoot;
  }
  if (previousMasterKey === undefined) {
    delete process.env.DPU_MASTER_KEY;
  } else {
    process.env.DPU_MASTER_KEY = previousMasterKey;
  }
  fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  fs.rmSync(tempDpuDataDir, { recursive: true, force: true });
});

test('confidential files are encrypted at rest outside the workspace boundary', async () => {
  await getWhoAmI(authInfo);
  const created = await createConfidential(authInfo, {
    type: 'file',
    name: 'note.txt',
    content: 'top secret text',
    mimeType: 'text/plain'
  });
  assert.equal(created.ok, true);
  const objectRecord = await getStoredObject(created.object.id);
  const blobPath = getBlobPath(created.object.id);
  const rawOnDisk = fs.readFileSync(blobPath, 'utf8');

  assert.equal(objectRecord.storagePath, undefined);
  assert.equal(path.join(tempDpuDataDir, 'state.json').startsWith(`${tempWorkspaceDir}${path.sep}`), false);
  assert.equal(blobPath.startsWith(`${tempWorkspaceDir}${path.sep}`), false);
  assert.match(rawOnDisk, /^DPUENC1:/);
  assert.notEqual(rawOnDisk, 'top secret text');

  const fetched = await getConfidentialById(authInfo, { id: created.object.id });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.object.content, 'top secret text');
});

test('secret values are encrypted at rest and remain readable through ACL-aware APIs', async () => {
  const readerAuth = {
    user: {
      email: 'reader@example.com'
    }
  };
  await putSecret(authInfo, { key: 'API_TOKEN', value: 'top-secret-value' });
  await grantSecret(authInfo, { key: 'API_TOKEN', principal: 'reader@example.com', role: 'read' });
  const rawOnDisk = fs.readFileSync(getSecretsPath(), 'utf8');

  assert.match(rawOnDisk, /^DPUSECS1:/);
  assert.equal(rawOnDisk.includes('top-secret-value'), false);

  const fetched = await getSecretByKey(readerAuth, { key: 'API_TOKEN' });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.secret.value, 'top-secret-value');
});

test('secret put stores display names separately from strict keys', async () => {
  const created = await putSecret(authInfo, {
    key: 'secret_3',
    displayName: 'secret 3',
    value: 'named-value'
  });

  assert.equal(created.ok, true);
  assert.equal(created.secret.key, 'secret_3');
  assert.equal(created.secret.displayName, 'secret 3');

  const fetched = await getSecretByKey(authInfo, { key: 'secret_3' });
  assert.equal(fetched.secret.key, 'secret_3');
  assert.equal(fetched.secret.displayName, 'secret 3');
  assert.equal(fetched.secret.value, 'named-value');
});

test('delegated secret reads accept direct agent invocations without a binding id', async () => {
  const readerAuth = {
    user: {
      email: 'reader@example.com'
    }
  };
  await putSecret(authInfo, { key: 'DIRECT_TOKEN', value: 'direct-value' });
  await grantSecret(authInfo, { key: 'DIRECT_TOKEN', principal: 'reader@example.com', role: 'read' });

  const delegatedAuth = {
    user: {
      email: 'reader@example.com'
    },
    agent: {
      principalId: 'agent:AssistOSExplorer/gitAgent',
      name: 'gitAgent'
    },
    invocation: {
      scope: ['secret:read'],
      tool: 'dpu_secret_get',
      workspaceId: 'default'
    }
  };

  const fetched = await getSecretByKey(delegatedAuth, { key: 'DIRECT_TOKEN' });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.secret.value, 'direct-value');
});

test('delegated secret reads reject missing required scope', async () => {
  await putSecret(authInfo, { key: 'DIRECT_SCOPE_TOKEN', value: 'direct-value' });
  await grantSecret(authInfo, { key: 'DIRECT_SCOPE_TOKEN', principal: 'reader@example.com', role: 'read' });

  const delegatedAuth = {
    user: {
      email: 'reader@example.com'
    },
    agent: {
      principalId: 'agent:AssistOSExplorer/gitAgent',
      name: 'gitAgent'
    },
    invocation: {
      scope: ['secret:write'],
      tool: 'dpu_secret_get',
      workspaceId: 'default'
    }
  };

  await assert.rejects(
    () => getSecretByKey(delegatedAuth, { key: 'DIRECT_SCOPE_TOKEN' }),
    /Invocation scope does not permit dpu_secret_get/
  );
});

test('delegated secret reads with no explicit scope fall through to secret ACL', async () => {
  await putSecret(authInfo, { key: 'DIRECT_NO_SCOPE_TOKEN', value: 'direct-value' });
  await grantSecret(authInfo, { key: 'DIRECT_NO_SCOPE_TOKEN', principal: 'reader@example.com', role: 'read' });

  const delegatedAuth = {
    user: {
      email: 'reader@example.com'
    },
    agent: {
      principalId: 'agent:AssistOSExplorer/gitAgent',
      name: 'gitAgent'
    },
    invocation: {
      scope: [],
      tool: 'dpu_secret_get',
      workspaceId: 'default'
    }
  };

  const fetched = await getSecretByKey(delegatedAuth, { key: 'DIRECT_NO_SCOPE_TOKEN' });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.secret.value, 'direct-value');
});

test('delegated confidential get uses usr as the acting principal', async () => {
  const created = await createConfidential(authInfo, {
    type: 'file',
    name: 'delegated-read.txt',
    content: 'delegated read',
    mimeType: 'text/plain'
  });
  await grantConfidential(authInfo, {
    id: created.object.id,
    principal: 'reader@example.com',
    role: 'read'
  });

  const delegatedAuth = {
    user: {
      email: 'reader@example.com'
    },
    agent: {
      principalId: 'agent:OnlyOfficeAgent/onlyOffice',
      name: 'onlyOffice'
    },
    invocation: {
      tool: 'dpu_confidential_get',
      workspaceId: 'default'
    }
  };

  const fetched = await getConfidentialById(delegatedAuth, { id: created.object.id });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.object.content, 'delegated read');

  const listed = await listAuditEntries(adminAuth);
  const auditEntry = await getAuditEntry(adminAuth, { name: listed.items[0].name });
  assert.match(auditEntry.item.content, /"principalId":"reader@example\.com"/);
  assert.match(auditEntry.item.content, /"agentPrincipalId":"agent:OnlyOfficeAgent\/onlyOffice"/);
});

test('delegated confidential update uses usr as the acting principal', async () => {
  const created = await createConfidential(authInfo, {
    type: 'file',
    name: 'delegated-write.txt',
    content: 'before',
    mimeType: 'text/plain'
  });
  await grantConfidential(authInfo, {
    id: created.object.id,
    principal: 'editor@example.com',
    role: 'write'
  });

  const delegatedAuth = {
    user: {
      email: 'editor@example.com'
    },
    agent: {
      principalId: 'agent:OnlyOfficeAgent/onlyOffice',
      name: 'onlyOffice'
    },
    invocation: {
      tool: 'dpu_confidential_update',
      workspaceId: 'default'
    }
  };

  const updated = await updateConfidential(delegatedAuth, {
    id: created.object.id,
    content: 'after'
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.object.content, 'after');

  const fetched = await getConfidentialById(authInfo, { id: created.object.id });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.object.content, 'after');
});

test('agent caller without usr cannot satisfy user-owned confidential acl', async () => {
  const created = await createConfidential(authInfo, {
    type: 'file',
    name: 'agent-only.txt',
    content: 'locked',
    mimeType: 'text/plain'
  });

  const agentOnlyAuth = {
    agent: {
      principalId: 'agent:OnlyOfficeAgent/onlyOffice',
      name: 'onlyOffice'
    },
    invocation: {
      tool: 'dpu_confidential_get',
      workspaceId: 'default'
    }
  };

  await assert.rejects(
    () => getConfidentialById(agentOnlyAuth, { id: created.object.id }),
    /Access denied: missing access on confidential object/
  );
  await assert.rejects(
    () => updateConfidential(agentOnlyAuth, { id: created.object.id, content: 'tampered' }),
    /Access denied: missing write on confidential object/
  );
});

test('delegated confidential get requires read delegation scope when present', async () => {
  const created = await createConfidential(authInfo, {
    type: 'file',
    name: 'delegated-scope-read.txt',
    content: 'scoped read',
    mimeType: 'text/plain'
  });
  await grantConfidential(authInfo, {
    id: created.object.id,
    principal: 'reader@example.com',
    role: 'read'
  });

  const delegatedAuth = {
    user: {
      email: 'reader@example.com'
    },
    agent: {
      principalId: 'agent:OnlyOfficeAgent/onlyOffice',
      name: 'onlyOffice'
    },
    invocation: {
      tool: 'dpu_confidential_get',
      delegation: {
        scope: ['dpu:confidential:write']
      }
    }
  };

  await assert.rejects(
    () => getConfidentialById(delegatedAuth, { id: created.object.id }),
    /Invocation scope does not permit dpu_confidential_get/
  );
});

test('delegated confidential update requires write delegation scope when present', async () => {
  const created = await createConfidential(authInfo, {
    type: 'file',
    name: 'delegated-scope-write.txt',
    content: 'before',
    mimeType: 'text/plain'
  });
  await grantConfidential(authInfo, {
    id: created.object.id,
    principal: 'editor@example.com',
    role: 'write'
  });

  const delegatedAuth = {
    user: {
      email: 'editor@example.com'
    },
    agent: {
      principalId: 'agent:OnlyOfficeAgent/onlyOffice',
      name: 'onlyOffice'
    },
    invocation: {
      tool: 'dpu_confidential_update',
      delegation: {
        scope: ['dpu:confidential:read']
      }
    }
  };

  await assert.rejects(
    () => updateConfidential(delegatedAuth, { id: created.object.id, content: 'after' }),
    /Invocation scope does not permit dpu_confidential_update/
  );
});

test('plaintext secret storage is rejected', async () => {
  const readerAuth = {
    user: {
      email: 'reader@example.com'
    }
  };
  await putSecret(authInfo, { key: 'LEGACY_TOKEN', value: 'legacy-value' });
  await grantSecret(authInfo, { key: 'LEGACY_TOKEN', principal: 'reader@example.com', role: 'read' });
  fs.writeFileSync(getSecretsPath(), 'LEGACY_TOKEN=legacy-value\n', 'utf8');
  await assert.rejects(
    () => getSecretByKey(readerAuth, { key: 'LEGACY_TOKEN' }),
    /DPU secret storage is invalid/
  );
});

test('plaintext confidential storage is rejected', async () => {
  await getWhoAmI(authInfo);
  const created = await createConfidential(authInfo, {
    type: 'file',
    name: 'legacy.txt',
    content: '',
    mimeType: 'text/plain'
  });
  assert.equal(created.ok, true);
  const objectRecord = await getStoredObject(created.object.id);

  fs.writeFileSync(getBlobPath(objectRecord.id), 'legacy plaintext', 'utf8');
  const beforeRead = fs.readFileSync(getBlobPath(objectRecord.id), 'utf8');
  assert.equal(beforeRead, 'legacy plaintext');

  await assert.rejects(
    () => getConfidentialById(authInfo, { id: created.object.id }),
    /Confidential file storage is invalid/
  );
});

test('missing confidential blob is rejected', async () => {
  await getWhoAmI(authInfo);
  const created = await createConfidential(authInfo, {
    type: 'file',
    name: 'missing.txt',
    content: 'must exist',
    mimeType: 'text/plain'
  });
  assert.equal(created.ok, true);

  fs.rmSync(getBlobPath(created.object.id), { force: true });

  await assert.rejects(
    () => getConfidentialById(authInfo, { id: created.object.id }),
    /Confidential file storage is missing/
  );
});

test('resolveActor uses a single canonical principal with email priority', () => {
  const actor = resolveActor({
    user: {
      email: 'Reader@Example.com',
      id: 'reader-id',
      username: 'reader-user'
    }
  });

  assert.equal(actor.principalId, 'reader@example.com');
});

test('My Space root id is the user privateId', async () => {
  const whoami = await getWhoAmI(authInfo);
  assert.equal(whoami.ok, true);
  assert.equal(whoami.userSpace.mySpaceRootId, whoami.userSpace.privateId);

  const state = getStoredState();
  assert.ok(state.confidentialObjects[whoami.userSpace.privateId]);
  assert.equal(state.confidentialObjects[whoami.userSpace.privateId].name, 'My Space');
});

test('workspace roots expose audit only to admin viewers', async () => {
  const adminRoots = await getWorkspaceRoots(adminAuth);
  const userRoots = await getWorkspaceRoots(authInfo);
  assert.equal(adminRoots.ok, true);
  assert.equal(adminRoots.roots.audit.path, '/Confidential/Audit');
  assert.equal(userRoots.ok, true);
  assert.equal(userRoots.roots.audit, undefined);
});

test('whoami rejects delegated calls without a read/access scope', async () => {
  const delegatedAuth = {
    user: {
      email: 'owner@example.com'
    },
    agent: {
      principalId: 'agent:AssistOSExplorer/gitAgent',
      name: 'gitAgent'
    },
    invocation: {
      scope: ['secret:write'],
      tool: 'dpu_whoami',
      workspaceId: 'default'
    }
  };

  await assert.rejects(
    () => getWhoAmI(delegatedAuth),
    /Invocation scope does not permit dpu_whoami/
  );
});

test('workspace roots reject delegated calls without a read/access scope', async () => {
  const delegatedAuth = {
    user: {
      email: 'owner@example.com'
    },
    agent: {
      principalId: 'agent:AssistOSExplorer/gitAgent',
      name: 'gitAgent'
    },
    invocation: {
      scope: ['secret:write'],
      tool: 'dpu_workspace_roots',
      workspaceId: 'default'
    }
  };

  await assert.rejects(
    () => getWorkspaceRoots(delegatedAuth),
    /Invocation scope does not permit dpu_workspace_roots/
  );
});

test('secret ACL principals are stored canonically and registry aliases keep the same principal across auth shapes', async () => {
  const ownerAuth = {
    user: {
      email: 'owner@example.com'
    }
  };
  const readerAuth = {
    user: {
      email: 'reader@example.com',
      id: 'reader-id',
      username: 'reader-user'
    }
  };
  const idOnlyAuth = {
    user: {
      id: 'reader-id',
      username: 'reader-user'
    }
  };

  await putSecret(ownerAuth, { key: 'CANONICAL_SECRET', value: 'value' });
  await grantSecret(ownerAuth, {
    key: 'CANONICAL_SECRET',
    principal: 'Reader@Example.com',
    role: 'read'
  });

  const manifest = getPermissionsManifest();
  assert.equal(manifest.permissions.secrets.CANONICAL_SECRET.acl['reader@example.com'], 'read');
  assert.equal(manifest.permissions.secrets.CANONICAL_SECRET.acl['Reader@Example.com'], undefined);

  const canonicalReader = await getSecretByKey(readerAuth, { key: 'CANONICAL_SECRET' });
  assert.equal(canonicalReader.ok, true);
  assert.equal(canonicalReader.secret.role, 'read');

  const idOnlyReader = await getSecretByKey(idOnlyAuth, { key: 'CANONICAL_SECRET' });
  assert.equal(idOnlyReader.ok, true);
  assert.equal(idOnlyReader.secret.role, 'read');
});

test('central permissions manifest becomes the ACL source of truth for secret access', async () => {
  const ownerAuth = {
    user: {
      email: 'owner@example.com'
    }
  };
  const readerAuth = {
    user: {
      email: 'reader@example.com'
    }
  };

  await putSecret(ownerAuth, { key: 'MANIFEST_SECRET', value: 'manifest-value' });
  await grantSecret(ownerAuth, {
    key: 'MANIFEST_SECRET',
    principal: 'reader@example.com',
    role: 'read'
  });

  const state = getStoredState();
  state.secrets.MANIFEST_SECRET.acl = {
    'reader@example.com': 'write'
  };
  setStoredState(state);

  const manifest = getPermissionsManifest();
  assert.equal(manifest.permissions.secrets.MANIFEST_SECRET.acl['reader@example.com'], 'read');

  const fetched = await getSecretByKey(readerAuth, { key: 'MANIFEST_SECRET' });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.secret.role, 'read');
  assert.equal(fetched.secret.value, 'manifest-value');
});

test('identity registry can resolve principals from SSO claims without exposing email directly', async () => {
  const ownerAuth = {
    user: {
      email: 'registry-owner@example.com'
    }
  };
  await putSecret(ownerAuth, { key: 'SSO_SECRET', value: 'claims-value' });
  await grantSecret(ownerAuth, {
    key: 'SSO_SECRET',
    principal: 'registry-reader@example.com',
    role: 'read'
  });

  const manifest = getPermissionsManifest();
  manifest.identities.principals['registry-reader@example.com'] = {
    aliases: {
      emails: ['registry-reader@example.com'],
      userIds: ['reader-id'],
      usernames: [],
      ssoSubjects: ['oidc-reader-subject'],
      issuers: ['https://issuer.example.com']
    },
    claims: {
      roles: ['reader']
    },
    createdAt: '2026-03-27T00:00:00.000Z',
    updatedAt: '2026-03-27T00:00:00.000Z'
  };
  fs.writeFileSync(getPermissionsManifestPath(), JSON.stringify(manifest, null, 2), 'utf8');

  const ssoReader = await getSecretByKey({
    claims: {
      sub: 'oidc-reader-subject',
      iss: 'https://issuer.example.com',
      roles: ['reader']
    },
    user: {}
  }, { key: 'SSO_SECRET' });

  assert.equal(ssoReader.ok, true);
  assert.equal(ssoReader.secret.role, 'read');
  assert.equal(ssoReader.secret.value, 'claims-value');
});

test('secret owners keep full access after writes and same-agent delegated reads remain full write access', async () => {
  const ownerAuth = {
    user: {
      id: 'local:admin',
      username: 'admin',
      email: ''
    }
  };

  await putSecret(ownerAuth, { key: 'AGENT_VISIBLE_SECRET', value: 'agent-readable-value' });

  const manifest = getPermissionsManifest();
  manifest.agentPolicies = manifest.agentPolicies || {};
  manifest.agentPolicies['agent:AssistOSExplorer/gitAgent'] = {
    secrets: { allowedRoles: ['read'] },
    updatedAt: '2026-04-16T00:00:00.000Z'
  };
  manifest.identities.principals['agent:AssistOSExplorer/gitAgent'] = {
    aliases: {
      emails: [],
      userIds: [],
      usernames: [],
      ssoSubjects: [],
      issuers: []
    },
    claims: {
      roles: []
    },
    createdAt: '2026-04-16T00:00:00.000Z',
    updatedAt: '2026-04-16T00:00:00.000Z'
  };
  fs.writeFileSync(getPermissionsManifestPath(), JSON.stringify(manifest, null, 2), 'utf8');

  const ownerView = await getSecretByKey(ownerAuth, { key: 'AGENT_VISIBLE_SECRET' });
  assert.equal(ownerView.ok, true);
  assert.equal(ownerView.secret.role, 'write');
  assert.equal(ownerView.secret.value, 'agent-readable-value');

  await grantSecret(ownerAuth, {
    key: 'AGENT_VISIBLE_SECRET',
    principal: 'agent:AssistOSExplorer/gitAgent',
    role: 'read'
  });

  const agentView = await getSecretByKey({
    user: {
      id: 'local:admin',
      username: 'admin',
      email: ''
    },
    agent: {
      name: 'gitAgent',
      principalId: 'agent:AssistOSExplorer/gitAgent'
    }
  }, { key: 'AGENT_VISIBLE_SECRET' });

  assert.equal(agentView.ok, true);
  assert.equal(agentView.secret.role, 'write');
  assert.equal(agentView.secret.canWrite, true);
  assert.equal(agentView.secret.value, 'agent-readable-value');
});

test('delegated owner writes still succeed after the same agent is granted read access', async () => {
  const ownerAuth = {
    user: {
      id: 'local:admin',
      username: 'admin',
      email: ''
    }
  };

  await putSecret(ownerAuth, { key: 'OWNER_UPDATE_SECRET', value: 'initial-value' });

  const manifest = getPermissionsManifest();
  manifest.agentPolicies = manifest.agentPolicies || {};
  manifest.agentPolicies['agent:AssistOSExplorer/gitAgent'] = {
    secrets: { allowedRoles: ['read'] },
    updatedAt: '2026-04-16T00:00:00.000Z'
  };
  manifest.identities.principals['agent:AssistOSExplorer/gitAgent'] = {
    aliases: {
      emails: [],
      userIds: [],
      usernames: [],
      ssoSubjects: [],
      issuers: []
    },
    claims: {
      roles: []
    },
    createdAt: '2026-04-16T00:00:00.000Z',
    updatedAt: '2026-04-16T00:00:00.000Z'
  };
  fs.writeFileSync(getPermissionsManifestPath(), JSON.stringify(manifest, null, 2), 'utf8');

  await grantSecret(ownerAuth, {
    key: 'OWNER_UPDATE_SECRET',
    principal: 'agent:AssistOSExplorer/gitAgent',
    role: 'read'
  });

  const delegatedOwnerAuth = {
    user: {
      id: 'local:admin',
      username: 'admin',
      email: ''
    },
    agent: {
      name: 'gitAgent',
      principalId: 'agent:AssistOSExplorer/gitAgent'
    },
    invocation: {
      scope: ['secret:write'],
      tool: 'dpu_secret_put',
      workspaceId: 'default'
    }
  };

  const updated = await putSecret(delegatedOwnerAuth, {
    key: 'OWNER_UPDATE_SECRET',
    value: 'updated-value'
  });
  assert.equal(updated.ok, true);

  const state = getStoredState();
  assert.equal(state.secrets.OWNER_UPDATE_SECRET.ownerId, 'user:local:admin');
});

test('agent secret grants are capped by DPU-owned agentPolicies allowedRoles', async () => {
  const ownerAuth = {
    user: {
      email: 'owner@example.com'
    }
  };
  await putSecret(ownerAuth, { key: 'AGENT_ROLE_LIMIT', value: 'value' });

  const manifest = getPermissionsManifest();
  manifest.agentPolicies = manifest.agentPolicies || {};
  manifest.agentPolicies['agent:AssistOSExplorer/gitAgent'] = {
    secrets: { allowedRoles: ['read'] },
    updatedAt: '2026-04-17T00:00:00.000Z'
  };
  manifest.identities.principals['agent:AssistOSExplorer/gitAgent'] = {
    aliases: {
      emails: [],
      userIds: [],
      usernames: [],
      ssoSubjects: [],
      issuers: []
    },
    claims: {
      roles: []
    },
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z'
  };
  fs.writeFileSync(getPermissionsManifestPath(), JSON.stringify(manifest, null, 2), 'utf8');

  await assert.rejects(
    () => grantSecret(ownerAuth, {
      key: 'AGENT_ROLE_LIMIT',
      principal: 'agent:AssistOSExplorer/gitAgent',
      role: 'write'
    }),
    /not allowed to receive secret role write/
  );
});

test('admin can set and then read an agent secret policy via DPU tools', async () => {
  const setResult = await setAgentPolicyAllowedRoles(adminAuth, {
    principalId: 'agent:AssistOSExplorer/gitAgent',
    allowedRoles: ['read', 'write']
  });
  assert.equal(setResult.ok, true);
  assert.equal(setResult.principalId, 'agent:AssistOSExplorer/gitAgent');
  assert.deepEqual(setResult.policy.secrets.allowedRoles, ['read', 'write']);

  const getResult = await getAgentPolicyForPrincipal(adminAuth, {
    principalId: 'agent:AssistOSExplorer/gitAgent'
  });
  assert.equal(getResult.ok, true);
  assert.deepEqual(getResult.policy.secrets.allowedRoles, ['read', 'write']);
});

test('non-admin callers cannot manage DPU agent policies', async () => {
  await assert.rejects(
    () => setAgentPolicyAllowedRoles({ user: { email: 'someone@example.com' } }, {
      principalId: 'agent:AssistOSExplorer/gitAgent',
      allowedRoles: ['read']
    }),
    /admin or security role/
  );
  await assert.rejects(
    () => getAgentPolicyForPrincipal({ user: { email: 'someone@example.com' } }, {
      principalId: 'agent:AssistOSExplorer/gitAgent'
    }),
    /admin or security role/
  );
});

test('agent policy tools reject non-agent principals', async () => {
  await assert.rejects(
    () => setAgentPolicyAllowedRoles(adminAuth, {
      principalId: 'user:local:admin',
      allowedRoles: ['read']
    }),
    /agent principal/
  );
});

test('agent secret grants are rejected when no DPU agent policy exists', async () => {
  const ownerAuth = {
    user: {
      email: 'owner@example.com'
    }
  };
  await putSecret(ownerAuth, { key: 'UNREGISTERED_AGENT_SECRET', value: 'value' });

  await assert.rejects(
    () => grantSecret(ownerAuth, {
      key: 'UNREGISTERED_AGENT_SECRET',
      principal: 'agent:AssistOSExplorer/gitAgent',
      role: 'read'
    }),
    /no DPU policy exists/
  );
});

test('audit policy is always enabled and writes JSONL records for DPU operations', async () => {
  const configBefore = await getAuditConfig(adminAuth);
  assert.equal(configBefore.ok, true);
  assert.equal(configBefore.audit.canManage, false);
  assert.equal(configBefore.audit.enabled, true);
  assert.deepEqual(configBefore.audit.capture, {
    dpuOperations: true,
    fileAccess: true,
    explorerActions: true,
    pluginUsage: true,
    aiActivity: false
  });

  await putSecret(adminAuth, { key: 'AUDITED_SECRET', value: 'value' });

  const listed = await listAuditEntries(adminAuth);
  assert.equal(listed.ok, true);
  assert.equal(Array.isArray(listed.items), true);
  assert.equal(listed.items.length > 0, true);
  assert.equal(fs.existsSync(getAuditDirPath()), true);

  const latestName = listed.items[0].name;
  const fetched = await getAuditEntry(adminAuth, { name: latestName });
  assert.equal(fetched.ok, true);
  assert.match(fetched.item.content, /dpu\.secret\.put/);
  assert.match(fetched.item.content, /AUDITED_SECRET/);
});

test('audit files are not visible to non-admin users', async () => {
  await putSecret(adminAuth, { key: 'ADMIN_ONLY_AUDIT', value: 'value' });

  await assert.rejects(
    () => listAuditEntries({
      user: {
        email: 'reader@example.com',
        username: 'reader'
      }
    }),
    /audit logs require admin or security role/i
  );
});

test('AI client events and their content are never appended', async () => {
  const appended = await appendAuditClientEvent(adminAuth, {
    eventType: 'copilot.prompt',
    source: 'explorer',
    path: '/src/app.js',
    language: 'javascript',
    prompt: 'const answer = ',
    metadata: {
      cursorOffset: 15
    }
  });
  assert.equal(appended.ok, true);
  assert.equal(appended.appended, false);
});

test('non-AI client audit events are appended under the fixed policy', async () => {
  const appended = await appendAuditClientEvent(adminAuth, {
    eventType: 'file.open',
    source: 'explorer',
    path: '/src/app.js'
  });
  assert.equal(appended.ok, true);
  assert.equal(appended.appended, true);
});

test('client-supplied free-form metadata is not persisted in audit records', async () => {
  await appendAuditClientEvent(adminAuth, {
    eventType: 'file.open',
    source: 'explorer',
    path: '/src/app.js',
    metadata: { Prompt: 'do not persist this prompt', custom: 'untrusted metadata' }
  });
  const listed = await listAuditEntries(adminAuth);
  const fetched = await getAuditEntry(adminAuth, { name: listed.items[0].name });
  assert.doesNotMatch(fetched.item.content, /do not persist this prompt|untrusted metadata/);
});

test('audit reads can be bounded to the newest complete records', async () => {
  const auditRoot = getAuditDirPath();
  fs.mkdirSync(auditRoot, { recursive: true });
  const name = '2099-01-01.jsonl';
  fs.writeFileSync(path.join(auditRoot, name), `${JSON.stringify({ id: 1, text: 'a'.repeat(200) })}\n${JSON.stringify({ id: 2, text: 'b'.repeat(200) })}\n`, 'utf8');
  const fetched = await getAuditEntry(adminAuth, { name, maxBytes: 260 });
  assert.doesNotMatch(fetched.item.content, /"id":1/);
  assert.match(fetched.item.content, /"id":2/);
});

test('audit reads preserve a complete record when the byte window begins at its boundary', async () => {
  const auditRoot = getAuditDirPath();
  fs.mkdirSync(auditRoot, { recursive: true });
  const name = '2099-01-02.jsonl';
  const first = `${JSON.stringify({ id: 1, text: 'first' })}\n`;
  const second = `${JSON.stringify({ id: 2, text: 'second' })}\n`;
  fs.writeFileSync(path.join(auditRoot, name), `${first}${second}`, 'utf8');
  const fetched = await getAuditEntry(adminAuth, { name, maxBytes: Buffer.byteLength(second) });
  assert.equal(fetched.item.content, second);
});

test('audit search returns newest case-insensitive matches with timestamps and a bounded result', async () => {
  const auditRoot = getAuditDirPath();
  fs.mkdirSync(auditRoot, { recursive: true });
  const first = JSON.stringify({ timestamp: '2099-01-01T10:00:00.000Z', event: 'Access DENIED' });
  const second = JSON.stringify({ timestamp: '2099-01-01T11:00:00.000Z', event: 'access denied again' });
  fs.writeFileSync(path.join(auditRoot, '2099-01-01.jsonl'), `${first}\n${second}\n`, 'utf8');
  const searched = await searchAuditEntries(adminAuth, { query: 'ACCESS denied', limit: 1 });
  assert.equal(searched.matches.length, 1);
  assert.equal(searched.matches[0].lineNumber, 2);
  assert.equal(searched.matches[0].timestamp, '2099-01-01T11:00:00.000Z');
  assert.equal(searched.truncated, true);
});

test('audit retention removes expired daily files and keeps recent files', async () => {
  const auditRoot = getAuditDirPath();
  fs.mkdirSync(auditRoot, { recursive: true });
  fs.writeFileSync(path.join(auditRoot, '2099-01-01.jsonl'), '{}\n');
  fs.writeFileSync(path.join(auditRoot, '2100-06-15.jsonl'), '{}\n');
  await pruneExpiredAuditFiles(new Date('2100-06-16T00:00:00.000Z'));
  assert.equal(fs.existsSync(path.join(auditRoot, '2099-01-01.jsonl')), false);
  assert.equal(fs.existsSync(path.join(auditRoot, '2100-06-15.jsonl')), true);
});

test('comment role can add annotations without write access and read role can see them', async () => {
  const ownerAuth = {
    user: {
      email: 'owner@example.com'
    }
  };
  const commenterAuth = {
    user: {
      email: 'commenter@example.com'
    }
  };
  const readerAuth = {
    user: {
      email: 'reader@example.com'
    }
  };

  const created = await createConfidential(ownerAuth, {
    type: 'file',
    name: 'commentable.txt',
    content: 'shared text',
    mimeType: 'text/plain'
  });

  await grantConfidential(ownerAuth, {
    id: created.object.id,
    principal: 'commenter@example.com',
    role: 'comment'
  });
  await grantConfidential(ownerAuth, {
    id: created.object.id,
    principal: 'reader@example.com',
    role: 'read'
  });

  const commenterView = await getConfidentialById(commenterAuth, { id: created.object.id });
  assert.equal(commenterView.ok, true);
  assert.equal(commenterView.object.canRead, true);
  assert.equal(commenterView.object.canComment, true);
  assert.equal(commenterView.object.canWrite, false);

  const added = await addConfidentialComment(commenterAuth, {
    id: created.object.id,
    message: 'Please review this line.'
  });
  assert.equal(added.ok, true);
  assert.equal(added.comment.userEmail, 'commenter@example.com');

  await assert.rejects(
    () => addConfidentialComment(readerAuth, {
      id: created.object.id,
      message: 'I should not be able to comment.'
    }),
    /missing comment/
  );

  const readerView = await getConfidentialById(readerAuth, { id: created.object.id });
  assert.equal(readerView.ok, true);
  assert.equal(readerView.object.commentsVisible, true);
  assert.equal(readerView.object.commentCount, 1);
  assert.equal(readerView.object.comments[0].message, 'Please review this line.');
  assert.equal(readerView.object.comments[0].canDelete, false);

  await deleteConfidentialComment(commenterAuth, {
    id: created.object.id,
    commentId: added.comment.id
  });

  const ownerView = await getConfidentialById(ownerAuth, { id: created.object.id });
  assert.equal(ownerView.object.commentCount, 0);
});

test('existing confidential comments without a line remain readable as general comments', async () => {
  const ownerAuth = {
    user: {
      email: 'owner@example.com'
    }
  };

  const created = await createConfidential(ownerAuth, {
    type: 'file',
    name: 'legacy-comments.txt',
    content: 'hello',
    mimeType: 'text/plain'
  });

  const state = getStoredState();
  state.confidentialObjects[created.object.id].comments = [{
    id: 'legacy-comment',
    authorPrincipal: 'owner@example.com',
    userEmail: 'owner@example.com',
    message: 'Older general comment.',
    createdAt: '2026-03-27T00:00:00.000Z',
    updatedAt: '2026-03-27T00:00:00.000Z'
  }];
  setStoredState(state);

  const ownerView = await getConfidentialById(ownerAuth, { id: created.object.id });
  assert.equal(ownerView.ok, true);
  assert.equal(ownerView.object.commentCount, 1);
  assert.equal(ownerView.object.comments[0].message, 'Older general comment.');
});

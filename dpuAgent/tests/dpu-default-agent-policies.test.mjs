import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const moduleSuffix = `?test=${Date.now()}`;
const {
  deriveSameRepoAgentPrincipal,
  defaultAgentPolicies,
  applyFreshDefaultAgentPolicies
} = await import(`../lib/dpu-store-internal/default-agent-policies.mjs${moduleSuffix}`);
const {
  loadPermissionsManifest,
  savePermissionsManifest,
  getPermissionsManifestPath
} = await import(`../lib/dpu-store-internal/storage.mjs${moduleSuffix}`);

function withEnv(env, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function freshDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dpu-policy-seed-'));
}

test('deriveSameRepoAgentPrincipal maps the DPU principal to a sibling agent', () => {
  assert.equal(
    deriveSameRepoAgentPrincipal('gitAgent', { PLOINKY_AGENT_ID: 'agent:AchillesIDE/dpuAgent' }),
    'agent:AchillesIDE/gitAgent'
  );
  assert.equal(deriveSameRepoAgentPrincipal('gitAgent', { PLOINKY_AGENT_ID: 'not-an-agent-id' }), '');
  assert.equal(deriveSameRepoAgentPrincipal('gitAgent', {}), '');
  assert.deepEqual(defaultAgentPolicies({}), {
    'agent:legacy-agents/searchAgent': {
      secrets: { allowedRoles: ['read'] },
      updatedAt: '1970-01-01T00:00:00.000Z'
    }
  });
});

test('fresh data root seeds the same-repo gitAgent read policy', async () => {
  const dataDir = freshDataDir();
  try {
    await withEnv({ DPU_DATA_ROOT: dataDir, PLOINKY_AGENT_ID: 'agent:AchillesIDE/dpuAgent' }, async () => {
      const manifest = await loadPermissionsManifest();
      assert.deepEqual(
        manifest.agentPolicies['agent:AchillesIDE/gitAgent']?.secrets?.allowedRoles,
        ['read']
      );
      assert.deepEqual(
        manifest.agentPolicies['agent:legacy-agents/searchAgent']?.secrets?.allowedRoles,
        ['read']
      );
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an existing manifest file receives missing default policies', async () => {
  const dataDir = freshDataDir();
  try {
    await withEnv({ DPU_DATA_ROOT: dataDir, PLOINKY_AGENT_ID: 'agent:AchillesIDE/dpuAgent' }, async () => {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(getPermissionsManifestPath(), JSON.stringify({
        schema: 'dpu-permissions-v2',
        version: 2,
        identities: { principals: {} },
        permissions: { secrets: {}, confidentialObjects: {}, resources: {} },
        agentPolicies: {}
      }), 'utf8');
      const manifest = await loadPermissionsManifest();
      assert.deepEqual(
        manifest.agentPolicies['agent:legacy-agents/searchAgent']?.secrets?.allowedRoles,
        ['read']
      );
      assert.deepEqual(
        manifest.agentPolicies['agent:AchillesIDE/gitAgent']?.secrets?.allowedRoles,
        ['read']
      );
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an admin-customized policy survives reloads untouched', async () => {
  const dataDir = freshDataDir();
  try {
    await withEnv({ DPU_DATA_ROOT: dataDir, PLOINKY_AGENT_ID: 'agent:AchillesIDE/dpuAgent' }, async () => {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(getPermissionsManifestPath(), JSON.stringify({
        schema: 'dpu-permissions-v2',
        version: 2,
        identities: { principals: {} },
        permissions: { secrets: {}, confidentialObjects: {}, resources: {} },
        agentPolicies: {
          'agent:AchillesIDE/gitAgent': { secrets: { allowedRoles: ['read', 'write'] }, updatedAt: '2026-01-01T00:00:00.000Z' }
        }
      }), 'utf8');
      const manifest = await loadPermissionsManifest();
      assert.deepEqual(
        manifest.agentPolicies['agent:AchillesIDE/gitAgent'].secrets.allowedRoles,
        ['read', 'write']
      );
      assert.deepEqual(
        manifest.agentPolicies['agent:legacy-agents/searchAgent'].secrets.allowedRoles,
        ['read']
      );
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the seed persists once the manifest is first saved', async () => {
  const dataDir = freshDataDir();
  try {
    await withEnv({ DPU_DATA_ROOT: dataDir, PLOINKY_AGENT_ID: 'agent:AchillesIDE/dpuAgent' }, async () => {
      const seeded = await loadPermissionsManifest();
      await savePermissionsManifest(seeded);
      const reloaded = await loadPermissionsManifest();
      assert.deepEqual(
        reloaded.agentPolicies['agent:AchillesIDE/gitAgent']?.secrets?.allowedRoles,
        ['read']
      );
      assert.deepEqual(
        reloaded.agentPolicies['agent:legacy-agents/searchAgent']?.secrets?.allowedRoles,
        ['read']
      );
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('applyFreshDefaultAgentPolicies never overwrites an existing entry in memory', () => {
  const manifest = {
    agentPolicies: {
      'agent:AchillesIDE/gitAgent': { secrets: { allowedRoles: [] }, updatedAt: '2026-01-01T00:00:00.000Z' },
      'agent:legacy-agents/searchAgent': { secrets: { allowedRoles: [] }, updatedAt: '2026-01-01T00:00:00.000Z' }
    }
  };
  applyFreshDefaultAgentPolicies(manifest, { PLOINKY_AGENT_ID: 'agent:AchillesIDE/dpuAgent' });
  assert.deepEqual(manifest.agentPolicies['agent:AchillesIDE/gitAgent'].secrets.allowedRoles, []);
  assert.deepEqual(manifest.agentPolicies['agent:legacy-agents/searchAgent'].secrets.allowedRoles, []);
});

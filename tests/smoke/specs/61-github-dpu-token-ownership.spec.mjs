import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { readAuthenticatedPrincipal } from '../lib/auth.mjs';
import { expectedGitTokenOwnership } from '../lib/github-token-owner.mjs';
import { dpuData } from '../lib/dpu-data.mjs';
import { assertExplorerDirectory, openExplorer } from '../lib/explorer.mjs';
import { callAgentToolViaRouter } from '../lib/mcp.mjs';

function findGitAgentPrincipal(permissions) {
  return Object.keys(permissions.agentPolicies || {}).find((principal) => /\/gitAgent$/.test(principal));
}

test.describe('GitHub token DPU ownership @external', () => {
  test.skip(!smokeConfig.flags.github, 'Set SMOKE_GITHUB=1 to run GitHub DPU token ownership checks.');

  test('fresh signed-out Explorer deep link survives login and mounts the exact directory', async ({ page }) => {
    const authCookieNames = new Set(['ploinky_jwt', 'ploinky_sso', 'ploinky_guest']);
    const initialAuthCookies = (await page.context().cookies(smokeConfig.baseURL))
      .filter((cookie) => authCookieNames.has(cookie.name));
    expect(initialAuthCookies).toEqual([]);

    const navigations = [];
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const location = new URL(frame.url());
      navigations.push({
        pathname: location.pathname,
        hash: location.hash,
        ...(location.pathname === '/auth/login' ? { returnTo: location.searchParams.get('returnTo') } : {}),
      });
    });

    await openExplorer(page, { hash: 'file-exp/Confidential/My%20Space' });
    await assertExplorerDirectory(page, '/Confidential/My Space');

    expect(navigations).toContainEqual({
      pathname: '/auth/login',
      hash: '',
      returnTo: '/explorer/index.html#file-exp/Confidential/My%20Space',
    });
    expect(navigations.at(-1)).toEqual({
      pathname: '/explorer/index.html',
      hash: '#file-exp/Confidential/My%20Space',
    });
  });

  test('manual token is stored user-owned, visible in Explorer, and removed on disconnect', async ({ page }) => {
    await openExplorer(page);
    const token = `ghp_smoke_${smokeConfig.runId.replace(/[^A-Za-z0-9]/g, '')}`;
    const principal = await readAuthenticatedPrincipal(page, smokeConfig.primaryUser);
    expect(principal.roles).toContain('admin');
    const { key, ownerId } = expectedGitTokenOwnership(principal);

    const result = await callAgentToolViaRouter(page, {
      agent: 'gitAgent',
      tool: 'git_auth_store_token',
      args: { token },
    });
    expect(result?.ok).toBe(true);
    expect(result?.tokenStored).toBe(true);

    const state = dpuData.readJson('state.json');
    const permissions = dpuData.readJson('permissions.manifest.json');
    expect(state.secrets?.[key]).toBeTruthy();
    expect(state.secrets[key].ownerId).toMatch(/^(user:|[^:\s@]+@)/);
    expect(state.secrets[key].ownerId).not.toMatch(/^agent:/);
    expect(state.secrets[key].ownerId, 'stored token belongs to the independently verified Router user').toBe(ownerId);

    const gitAgentPrincipal = findGitAgentPrincipal(permissions);
    expect(gitAgentPrincipal).toBeTruthy();
    expect(permissions.agentPolicies[gitAgentPrincipal]?.secrets?.allowedRoles).toEqual(['read']);
    expect(permissions.permissions?.secrets?.[key]?.acl?.[gitAgentPrincipal]).toBe('read');

    const encryptedValues = dpuData.readText('secrets.json');
    expect(encryptedValues.startsWith('DPUSECS1:')).toBe(true);
    expect(encryptedValues).not.toContain(token);

    await openExplorer(page, { hash: 'file-exp/Confidential/Secrets/' });
    await assertExplorerDirectory(page, '/Confidential/Secrets');
    await expect(page.locator('body')).toContainText(key);

    const disconnect = await callAgentToolViaRouter(page, {
      agent: 'gitAgent',
      tool: 'git_auth_disconnect',
      args: {},
    });
    expect(disconnect?.ok).toBe(true);
    const stateAfter = dpuData.readJson('state.json');
    const permissionsAfter = dpuData.readJson('permissions.manifest.json');
    expect(stateAfter.secrets?.[key]).toBeUndefined();
    expect(permissionsAfter.permissions?.secrets?.[key]).toBeUndefined();
  });

  test('a foreign agent-owned token record is denied without changing ownership or encrypted material', async ({ page }) => {
    await openExplorer(page);
    const principal = await readAuthenticatedPrincipal(page, smokeConfig.primaryUser);
    expect(principal.roles).toContain('admin');
    const { key, ownerId } = expectedGitTokenOwnership(principal);
    const stateBefore = dpuData.readJson('state.json');
    const permissionsBefore = dpuData.readJson('permissions.manifest.json');
    const gitAgentPrincipal = findGitAgentPrincipal(permissionsBefore);
    expect(gitAgentPrincipal).toBeTruthy();
    expect(gitAgentPrincipal).not.toBe(ownerId);
    const previousSecret = structuredClone(stateBefore.secrets?.[key]);
    const previousPermission = structuredClone(permissionsBefore.permissions?.secrets?.[key]);
    const encryptedBefore = dpuData.exists('secrets.json') ? dpuData.readBuffer('secrets.json') : null;
    const nowIso = new Date().toISOString();
    const foreignSecret = {
      id: `smoke-foreign-record-${smokeConfig.runId}`, key, displayName: key,
      ownerId: gitAgentPrincipal, acl: {}, createdAt: nowIso, updatedAt: nowIso,
    };
    const foreignPermission = { acl: { [gitAgentPrincipal]: 'read' }, updatedAt: nowIso };

    try {
      stateBefore.secrets = stateBefore.secrets || {};
      stateBefore.secrets[key] = foreignSecret;
      dpuData.writeJson('state.json', stateBefore);
      permissionsBefore.permissions = permissionsBefore.permissions || {};
      permissionsBefore.permissions.secrets = permissionsBefore.permissions.secrets || {};
      permissionsBefore.permissions.secrets[key] = foreignPermission;
      dpuData.writeJson('permissions.manifest.json', permissionsBefore);

      const token = `ghp_denied_${smokeConfig.runId.replace(/[^A-Za-z0-9]/g, '')}`;
      const result = await callAgentToolViaRouter(page, {
        agent: 'gitAgent', tool: 'git_auth_store_token', args: { token },
      });
      expect(result).toEqual({ ok: false, error: `Access denied: missing write on secret ${key}` });
      expect(dpuData.readJson('state.json').secrets?.[key]).toEqual(foreignSecret);
      expect(dpuData.readJson('permissions.manifest.json').permissions?.secrets?.[key]).toEqual(foreignPermission);
      expect(dpuData.exists('secrets.json')).toBe(encryptedBefore !== null);
      if (encryptedBefore !== null) {
        expect(dpuData.readBuffer('secrets.json').equals(encryptedBefore), 'denied store preserves the exact encrypted secret map').toBe(true);
      }
    } finally {
      // Restore only this fixture's key using the latest files, preserving
      // unrelated users, objects, secrets and permission changes from the run.
      const state = dpuData.readJson('state.json');
      state.secrets = state.secrets || {};
      if (previousSecret === undefined) delete state.secrets[key];
      else state.secrets[key] = previousSecret;
      dpuData.writeJson('state.json', state);
      const permissions = dpuData.readJson('permissions.manifest.json');
      permissions.permissions = permissions.permissions || {};
      permissions.permissions.secrets = permissions.permissions.secrets || {};
      if (previousPermission === undefined) delete permissions.permissions.secrets[key];
      else permissions.permissions.secrets[key] = previousPermission;
      dpuData.writeJson('permissions.manifest.json', permissions);
    }
  });
});

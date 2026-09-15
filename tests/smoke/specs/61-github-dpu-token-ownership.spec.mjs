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
      });
    });

    await openExplorer(page, { hash: 'file-exp/Confidential/My%20Space' });
    await assertExplorerDirectory(page, '/Confidential/My Space');

    expect(navigations).toContainEqual({
      pathname: '/auth/login',
      hash: '#file-exp/Confidential/My%20Space',
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

  test('a stale agent-owned record from the pre-delegation bug is self-repaired on store', async ({ page }) => {
    await openExplorer(page);
    const principal = await readAuthenticatedPrincipal(page, smokeConfig.primaryUser);
    expect(principal.roles).toContain('admin');
    const { key, ownerId } = expectedGitTokenOwnership(principal);
    const permissionsBefore = dpuData.readJson('permissions.manifest.json');
    const gitAgentPrincipal = findGitAgentPrincipal(permissionsBefore);
    expect(gitAgentPrincipal).toBeTruthy();

    const state = dpuData.readJson('state.json');
    const nowIso = new Date().toISOString();
    state.secrets = state.secrets || {};
    state.secrets[key] = {
      id: 'smoke-stale-record',
      key,
      displayName: key,
      ownerId: gitAgentPrincipal,
      acl: {},
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    dpuData.writeJson('state.json', state);
    permissionsBefore.permissions = permissionsBefore.permissions || { secrets: {}, objects: {} };
    permissionsBefore.permissions.secrets[key] = { acl: { [gitAgentPrincipal]: 'read' }, updatedAt: nowIso };
    dpuData.writeJson('permissions.manifest.json', permissionsBefore);

    const token = `ghp_upgrade_${smokeConfig.runId.replace(/[^A-Za-z0-9]/g, '')}`;
    const result = await callAgentToolViaRouter(page, {
      agent: 'gitAgent',
      tool: 'git_auth_store_token',
      args: { token },
    });
    expect(result?.ok).toBe(true);

    const stateAfter = dpuData.readJson('state.json');
    expect(stateAfter.secrets[key].ownerId).not.toBe(gitAgentPrincipal);
    expect(stateAfter.secrets[key].ownerId, 'repair restores the independently verified Router owner').toBe(ownerId);
    expect(stateAfter.secrets[key].ownerId).toMatch(/^(user:|[^:\s@]+@)/);
    const permissionsAfter = dpuData.readJson('permissions.manifest.json');
    expect(permissionsAfter.permissions?.secrets?.[key]?.acl?.[gitAgentPrincipal]).toBe('read');

    await callAgentToolViaRouter(page, { agent: 'gitAgent', tool: 'git_auth_disconnect', args: {} });
  });
});

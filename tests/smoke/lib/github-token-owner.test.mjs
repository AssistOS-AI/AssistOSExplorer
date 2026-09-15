import assert from 'node:assert/strict';
import test from 'node:test';

import { expectedGitTokenOwnership } from './github-token-owner.mjs';
import { authInfoFromInvocation } from '../../../shared/invocation-auth.mjs';
import { resolveActor } from '../../../dpuAgent/lib/dpu-store-internal/identity-acl.mjs';
import { extractIdentityHints, upsertPrincipalIdentity } from '../../../dpuAgent/lib/dpu-store-internal/permissions-manifest.mjs';

test('Git token key and DPU owner retain the independently authenticated opaque ID', () => {
  const owner = expectedGitTokenOwnership({
    id: 'USER.2', email: 'owner@example.test', canonicalId: 'user.2', canonicalUsername: 'display-name',
  });
  assert.deepEqual(owner, { key: 'GIT_GITHUB_TOKEN_675E750D6CB105C1', ownerId: 'user:USER.2' });
  assert.deepEqual(expectedGitTokenOwnership({ id: 'user.2', email: 'owner@example.test' }), {
    key: 'GIT_GITHUB_TOKEN_992A899A93045136', ownerId: 'user:user.2',
  }, 'opaque ID case changes the signed scope and owner');
  assert.deepEqual(expectedGitTokenOwnership({ id: 'member-17', email: 'member@example.test' }), {
    key: 'GIT_GITHUB_TOKEN_E1BAA2448D400C74', ownerId: 'user:member-17',
  }, 'a different authenticated account gets a different exact key and owner');
});

test('displayed profile email cannot change the actor established by direct browser MCP', () => {
  const expected = { key: 'GIT_GITHUB_TOKEN_A612DD545301D1A8', ownerId: 'user:USER.1' };
  for (const email of ['owner@example.test', 'changed@example.test', '', undefined]) {
    assert.deepEqual(expectedGitTokenOwnership({ id: 'USER.1', email }), expected);
  }
  assert.deepEqual(expectedGitTokenOwnership({ id: 'local:admin', email: '' }), {
    key: 'GIT_GITHUB_TOKEN_3A8C9AF657B616D3', ownerId: 'user:local:admin',
  });
});

test('direct and delegated verified grant projections resolve to one DPU owner through the user-ID alias', () => {
  const routerUser = { id: 'USER.1', username: 'profile-name', email: 'owner@example.test', roles: ['admin'] };
  // This is the verified direct-user grant shape built by mcp-proxy/index.js:
  // actor/sub, not profile usr. No browser session token reaches the agent.
  const direct = authInfoFromInvocation({ sub: 'user:USER.1', actor: { kind: 'user', id: 'user:USER.1', roles: ['admin'] } });
  assert.equal(direct.user.id, routerUser.id);
  assert.equal(direct.user.email, '');
  const manifest = {};
  const initial = resolveActor(direct, manifest);
  assert.equal(initial.principalId, 'user:USER.1');
  upsertPrincipalIdentity(manifest, initial.principalId, extractIdentityHints(direct));

  // UserDelegationGrantService retains the verified user's email in usr; this
  // unit checks identity projection and alias resolution, not JWT verification.
  const delegated = authInfoFromInvocation({ sub: 'agent:AchillesIDE/gitAgent',
    actor: { kind: 'agent', id: 'agent:AchillesIDE/gitAgent', roles: [] }, usr: routerUser });
  assert.equal(delegated.user.email, routerUser.email, 'the delegated grant really does carry the signed email');
  assert.equal(resolveActor(delegated, manifest).principalId, 'user:USER.1', 'the earlier direct-user identity remains authoritative');
  assert.equal(expectedGitTokenOwnership(routerUser).ownerId, initial.principalId);
  assert.notEqual(resolveActor({ user: { ...routerUser, id: 'USER.9' } }, manifest).principalId, initial.principalId,
    'an unrelated account cannot borrow the stored user-ID alias');
});

test('storage records, normalized IDs and configured email cannot substitute for the exact Router ID', () => {
  for (const principal of [undefined, {}, { canonicalId: 'user.2', email: 'owner@example.test' },
    { ownerId: 'user:USER.2', key: 'GIT_GITHUB_TOKEN_675E750D6CB105C1' },
    { loginEmail: 'configured@example.test' }, { id: '' }, { id: ' USER.2 ' }]) {
    assert.throws(() => expectedGitTokenOwnership(principal), /exact authenticated Router user ID/);
  }
});

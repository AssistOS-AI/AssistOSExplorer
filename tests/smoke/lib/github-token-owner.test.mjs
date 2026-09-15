import assert from 'node:assert/strict';
import test from 'node:test';

import { expectedGitTokenOwnership } from './github-token-owner.mjs';

test('Git token ownership uses the independently authenticated opaque ID and email', () => {
  const owner = expectedGitTokenOwnership({
    id: 'USER.2', email: 'owner@example.test', canonicalId: 'user.2', canonicalUsername: 'display-name',
  });
  assert.deepEqual(owner, {
    key: 'GIT_GITHUB_TOKEN_675E750D6CB105C1',
    ownerId: 'owner@example.test',
  });
  assert.equal(expectedGitTokenOwnership({ id: 'user.2', email: 'owner@example.test' }).key,
    'GIT_GITHUB_TOKEN_992A899A93045136', 'opaque ID case changes the signed Git scope');
  assert.equal(expectedGitTokenOwnership({ id: 'member-17', email: 'member@example.test' }).key,
    'GIT_GITHUB_TOKEN_E1BAA2448D400C74', 'a different authenticated account gets a different exact key');
});

test('accounts without a signed email retain the exact user principal owner', () => {
  assert.deepEqual(expectedGitTokenOwnership({ id: 'local:admin', email: '' }), {
    key: 'GIT_GITHUB_TOKEN_3A8C9AF657B616D3', ownerId: 'user:local:admin',
  });
  assert.equal(expectedGitTokenOwnership({ id: 'USER.2', email: '' }).ownerId, 'user:USER.2');
});

test('storage records, normalized IDs and configured email cannot substitute for the Router projection', () => {
  for (const principal of [undefined, {}, { canonicalId: 'user.2', email: 'owner@example.test' },
    { ownerId: 'owner@example.test', key: 'GIT_GITHUB_TOKEN_675E750D6CB105C1' },
    { id: '', email: '' }, { id: ' USER.2 ', email: '' }]) {
    assert.throws(() => expectedGitTokenOwnership(principal), /exact authenticated Router user ID/);
  }
  for (const principal of [{ id: 'USER.2', loginEmail: 'configured@example.test' },
    { id: 'USER.2', email: 'Malformed' }, { id: 'USER.2', email: ' Owner@example.test ' }]) {
    assert.throws(() => expectedGitTokenOwnership(principal), /authenticated Router email projection/);
  }
});

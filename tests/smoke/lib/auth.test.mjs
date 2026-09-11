import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDistinctAuthenticatedPrincipals,
  hasAuthenticatedSession,
  normalizePrincipalComponent,
  readEmailCode,
  totpToken,
  validateAuthenticatedPrincipal,
} from './auth.mjs';

test('authenticator codes follow RFC 6238 for a base32 secret', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpToken(secret, 59_000), '287082');
  assert.equal(totpToken(secret, 1_111_111_109_000), '081804');
  assert.equal(totpToken('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000), '287082');
  assert.throws(() => totpToken('not base32!'), /base32/);
  assert.throws(() => totpToken(''), /empty/);
});

test('email codes come only from the configured command and must be newer than the baseline', async () => {
  await assert.rejects(readEmailCode('member@example.test', { command: '' }), /BLOCKED: SMOKE_EMAIL_CODE_COMMAND/);
  const outputs = ['old 111111', 'old 111111', 'log 111111\nlog 222222'];
  const seen = [];
  const code = await readEmailCode('member@example.test', {
    command: 'print-code', after: '111111', intervalMs: 1, timeoutMs: 5_000,
    run: async (command, email) => { seen.push([command, email]); return outputs.shift() ?? ''; },
  });
  assert.equal(code, '222222');
  assert.deepEqual(seen[0], ['print-code', 'member@example.test']);
  await assert.rejects(readEmailCode('member@example.test', {
    command: 'print-code', after: '333333', intervalMs: 1, timeoutMs: 20, run: async () => 'still 333333',
  }), /No new UserPersisto email code/);
});

test('session detection uses the account-neutral auth endpoint', async () => {
  const requested = [];
  assert.equal(await hasAuthenticatedSession({
    async get(url, options) {
      requested.push({ url, options });
      return { ok: () => true };
    },
  }), true);
  assert.deepEqual(requested, [{
    url: '/auth/token',
    options: { headers: { connection: 'close' }, maxRetries: 0 },
  }]);

  assert.equal(await hasAuthenticatedSession({
    async get() {
      return { ok: () => false };
    },
  }), false);
  assert.equal(await hasAuthenticatedSession({
    async get() {
      throw new Error('offline');
    },
  }), false);
});

test('authenticated principals are normalized and matched to the configured account', () => {
  const principal = validateAuthenticatedPrincipal({
    id: ' LOCAL:User-One ',
    username: 'UsEr-One',
    roles: ['USER'],
  }, { expectedUsername: ' user-one ' });
  assert.deepEqual(principal, {
    canonicalId: 'local:user-one',
    canonicalUsername: 'user-one',
    roles: ['user'],
  });
  assert.equal(normalizePrincipalComponent('\uff21dmin'), 'admin');
});

test('email-only principals are matched by returned email without replacing a real username', () => {
  const principal = validateAuthenticatedPrincipal({
    id: 'USER.2', username: '', email: 'Member@Example.Test', roles: ['user'],
  }, { expectedUsername: 'member@example.test' });
  assert.equal(principal.canonicalUsername, 'member@example.test');
  assert.throws(() => validateAuthenticatedPrincipal({
    id: 'USER.2', username: '', email: 'member@example.test', roles: ['user'],
  }, { expectedUsername: 'other@example.test' }), /does not match/);
  assert.throws(() => validateAuthenticatedPrincipal({
    id: 'USER.2', username: 'actual-name', email: 'member@example.test', roles: ['user'],
  }, { expectedUsername: 'member@example.test' }), /does not match/);
});

test('UserPersisto login email proves the configured account without replacing its username', () => {
  const principal = validateAuthenticatedPrincipal({
    id: 'USER.2', username: 'persisted-profile', email: 'Member@Example.Test', roles: ['user'],
  }, {
    expectedUsername: 'configured-account-label',
    expectedEmail: ' member@example.test ',
  });
  assert.deepEqual(principal, {
    canonicalId: 'user.2',
    canonicalUsername: 'persisted-profile',
    roles: ['user'],
  });

  assert.throws(() => validateAuthenticatedPrincipal({
    id: 'USER.2', username: 'persisted-profile', email: 'member@example.test', roles: ['user'],
  }, {
    expectedUsername: 'configured-account-label',
    expectedEmail: 'other@example.test',
  }), /does not match/);
  assert.throws(() => validateAuthenticatedPrincipal({
    id: 'USER.2', username: 'member@example.test', email: 'actual@example.test', roles: ['user'],
  }, {
    expectedUsername: 'configured-account-label',
    expectedEmail: 'member@example.test',
  }), /does not match/, 'the configured login email must match the returned email field');
});

test('authenticated principal verification fails closed on missing, guest, or mismatched identity', () => {
  assert.throws(() => validateAuthenticatedPrincipal(null), /no user principal/);
  assert.throws(() => validateAuthenticatedPrincipal({ id: '', username: 'user', roles: ['user'] }), /principal id/);
  assert.throws(() => validateAuthenticatedPrincipal({ id: 'local:user', username: '', roles: ['user'] }), /principal username/);
  assert.throws(() => validateAuthenticatedPrincipal({ id: 'guest:one', username: 'guest', roles: ['guest'] }), /guest principal/);
  assert.throws(() => validateAuthenticatedPrincipal({ id: 'guest:one', username: 'visitor', roles: [] }), /guest principal/);
  assert.throws(() => validateAuthenticatedPrincipal({
    id: 'local:user', username: 'actual', roles: ['user'],
  }, { expectedUsername: 'configured' }), /does not match/);
});

test('distinct-account proof rejects case-folded aliases and the same immutable id', () => {
  const first = validateAuthenticatedPrincipal({ id: 'local:one', username: 'one', roles: ['user'] });
  const second = validateAuthenticatedPrincipal({ id: 'local:two', username: 'two', roles: ['user'] });
  assert.equal(assertDistinctAuthenticatedPrincipals(first, second).length, 2);

  assert.throws(() => assertDistinctAuthenticatedPrincipals(
    first,
    validateAuthenticatedPrincipal({ id: 'LOCAL:ONE', username: 'alias', roles: ['user'] }),
  ), /distinct authenticated principals/);
  assert.throws(() => assertDistinctAuthenticatedPrincipals(
    first,
    validateAuthenticatedPrincipal({ id: 'local:other', username: 'ONE', roles: ['user'] }),
  ), /distinct authenticated principals/);
});

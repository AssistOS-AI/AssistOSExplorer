import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDistinctAuthenticatedPrincipals,
  freshTotpToken,
  hasAuthenticatedSession,
  normalizePrincipalComponent,
  readAuthenticatedPrincipal,
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

test('each authenticator login waits for a new counter without worker-local history', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    let time = 59_800;
    const waits = [];
    const clock = {
        now: () => time,
        wait: async (durationMs) => {
            waits.push(durationMs);
            time += durationMs;
        },
    };
    const alreadyUsed = totpToken(secret, time);
    const first = await freshTotpToken(secret, clock);
    assert.deepEqual(waits, [450]);
    assert.equal(first, totpToken(secret, 60_250));
    assert.notEqual(first, alreadyUsed);
    const second = await freshTotpToken(secret, { ...clock });
    assert.deepEqual(waits, [450, 30_000]);
    assert.equal(second, totpToken(secret, 90_250));
    assert.notEqual(second, first);
});

test('a boundary-start login waits a full counter and an early timer cannot return an old code', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    let time = 60_000;
    const waits = [];
    const token = await freshTotpToken(secret, {
        now: () => time,
        wait: async (durationMs) => {
            waits.push(durationMs);
            time += durationMs - (waits.length === 1 ? 100 : 0);
        },
    });
    assert.deepEqual(waits, [30_250, 100]);
    assert.equal(token, totpToken(secret, 90_250));
});

test('authenticator pacing rejects invalid secrets and insufficient or elapsed timeout budgets', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const neverWait = async () => assert.fail('no timer should start');
    await assert.rejects(freshTotpToken('', { wait: neverWait }), /empty/);
    await assert.rejects(freshTotpToken('invalid!', { wait: neverWait }), /base32/);
    for (const timeoutMs of [0, -1, NaN, Infinity]) {
        await assert.rejects(freshTotpToken(secret, { timeoutMs, wait: neverWait }), /positive integer/);
    }
    await assert.rejects(freshTotpToken(secret, {
        now: () => 60_000, timeoutMs: 30_250, wait: neverWait,
    }), /Timed out waiting/);
    let time = 60_000;
    await assert.rejects(freshTotpToken(secret, {
        now: () => time,
        timeoutMs: 31_000,
        wait: async (durationMs) => { time += durationMs + 1_000; },
    }), /Timed out waiting/);
});

test('authenticator pacing honors cancellation before and during its timer', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const stopped = new AbortController();
    stopped.abort(new Error('test stopped'));
    await assert.rejects(freshTotpToken(secret, {
        signal: stopped.signal,
        wait: async () => assert.fail('canceled login must not wait'),
    }), /test stopped/);
    const controller = new AbortController();
    const pending = freshTotpToken(secret, { now: () => 60_000, signal: controller.signal });
    setImmediate(() => controller.abort());
    await assert.rejects(pending, { name: 'AbortError' });
    const afterWake = new AbortController();
    let time = 60_000;
    await assert.rejects(freshTotpToken(secret, {
        now: () => time,
        signal: afterWake.signal,
        wait: async (durationMs) => {
            time += durationMs;
            afterWake.abort(new Error('page closed'));
        },
    }), /page closed/);
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

test('verified Router identity exposes its exact signed id and normalized signed email', async () => {
    const page = {
        async evaluate() {
            return { ok: true, user: {
                id: 'USER.MixedCase-ID', username: 'Profile-Name',
                email: 'Member@Example.Test', roles: ['USER'],
            } };
        },
    };
    const principal = await readAuthenticatedPrincipal(page, {
        username: 'configured-label', loginEmail: 'member@example.test',
    });
    assert.deepEqual(principal, {
        canonicalId: 'user.mixedcase-id', canonicalUsername: 'profile-name', roles: ['user'],
        id: 'USER.MixedCase-ID', email: 'member@example.test',
    });
    assert.equal(Object.isFrozen(principal), true);
    await assert.rejects(readAuthenticatedPrincipal(page, {
        username: 'other-profile', loginEmail: 'other@example.test',
    }), /does not match/);
});

test('signed identity projection never substitutes configured email or accepts a guest', async () => {
    const page = {
        async evaluate() {
            return { ok: true, user: { id: 'USER.3', username: 'actual-profile', roles: ['user'] } };
        },
    };
    const principal = await readAuthenticatedPrincipal(page, {
        username: 'actual-profile', loginEmail: 'configured@example.test',
    });
    assert.equal(principal.email, '');
    assert.equal(principal.id, 'USER.3');
    await assert.rejects(readAuthenticatedPrincipal({
        async evaluate() {
            return { ok: true, user: { id: 'guest:USER.3', username: 'actual-profile', roles: ['guest'] } };
        },
    }, { username: 'actual-profile' }), /guest principal/);
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

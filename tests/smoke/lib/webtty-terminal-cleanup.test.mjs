import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupWebttyTerminals, requireDetachedShell } from './webtty-terminal-cleanup.mjs';

test('tab-close negative control rejects an exited tombstone with the same id', () => {
  const id = 'S'.repeat(32);
  const payload = (status, viewerCount = 0) => ({ ok: true, version: 1, sessions: [{ id, status, viewerCount }] });
  assert.equal(requireDetachedShell(payload('detached'), id).id, id);
  assert.throws(() => requireDetachedShell(payload('exited'), id), /must remain detached/);
  assert.throws(() => requireDetachedShell(payload('attached', 1), id), /must remain detached/);
  assert.throws(() => requireDetachedShell(payload('detached', 1), id), /no viewers/);
  assert.throws(() => requireDetachedShell({ ok: true, version: 1, sessions: [] }, id), /must remain detached/);
});

test('failure immediately after logout reauthenticates before DELETE and retains the context through cleanup', async () => {
  const order = [];
  const terminal = { cleaned: false };
  const page = { authenticated: false };
  await cleanupWebttyTerminals({
    terminals: [terminal],
    authenticate: async () => { order.push('login'); page.authenticated = true; return page; },
    closeTerminal: async (current, options) => {
      assert.equal(options.requestPage, page);
      assert.equal(options.allowMissing, true);
      assert.equal(page.authenticated, true);
      order.push('DELETE');
      current.cleaned = true;
    },
    closeContexts: async () => { order.push('close contexts'); page.authenticated = false; },
    removeFixture: async () => { order.push('remove fixture'); },
  });
  assert.deepEqual(order, ['login', 'DELETE', 'close contexts', 'remove fixture']);
});

test('cleanup refuses to remove the fixture after a DELETE 401 and preserves the original failure', async () => {
  const original = new Error('the live assertion failed');
  const denied = new Error('terminal DELETE returned 401');
  const terminals = [{ cleaned: false }, { cleaned: false }];
  let deletions = 0;
  let removed = false;
  let closed = false;
  await assert.rejects(cleanupWebttyTerminals({
    terminals,
    priorFailure: original,
    authenticate: async () => ({}),
    closeTerminal: async (terminal) => {
      deletions += 1;
      if (deletions === 1) throw denied;
      terminal.cleaned = true;
    },
    closeContexts: async () => { closed = true; },
    removeFixture: async () => { removed = true; },
  }), (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === denied);
  assert.equal(deletions, 2);
  assert.equal(closed, true);
  assert.equal(removed, false);
  assert.equal(terminals.some((terminal) => !terminal.cleaned), true);
});

test('failed fallback login retains the fixture and reports the cleanup failure', async () => {
  let removed = false;
  let deleted = false;
  await assert.rejects(cleanupWebttyTerminals({
    terminals: [{ cleaned: false }],
    authenticate: async () => { throw new Error('login unavailable'); },
    closeTerminal: async () => { deleted = true; },
    closeContexts: async () => {},
    removeFixture: async () => { removed = true; },
  }), (error) => error instanceof AggregateError && error.errors[0].message === 'login unavailable');
  assert.equal(deleted, false);
  assert.equal(removed, false);
});

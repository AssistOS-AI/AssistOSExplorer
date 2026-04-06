import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toAccountView, deriveAggregateStatus, buildAccountsPayload } from '../../management/account-view.mjs';

describe('management/account-view', () => {
  describe('toAccountView', () => {
    it('lifts email out of metadata to a top-level field', () => {
      const row = {
        id: 'acc-1',
        account_label: 'user@example.com',
        auth_type: 'oauth',
        status: 'active',
        external_account_id: 'ext-1',
        access_token_expires_at: new Date(Date.now() + 10 * 86400000).toISOString(),
        refresh_token_expires_at: null,
        quota_resets_at: null,
        metadata: {
          email: 'user@example.com',
          access_token: 'SECRET',
          refresh_token: 'SECRET_REFRESH',
        },
      };

      const view = toAccountView(row);

      assert.equal(view.email, 'user@example.com');
      assert.equal(view.id, 'acc-1');
      assert.equal(view.label, 'user@example.com');
      assert.equal(view.status, 'active');
      assert.equal(view.externalAccountId, 'ext-1');
    });

    it('falls back to metadata.login when email is absent (e.g. GitHub Copilot)', () => {
      const view = toAccountView({
        id: 'acc-2',
        status: 'active',
        metadata: { login: 'octocat' },
      });
      assert.equal(view.email, 'octocat');
    });

    it('strips secret-bearing keys from metadata in the view', () => {
      const view = toAccountView({
        id: 'acc-3',
        status: 'active',
        metadata: {
          email: 'e@x.test',
          access_token: 'at',
          refresh_token: 'rt',
          idToken: 'jwt',
          githubAccessToken: 'ghat',
          organizationName: 'Public Org',
        },
      });

      assert.equal(view.email, 'e@x.test');
      assert.equal(view.metadata.organizationName, 'Public Org');
      assert.equal(view.metadata.access_token, undefined);
      assert.equal(view.metadata.refresh_token, undefined);
      assert.equal(view.metadata.idToken, undefined);
      assert.equal(view.metadata.githubAccessToken, undefined);
    });

    it('derives quotaExhausted and needsReauth from DB status', () => {
      const exhausted = toAccountView({ id: '1', status: 'quota_exhausted', metadata: {} });
      assert.equal(exhausted.quotaExhausted, true);
      assert.equal(exhausted.needsReauth, false);

      const reauth = toAccountView({ id: '2', status: 'reauth_required', metadata: {} });
      assert.equal(reauth.quotaExhausted, false);
      assert.equal(reauth.needsReauth, true);

      const disabled = toAccountView({ id: '3', status: 'disabled', metadata: {} });
      assert.equal(disabled.needsReauth, true);

      const active = toAccountView({ id: '4', status: 'active', metadata: {} });
      assert.equal(active.quotaExhausted, false);
      assert.equal(active.needsReauth, false);
    });

    it('flags expiryWarning when token expires within 30 days and daysUntilExpiry is positive', () => {
      const soonMs = Date.now() + 5 * 86400000;
      const view = toAccountView({
        id: '1',
        status: 'active',
        access_token_expires_at: new Date(soonMs).toISOString(),
        metadata: { email: 'e@x.test', refresh_token: 'rt' },
      });
      assert.equal(view.expiryWarning, true);
      assert.equal(view.daysUntilExpiry, 5);
    });

    it('does not warn when the token is far from expiry', () => {
      const view = toAccountView({
        id: '1',
        status: 'active',
        access_token_expires_at: new Date(Date.now() + 60 * 86400000).toISOString(),
        metadata: { email: 'e@x.test', refresh_token: 'rt' },
      });
      assert.equal(view.expiryWarning, false);
    });

    it('flags noRefreshToken when expiry is set but no refresh token is stored', () => {
      const view = toAccountView({
        id: '1',
        status: 'active',
        access_token_expires_at: new Date(Date.now() + 10 * 86400000).toISOString(),
        metadata: { email: 'e@x.test' }, // no refresh_token
      });
      assert.equal(view.noRefreshToken, true);
    });

    it('does not flag noRefreshToken when no expiry is known (static keys)', () => {
      const view = toAccountView({
        id: '1',
        status: 'active',
        access_token_expires_at: null,
        metadata: { email: 'e@x.test' },
      });
      assert.equal(view.noRefreshToken, false);
    });

    it('returns null when given null', () => {
      assert.equal(toAccountView(null), null);
    });
  });

  describe('deriveAggregateStatus', () => {
    it('returns no_accounts when the list is empty', () => {
      const { status, activeIndex } = deriveAggregateStatus([]);
      assert.equal(status, 'no_accounts');
      assert.equal(activeIndex, null);
    });

    it('returns all_exhausted when every account is quota-exhausted', () => {
      const { status, activeIndex } = deriveAggregateStatus([
        { id: '1', quotaExhausted: true, needsReauth: false, expiryWarning: false },
        { id: '2', quotaExhausted: true, needsReauth: false, expiryWarning: false },
      ]);
      assert.equal(status, 'all_exhausted');
      assert.equal(activeIndex, null);
    });

    it('returns needs_reauth when no primary candidate exists but some account needs reauth', () => {
      const { status, activeIndex } = deriveAggregateStatus([
        { id: '1', quotaExhausted: true, needsReauth: false },
        { id: '2', quotaExhausted: false, needsReauth: true },
      ]);
      assert.equal(status, 'needs_reauth');
      assert.equal(activeIndex, null);
    });

    it('returns expiring when the primary account has an expiryWarning', () => {
      const { status, activeIndex } = deriveAggregateStatus([
        { id: '1', quotaExhausted: false, needsReauth: false, expiryWarning: true },
      ]);
      assert.equal(status, 'expiring');
      assert.equal(activeIndex, '1');
    });

    it('returns active and the first healthy account as activeIndex', () => {
      const { status, activeIndex } = deriveAggregateStatus([
        { id: 'a', quotaExhausted: true, needsReauth: false, expiryWarning: false },
        { id: 'b', quotaExhausted: false, needsReauth: false, expiryWarning: false },
        { id: 'c', quotaExhausted: false, needsReauth: false, expiryWarning: false },
      ]);
      assert.equal(status, 'active');
      assert.equal(activeIndex, 'b');
    });
  });

  describe('buildAccountsPayload', () => {
    it('returns both data and accounts keys for dashboard compatibility', () => {
      const payload = buildAccountsPayload([
        {
          id: 'acc-1',
          status: 'active',
          account_label: 'user@example.com',
          access_token_expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
          metadata: { email: 'user@example.com', refresh_token: 'rt' },
        },
      ]);

      assert.equal(payload.status, 'active');
      assert.equal(payload.activeIndex, 'acc-1');
      assert.equal(payload.accounts.length, 1);
      assert.equal(payload.data.length, 1);
      assert.equal(payload.accounts[0].email, 'user@example.com');
      assert.equal(payload.data[0].email, 'user@example.com');
    });

    it('handles empty input', () => {
      const payload = buildAccountsPayload([]);
      assert.equal(payload.status, 'no_accounts');
      assert.equal(payload.accounts.length, 0);
    });

    it('tolerates null input', () => {
      const payload = buildAccountsPayload(null);
      assert.equal(payload.status, 'no_accounts');
      assert.deepEqual(payload.accounts, []);
    });
  });
});

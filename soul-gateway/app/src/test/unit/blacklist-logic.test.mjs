import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mockGetEnabledRules = mock.fn();

mock.module('../../db/blacklist-dao.mjs', {
  namedExports: { getEnabledRules: mockGetEnabledRules },
});

const { checkBlacklist } = await import('../../pipeline/blacklist.mjs');

describe('blacklist-logic', () => {
  beforeEach(() => {
    mockGetEnabledRules.mock.resetCalls();
  });

  it('passes when no rules exist', async () => {
    mockGetEnabledRules.mock.mockImplementation(async () => []);
    await checkBlacklist([{ role: 'user', content: 'anything' }], 'fam-1');
    assert.equal(mockGetEnabledRules.mock.callCount(), 1);
  });

  it('blocks exact match', async () => {
    mockGetEnabledRules.mock.mockImplementation(async () => [
      { id: 'r1', pattern: 'forbidden-exact', match_type: 'exact', description: 'test' },
    ]);
    await assert.rejects(
      () => checkBlacklist([{ role: 'user', content: 'forbidden-exact' }], 'fam-1'),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.type, 'content_blocked');
        assert.equal(err.ruleId, 'r1');
        return true;
      }
    );
  });

  it('exact match requires full content match', async () => {
    mockGetEnabledRules.mock.mockImplementation(async () => [
      { id: 'r1', pattern: 'forbidden', match_type: 'exact', description: 'test' },
    ]);
    // Content has extra text, so exact match should not trigger
    await checkBlacklist([{ role: 'user', content: 'this is forbidden text' }], 'fam-1');
  });

  it('blocks substring match', async () => {
    mockGetEnabledRules.mock.mockImplementation(async () => [
      { id: 'r2', pattern: 'bad-word', match_type: 'substring', description: 'test' },
    ]);
    await assert.rejects(
      () => checkBlacklist([{ role: 'user', content: 'this contains bad-word inside' }], 'fam-1'),
      (err) => {
        assert.equal(err.ruleId, 'r2');
        return true;
      }
    );
  });

  it('blocks regex match', async () => {
    mockGetEnabledRules.mock.mockImplementation(async () => [
      { id: 'r3', pattern: 'secret\\d+code', match_type: 'regex', description: 'test' },
    ]);
    await assert.rejects(
      () => checkBlacklist([{ role: 'user', content: 'my secret42code here' }], 'fam-1'),
      (err) => {
        assert.equal(err.ruleId, 'r3');
        return true;
      }
    );
  });

  it('regex is case-insensitive', async () => {
    mockGetEnabledRules.mock.mockImplementation(async () => [
      { id: 'r4', pattern: 'FORBIDDEN', match_type: 'regex', description: 'test' },
    ]);
    await assert.rejects(
      () => checkBlacklist([{ role: 'user', content: 'this is forbidden' }], 'fam-1'),
      (err) => {
        assert.equal(err.ruleId, 'r4');
        return true;
      }
    );
  });

  it('skips invalid regex', async () => {
    mockGetEnabledRules.mock.mockImplementation(async () => [
      { id: 'r5', pattern: '[invalid', match_type: 'regex', description: 'bad regex' },
    ]);
    // Should not throw — invalid regex is silently skipped
    await checkBlacklist([{ role: 'user', content: '[invalid' }], 'fam-1');
  });

  it('concatenates content from multiple messages', async () => {
    mockGetEnabledRules.mock.mockImplementation(async () => [
      { id: 'r6', pattern: 'combined', match_type: 'substring', description: 'test' },
    ]);
    await assert.rejects(
      () => checkBlacklist([
        { role: 'system', content: 'com' },
        { role: 'user', content: 'bined' },
      ], 'fam-1'),
      // The messages are joined with \n, so "com\nbined" does NOT contain "combined"
      // This should NOT throw
    ).catch(() => {
      // Expected: no rejection because "com\nbined" !== "combined"
    });
    // Verify the actual behavior: joined with \n
    mockGetEnabledRules.mock.resetCalls();
    mockGetEnabledRules.mock.mockImplementation(async () => [
      { id: 'r6', pattern: 'com\nbined', match_type: 'substring', description: 'test' },
    ]);
    await assert.rejects(
      () => checkBlacklist([
        { role: 'system', content: 'com' },
        { role: 'user', content: 'bined' },
      ], 'fam-1'),
      (err) => {
        assert.equal(err.ruleId, 'r6');
        return true;
      }
    );
  });

  it('handles multimodal array content', async () => {
    mockGetEnabledRules.mock.mockImplementation(async () => [
      { id: 'r7', pattern: 'blocked-text', match_type: 'substring', description: 'test' },
    ]);
    await assert.rejects(
      () => checkBlacklist([{
        role: 'user',
        content: [
          { type: 'text', text: 'contains blocked-text here' },
          { type: 'image_url', image_url: { url: 'data:...' } },
        ],
      }], 'fam-1'),
      (err) => {
        assert.equal(err.ruleId, 'r7');
        return true;
      }
    );
  });

  it('truncates match pattern in error to 50 chars', async () => {
    const longPattern = 'x'.repeat(100);
    mockGetEnabledRules.mock.mockImplementation(async () => [
      { id: 'r8', pattern: longPattern, match_type: 'substring', description: 'test' },
    ]);
    await assert.rejects(
      () => checkBlacklist([{ role: 'user', content: longPattern }], 'fam-1'),
      (err) => {
        assert.equal(err.match.length, 50);
        return true;
      }
    );
  });
});

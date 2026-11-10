import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { gitAgentTarget, matchesProfileDiscovery, safePrimaryFailure } from './terminal-agent-chooser.mjs';

test('target locator uses the row-relative detail and ignores outside and similar rows', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<span class="terminal-target-detail">AchillesIDE/gitAgent</span>
      <div role="dialog"><button class="terminal-target-button"><span class="terminal-target-detail">AchillesIDE/gitAgent</span></button>
      <button class="terminal-target-button"><span class="terminal-target-detail">AchillesIDE/gitAgent-extra</span></button></div>`);
    const chooser = page.getByRole('dialog');
    const old = chooser.locator('.terminal-target-button').filter({ has: chooser.locator('.terminal-target-detail', { hasText: 'AchillesIDE/gitAgent' }) });
    assert.equal(await old.count(), 0);
    assert.equal(await gitAgentTarget(page, chooser).count(), 1);
  } finally { await browser.close(); }
});

test('profile matching rejects plain and unrelated discoveries while retaining error responses', () => {
  const response = (profile, status = 201) => ({ url: () => 'http://localhost/webtty/target-discoveries', status: () => status,
    request: () => ({ method: () => 'POST', postDataJSON: () => ({ profile }) }) });
  const profile = { provider: 'roboWorkAgent', id: 'robot-1.default', mode: 'live-agent' };
  assert.equal(matchesProfileDiscovery(response(undefined), profile.id), false);
  assert.equal(matchesProfileDiscovery(response({ ...profile, id: 'other.default' }), profile.id), false);
  assert.equal(matchesProfileDiscovery(response(profile, 503), profile.id), true);
});

test('failure evidence removes credentials and opaque handles', () => {
  const value = 'longopaquehandletoken123456789012345';
  const safe = safePrimaryFailure(new Error(`failed ${value}`), 'chooser');
  assert.equal(safe.phase, 'chooser');
  assert.equal(safe.message.includes(value), false);
});

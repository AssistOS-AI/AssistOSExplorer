import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.EMAILAGENT_SETTINGS_KEY = 'unit-test-key';
process.env.EMAILAGENT_SETTINGS_FILE = join(mkdtempSync(join(tmpdir(), 'emailagent-')), 'settings.enc.json');

const { saveSettings, getSettings, getSecret, maskSecret } = await import('../lib/settings.mjs');

test('secrets round-trip encrypted, masked on read, empty keeps, remove deletes', async () => {
    await saveSettings({ MAILJET_API_KEY: 'mj_1234567890abcdef', MAILJET_FROM_EMAIL: 'noreply@x.com' });

    const view = await getSettings();
    assert.equal(view.MAILJET_FROM_EMAIL, 'noreply@x.com');
    assert.equal(view.MAILJET_API_KEY, maskSecret('mj_1234567890abcdef'));
    assert.notEqual(view.MAILJET_API_KEY, 'mj_1234567890abcdef');

    assert.equal(await getSecret('MAILJET_API_KEY'), 'mj_1234567890abcdef');

    await saveSettings({ MAILJET_API_KEY: '' }); // empty = keep
    assert.equal(await getSecret('MAILJET_API_KEY'), 'mj_1234567890abcdef');

    await saveSettings({ remove: ['MAILJET_API_KEY'] });
    assert.equal(await getSecret('MAILJET_API_KEY'), '');
});

test('maskSecret keeps prefix and suffix only', () => {
    const masked = maskSecret('sk_live_abc12345678xyz9');
    assert.ok(masked.startsWith('sk_liv'));
    assert.ok(masked.endsWith('xyz9'));
    assert.ok(masked.includes('*'));
    assert.equal(maskSecret('short'), '*****');
});

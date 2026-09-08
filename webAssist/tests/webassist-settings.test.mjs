import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_JS = path.resolve(TESTS_DIR, '..', 'IDE-plugins', 'web-assist-chat', 'webassist-settings', 'webassist-settings.js');
const SETTINGS_HTML = path.resolve(TESTS_DIR, '..', 'IDE-plugins', 'web-assist-chat', 'webassist-settings', 'webassist-settings.html');

test('webassist settings build embed URL with siteId and no manual fallback', async () => {
    const source = await fs.readFile(SETTINGS_JS, 'utf8');
    assert.match(source, /siteId: this\.state\.siteId/);
    assert.match(source, /callTool\('list-sites'/);
    assert.match(source, /toolResult\?\.isError === true/);
    assert.match(source, /agent=roboTeamAgent&robot=default&workspace-dir=\.data\/webAssist\/data&forward-envelope=1/);
});

test('webassist settings markup includes site selector instead of manual siteId input', async () => {
    const source = await fs.readFile(SETTINGS_HTML, 'utf8');
    assert.match(source, /id="webassistSiteId"/);
    assert.ok(!source.includes('id="siteId"'));
    assert.match(source, /Site ID/);
});

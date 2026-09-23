import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const pluginRoot = path.join(repoRoot, 'IDE-plugins/webmeet-tool-button');

async function collectFiles(dir, extensions) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectFiles(fullPath, extensions));
        } else if (extensions.includes(path.extname(entry.name))) {
            files.push(fullPath);
        }
    }
    return files;
}

test('guest-facing WebMeet assets use shared public paths', async () => {
    const extensions = ['.html', '.css', '.js', '.mjs'];
    const files = await collectFiles(pluginRoot, extensions);
    const offenders = [];
    for (const file of files) {
        const text = await fs.readFile(file, 'utf8');
        if (text.includes('/explorer/assets/')) {
            offenders.push(path.relative(repoRoot, file));
        }
    }
    // Unauthenticated guests can only load /explorer/shared/* and
    // /explorer/web-components/components/*; /explorer/assets/* is denied.
    assert.deepEqual(offenders, []);
});

test('the shared fullscreen icon exists for guest room settings and blackboard', async () => {
    const sharedIcon = path.join(repoRoot, '../explorer/shared/assets/icons/fullscreen.svg');
    await assert.doesNotReject(fs.access(sharedIcon));

    const settingsHtml = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.html'),
        'utf8'
    );
    const blackboardRendering = await fs.readFile(
        path.join(
            pluginRoot,
            'components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-collaboration-rendering.js'
        ),
        'utf8'
    );
    assert.match(settingsHtml, /\/explorer\/shared\/assets\/icons\/fullscreen\.svg/);
    assert.match(blackboardRendering, /\/explorer\/shared\/assets\/icons\/fullscreen\.svg/);
});

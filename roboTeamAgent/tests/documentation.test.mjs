import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(TEST_DIR, '..');

async function read(relativePath) {
    return readFile(join(AGENT_ROOT, relativePath), 'utf8');
}

test('documentation records first-use current-version tool caching', async () => {
    const sources = [
        await read('README.md'),
        await read('docs/images.html'),
        await read('docs/specs/DS004-robot-container-runtime.md'),
    ];

    for (const source of sources) {
        const plainText = source.replaceAll(/<[^>]+>|`/g, '');
        assert.match(plainText, /current/u);
        assert.match(plainText, /cache/u);
        assert.doesNotMatch(plainText, /(?:computer-use-linux 0\.5\.0|Playwright MCP 0\.0\.79|Supergateway 3\.4\.3|Codex 0\.152\.1)/u);
    }
});

test('documentation explains executable placement and robot creation', async () => {
    const readme = await read('README.md');
    const images = await read('docs/images.html');

    assert.match(readme, /Creating a robot creates metadata and persistent directories only/);
    assert.match(readme, /Codex package and mounts that cached generation/);
    assert.match(readme, /instead of being baked into the images or declared in RoboTeam's `package\.json`/);
    assert.match(images, /Codex is not baked in/);
    assert.match(images, /does not copy an image or install an executable/);
    assert.match(images, /manual desktop mounts the active Codex generation/);
    assert.match(images, /last (?:valid|stamped) generation/i);
});

test('documentation exposes the image guide from shared navigation', async () => {
    const header = await read('docs/partials/header.html');

    assert.match(header, /href="images\.html"[^>]*>Images &amp; Dependencies</);
});

test('documentation explains the nested ALA sandbox fallback and its retained boundaries', async () => {
    const sources = [
        await read('README.md'),
        await read('docs/security.html'),
        await read('docs/specs/DS005-ploinky-security.md'),
        await read('docs/specs/DS006-ala-task-boundary.md'),
    ];

    for (const source of sources) {
        const plainText = source.replaceAll(/<[^>]+>|`/g, '');
        assert.match(plainText, /private proc(?:fs| path)/iu);
        assert.match(plainText, /capabilit/iu);
        assert.match(plainText, /drop(?:s|ped)? all capabilities|cap-drop ALL/iu);
    }
    assert.match(sources.join('\n'), /unsandboxed fallback (?:is )?forbidden|not an unsandboxed fallback/iu);
});

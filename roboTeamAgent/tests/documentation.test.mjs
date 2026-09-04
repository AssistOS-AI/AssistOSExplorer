import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
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

test('overview begins with product vision and no separate vision page remains', async () => {
    const overview = await read('docs/index.html');
    const header = await read('docs/partials/header.html');
    const firstSection = overview.match(/<h2>([^<]+)<\/h2>/u)?.[1];

    assert.equal(firstSection, 'Product vision');
    assert.doesNotMatch(header, /vision\.html/u);
    await assert.rejects(access(join(AGENT_ROOT, 'docs/vision.html')), { code: 'ENOENT' });
});

test('operations documents every MCP tool in a two-column table', async () => {
    const operations = await read('docs/operations.html');
    const config = JSON.parse(await read('mcp-config.json'));
    const toolTable = operations.match(/<h2>MCP tools<\/h2>\s*<table>([\s\S]*?)<\/table>/u)?.[1] || '';

    assert.match(toolTable, /<th>Tool<\/th><th>What it does<\/th>/u);
    assert.equal((toolTable.match(/<th>/gu) || []).length, 2);
    for (const tool of config.tools) assert.match(toolTable, new RegExp(`<code>${tool.name}<\\/code>`, 'u'));
});

test('documentation introduces ALA execution and AchillesCLI integration', async () => {
    const overview = await read('docs/index.html');
    const operations = await read('docs/operations.html');
    const combined = `${overview}\n${operations}`;

    for (const backend of ['Codex', 'OpenCode', 'Pi']) assert.match(combined, new RegExp(backend, 'u'));
    for (const option of ['--home', '--cwd', '--taskFile', '--ca', '--MCPServers', '--skillSets', '--model']) {
        assert.match(operations, new RegExp(option, 'u'));
    }
    assert.match(combined, /list-robots/u);
    assert.match(combined, /launch-robot/u);
    assert.match(combined, /Ploinky Router/u);
});

test('documentation explains native async progress and the per-robot FIFO queue', async () => {
    const sources = [
        await read('README.md'),
        await read('docs/index.html'),
        await read('docs/operations.html'),
        await read('docs/specs/DS003-main-behavior.md'),
        await read('docs/specs/DS006-ala-task-boundary.md'),
    ];
    const combined = sources.join('\n').replaceAll(/<[^>]+>|`/g, '');
    assert.match(combined, /native asynchronous Ploinky/iu);
    assert.match(combined, /FIFO queue/iu);
    assert.match(combined, /one ALA process/iu);
    assert.match(combined, /intermediate ALA messages|coding-agent-message/iu);
    assert.match(combined, /standard error/iu);
    assert.match(combined, /standard output/iu);
});

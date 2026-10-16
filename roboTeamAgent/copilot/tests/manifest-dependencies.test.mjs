import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, '..', '..');

test('AchillesCLI starts Soul Gateway asynchronously before model discovery', async () => {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'manifest.json'), 'utf8'));

    assert.ok(Array.isArray(manifest.enable));
    assert.ok(manifest.enable.includes('proxies/soul-gateway no-wait'));
});

test('RoboTeam owns the CLI without recursively enabling itself', async () => {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'manifest.json'), 'utf8'));

    assert.ok(Array.isArray(manifest.enable));
    assert.ok(!manifest.enable.includes('roboTeamAgent no-wait'));
    assert.equal(manifest.cli, 'node /code/server/robot-cli.mjs');
});

test('AchillesCLI opts into structured WebChat envelopes', async () => {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'manifest.json'), 'utf8'));

    assert.equal(manifest.webchat?.forwardEnvelope, true);
});

test('AchillesCLI manifest does not redeclare generated-local protected overrides', async () => {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'manifest.json'), 'utf8'));
    const source = JSON.stringify(manifest);

    assert.doesNotMatch(source, /SOUL_GATEWAY_(?:API_KEY|BASE_URL)|PLOINKY_ROUTER_(?:URL|HOST|PORT)/);
});

test('AchillesCLI leaves optional coding and research agents for explicit startup', async () => {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'manifest.json'), 'utf8'));

    assert.ok(Array.isArray(manifest.enable));
    for (const agentName of ['GPTResearcher', 'searchAgent', 'opencodeAgent', 'piAgent', 'codexAgent']) {
        assert.ok(!manifest.enable.some((entry) => String(entry).includes(agentName)));
    }
});

test('AchillesCLI optional workers declare manual workspace startup', async () => {
    for (const agentName of ['GPTResearcher']) {
        const manifest = JSON.parse(await readFile(join(REPO_ROOT, '..', agentName, 'manifest.json'), 'utf8'));
        assert.equal(manifest.startup, 'manual', `${agentName} should start only through explicit invocation`);
    }
});

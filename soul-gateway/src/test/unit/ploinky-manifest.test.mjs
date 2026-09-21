import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const LEGACY_ENV_PREFIXES = [
    ['SOUL', 'GATEWAY', 'PROVIDER'].join('_') + '_',
    ['LOCAL', 'LLM'].join('_') + '_',
];

function readManifest() {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
}

function readPluginConfig(pluginDir) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, 'IDE-plugins', pluginDir, 'config.json'), 'utf8'));
}

test('Ploinky uses only the Router agent-port convention', () => {
    const manifest = readManifest();
    assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'httpServices'), false);
});

test('Ploinky route policy matches the gateway contract', () => {
    const manifest = readManifest();
    const routes = new Map((manifest.routerAccess?.httpRoutes || []).map((route) => [route.path, route]));

    assert.equal(routes.get('/base-agent-additional-server/soul-gateway/7000/v1/*')?.access, 'guest');
    assert.equal(routes.get('/base-agent-additional-server/soul-gateway/7000/management/*')?.access, 'authenticated');
    assert.equal(routes.get('/base-agent-additional-server/soul-gateway/7000/healthz/*')?.access, 'public');
});

test('Manifest does not declare runtime-injected agent identity keys', () => {
    const manifest = readManifest();
    const env = manifest.profiles?.default?.env || {};

    // Inbound /v1/* auth is signed-subject; identity keys are injected by the
    // Ploinky runtime and must not be declared by the manifest.
    assert.equal(env.PLOINKY_AGENT_API_KEY, undefined, 'PLOINKY_AGENT_API_KEY must not be declared as a workspace env key');
    assert.equal(env.PLOINKY_AGENT_API_PUBLIC_KEY, undefined, 'PLOINKY_AGENT_API_PUBLIC_KEY must not be declared as a workspace env key');

    for (const [name, spec] of Object.entries(env)) {
        if (spec && typeof spec === 'object') {
            assert.notEqual(spec.sharedGeneratedSecret, true, name + ' must not be a sharedGeneratedSecret for runtime-injected identity');
            assert.notEqual(spec.varName, 'PLOINKY_AGENT_API_KEY', name + ' must not alias the injected API key name via varName');
            assert.notEqual(spec.varName, 'PLOINKY_AGENT_API_PUBLIC_KEY', name + ' must not alias the injected public key name via varName');
        }
    }

    assert.equal(env.LLM_DEFAULT_AGENT, undefined, 'the retired default-agent override is not configurable');
    assert.equal(
        env.LLM_DEFAULT_TIERS?.default,
        'fast,code,plan,write,deep,ultra,web-assist'
    );
    assert.equal(env.FREE_MODELS_ENABLED?.default, 'true');
    assert.equal(env.OPENROUTER_API_KEY?.default, '');
    assert.equal(env.PRICING_DIRECTORY_TIMEOUT_MS?.default, '5000');

    for (const name of Object.keys(env)) {
        assert.ok(
            !LEGACY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
            name + ' must not be declared after hub-only provider bootstrap'
        );
    }
});

test('Ploinky manifest uses mounted source instead of baked app source', () => {
    const manifest = readManifest();
    const env = manifest.profiles?.default?.env || {};

    assert.equal(
        manifest.container,
        'docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669',
        'Soul Gateway should use the shared Ploinky Node runtime image, not an app-source image'
    );
    assert.equal(manifest.agent, 'bash /code/startup.sh');
    assert.equal(manifest.cli, 'bash /code/cli.sh');
    assert.equal(manifest.profiles?.default?.install, 'bash /code/install.sh');
    assert.equal(manifest.readiness?.protocol, 'tcp');

    assert.equal(env.SOUL_GATEWAY_USE_LIVE_SOURCE, undefined);
    assert.equal(env.SOUL_GATEWAY_IMAGE_APP_DIR, undefined);
});

test('Ploinky manifest supplies the complete managed persistence contract', () => {
    const manifest = readManifest();
    const env = manifest.profiles?.default?.env || {};

    assert.deepEqual(manifest.volumes, {
        '.data/soul-gateway': '/data',
    });
    assert.equal(env.DATA_DIR?.default, '/data');
    assert.equal(env.CREDENTIALS_DIR?.default, '/data/credentials');
    assert.equal(env.SQLITE_PATH?.default, '/data/soul-gateway.sqlite3');
});

test('Soul Gateway ships an admin-only settings entry and toolbar button', () => {
    const manifest = readManifest();
    const settings = readPluginConfig('soul-gateway-settings');
    const toolbar = readPluginConfig('soul-gateway-tool-button');

    const settingsEntry = (manifest.ideSettings || []).find((entry) => entry.key === 'soul-gateway');
    assert.ok(settingsEntry);
    assert.equal(settingsEntry.pluginKey, 'soul-gateway/soul-gateway');
    assert.equal(settingsEntry.adminOnly, true);
    assert.equal(settingsEntry.settingsUrl, '/base-agent-additional-server/soul-gateway/7000/management/');

    assert.equal(settings.id, 'soul-gateway');
    assert.equal(settings.adminOnly, true);
    assert.equal(settings.settingsUrl, settingsEntry.settingsUrl);

    assert.equal(toolbar.pluginCategory, 'application');
    assert.equal(toolbar.id, 'soul-gateway-configure');
    assert.notEqual(toolbar.id, settings.id);
    assert.equal(toolbar.type, 'embedded');
    assert.equal(toolbar.adminOnly, true);
    assert.deepEqual(toolbar.location, ['file-exp:toolbar']);
    assert.equal(toolbar.locationOrder, 290);
    assert.equal(toolbar.component, 'soul-gateway-tool-button');
    assert.equal(toolbar.presenter, 'SoulGatewayToolButton');

    const presenterSource = fs.readFileSync(
        path.join(repoRoot, 'IDE-plugins', 'soul-gateway-tool-button', 'soul-gateway-tool-button.js'),
        'utf8'
    );
    assert.match(presenterSource, /launchAgentSettings/);
    assert.match(presenterSource, /getCachedRuntimePlugins/);
});

test('Manifest no longer enables or defaults to the retired local model runtime', () => {
    const manifest = readManifest();
    const serialized = JSON.stringify(manifest);
    const enabled = Array.isArray(manifest.enable) ? manifest.enable : [];
    assert.equal(
        enabled.some((entry) => /default-local-llm/.test(String(entry))),
        false,
        'Soul Gateway must not enable default-local-llm'
    );
    assert.doesNotMatch(serialized, /default-local-llm/);
    assert.doesNotMatch(serialized, /sk-or-v1-/, 'no credential material in the manifest');
});

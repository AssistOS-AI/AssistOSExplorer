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

    assert.equal(env.LLM_DEFAULT_AGENT?.default, 'default-local-llm');
    assert.equal(env.LLM_DEFAULT_TIERS?.default, 'fast,plan,deep');

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

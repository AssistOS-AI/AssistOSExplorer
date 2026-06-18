import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const VALID_SERVICE_ACCESS = new Set(['public', 'guest', 'authenticated']);
const REMOVED_SERVICE_FIELDS = ['auth', 'mode', 'forceGuest'];
const LEGACY_ENV_PREFIXES = [
    ['SOUL', 'GATEWAY', 'PROVIDER'].join('_') + '_',
    ['LOCAL', 'LLM'].join('_') + '_',
];

function readManifest() {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
}

function assertModernHttpService(service, label) {
    assert.ok(VALID_SERVICE_ACCESS.has(service.access), `${label} must declare access: public | guest | authenticated`);

    for (const field of REMOVED_SERVICE_FIELDS) {
        assert.equal(service[field], undefined, `${label} must not declare removed ${field} field`);
    }
}

test('Ploinky HTTP services use the access schema', () => {
    const manifest = readManifest();
    const services = manifest.httpServices || [];
    assert.equal(services.length, 3);

    for (const service of services) {
        assertModernHttpService(service, service.externalPrefix || 'http service');
    }
});

test('Ploinky service exposure matches the gateway contract', () => {
    const manifest = readManifest();
    const services = new Map((manifest.httpServices || []).map((service) => [service.externalPrefix, service]));

    assert.equal(services.get('/services/soul-gateway/v1/')?.access, 'guest');
    assert.equal(services.get('/services/soul-gateway/management/')?.access, 'authenticated');
    assert.equal(services.get('/public-services/soul-gateway-health/')?.access, 'public');
});

test('Manifest does not declare a workspace SOUL_GATEWAY_API_KEY secret', () => {
    const manifest = readManifest();
    const env = manifest.profiles?.default?.env || {};

    // Inbound /v1/* auth is signed-subject; the gateway must not require a
    // local workspace-generated SOUL_GATEWAY_API_KEY.
    assert.equal(env.SOUL_GATEWAY_API_KEY, undefined, 'SOUL_GATEWAY_API_KEY must not be declared as a workspace env key');

    for (const [name, spec] of Object.entries(env)) {
        if (spec && typeof spec === 'object') {
            assert.notEqual(spec.sharedGeneratedSecret, true, name + ' must not be a sharedGeneratedSecret named SOUL_GATEWAY_API_KEY');
            assert.notEqual(spec.varName, 'SOUL_GATEWAY_API_KEY', name + ' must not alias the SOUL_GATEWAY_API_KEY name via varName');
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
        'docker.io/assistos/ploinky-node:24-bookworm-tools',
        'Soul Gateway should use the shared Ploinky Node runtime image, not an app-source image'
    );
    assert.equal(manifest.agent, 'bash /code/startup.sh');
    assert.equal(manifest.cli, 'bash /code/cli.sh');
    assert.equal(manifest.profiles?.default?.install, 'bash /code/install.sh');
    assert.equal(manifest.readiness?.protocol, 'tcp');

    assert.equal(env.SOUL_GATEWAY_USE_LIVE_SOURCE, undefined);
    assert.equal(env.SOUL_GATEWAY_IMAGE_APP_DIR, undefined);
});

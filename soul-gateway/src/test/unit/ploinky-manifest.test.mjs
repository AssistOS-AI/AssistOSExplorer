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

    assert.equal(services.get('/services/soul-gateway/v1/')?.access, 'public');
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

    // A remote upstream provider key, if present, uses its own env name.
    const provider = env.SOUL_GATEWAY_PROVIDER_API_KEY;
    if (provider && typeof provider === 'object') {
        assert.equal(provider.varName, undefined, 'SOUL_GATEWAY_PROVIDER_API_KEY must source from its own env name');
        assert.notEqual(provider.sharedGeneratedSecret, true, 'SOUL_GATEWAY_PROVIDER_API_KEY must not be a workspace shared secret');
    }
});

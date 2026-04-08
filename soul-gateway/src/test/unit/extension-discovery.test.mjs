import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ExtensionLoader } from '../../runtime/plugins/extension-loader.mjs';
import {
    EXTENSION_SCOPES,
    EXTENSION_TYPES,
} from '../../runtime/plugins/extension-constants.mjs';
import { TRANSPORT_TYPES } from '../../runtime/transports/transport-constants.mjs';

// ── Helpers ──────────────────────────────────────────────────────────

const noopLog = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
};

/**
 * Write a minimal extension module into the given directory.
 */
async function writeExtension(dir, filename, manifest, options = {}) {
    await mkdir(dir, { recursive: true });
    const parts = [`export const manifest = ${JSON.stringify(manifest)};`];
    if (options.factory)
        parts.push(
            'export const meta = manifest; export function factory() { return async (ctx, next) => { await next(); }; }'
        );
    if (options.execute)
        parts.push('export async function execute(ctx) { return {}; }');
    await writeFile(join(dir, filename), parts.join('\n') + '\n');
}

// ═══════════════════════════════════════════════════════════════════════
// Canonical Path Discovery
// ═══════════════════════════════════════════════════════════════════════

describe('ExtensionLoader — canonical paths', () => {
    let tmpDir;
    let loader;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'soul-ext-canonical-'));
        loader = new ExtensionLoader(tmpDir, noopLog);
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('discovers gateway middleware files and tags scope=gateway, type=middleware', async () => {
        await writeExtension(
            join(tmpDir, 'middlewares'),
            'my-filter.middleware.mjs',
            { key: 'my-filter' },
            { factory: true }
        );

        const catalog = await loader.scan();

        assert.equal(catalog.middlewares.length, 1);
        const entry = catalog.middlewares[0];
        assert.equal(entry.manifest.key, 'my-filter');
        assert.equal(entry.scope, EXTENSION_SCOPES.GATEWAY);
        assert.equal(entry.type, EXTENSION_TYPES.MIDDLEWARE);
        assert.ok(entry.checksum);
        assert.ok(entry.filePath.endsWith('.middleware.mjs'));
    });

    it('discovers provider middleware files and tags scope=provider, type=middleware', async () => {
        await writeExtension(
            join(tmpDir, 'provider-middlewares'),
            'prompt-shaper.middleware.mjs',
            { key: 'prompt-shaper' },
            { factory: true }
        );

        const catalog = await loader.scan();

        assert.equal(catalog.providerMiddlewares.length, 1);
        const entry = catalog.providerMiddlewares[0];
        assert.equal(entry.manifest.key, 'prompt-shaper');
        assert.equal(entry.scope, EXTENSION_SCOPES.PROVIDER);
        assert.equal(entry.type, EXTENSION_TYPES.MIDDLEWARE);
    });

    it('discovers transport files and tags type=transport', async () => {
        await writeExtension(
            join(tmpDir, 'transports'),
            'custom-backend.transport.mjs',
            { key: 'custom-backend' },
            { execute: true }
        );

        const catalog = await loader.scan();

        assert.equal(catalog.transports.length, 1);
        const entry = catalog.transports[0];
        assert.equal(entry.manifest.key, 'custom-backend');
        assert.equal(entry.scope, null);
        assert.equal(entry.type, EXTENSION_TYPES.TRANSPORT);
    });

    it('skips files that do not match the suffix', async () => {
        const dir = join(tmpDir, 'middlewares');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'notes.txt'), 'not an extension');
        await writeFile(join(dir, 'helper.mjs'), 'export const x = 1;');

        const catalog = await loader.scan();
        assert.equal(catalog.middlewares.length, 0);
    });

    it('skips files without a manifest export', async () => {
        const dir = join(tmpDir, 'middlewares');
        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, 'bare.middleware.mjs'),
            'export function noop() {}\n'
        );

        const catalog = await loader.scan();
        assert.equal(catalog.middlewares.length, 0);
    });

    it('gracefully handles missing directories', async () => {
        const catalog = await loader.scan();
        assert.equal(catalog.middlewares.length, 0);
        assert.equal(catalog.providerMiddlewares.length, 0);
        assert.equal(catalog.transports.length, 0);
    });

    it('discovers from all canonical directories in a single scan', async () => {
        await writeExtension(
            join(tmpDir, 'middlewares'),
            'rate-check.middleware.mjs',
            { key: 'rate-check' },
            { factory: true }
        );
        await writeExtension(
            join(tmpDir, 'provider-middlewares'),
            'retry.middleware.mjs',
            { key: 'retry' },
            { factory: true }
        );
        await writeExtension(
            join(tmpDir, 'transports'),
            'ollama.transport.mjs',
            { key: 'ollama' },
            { execute: true }
        );

        const catalog = await loader.scan();

        assert.equal(catalog.middlewares.length, 1);
        assert.equal(catalog.providerMiddlewares.length, 1);
        assert.equal(catalog.transports.length, 1);

        assert.equal(catalog.middlewares[0].scope, EXTENSION_SCOPES.GATEWAY);
        assert.equal(catalog.middlewares[0].type, EXTENSION_TYPES.MIDDLEWARE);
        assert.equal(
            catalog.providerMiddlewares[0].scope,
            EXTENSION_SCOPES.PROVIDER
        );
        assert.equal(
            catalog.providerMiddlewares[0].type,
            EXTENSION_TYPES.MIDDLEWARE
        );
        assert.equal(catalog.transports[0].scope, null);
        assert.equal(catalog.transports[0].type, EXTENSION_TYPES.TRANSPORT);
    });

    it('increments generation on each scan', async () => {
        assert.equal(loader.generation, 0);

        await loader.scan();
        assert.equal(loader.generation, 1);

        await loader.scan();
        assert.equal(loader.generation, 2);
    });

    it('includes generation in catalog', async () => {
        const first = await loader.scan();
        assert.equal(first.generation, 1);

        const second = await loader.scan();
        assert.equal(second.generation, 2);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Manifest Validation
// ═══════════════════════════════════════════════════════════════════════

describe('ExtensionLoader — manifest validation', () => {
    let tmpDir;
    let loader;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'soul-ext-validate-'));
        loader = new ExtensionLoader(tmpDir, noopLog);
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('rejects extensions with invalid key format', async () => {
        await writeExtension(
            join(tmpDir, 'transports'),
            'bad-key.transport.mjs',
            { key: 'Bad_Key!' },
            { execute: true }
        );

        const catalog = await loader.scan();
        assert.equal(catalog.transports.length, 0);
    });

    it('accepts native gateway middleware extensions', async () => {
        await writeExtension(
            join(tmpDir, 'middlewares'),
            'good.middleware.mjs',
            { key: 'good' },
            { factory: true }
        );
        const catalog = await loader.scan();
        assert.equal(catalog.middlewares.length, 1);
    });

    it('ignores obsolete hooks metadata on gateway middleware manifests', async () => {
        await writeExtension(
            join(tmpDir, 'middlewares'),
            'bad.middleware.mjs',
            { key: 'bad', hooks: 'invalid' },
            { factory: true }
        );
        const catalog = await loader.scan();
        assert.equal(catalog.middlewares.length, 1);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

describe('extension-constants', () => {
    it('exports frozen EXTENSION_SCOPES', () => {
        assert.equal(EXTENSION_SCOPES.GATEWAY, 'gateway');
        assert.equal(EXTENSION_SCOPES.PROVIDER, 'provider');
        assert.ok(Object.isFrozen(EXTENSION_SCOPES));
    });

    it('exports frozen EXTENSION_TYPES', () => {
        assert.equal(EXTENSION_TYPES.MIDDLEWARE, 'middleware');
        assert.equal(EXTENSION_TYPES.TRANSPORT, 'transport');
        assert.ok(Object.isFrozen(EXTENSION_TYPES));
    });
});

describe('transport-constants', () => {
    it('exports frozen TRANSPORT_TYPES', () => {
        assert.equal(TRANSPORT_TYPES.EXTERNAL_API, 'external_api');
        assert.equal(TRANSPORT_TYPES.SEARCH, 'search');
        assert.equal(TRANSPORT_TYPES.LOCAL_MODEL, 'local_model');
        assert.equal(TRANSPORT_TYPES.CUSTOM, 'custom');
        assert.ok(Object.isFrozen(TRANSPORT_TYPES));
    });
});

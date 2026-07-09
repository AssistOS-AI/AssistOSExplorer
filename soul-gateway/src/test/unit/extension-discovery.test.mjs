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
    const parts = [];

    if (!options.backendModuleOnly) {
        parts.push(`export const manifest = ${JSON.stringify(manifest)};`);
    }

    if (options.factory)
        parts.push(
            'export const meta = manifest; export function factory() { return async (ctx, next) => { await next(); }; }'
        );
    if (options.execute)
        parts.push('export async function execute(ctx) { return {}; }');
    if (options.backendModule) {
        parts.push(
            `export const backendModule = {
    manifest: ${JSON.stringify(manifest)},
    async execute() { return {}; },
    classifyError(error) { return error; }
};`
        );
    }
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

    it('discovers backend files and tags type=backend', async () => {
        await writeExtension(
            join(tmpDir, 'backends'),
            'custom-backend.backend.mjs',
            {
                key: 'custom-backend',
                kind: 'custom',
                authStrategy: 'none',
                supportsStreaming: true,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            { execute: true }
        );

        const catalog = await loader.scan();

        assert.equal(catalog.backends.length, 1);
        const entry = catalog.backends[0];
        assert.equal(entry.manifest.key, 'custom-backend');
        assert.equal(entry.scope, null);
        assert.equal(entry.type, EXTENSION_TYPES.BACKEND);
    });

    it('discovers backend files that export backendModule only', async () => {
        await writeExtension(
            join(tmpDir, 'backends'),
            'external-api.backend.mjs',
            {
                key: 'external-api',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            { backendModule: true, backendModuleOnly: true }
        );

        const catalog = await loader.scan();

        assert.equal(catalog.backends.length, 1);
        const entry = catalog.backends[0];
        assert.equal(entry.manifest.key, 'external-api');
        assert.equal(entry.manifest.kind, 'external_api');
    });

    it('preserves canonical backend kinds on bare execute-style extensions', async () => {
        await writeExtension(
            join(tmpDir, 'backends'),
            'external-fetch.backend.mjs',
            {
                key: 'external-fetch',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: false,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            { execute: true }
        );

        const catalog = await loader.scan();

        assert.equal(catalog.backends.length, 1);
        const entry = catalog.backends[0];
        assert.equal(entry.manifest.key, 'external-fetch');
        assert.equal(entry.manifest.kind, 'external_api');
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
        assert.equal(catalog.backends.length, 0);
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
            join(tmpDir, 'backends'),
            'ollama.backend.mjs',
            { key: 'ollama' },
            { execute: true }
        );

        const catalog = await loader.scan();

        assert.equal(catalog.middlewares.length, 1);
        assert.equal(catalog.providerMiddlewares.length, 1);
        assert.equal(catalog.backends.length, 1);

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
        assert.equal(catalog.backends[0].scope, null);
        assert.equal(catalog.backends[0].type, EXTENSION_TYPES.BACKEND);
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
            join(tmpDir, 'backends'),
            'bad-key.backend.mjs',
            {
                key: 'Bad_Key!',
                kind: 'custom',
                authStrategy: 'none',
                supportsStreaming: true,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            { execute: true }
        );

        const catalog = await loader.scan();
        assert.equal(catalog.backends.length, 0);
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
        assert.equal(EXTENSION_TYPES.BACKEND, 'backend');
        assert.ok(Object.isFrozen(EXTENSION_TYPES));
    });
});

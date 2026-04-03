import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ExtensionLoader } from '../../runtime/plugins/extension-loader.mjs';
import { HOOK_SCOPES, HOOK_TYPES } from '../../runtime/hooks/hook-constants.mjs';
import { EXECUTOR_TYPES } from '../../runtime/executors/executor-constants.mjs';

// ── Helpers ──────────────────────────────────────────────────────────

const noopLog = {
  debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

/**
 * Write a minimal extension module into the given directory.
 */
async function writeExtension(dir, filename, manifest, hooks = {}) {
  await mkdir(dir, { recursive: true });
  const parts = [`export const manifest = ${JSON.stringify(manifest)};`];
  if (hooks.pre) parts.push('export function pre(ctx) { return ctx; }');
  if (hooks.post) parts.push('export function post(ctx) { return ctx; }');
  if (hooks.onRequest) parts.push('export function onRequest(ctx) { return ctx; }');
  if (hooks.onResponse) parts.push('export function onResponse(ctx) { return ctx; }');
  if (hooks.execute) parts.push('export async function execute(ctx) { return {}; }');
  if (hooks.providerPlugin) {
    parts.push('export const providerPlugin = { async dispatch() { return {}; } };');
  }
  await writeFile(join(dir, filename), parts.join('\n') + '\n');
}

// ═══════════════════════════════════════════════════════════════════════
// Legacy Path Discovery
// ═══════════════════════════════════════════════════════════════════════

describe('ExtensionLoader — legacy paths', () => {
  let tmpDir;
  let loader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'soul-ext-legacy-'));
    loader = new ExtensionLoader(tmpDir, noopLog);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers middleware files and tags scope=gateway, type=hook', async () => {
    await writeExtension(
      join(tmpDir, 'middlewares'),
      'my-filter.middleware.mjs',
      { key: 'my-filter', hooks: 'both' },
      { pre: true, post: true },
    );

    const catalog = await loader.scan();

    assert.equal(catalog.middlewares.length, 1);
    const entry = catalog.middlewares[0];
    assert.equal(entry.manifest.key, 'my-filter');
    assert.equal(entry.scope, HOOK_SCOPES.GATEWAY);
    assert.equal(entry.type, HOOK_TYPES.HOOK);
    assert.ok(entry.checksum);
    assert.ok(entry.filePath.endsWith('.middleware.mjs'));
  });

  it('discovers wrapper files and tags scope=provider, type=hook', async () => {
    await writeExtension(
      join(tmpDir, 'wrappers'),
      'my-wrapper.wrapper.mjs',
      { key: 'my-wrapper' },
      { providerPlugin: true },
    );

    const catalog = await loader.scan();

    assert.equal(catalog.wrappers.length, 1);
    const entry = catalog.wrappers[0];
    assert.equal(entry.manifest.key, 'my-wrapper');
    assert.equal(entry.scope, HOOK_SCOPES.PROVIDER);
    assert.equal(entry.type, HOOK_TYPES.HOOK);
  });

  it('discovers search files and tags type=executor', async () => {
    await writeExtension(
      join(tmpDir, 'search'),
      'web-search.search.mjs',
      { key: 'web-search' },
      { providerPlugin: true },
    );

    const catalog = await loader.scan();

    assert.equal(catalog.search.length, 1);
    const entry = catalog.search[0];
    assert.equal(entry.manifest.key, 'web-search');
    assert.equal(entry.scope, null);
    assert.equal(entry.type, HOOK_TYPES.EXECUTOR);
  });

  it('discovers model files and tags type=executor', async () => {
    await writeExtension(
      join(tmpDir, 'models'),
      'local-llm.model.mjs',
      { key: 'local-llm' },
      { providerPlugin: true },
    );

    const catalog = await loader.scan();

    assert.equal(catalog.models.length, 1);
    const entry = catalog.models[0];
    assert.equal(entry.manifest.key, 'local-llm');
    assert.equal(entry.scope, null);
    assert.equal(entry.type, HOOK_TYPES.EXECUTOR);
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
    await writeFile(join(dir, 'bare.middleware.mjs'), 'export function pre() {}\n');

    const catalog = await loader.scan();
    assert.equal(catalog.middlewares.length, 0);
  });

  it('gracefully handles missing directories', async () => {
    // tmpDir exists but has no subdirectories
    const catalog = await loader.scan();
    assert.equal(catalog.middlewares.length, 0);
    assert.equal(catalog.search.length, 0);
    assert.equal(catalog.models.length, 0);
    assert.equal(catalog.wrappers.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// New Path Discovery
// ═══════════════════════════════════════════════════════════════════════

describe('ExtensionLoader — new paths', () => {
  let tmpDir;
  let loader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'soul-ext-new-'));
    loader = new ExtensionLoader(tmpDir, noopLog);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers gateway-hooks/*.hook.mjs and tags scope=gateway, type=hook', async () => {
    await writeExtension(
      join(tmpDir, 'gateway-hooks'),
      'auth-check.hook.mjs',
      { key: 'auth-check', phases: ['request'] },
      { onRequest: true },
    );

    const catalog = await loader.scan();

    assert.equal(catalog.gatewayHooks.length, 1);
    const entry = catalog.gatewayHooks[0];
    assert.equal(entry.manifest.key, 'auth-check');
    assert.equal(entry.scope, HOOK_SCOPES.GATEWAY);
    assert.equal(entry.type, HOOK_TYPES.HOOK);
    assert.ok(entry.checksum);
  });

  it('discovers provider-hooks/*.hook.mjs and tags scope=provider, type=hook', async () => {
    await writeExtension(
      join(tmpDir, 'provider-hooks'),
      'prompt-shaper.hook.mjs',
      { key: 'prompt-shaper', phases: ['request', 'response'] },
      { onRequest: true, onResponse: true },
    );

    const catalog = await loader.scan();

    assert.equal(catalog.providerHooks.length, 1);
    const entry = catalog.providerHooks[0];
    assert.equal(entry.manifest.key, 'prompt-shaper');
    assert.equal(entry.scope, HOOK_SCOPES.PROVIDER);
    assert.equal(entry.type, HOOK_TYPES.HOOK);
  });

  it('discovers executors/*.executor.mjs and tags type=executor', async () => {
    await writeExtension(
      join(tmpDir, 'executors'),
      'custom-backend.executor.mjs',
      { key: 'custom-backend' },
      { execute: true },
    );

    const catalog = await loader.scan();

    assert.equal(catalog.executors.length, 1);
    const entry = catalog.executors[0];
    assert.equal(entry.manifest.key, 'custom-backend');
    assert.equal(entry.scope, null);
    assert.equal(entry.type, HOOK_TYPES.EXECUTOR);
  });

  it('gracefully handles missing new directories', async () => {
    const catalog = await loader.scan();
    assert.equal(catalog.gatewayHooks.length, 0);
    assert.equal(catalog.providerHooks.length, 0);
    assert.equal(catalog.executors.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Mixed Discovery — old and new paths together
// ═══════════════════════════════════════════════════════════════════════

describe('ExtensionLoader — mixed old and new paths', () => {
  let tmpDir;
  let loader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'soul-ext-mixed-'));
    loader = new ExtensionLoader(tmpDir, noopLog);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers from both old and new directories in a single scan', async () => {
    // legacy middleware
    await writeExtension(
      join(tmpDir, 'middlewares'),
      'rate-check.middleware.mjs',
      { key: 'rate-check', hooks: 'pre' },
      { pre: true },
    );

    // legacy wrapper
    await writeExtension(
      join(tmpDir, 'wrappers'),
      'context-fix.wrapper.mjs',
      { key: 'context-fix' },
      { providerPlugin: true },
    );

    // new gateway hook
    await writeExtension(
      join(tmpDir, 'gateway-hooks'),
      'logging.hook.mjs',
      { key: 'logging', phases: ['request', 'response'] },
      { onRequest: true, onResponse: true },
    );

    // new provider hook
    await writeExtension(
      join(tmpDir, 'provider-hooks'),
      'retry-wrapper.hook.mjs',
      { key: 'retry-wrapper', phases: ['request'] },
      { onRequest: true },
    );

    // new executor
    await writeExtension(
      join(tmpDir, 'executors'),
      'ollama.executor.mjs',
      { key: 'ollama' },
      { execute: true },
    );

    const catalog = await loader.scan();

    // legacy
    assert.equal(catalog.middlewares.length, 1);
    assert.equal(catalog.wrappers.length, 1);

    // new
    assert.equal(catalog.gatewayHooks.length, 1);
    assert.equal(catalog.providerHooks.length, 1);
    assert.equal(catalog.executors.length, 1);

    // verify metadata on each
    assert.equal(catalog.middlewares[0].scope, HOOK_SCOPES.GATEWAY);
    assert.equal(catalog.middlewares[0].type, HOOK_TYPES.HOOK);

    assert.equal(catalog.wrappers[0].scope, HOOK_SCOPES.PROVIDER);
    assert.equal(catalog.wrappers[0].type, HOOK_TYPES.HOOK);

    assert.equal(catalog.gatewayHooks[0].scope, HOOK_SCOPES.GATEWAY);
    assert.equal(catalog.gatewayHooks[0].type, HOOK_TYPES.HOOK);

    assert.equal(catalog.providerHooks[0].scope, HOOK_SCOPES.PROVIDER);
    assert.equal(catalog.providerHooks[0].type, HOOK_TYPES.HOOK);

    assert.equal(catalog.executors[0].scope, null);
    assert.equal(catalog.executors[0].type, HOOK_TYPES.EXECUTOR);
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
// Manifest Validation for New Paths
// ═══════════════════════════════════════════════════════════════════════

describe('ExtensionLoader — manifest validation on new paths', () => {
  let tmpDir;
  let loader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'soul-ext-validate-'));
    loader = new ExtensionLoader(tmpDir, noopLog);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects gateway hook with invalid phase', async () => {
    await writeExtension(
      join(tmpDir, 'gateway-hooks'),
      'bad-phase.hook.mjs',
      { key: 'bad-phase', phases: ['invalid-phase'] },
      { onRequest: true },
    );

    const catalog = await loader.scan();

    // Should not be loaded due to validation failure
    assert.equal(catalog.gatewayHooks.length, 0);
  });

  it('accepts gateway hook with valid phases', async () => {
    await writeExtension(
      join(tmpDir, 'gateway-hooks'),
      'good-phases.hook.mjs',
      { key: 'good-phases', phases: ['request', 'stream', 'response'] },
      { onRequest: true, onResponse: true },
    );

    const catalog = await loader.scan();
    assert.equal(catalog.gatewayHooks.length, 1);
  });

  it('rejects extensions with invalid key format', async () => {
    await writeExtension(
      join(tmpDir, 'executors'),
      'bad-key.executor.mjs',
      { key: 'Bad_Key!' },
      { execute: true },
    );

    const catalog = await loader.scan();
    assert.equal(catalog.executors.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

describe('hook-constants', () => {
  it('exports frozen HOOK_SCOPES', () => {
    assert.equal(HOOK_SCOPES.GATEWAY, 'gateway');
    assert.equal(HOOK_SCOPES.PROVIDER, 'provider');
    assert.ok(Object.isFrozen(HOOK_SCOPES));
  });

  it('exports frozen HOOK_TYPES', () => {
    assert.equal(HOOK_TYPES.HOOK, 'hook');
    assert.equal(HOOK_TYPES.EXECUTOR, 'executor');
    assert.ok(Object.isFrozen(HOOK_TYPES));
  });
});

describe('executor-constants', () => {
  it('exports frozen EXECUTOR_TYPES', () => {
    assert.equal(EXECUTOR_TYPES.EXTERNAL_API, 'external_api');
    assert.equal(EXECUTOR_TYPES.SEARCH, 'search');
    assert.equal(EXECUTOR_TYPES.LOCAL_MODEL, 'local_model');
    assert.equal(EXECUTOR_TYPES.CUSTOM, 'custom');
    assert.ok(Object.isFrozen(EXECUTOR_TYPES));
  });
});

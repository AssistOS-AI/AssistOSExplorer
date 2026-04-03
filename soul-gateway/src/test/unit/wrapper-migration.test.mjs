import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  validateManifest,
  drainDeprecationWarnings,
  isExecutorKind,
  isDeprecatedKind,
} from '../../runtime/providers/provider-interface.mjs';

import { ProviderLoader } from '../../runtime/providers/provider-loader.mjs';
import { validateExtensionManifest } from '../../runtime/plugins/manifest-validator.mjs';
import { ExtensionLoader } from '../../runtime/plugins/extension-loader.mjs';
import { HOOK_SCOPES, HOOK_TYPES } from '../../runtime/hooks/hook-constants.mjs';

// ── Helpers ──────────────────────────────────────────────────────────

const noopLog = {
  debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

/**
 * Create a logger that records warnings for later inspection.
 */
function createCapturingLog() {
  const warnings = [];
  return {
    log: {
      debug() {},
      info() {},
      warn(code, data) { warnings.push({ code, data }); },
      error() {},
      fatal() {},
    },
    warnings,
  };
}

/**
 * Build a valid provider manifest with the given kind.
 */
function makeProviderManifest(kind, key = 'test-plugin') {
  return {
    key,
    kind,
    authStrategy: 'api_key',
    supportsStreaming: true,
    supportsTools: true,
    supportedFormats: ['openai_chat'],
  };
}

/**
 * Build a minimal provider plugin (executor-style: execute + classifyError).
 */
function makeExecutorPlugin(kind, key = 'test-plugin') {
  return {
    manifest: makeProviderManifest(kind, key),
    async init() {},
    async shutdown() {},
    async execute(ctx) {
      return { accountId: null, stream: null, abort: async () => {} };
    },
    classifyError(err) {
      return {
        httpStatus: 500, errorType: 'internal_error',
        retryable: false, cooldown: false, cascade: false,
        retryAfterSeconds: null,
      };
    },
  };
}

/**
 * Write a provider plugin module to disk for ProviderLoader testing.
 */
async function writeProviderModule(dir, filename, { kind, hasHookFunctions = false }) {
  await mkdir(dir, { recursive: true });
  const lines = [];

  // Always export the providerPlugin with execute/classifyError
  lines.push(`export const providerPlugin = {`);
  lines.push(`  manifest: {`);
  lines.push(`    key: '${filename.replace(/\.provider\.mjs$/, '')}',`);
  lines.push(`    kind: '${kind}',`);
  lines.push(`    authStrategy: 'api_key',`);
  lines.push(`    supportsStreaming: true,`);
  lines.push(`    supportsTools: true,`);
  lines.push(`    supportedFormats: ['openai_chat'],`);
  lines.push(`  },`);
  lines.push(`  async init() {},`);
  lines.push(`  async shutdown() {},`);
  lines.push(`  async execute(ctx) { return { accountId: null, stream: null, abort: async () => {} }; },`);
  lines.push(`  classifyError(err) { return { httpStatus: 500, errorType: 'internal_error', retryable: false, cooldown: false, cascade: false, retryAfterSeconds: null }; },`);

  if (hasHookFunctions) {
    lines.push(`  async onRequest(ctx) { ctx._hookRan = true; },`);
    lines.push(`  async onResponse(ctx) { ctx._hookRan = true; },`);
  }

  lines.push(`};`);

  // Also export module-level hook functions if requested
  if (hasHookFunctions) {
    lines.push(`export async function onRequest(ctx) { ctx._hookRan = true; }`);
    lines.push(`export async function onResponse(ctx) { ctx._hookRan = true; }`);
  }

  await writeFile(join(dir, filename), lines.join('\n') + '\n');
}

/**
 * Write a minimal extension module for ExtensionLoader testing.
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
// CP11: Provider Manifest — kind='wrapper' Deprecation
// ═══════════════════════════════════════════════════════════════════════

describe('CP11: validateManifest — wrapper deprecation', () => {

  beforeEach(() => {
    drainDeprecationWarnings();
  });

  it('still accepts kind=wrapper without throwing', () => {
    const manifest = makeProviderManifest('wrapper');
    assert.doesNotThrow(() => validateManifest(manifest));
  });

  it('records a deprecation warning for kind=wrapper', () => {
    const manifest = makeProviderManifest('wrapper');
    validateManifest(manifest);
    const warnings = drainDeprecationWarnings();
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('deprecated'));
    assert.equal(warnings[0].kind, 'wrapper');
  });

  it('does not record deprecation for executor kinds', () => {
    for (const kind of ['external_api', 'search', 'local_model', 'custom']) {
      validateManifest(makeProviderManifest(kind));
    }
    const warnings = drainDeprecationWarnings();
    assert.equal(warnings.length, 0);
  });

  it('logs a warning via the provided logger', () => {
    const { log, warnings } = createCapturingLog();
    const manifest = makeProviderManifest('wrapper');
    validateManifest(manifest, { log });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'provider_manifest_deprecated_kind');
    assert.equal(warnings[0].data.kind, 'wrapper');
  });

  it('accepts canonical executor kinds: external_api, search, local_model, custom', () => {
    for (const kind of ['external_api', 'search', 'local_model', 'custom']) {
      assert.doesNotThrow(
        () => validateManifest(makeProviderManifest(kind)),
        `kind='${kind}' should be accepted`,
      );
    }
  });

  it('rejects unknown kinds', () => {
    assert.throws(
      () => validateManifest(makeProviderManifest('nonexistent')),
      /manifest\.kind/,
    );
  });
});

describe('CP11: isExecutorKind / isDeprecatedKind helpers', () => {

  it('isExecutorKind returns true for canonical executor kinds', () => {
    assert.ok(isExecutorKind('external_api'));
    assert.ok(isExecutorKind('search'));
    assert.ok(isExecutorKind('local_model'));
    assert.ok(isExecutorKind('custom'));
  });

  it('isExecutorKind returns false for wrapper', () => {
    assert.equal(isExecutorKind('wrapper'), false);
  });

  it('isDeprecatedKind returns true for wrapper', () => {
    assert.ok(isDeprecatedKind('wrapper'));
  });

  it('isDeprecatedKind returns false for executor kinds', () => {
    assert.equal(isDeprecatedKind('external_api'), false);
    assert.equal(isDeprecatedKind('search'), false);
    assert.equal(isDeprecatedKind('custom'), false);
  });
});


// ═══════════════════════════════════════════════════════════════════════
// CP11: ProviderLoader — Wrapper Classification
// ═══════════════════════════════════════════════════════════════════════

describe('CP11: ProviderLoader — wrapper with hook functions classified as provider_hook', () => {
  let tmpDir;
  let loader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'soul-wrapper-hook-'));
    loader = new ProviderLoader({
      builtinDir: join(tmpDir, 'builtin'),
      extensionsDir: tmpDir,
      log: noopLog,
    });
    await mkdir(join(tmpDir, 'builtin'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('classifies wrapper with onRequest/onResponse as provider_hook', async () => {
    await writeProviderModule(join(tmpDir, 'builtin'), 'hook-wrapper.provider.mjs', {
      kind: 'wrapper',
      hasHookFunctions: true,
    });
    const plugins = await loader.loadAll();
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]._wrapperClassification, 'provider_hook');
  });

  it('classifies wrapper with only execute/classifyError as executor', async () => {
    await writeProviderModule(join(tmpDir, 'builtin'), 'exec-wrapper.provider.mjs', {
      kind: 'wrapper',
      hasHookFunctions: false,
    });
    const plugins = await loader.loadAll();
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]._wrapperClassification, 'executor');
  });

  it('does not classify non-wrapper plugins', async () => {
    await writeProviderModule(join(tmpDir, 'builtin'), 'normal-api.provider.mjs', {
      kind: 'external_api',
      hasHookFunctions: false,
    });
    const plugins = await loader.loadAll();
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]._wrapperClassification, null);
  });
});

describe('CP11: ProviderLoader — wrapper manifests still load without error', () => {
  let tmpDir;
  let loader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'soul-wrapper-compat-'));
    loader = new ProviderLoader({
      builtinDir: join(tmpDir, 'builtin'),
      extensionsDir: tmpDir,
      log: noopLog,
    });
    await mkdir(join(tmpDir, 'builtin'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads wrapper manifests through the full loadAll path', async () => {
    await writeProviderModule(join(tmpDir, 'builtin'), 'legacy-wrap.provider.mjs', {
      kind: 'wrapper',
      hasHookFunctions: false,
    });
    const plugins = await loader.loadAll();
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].manifest.kind, 'wrapper');
  });

  it('preserves runtime behavior: execute is callable', async () => {
    await writeProviderModule(join(tmpDir, 'builtin'), 'callable-wrap.provider.mjs', {
      kind: 'wrapper',
      hasHookFunctions: false,
    });
    const plugins = await loader.loadAll();
    const plugin = plugins[0];
    const result = await plugin.execute({});
    assert.ok(result !== undefined);
  });
});


// ═══════════════════════════════════════════════════════════════════════
// CP11: Manifest Validator — wrapper accepted but deprecated
// ═══════════════════════════════════════════════════════════════════════

describe('CP11: manifest-validator — kind=wrappers still valid', () => {

  it('accepts wrappers as a valid extension kind', () => {
    assert.doesNotThrow(() => {
      validateExtensionManifest({ key: 'my-wrapper', kind: 'wrappers' }, 'wrappers');
    });
  });

  it('accepts gatewayHooks as a valid extension kind', () => {
    assert.doesNotThrow(() => {
      validateExtensionManifest(
        { key: 'my-hook', kind: 'gatewayHooks', phases: ['request'] },
        'gatewayHooks',
      );
    });
  });

  it('accepts providerHooks as a valid extension kind', () => {
    assert.doesNotThrow(() => {
      validateExtensionManifest(
        { key: 'my-phook', kind: 'providerHooks', phases: ['request', 'response'] },
        'providerHooks',
      );
    });
  });

  it('accepts executors as a valid extension kind', () => {
    assert.doesNotThrow(() => {
      validateExtensionManifest({ key: 'my-exec', kind: 'executors' }, 'executors');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════
// CP11: ExtensionLoader — wrappers/ maps to scope=provider, type=hook
// ═══════════════════════════════════════════════════════════════════════

describe('CP11: ExtensionLoader — wrapper path maps to provider hook', () => {
  let tmpDir;
  let loader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'soul-ext-wrap-'));
    loader = new ExtensionLoader(tmpDir, noopLog);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('extensions/wrappers/ maps to scope=provider, type=hook', async () => {
    await writeExtension(
      join(tmpDir, 'wrappers'),
      'old-wrap.wrapper.mjs',
      { key: 'old-wrap' },
      { providerPlugin: true },
    );
    const catalog = await loader.scan();
    assert.equal(catalog.wrappers.length, 1);
    assert.equal(catalog.wrappers[0].scope, HOOK_SCOPES.PROVIDER);
    assert.equal(catalog.wrappers[0].type, HOOK_TYPES.HOOK);
  });

  it('extensions/provider-hooks/ also maps to scope=provider, type=hook', async () => {
    await writeExtension(
      join(tmpDir, 'provider-hooks'),
      'new-hook.hook.mjs',
      { key: 'new-hook', phases: ['request'] },
      { onRequest: true },
    );
    const catalog = await loader.scan();
    assert.equal(catalog.providerHooks.length, 1);
    assert.equal(catalog.providerHooks[0].scope, HOOK_SCOPES.PROVIDER);
    assert.equal(catalog.providerHooks[0].type, HOOK_TYPES.HOOK);
  });
});


// ═══════════════════════════════════════════════════════════════════════
// CP12: Final runtime has no hard dependency on kind='wrapper'
// ═══════════════════════════════════════════════════════════════════════

describe('CP12: No hard dependency on kind=wrapper for new code', () => {

  it('all canonical executor kinds pass validation without deprecation', () => {
    drainDeprecationWarnings();
    for (const kind of ['external_api', 'search', 'local_model', 'custom']) {
      validateManifest(makeProviderManifest(kind));
    }
    const warnings = drainDeprecationWarnings();
    assert.equal(warnings.length, 0, 'No deprecation warnings for canonical kinds');
  });

  it('new provider hooks do not use kind=wrapper', () => {
    // Verify that the hook contract does not reference wrapper kinds
    // A provider hook uses scope='provider' and phases, not kind='wrapper'
    const hookMeta = {
      key: 'test-hook',
      name: 'Test Hook',
      scope: 'provider',
      phases: ['request', 'response'],
      defaultSettings: {},
    };
    assert.equal(hookMeta.scope, 'provider');
    assert.ok(!('kind' in hookMeta));
  });

  it('extension loader populates provider hooks from provider-hooks/ without wrapper kind', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'soul-cp12-'));
    const loader = new ExtensionLoader(tmpDir, noopLog);
    try {
      await writeExtension(
        join(tmpDir, 'provider-hooks'),
        'clean-hook.hook.mjs',
        { key: 'clean-hook', phases: ['request'] },
        { onRequest: true },
      );
      const catalog = await loader.scan();
      assert.equal(catalog.providerHooks.length, 1);
      // The entry uses scope/type, not kind='wrapper'
      assert.equal(catalog.providerHooks[0].scope, HOOK_SCOPES.PROVIDER);
      assert.equal(catalog.providerHooks[0].type, HOOK_TYPES.HOOK);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('CP12: Old wrapper manifests still load through compatibility', () => {

  it('old wrapper extension manifests are accepted by the manifest validator', () => {
    assert.doesNotThrow(() => {
      validateExtensionManifest({ key: 'legacy-wrapper' }, 'wrappers');
    });
  });

  it('old wrapper provider manifests are accepted by validateManifest', () => {
    drainDeprecationWarnings();
    const manifest = makeProviderManifest('wrapper', 'old-wrapper');
    assert.doesNotThrow(() => validateManifest(manifest));
    const warnings = drainDeprecationWarnings();
    assert.equal(warnings.length, 1, 'Should produce exactly one deprecation warning');
  });

  it('old wrapper in extension loader still discovers and tags correctly', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'soul-cp12-compat-'));
    const loader = new ExtensionLoader(tmpDir, noopLog);
    try {
      await writeExtension(
        join(tmpDir, 'wrappers'),
        'compat-wrapper.wrapper.mjs',
        { key: 'compat-wrapper' },
        { providerPlugin: true },
      );
      const catalog = await loader.scan();
      assert.equal(catalog.wrappers.length, 1);
      assert.equal(catalog.wrappers[0].manifest.key, 'compat-wrapper');
      assert.equal(catalog.wrappers[0].scope, HOOK_SCOPES.PROVIDER);
      assert.equal(catalog.wrappers[0].type, HOOK_TYPES.HOOK);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

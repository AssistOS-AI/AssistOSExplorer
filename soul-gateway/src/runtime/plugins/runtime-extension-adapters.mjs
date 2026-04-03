import { ConfigurationError } from '../../core/errors.mjs';
import { validateExecutorManifest } from '../executors/executor-interface.mjs';
import { adaptProviderToExecutor } from '../executors/provider-executor-adapter.mjs';
import { validateHookModule } from '../hooks/hook-interface.mjs';

export function adaptExtensionEntryToHook(entry) {
  const mod = entry?.module || {};
  const manifest = mod.manifest || mod.meta || entry?.manifest || {};
  const hookModule = mod.hookModule || buildHookModule(mod, manifest, entry?.scope);
  const validation = validateHookModule(hookModule);
  if (!validation.valid) {
    throw new ConfigurationError(
      `Invalid hook extension ${manifest.key || entry?.filePath || 'unknown'}: ${validation.errors.join('; ')}`,
    );
  }
  return hookModule;
}

export function adaptExtensionEntryToExecutor(entry) {
  const mod = entry?.module || {};
  if (mod.executorPlugin) {
    validateExecutorManifest(mod.executorPlugin.manifest);
    return mod.executorPlugin;
  }
  if (mod.providerPlugin) {
    return adaptProviderToExecutor(mod.providerPlugin);
  }

  const manifest = mod.manifest || mod.meta || entry?.manifest || {};
  if (typeof mod.execute !== 'function') {
    throw new ConfigurationError(
      `Executor extension ${manifest.key || entry?.filePath || 'unknown'} must export execute(), executorPlugin, or providerPlugin`,
    );
  }

  const executor = {
    manifest: normalizeExecutorManifest(manifest, entry),
    execute: mod.execute.bind(mod),
    classifyError: typeof mod.classifyError === 'function'
      ? mod.classifyError.bind(mod)
      : (error) => error,
  };

  if (typeof mod.discoverModels === 'function') {
    executor.discoverModels = mod.discoverModels.bind(mod);
  }
  if (typeof mod.testConnection === 'function') {
    executor.testConnection = mod.testConnection.bind(mod);
  }
  if (typeof mod.init === 'function') {
    executor.init = mod.init.bind(mod);
  }
  if (typeof mod.shutdown === 'function') {
    executor.shutdown = mod.shutdown.bind(mod);
  }

  validateExecutorManifest(executor.manifest);
  return executor;
}

function buildHookModule(mod, manifest, scope) {
  const onRequest = typeof mod.onRequest === 'function'
    ? mod.onRequest.bind(mod)
    : (typeof mod.pre === 'function' ? mod.pre.bind(mod) : undefined);
  const wrapStream = typeof mod.wrapStream === 'function'
    ? mod.wrapStream.bind(mod)
    : undefined;
  const onResponse = typeof mod.onResponse === 'function'
    ? mod.onResponse.bind(mod)
    : (typeof mod.post === 'function' ? mod.post.bind(mod) : undefined);

  const phases = Array.isArray(manifest.phases) && manifest.phases.length > 0
    ? [...manifest.phases]
    : inferHookPhases({ onRequest, wrapStream, onResponse });

  return {
    meta: {
      key: manifest.key,
      name: manifest.name || manifest.displayName || manifest.key,
      description: manifest.description || '',
      version: manifest.version || '1.0.0',
      scope: manifest.scope || scope,
      phases,
      defaultSettings: manifest.defaultSettings || {},
    },
    ...(onRequest ? { onRequest } : {}),
    ...(wrapStream ? { wrapStream } : {}),
    ...(onResponse ? { onResponse } : {}),
  };
}

function inferHookPhases({ onRequest, wrapStream, onResponse }) {
  const phases = [];
  if (typeof onRequest === 'function') phases.push('request');
  if (typeof wrapStream === 'function') phases.push('stream');
  if (typeof onResponse === 'function') phases.push('response');
  return phases;
}

function normalizeExecutorManifest(manifest, entry) {
  return {
    key: manifest.key,
    name: manifest.name || manifest.displayName || manifest.key,
    executorType: manifest.executorType || inferExecutorType(entry),
    supportsStreaming: manifest.supportsStreaming ?? true,
    supportsTools: manifest.supportsTools ?? false,
  };
}

function inferExecutorType(entry) {
  return 'custom';
}

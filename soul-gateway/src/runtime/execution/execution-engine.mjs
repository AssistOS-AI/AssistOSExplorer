import { executeWithHttpRetry } from './http-retry.mjs';
import { executeModelCascade } from './model-cascade.mjs';
import { collectNormalizedStream } from './stream-collector.mjs';
import { withExecutionTimeout } from './timeout-controller.mjs';
import { resolveTier } from '../registry/model-registry.mjs';
import { createProviderContext } from '../providers/provider-context.mjs';
import { withModelFieldAliases, withProviderFieldAliases } from '../providers/record-aliases.mjs';
import { ConfigurationError, InternalServerError } from '../../core/errors.mjs';
import { executeProviderPipeline, runResponseHooks } from '../hooks/provider-hook-engine.mjs';
import {
  applyCollectedResultToHookContext,
  createProviderHookContext,
  readCollectedResultFromHookContext,
} from '../hooks/provider-hook-context.mjs';

/**
 * Execute a resolved request through the provider system.
 *
 * @param {object} execCtx
 * @param {object} execCtx.resolvedModel - model record (or null for tier)
 * @param {object} execCtx.resolvedTier - tier record (or null for direct model)
 * @param {object} execCtx.normalizedRequest - internal request shape
 * @param {object} execCtx.snapshot - runtime snapshot
 * @param {object} execCtx.appCtx - application context
 * @param {object} execCtx.concurrencyController - ConcurrencyController
 * @param {object} execCtx.providerCatalog - ProviderCatalog (or null)
 * @param {object} execCtx.executorCatalog - ExecutorCatalog (or null)
 * @param {object} execCtx.credentialManager - CredentialManager (or null)
 * @param {function} execCtx.onCooldown - (modelKey, error) => void
 * @param {object} execCtx.log - logger
 */
export async function executeResolvedRequest(execCtx) {
  const {
    resolvedModel,
    resolvedTier,
    normalizedRequest,
    snapshot,
    appCtx,
    concurrencyController,
    providerCatalog,
    credentialManager,
    onCooldown,
    log,
  } = execCtx;

  // Direct model request
  if (resolvedModel && !resolvedTier) {
    return executeModelAttempt(resolvedModel, execCtx);
  }

    // Tier request — use cascade
  if (resolvedTier) {
    return executeModelCascade({
      resolveTier: (tierKey, options = {}) => {
        const resolution = resolveTier(snapshot, tierKey);
        if (!resolution) return null;

        const { excludeModels = new Set() } = options;
        const candidate = resolution.candidates.find(({ model }) => {
          return !excludeModels.has(model.modelKey || model.model_key);
        });

        if (!candidate) return null;

        return {
          tier: resolution.tier,
          model: candidate.model,
          candidate,
        };
      },
      dispatch: (model) => executeModelAttempt(model, execCtx),
      tierKey: resolvedTier.tierKey || resolvedTier.tier_key,
      maxAttempts: resolvedTier.maxModelAttempts || resolvedTier.max_model_attempts || appCtx.config.env.DEFAULT_MODEL_ATTEMPTS,
      failedModels: new Set(),
      onCooldown,
      log,
    });
  }

  throw new InternalServerError('Execution engine requires a resolved model or tier');
}

/**
 * Execute a single model attempt with concurrency control, timeout, and retries.
 */
async function executeModelAttempt(model, execCtx) {
  const {
    normalizedRequest,
    appCtx,
    concurrencyController,
    providerCatalog,
    executorCatalog,
    credentialManager,
    log,
  } = execCtx;

  const resolvedModel = withModelFieldAliases(model);
  const activeExecutorCatalog = executorCatalog || appCtx.services.executorCatalog || null;
  const modelKey = resolvedModel.modelKey || resolvedModel.model_key;
  const timeoutMs = resolvedModel.requestTimeoutMs || resolvedModel.request_timeout_ms || appCtx.config.env.DEFAULT_REQUEST_TIMEOUT_MS;
  const queueTimeoutMs = resolvedModel.queueTimeoutMs || resolvedModel.queue_timeout_ms || appCtx.config.env.DEFAULT_QUEUE_TIMEOUT_MS;
  const env = appCtx.config.env;

  // 1. Acquire concurrency slot
  if (concurrencyController) {
    concurrencyController.configure(modelKey, resolvedModel.concurrencyLimit || resolvedModel.concurrency_limit || env.DEFAULT_MODEL_CONCURRENCY);
  }
  const queueStartMs = Date.now();
  const release = concurrencyController
    ? await concurrencyController.acquire(modelKey, queueTimeoutMs)
    : () => {};
  const queueWaitMs = Date.now() - queueStartMs;

  try {
    // 2. Execute with HTTP retry
    const retryPolicyConfig = resolvedModel.retryPolicy || resolvedModel.retry_policy || {};
    const retryPolicy = {
      maxAttempts: retryPolicyConfig.maxAttempts ?? env.HTTP_RETRY_MAX_ATTEMPTS,
      baseDelayMs: retryPolicyConfig.baseDelayMs ?? env.HTTP_RETRY_BASE_DELAY_MS,
      multiplier: retryPolicyConfig.multiplier ?? env.HTTP_RETRY_MULTIPLIER,
      maxDelayMs: retryPolicyConfig.maxDelayMs ?? env.HTTP_RETRY_MAX_DELAY_MS,
      jitterPct: retryPolicyConfig.jitterPct ?? env.HTTP_RETRY_JITTER_PCT,
    };

    const { result, error, trace } = await executeWithHttpRetry(retryPolicy, async (attempt) => {
      // 3. Get provider plugin and credentials
      const { signal, clear } = withExecutionTimeout(timeoutMs, resolvedModel.providerKey || resolvedModel.provider_key || modelKey);
      let credentialLease = null;

      try {
        // If no execution backend catalog exists yet, return a stub result
        if (!providerCatalog && !activeExecutorCatalog) {
          return {
            collected: {
              message: { role: 'assistant', content: '[provider not yet implemented]' },
              content: '[provider not yet implemented]',
              excerpt: '[provider not yet implemented]',
              finishReason: 'stop',
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
              toolCalls: [],
            },
            accountId: null,
            queueWaitMs,
          };
        }

        const providerRecord = withProviderFieldAliases(
          execCtx.snapshot.providers.get(resolvedModel.providerKey || resolvedModel.provider_key)
        );

        // Resolve which plugin handles this provider. The
        // authoritative field is `adapter_key` (every provider record
        // points at a protocol-family plugin like `openai-api`,
        // `anthropic-api`, `search-builtin` …); `executor_key` is the
        // optional override for custom executors, and `provider_key`
        // is only kept as a last-ditch legacy fallback for old
        // single-vendor providers where the two happened to coincide
        // (codex-api, copilot-api). Without `adapter_key` in the
        // chain, every preset-based provider (codestral, nvidia,
        // groq, fireworks, …) blew up with "Execution backend not
        // loaded: <vendor>" because the lookup asked for the vendor
        // name instead of the protocol family. The lifecycle path
        // (testConnection / discoverModels) already uses this same
        // resolution order via ProviderCatalog._resolveLifecycleTarget.
        const executorKey = providerRecord?.executorKey
          || providerRecord?.executor_key
          || providerRecord?.adapterKey
          || providerRecord?.adapter_key
          || resolvedModel.providerKey
          || resolvedModel.provider_key;

        const executor = activeExecutorCatalog?.getExecutor(executorKey)
          || providerCatalog?.getPlugin(executorKey)
          || null;
        if (!executor) {
          throw new ConfigurationError(`Execution backend not loaded: ${executorKey}`);
        }

        credentialLease = credentialManager
          ? await credentialManager.getCredentials(resolvedModel.providerId || resolvedModel.provider_id)
          : null;

        const providerCtx = createProviderContext({
          requestId: execCtx.requestId,
          request: normalizedRequest,
          resolvedModel,
          providerRecord,
          credentialLease,
          attempt: { index: attempt, previousErrors: [] },
          signal,
          services: appCtx.services.extensionServices || Object.freeze({}),
          logger: appCtx.log,
        });
        const providerHookCtx = createProviderHookContext(providerCtx);

        // Check if this provider has hook assignments via the provider hook catalog
        const providerHookCatalog = appCtx.services.providerHookCatalog;
        const providerId = resolvedModel.providerId || resolvedModel.provider_id;
        const pipeline = providerHookCatalog
          ? providerHookCatalog.getProviderPipeline(providerId)
          : null;

        let handle;
        let collected;

        if (pipeline && (pipeline.request.length || pipeline.stream.length || pipeline.response.length)) {
          // Provider has hook assignments — execute through the hook pipeline
          try {
            handle = await executeProviderPipeline({
              requestHooks: pipeline.request,
              streamHooks: pipeline.stream,
              responseHooks: pipeline.response,
              executor: (ctx) => executor.execute(ctx),
              ctx: providerHookCtx,
              log,
            });
          } catch (err) {
            throw classifyExecutionError(executor, err, providerHookCtx);
          }

          try {
            collected = await collectNormalizedStream(handle.stream, {
              maxExcerptChars: appCtx.config.defaults.responseExcerptChars,
            });
          } catch (err) {
            throw classifyExecutionError(executor, err, providerHookCtx);
          }

          // Run response hooks after collection
          applyCollectedResultToHookContext(providerHookCtx, collected);
          await runResponseHooks(handle, providerHookCtx, log);
          collected = readCollectedResultFromHookContext(providerHookCtx, collected);
        } else {
          // No hook assignments — direct execution as before
          try {
            handle = await executor.execute(providerCtx);
          } catch (err) {
            throw classifyExecutionError(executor, err, providerCtx);
          }

          try {
            collected = await collectNormalizedStream(handle.stream, {
              maxExcerptChars: appCtx.config.defaults.responseExcerptChars,
            });
          } catch (err) {
            throw classifyExecutionError(executor, err, providerCtx);
          }
        }

        return {
          collected,
          accountId: handle.accountId || credentialLease?.accountId || null,
          queueWaitMs,
        };
      } finally {
        if (credentialLease && credentialManager) {
          credentialManager.release(credentialLease);
        }
        clear();
      }
    });

    if (error) throw error;

    return { ...result, retryTrace: trace, model: resolvedModel };
  } finally {
    release();
  }
}

function classifyExecutionError(executor, error, providerCtx) {
  if (typeof executor?.classifyError !== 'function') {
    return error;
  }

  try {
    return executor.classifyError(error, providerCtx);
  } catch {
    return error;
  }
}

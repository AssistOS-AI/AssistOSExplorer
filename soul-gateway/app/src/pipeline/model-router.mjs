import { getModelByName } from '../db/models-dao.mjs';
import { ModelNotFoundError } from '../utils/errors.mjs';
import { lookupOpenRouterPricing } from './openrouter-pricing.mjs';

/**
 * Resolve the requested model to a provider/model pair.
 * Looks up model_configs for provider_key + provider_model.
 * Returns: { resolvedModel, providerKey, providerModel, mode, inputPrice, outputPrice, maxConcurrency }
 */
export async function resolveModel(requestedModel) {
  const modelConfig = await getModelByName(requestedModel);
  if (!modelConfig) {
    throw new ModelNotFoundError(requestedModel);
  }

  if (!modelConfig.is_enabled) {
    throw new ModelNotFoundError(`${requestedModel} (disabled)`);
  }

  const providerKey = modelConfig.provider_key;
  const providerModel = modelConfig.provider_model;

  if (!providerKey || !providerModel) {
    throw new ModelNotFoundError(`${requestedModel} (missing provider configuration)`);
  }

  let inputPrice = parseFloat(modelConfig.input_price) || 0;
  let outputPrice = parseFloat(modelConfig.output_price) || 0;

  // Fallback: if DB has no pricing, look up the provider_model on OpenRouter
  if (inputPrice === 0 && outputPrice === 0) {
    const orPricing = await lookupOpenRouterPricing(providerModel);
    if (orPricing) {
      inputPrice = orPricing.input_price;
      outputPrice = orPricing.output_price;
    }
  }

  return {
    resolvedModel: requestedModel,
    providerKey,
    providerModel,
    mode: modelConfig.mode,
    inputPrice,
    outputPrice,
    maxConcurrency: parseInt(modelConfig.max_concurrency) || 3,
  };
}

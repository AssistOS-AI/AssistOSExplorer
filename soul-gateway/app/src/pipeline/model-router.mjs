import { getModelByName } from '../db/models-dao.mjs';
import { ModelNotFoundError } from '../utils/errors.mjs';
import { lookupOpenRouterPricing } from './openrouter-pricing.mjs';

/**
 * Resolve the requested model to a provider/model pair.
 * 1. Check family model_mapping for remapping
 * 2. Look up model_configs for provider_key + provider_model
 * 3. Validate against family allowed_models (if set)
 * Returns: { resolvedModel, providerKey, providerModel, mode, inputPrice, outputPrice }
 */
export async function resolveModel(requestedModel, familyContext) {
  const { model_mapping, allowed_models } = familyContext;

  // Step 1: Apply family-level model mapping
  let modelName = requestedModel;
  if (model_mapping && model_mapping[requestedModel]) {
    modelName = model_mapping[requestedModel];
  }

  // Step 2: Look up in model_configs
  const modelConfig = await getModelByName(modelName);
  if (!modelConfig) {
    throw new ModelNotFoundError(modelName);
  }

  if (!modelConfig.is_enabled) {
    throw new ModelNotFoundError(`${modelName} (disabled)`);
  }

  // Step 3: Validate against family allowlist
  if (allowed_models && allowed_models.length > 0) {
    if (!allowed_models.includes(modelName) && !allowed_models.includes(requestedModel)) {
      throw new ModelNotFoundError(modelName);
    }
  }

  const providerKey = modelConfig.provider_key;
  const providerModel = modelConfig.provider_model;

  if (!providerKey || !providerModel) {
    throw new ModelNotFoundError(`${modelName} (missing provider configuration)`);
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
    resolvedModel: modelName,
    providerKey,
    providerModel,
    mode: modelConfig.mode,
    inputPrice,
    outputPrice,
    maxConcurrency: parseInt(modelConfig.max_concurrency) || 3,
  };
}

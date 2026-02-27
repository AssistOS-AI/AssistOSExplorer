import { getModelByName } from '../db/models-dao.mjs';
import { getTierByName } from '../db/tiers-dao.mjs';
import { ModelNotFoundError } from '../utils/errors.mjs';
import { lookupOpenRouterPricing } from './openrouter-pricing.mjs';

/**
 * Build the return object from a resolved model_config row.
 */
async function buildModelInfo(requestedModel, modelConfig) {
  const providerKey = modelConfig.provider_key;
  const providerModel = modelConfig.provider_model;

  if (!providerKey || !providerModel) {
    throw new ModelNotFoundError(`${modelConfig.name} (missing provider configuration)`);
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

/**
 * Resolve a tier name to the first enabled model in its model list.
 * Follows the fallback_tier chain if no enabled model found in the current tier.
 */
async function resolveFromTier(tierName, visited = new Set()) {
  if (visited.has(tierName)) return null; // prevent cycles
  visited.add(tierName);

  const tier = await getTierByName(tierName);
  if (!tier || !tier.is_enabled) return null;

  // Try each model in priority order
  for (const modelName of (tier.models || [])) {
    const mc = await getModelByName(modelName);
    if (mc && mc.is_enabled && mc.provider_key && mc.provider_model) {
      return mc;
    }
  }

  // Follow fallback tier chain
  if (tier.fallback_tier) {
    return resolveFromTier(tier.fallback_tier, visited);
  }

  return null;
}

/**
 * Resolve the requested model to a provider/model pair.
 * 1. Looks up model_configs by name
 * 2. If not found, looks up model_tiers by name and picks the first enabled model
 * Returns: { resolvedModel, providerKey, providerModel, mode, inputPrice, outputPrice, maxConcurrency }
 */
export async function resolveModel(requestedModel) {
  // 1. Direct model_config lookup
  const modelConfig = await getModelByName(requestedModel);
  if (modelConfig) {
    if (!modelConfig.is_enabled) {
      throw new ModelNotFoundError(`${requestedModel} (disabled)`);
    }
    return buildModelInfo(requestedModel, modelConfig);
  }

  // 2. Tier-based lookup: treat the requested name as a tier
  const resolved = await resolveFromTier(requestedModel);
  if (resolved) {
    return buildModelInfo(requestedModel, resolved);
  }

  throw new ModelNotFoundError(requestedModel);
}

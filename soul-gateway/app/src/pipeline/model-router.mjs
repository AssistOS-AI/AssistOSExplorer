import { getModelByName, getTierByName } from '../db/models-dao.mjs';
import { ModelNotFoundError } from '../utils/errors.mjs';
import { lookupOpenRouterPricing } from './openrouter-pricing.mjs';
import { isModelInCooldown } from './model-cooldown.mjs';

/**
 * Build the return object from a resolved model_config row.
 */
async function buildModelInfo(requestedModel, modelConfig, tier = null) {
  const providerKey = modelConfig.provider_key;
  const providerModel = modelConfig.provider_model;

  if (!providerKey || !providerModel) {
    throw new ModelNotFoundError(`${modelConfig.name} (missing provider configuration)`);
  }

  let inputPrice = parseFloat(modelConfig.input_price) || 0;
  let outputPrice = parseFloat(modelConfig.output_price) || 0;

  // Fallback: if DB has no pricing and model is token-priced, look up on OpenRouter
  if (inputPrice === 0 && outputPrice === 0 && (modelConfig.pricing_type || 'token') !== 'request') {
    const orPricing = await lookupOpenRouterPricing(providerModel);
    if (orPricing) {
      inputPrice = orPricing.input_price;
      outputPrice = orPricing.output_price;
    }
  }

  return {
    resolvedModel: requestedModel,
    modelConfigName: modelConfig.name,
    modelConfigId: modelConfig.id,
    providerKey,
    providerModel,
    providerConfigId: modelConfig.provider_config_id || null,
    mode: modelConfig.mode,
    inputPrice,
    outputPrice,
    pricingType: modelConfig.pricing_type || 'token',
    requestCost: parseFloat(modelConfig.request_cost) || 0,
    isFree: !!modelConfig.is_free,
    maxConcurrency: parseInt(modelConfig.max_concurrency) || 3,
    tierName: tier?.name || null,
    tierId: tier?.id || null,
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
  for (const modelName of (tier.model_refs || [])) {
    if (isModelInCooldown(modelName)) continue;
    const mc = await getModelByName(modelName);
    if (mc && mc.is_enabled && mc.provider_key && mc.provider_model) {
      return { modelConfig: mc, tier };
    }
  }

  // Follow fallback tier chain
  if (tier.fallback_model) {
    return resolveFromTier(tier.fallback_model, visited);
  }

  return null;
}

/**
 * Resolve the requested model to a provider/model pair.
 * 1. Looks up model_configs by name
 * 2. If not found, looks up model_tiers by name and picks the first enabled model
 * 3. Backward compat: tries stripping/adding axl/ prefix for old-style names
 * Returns: { resolvedModel, providerKey, providerModel, mode, inputPrice, outputPrice, maxConcurrency }
 */
export async function resolveModel(requestedModel) {
  // 1. Direct model_config lookup
  const modelConfig = await getModelByName(requestedModel);
  if (modelConfig && modelConfig.type !== 'tier') {
    if (!modelConfig.is_enabled) {
      throw new ModelNotFoundError(`${requestedModel} (disabled)`);
    }
    return buildModelInfo(requestedModel, modelConfig, null);
  }

  // 2. Tier-based lookup: treat the requested name as a tier
  const resolved = await resolveFromTier(requestedModel);
  if (resolved) {
    return buildModelInfo(requestedModel, resolved.modelConfig, resolved.tier);
  }

  // 3. Handle disabled tier
  if (modelConfig && modelConfig.type === 'tier' && !modelConfig.is_enabled) {
    throw new ModelNotFoundError(`${requestedModel} (disabled)`);
  }

  // 4. Backward compat: old axl/<provider>/<model> → try <provider>/<model>
  if (requestedModel.startsWith('axl/')) {
    const stripped = requestedModel.slice(4);
    const mc = await getModelByName(stripped);
    if (mc && mc.type !== 'tier' && mc.is_enabled) {
      return buildModelInfo(requestedModel, mc, null);
    }
  }

  // 5. Backward compat: old plain tier name → try axl/<name>
  if (!requestedModel.includes('/')) {
    const prefixed = `axl/${requestedModel}`;
    const tierResolved = await resolveFromTier(prefixed);
    if (tierResolved) {
      return buildModelInfo(requestedModel, tierResolved.modelConfig, tierResolved.tier);
    }
  }

  throw new ModelNotFoundError(requestedModel);
}

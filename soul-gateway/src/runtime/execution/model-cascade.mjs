import { TierExhaustedError } from '../../core/errors.mjs';

/**
 * Model cascade — tries each model in a tier's priority list.
 *
 * When a model fails:
 *  - Quota/rate-limit errors: model enters cooldown, re-resolve tier
 *  - Other classified errors: cascade immediately, no cooldown
 *  - Unclassified errors: fail without cascade
 *
 * @param {object} cascadeCtx
 * @param {function} cascadeCtx.resolveTier - (tierKey, options) => { model, tier }
 * @param {function} cascadeCtx.dispatch - (model) => result
 * @param {string} cascadeCtx.tierKey - tier being resolved
 * @param {number} cascadeCtx.maxAttempts - max model attempts
 * @param {Set} cascadeCtx.failedModels - models that failed in this request
 * @param {function} cascadeCtx.onCooldown - (modelKey, error) => void
 * @param {object} cascadeCtx.log - logger
 */
export async function executeModelCascade(cascadeCtx) {
  const {
    resolveTier,
    dispatch,
    tierKey,
    maxAttempts,
    failedModels = new Set(),
    onCooldown,
    log,
  } = cascadeCtx;

  const trace = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resolution = resolveTier(tierKey, { excludeModels: failedModels });

    if (!resolution) {
      throw new TierExhaustedError(tierKey);
    }

    const { model } = resolution;
    const modelKey = model.modelKey || model.model_key;
    log.info('cascade attempt', { tierKey, model: modelKey, attempt });

    try {
      const result = await dispatch(model);
      return { result, trace, model };
    } catch (err) {
      failedModels.add(modelKey);

      trace.push({
        attempt,
        model: modelKey,
        error_type: err.errorType || 'unknown',
        cascade: !!err.cascade,
        cooldown: !!err.cooldown,
        timestamp: new Date().toISOString(),
      });

      // Apply cooldown if applicable
      if (err.cooldown && onCooldown) {
        onCooldown(modelKey, err);
      }

      // Only cascade if the error is classified and allows it
      if (!err.cascade) {
        throw err;
      }

      // Continue to next model in tier
    }
  }

  throw new TierExhaustedError(tierKey);
}

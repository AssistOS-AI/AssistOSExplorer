/**
 * View transform for provider-model discovery results.
 *
 * Provider plugins return discovered models in a camelCase,
 * capability-rich shape:
 *
 *   { modelId, displayName, contextWindow, maxOutputTokens,
 *     supportsTools, supportsStreaming, supportsVision }
 *
 * The dashboard's discovery modal and `addDiscoveredModel` flow
 * were written against the old gateway's pricing-centric shape:
 *
 *   { id, display_name, owned_by, input_price, output_price, ... }
 *
 * Translate the plugin contract into the dashboard contract at the
 * management-API boundary so the plugin interface can stay
 * domain-focused and the dashboard stays untouched.
 */

/**
 * Transform a single discovered model.
 *
 * @param {object} model                Plugin discovery object
 * @param {object} [options]
 * @param {string|null} [options.providerName]  Used as owned_by fallback
 * @returns {object|null}
 */
export function toDiscoveryView(model, { providerName = null } = {}) {
  if (!model) return null;

  const id = model.modelId || model.model_key || model.id || null;
  if (!id) return null;

  const inputPrice = Number.parseFloat(
    model.input_price ?? model.inputPrice ?? 0,
  ) || 0;
  const outputPrice = Number.parseFloat(
    model.output_price ?? model.outputPrice ?? 0,
  ) || 0;

  return {
    id,
    display_name: model.displayName || model.display_name || id,
    owned_by: model.owned_by || model.ownedBy || providerName || null,
    input_price: inputPrice,
    output_price: outputPrice,
    context_window: model.contextWindow ?? model.context_window ?? null,
    max_output_tokens: model.maxOutputTokens ?? model.max_output_tokens ?? null,
    supports_tools: model.supportsTools ?? model.supports_tools ?? null,
    supports_streaming: model.supportsStreaming ?? model.supports_streaming ?? null,
    supports_vision: model.supportsVision ?? model.supports_vision ?? null,
  };
}

/**
 * Transform a list of discovered models, skipping entries that lack an id.
 *
 * @param {Array<object>} models
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function toDiscoveryList(models, options = {}) {
  if (!Array.isArray(models)) return [];
  return models.map((m) => toDiscoveryView(m, options)).filter(Boolean);
}

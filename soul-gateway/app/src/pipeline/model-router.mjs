import { getModelByName } from '../db/models-dao.mjs';
import { ModelNotFoundError } from '../utils/errors.mjs';

/**
 * Resolve the requested model to an upstream model name.
 * 1. Check family model_mapping for remapping
 * 2. Look up model_configs for the upstream name
 * 3. Validate against family allowed_models (if set)
 * Returns: { resolvedModel, upstreamModel, mode, inputPrice, outputPrice }
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

  return {
    resolvedModel: modelName,
    upstreamModel: modelConfig.upstream_model,
    mode: modelConfig.mode,
    inputPrice: parseFloat(modelConfig.input_price) || 0,
    outputPrice: parseFloat(modelConfig.output_price) || 0,
  };
}

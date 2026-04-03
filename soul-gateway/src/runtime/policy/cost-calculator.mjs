/**
 * Cost calculation for LLM requests.
 *
 * Supports multiple pricing modes:
 *   - token:              per-million-token pricing (input + output)
 *   - request:            flat per-request price
 *   - free:               zero cost
 *   - external_directory:  lookup from an external pricing directory
 */

/**
 * Calculate the cost of a single request.
 *
 * @param {object} pricingRecord
 * @param {string} pricingRecord.pricingMode  'token' | 'request' | 'free' | 'external_directory'
 * @param {number} [pricingRecord.inputPricePerMillion]
 * @param {number} [pricingRecord.outputPricePerMillion]
 * @param {number} [pricingRecord.requestPriceUsd]
 * @param {object} usage
 * @param {number} usage.inputTokens
 * @param {number} usage.outputTokens
 * @param {import('./pricing-directory.mjs').PricingDirectory} [pricingDirectory]  For external_directory mode
 * @param {string} [providerKey]   Provider key for directory lookup
 * @param {string} [modelId]       Model ID for directory lookup
 * @returns {{ inputCostUsd: number, outputCostUsd: number, totalCostUsd: number, budgetExempt: boolean, pricingMissing: boolean }}
 */
export function calculateRequestCost(pricingRecord, usage, pricingDirectory, providerKey, modelId) {
  const { pricingMode } = pricingRecord;

  if (pricingMode === 'free') {
    return {
      inputCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
      budgetExempt: true,
      pricingMissing: false,
    };
  }

  if (pricingMode === 'request') {
    const cost = pricingRecord.requestPriceUsd || 0;
    return {
      inputCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: cost,
      budgetExempt: false,
      pricingMissing: false,
    };
  }

  if (pricingMode === 'token') {
    const inputCost = (usage.inputTokens / 1_000_000) * (pricingRecord.inputPricePerMillion || 0);
    const outputCost = (usage.outputTokens / 1_000_000) * (pricingRecord.outputPricePerMillion || 0);
    return {
      inputCostUsd: inputCost,
      outputCostUsd: outputCost,
      totalCostUsd: inputCost + outputCost,
      budgetExempt: false,
      pricingMissing: false,
    };
  }

  if (pricingMode === 'external_directory') {
    if (pricingDirectory && providerKey && modelId) {
      const entry = pricingDirectory.lookup(providerKey, modelId);
      if (entry) {
        const inputCost = (usage.inputTokens / 1_000_000) * entry.inputPricePerMillion;
        const outputCost = (usage.outputTokens / 1_000_000) * entry.outputPricePerMillion;
        return {
          inputCostUsd: inputCost,
          outputCostUsd: outputCost,
          totalCostUsd: inputCost + outputCost,
          budgetExempt: false,
          pricingMissing: false,
        };
      }
    }

    // Directory lookup failed — return 0 with warning flag
    return {
      inputCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
      budgetExempt: false,
      pricingMissing: true,
    };
  }

  // Unknown pricing mode — treat as missing
  return {
    inputCostUsd: 0,
    outputCostUsd: 0,
    totalCostUsd: 0,
    budgetExempt: false,
    pricingMissing: true,
  };
}

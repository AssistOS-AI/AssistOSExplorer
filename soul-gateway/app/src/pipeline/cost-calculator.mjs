/**
 * Calculate cost based on token usage and model pricing.
 * For token-priced models: prices are per 1M tokens.
 * For request-priced models: flat requestCost per request.
 */
export function calculateCost(usage, inputPrice, outputPrice, pricingType, requestCost) {
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = promptTokens + completionTokens;

  let inputCost, outputCost, totalCost;
  if (pricingType === 'request') {
    inputCost = 0;
    outputCost = 0;
    totalCost = requestCost || 0;
  } else {
    inputCost = (promptTokens / 1_000_000) * inputPrice;
    outputCost = (completionTokens / 1_000_000) * outputPrice;
    totalCost = inputCost + outputCost;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    input_cost: Math.round(inputCost * 1_000_000) / 1_000_000,
    output_cost: Math.round(outputCost * 1_000_000) / 1_000_000,
    total_cost: Math.round(totalCost * 1_000_000) / 1_000_000,
  };
}

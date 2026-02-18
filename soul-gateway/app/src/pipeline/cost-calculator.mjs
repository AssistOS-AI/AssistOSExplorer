/**
 * Calculate cost based on token usage and model pricing.
 * Prices are per 1M tokens.
 */
export function calculateCost(usage, inputPrice, outputPrice) {
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = promptTokens + completionTokens;

  const inputCost = (promptTokens / 1_000_000) * inputPrice;
  const outputCost = (completionTokens / 1_000_000) * outputPrice;
  const totalCost = inputCost + outputCost;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    input_cost: Math.round(inputCost * 1_000_000) / 1_000_000, // 6 decimal precision
    output_cost: Math.round(outputCost * 1_000_000) / 1_000_000,
    total_cost: Math.round(totalCost * 1_000_000) / 1_000_000,
  };
}

/**
 * Normalize usage/token data from diverse LLM provider response formats
 * into a canonical shape used throughout the gateway.
 *
 * Providers use inconsistent field names:
 *  - OpenAI/Copilot:  prompt_tokens, completion_tokens
 *  - Anthropic:       input_tokens, output_tokens
 *
 * This helper accepts either convention and produces a canonical object.
 */
export function normalizeUsage(usage) {
    const input = usage.input_tokens || usage.prompt_tokens || 0;
    const output = usage.output_tokens || usage.completion_tokens || 0;
    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: usage.total_tokens || input + output,
    };
}

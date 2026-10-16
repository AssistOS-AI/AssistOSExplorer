/**
 * Quick prompt-token estimator without a real tokenizer.
 *
 * Heuristic: ~4 characters per token for English text.
 * This is a rough estimate used for pre-flight budget checks;
 * actual token counts come from the provider response.
 */

/**
 * Estimate the number of prompt tokens in a chat completion request.
 *
 * @param {object} request  The incoming request body
 * @param {Array<{ role: string, content: string|Array }>} request.messages
 * @returns {number} Estimated token count (integer)
 */
export function estimatePromptTokens(request) {
    const messages = request?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return 0;

    let totalChars = 0;

    for (const msg of messages) {
        totalChars += estimateMessageChars(msg);
    }

    return Math.ceil(totalChars / 4);
}

// ── internals ─────────────────────────────────────────────────────────

/**
 * Estimate character count for a single message, handling both
 * string and multi-part content arrays.
 */
function estimateMessageChars(msg) {
    if (!msg) return 0;

    // Role name overhead (~4 chars per role token)
    let chars = (msg.role || '').length;

    const content = msg.content;

    if (typeof content === 'string') {
        chars += content.length;
    } else if (Array.isArray(content)) {
        // Multi-part content (text + image_url blocks, etc.)
        for (const part of content) {
            if (part && typeof part.text === 'string') {
                chars += part.text.length;
            }
        }
    }

    // Tool calls in assistant messages
    if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            if (tc.function) {
                chars += (tc.function.name || '').length;
                chars += (tc.function.arguments || '').length;
            }
        }
    }

    return chars;
}

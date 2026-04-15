/**
 * Ingress format normalization.
 *
 * Converts incoming request bodies from any supported API format
 * (OpenAI Chat Completions, Anthropic Messages, OpenAI Responses)
 * into the internal normalized representation, which is OpenAI Chat
 * Completions format.
 *
 * The normalized shape:
 *   { messages, model, stream, ...params }
 */

import { UnsupportedFormatError, BadRequestError } from '../core/errors.mjs';

/**
 * Normalize an incoming request body to the internal chat-completions shape.
 *
 * @param {'openai_chat' | 'anthropic_messages' | 'openai_responses'} routeKind
 * @param {object} body - parsed JSON body from the client
 * @returns {{ messages: Array, model: string, stream: boolean, [key: string]: any }}
 */
export function normalizeIncomingFormat(routeKind, body) {
    if (!body || typeof body !== 'object') {
        throw new BadRequestError('Request body must be a JSON object');
    }

    switch (routeKind) {
        case 'openai_chat':
            return normalizeOpenAiChat(body);
        case 'anthropic_messages':
            return normalizeAnthropicMessages(body);
        case 'openai_responses':
            return normalizeOpenAiResponses(body);
        default:
            throw new UnsupportedFormatError(
                `Unsupported ingress format: ${routeKind}`
            );
    }
}

// ── OpenAI Chat Completions ─────────────────────────────────────────

function normalizeOpenAiChat(body) {
    const { messages, model, stream = false, ...rest } = body;
    return {
        messages: messages || [],
        model,
        stream: Boolean(stream),
        ...rest,
    };
}

// ── Anthropic Messages ──────────────────────────────────────────────

function normalizeAnthropicMessages(body) {
    const {
        model,
        messages: anthropicMessages = [],
        system,
        max_tokens,
        stream = false,
        temperature,
        top_p,
        top_k,
        stop_sequences,
        tools: anthropicTools,
        tool_choice,
        metadata,
        ...rest
    } = body;

    const messages = [];

    // System prompt becomes a system message at position 0
    if (system) {
        if (typeof system === 'string') {
            messages.push({ role: 'system', content: system });
        } else if (Array.isArray(system)) {
            // Anthropic allows system as array of content blocks
            messages.push({
                role: 'system',
                content: convertAnthropicContent(system),
            });
        }
    }

    // Convert each Anthropic message. Tool result messages may expand
    // to an array of OpenAI tool messages (one per tool_result block).
    for (const msg of anthropicMessages) {
        const converted = convertAnthropicMessage(msg);
        if (Array.isArray(converted)) {
            messages.push(...converted);
        } else {
            messages.push(converted);
        }
    }

    const normalized = { messages, model, stream: Boolean(stream) };

    if (max_tokens != null) normalized.max_tokens = max_tokens;
    if (temperature != null) normalized.temperature = temperature;
    if (top_p != null) normalized.top_p = top_p;
    if (stop_sequences) normalized.stop = stop_sequences;

    // Convert Anthropic tool definitions to OpenAI format
    if (anthropicTools && anthropicTools.length > 0) {
        normalized.tools = anthropicTools.map(convertAnthropicToolDef);
    }

    if (tool_choice) {
        normalized.tool_choice = convertAnthropicToolChoice(tool_choice);
    }

    return normalized;
}

/**
 * Convert a single Anthropic message to OpenAI chat message format.
 */
function convertAnthropicMessage(msg) {
    const { role, content } = msg;

    // Anthropic uses 'assistant' and 'user' roles — same as OpenAI.
    const openaiRole = role;

    // Simple string content passes through
    if (typeof content === 'string') {
        return { role: openaiRole, content };
    }

    // Array of content blocks
    if (Array.isArray(content)) {
        // Check if message contains tool_use blocks (assistant tool calls)
        const toolUseBlocks = content.filter((b) => b.type === 'tool_use');
        const toolResultBlocks = content.filter(
            (b) => b.type === 'tool_result'
        );

        if (toolUseBlocks.length > 0) {
            // Convert to OpenAI tool_calls format
            const textParts = content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('');
            const toolCalls = toolUseBlocks.map((block) => ({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments:
                        typeof block.input === 'string'
                            ? block.input
                            : JSON.stringify(block.input),
                },
            }));

            const result = { role: 'assistant', tool_calls: toolCalls };
            if (textParts) result.content = textParts;
            return result;
        }

        if (toolResultBlocks.length > 0 && role === 'user') {
            // Anthropic sends tool results as user messages with tool_result content blocks.
            // Each block maps to a separate OpenAI tool message.
            return toolResultBlocks.map((block) => ({
                role: 'tool',
                tool_call_id: block.tool_use_id,
                content:
                    typeof block.content === 'string'
                        ? block.content
                        : JSON.stringify(block.content),
            }));
        }

        // Generic content array: convert to OpenAI multipart content
        return { role: openaiRole, content: convertAnthropicContent(content) };
    }

    return { role: openaiRole, content: content ?? '' };
}

/**
 * Convert Anthropic content blocks array to OpenAI multipart content format.
 */
function convertAnthropicContent(blocks) {
    if (!Array.isArray(blocks)) return blocks;

    const parts = [];
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
                parts.push({ type: 'text', text: block.text });
                break;
            case 'image': {
                const src = block.source || {};
                parts.push({
                    type: 'image_url',
                    image_url: {
                        url:
                            src.type === 'base64'
                                ? `data:${src.media_type};base64,${src.data}`
                                : src.url || '',
                    },
                });
                break;
            }
            default:
                // Pass through unknown block types as text representation
                parts.push({ type: 'text', text: JSON.stringify(block) });
                break;
        }
    }

    // If all parts are text, collapse to a single string
    if (parts.length > 0 && parts.every((p) => p.type === 'text')) {
        return parts.map((p) => p.text).join('');
    }

    return parts;
}

/**
 * Convert an Anthropic tool definition to OpenAI function-calling format.
 */
function convertAnthropicToolDef(tool) {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || {},
        },
    };
}

/**
 * Convert Anthropic tool_choice to OpenAI tool_choice.
 */
function convertAnthropicToolChoice(choice) {
    if (typeof choice === 'string') {
        // "auto", "any", "none"
        if (choice === 'any') return 'required';
        return choice; // "auto" and "none" are the same in OpenAI
    }
    if (choice && choice.type === 'tool') {
        return { type: 'function', function: { name: choice.name } };
    }
    if (choice && choice.type === 'auto') return 'auto';
    if (choice && choice.type === 'any') return 'required';
    return choice;
}

// ── OpenAI Responses API ────────────────────────────────────────────

function normalizeOpenAiResponses(body) {
    const {
        model,
        input,
        instructions,
        stream = false,
        temperature,
        top_p,
        max_output_tokens,
        tools: responsesTools,
        tool_choice,
        ...rest
    } = body;

    const messages = [];

    // Instructions map to a system message
    if (instructions) {
        messages.push({ role: 'system', content: instructions });
    }

    // Input can be a string or an array of input items
    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
        for (const item of input) {
            messages.push(convertResponsesInputItem(item));
        }
    }

    const normalized = { messages, model, stream: Boolean(stream) };

    if (max_output_tokens != null) normalized.max_tokens = max_output_tokens;
    if (temperature != null) normalized.temperature = temperature;
    if (top_p != null) normalized.top_p = top_p;
    if (tool_choice != null) normalized.tool_choice = tool_choice;

    // Convert Responses API tools to OpenAI chat tools
    if (responsesTools && responsesTools.length > 0) {
        normalized.tools = responsesTools
            .filter((t) => t.type === 'function')
            .map((t) => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description || '',
                    parameters: t.parameters || {},
                },
            }));
    }

    return normalized;
}

/**
 * Convert a Responses API input item to a chat message.
 */
function convertResponsesInputItem(item) {
    if (typeof item === 'string') {
        return { role: 'user', content: item };
    }

    // Responses API input items have a `type` field
    switch (item.type) {
        case 'message':
            return {
                role: item.role || 'user',
                content:
                    typeof item.content === 'string'
                        ? item.content
                        : Array.isArray(item.content)
                          ? item.content
                                .map(convertResponsesContentPart)
                                .filter(Boolean)
                          : '',
            };

        case 'item_reference':
            // Pass through as a user message with the referenced content
            return { role: 'user', content: item.text || '' };

        default:
            // Treat unknown types as user messages
            return {
                role: item.role || 'user',
                content: item.content || item.text || '',
            };
    }
}

/**
 * Convert a Responses API content part to an OpenAI chat content part.
 */
function convertResponsesContentPart(part) {
    if (typeof part === 'string') return { type: 'text', text: part };

    switch (part.type) {
        case 'input_text':
            return { type: 'text', text: part.text };
        case 'input_image':
            return {
                type: 'image_url',
                image_url: {
                    url: part.image_url || part.url || '',
                    ...(part.detail ? { detail: part.detail } : {}),
                },
            };
        case 'input_audio':
            return { type: 'text', text: '[audio input]' };
        default:
            return { type: 'text', text: part.text || '' };
    }
}

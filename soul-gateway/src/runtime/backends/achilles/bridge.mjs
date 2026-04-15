import { normalizeUsage } from '../normalize-usage.mjs';

export function getCredentialToken(credentialLease) {
    return credentialLease?.secret || credentialLease?.oauth?.accessToken || '';
}

export function createAchillesExecutionHandle(ctx, familyModule, options) {
    const stream = toGatewayNormalizedStream(
        familyModule.callLLMStreaming(ctx.request?.messages || [], options),
        {
            requestId: ctx.requestId,
            model: options.model,
        }
    );

    return {
        accountId: ctx.credentialLease?.accountId || null,
        stream,
        abort: async () => {},
    };
}

export async function* toGatewayNormalizedStream(source, meta = {}) {
    let started = false;
    let usageEmitted = false;
    let sawToolDelta = false;
    let doneEmitted = false;

    const emitMessageStart = async function* () {
        if (started) return;
        started = true;
        yield {
            type: 'message_start',
            data: {
                id: meta.requestId || null,
                model: meta.model || null,
                role: 'assistant',
            },
        };
    };

    for await (const chunk of source) {
        switch (chunk?.type) {
            case 'message_start': {
                started = true;
                yield {
                    type: 'message_start',
                    data: {
                        id:
                            chunk.id ||
                            chunk.data?.id ||
                            meta.requestId ||
                            null,
                        model:
                            chunk.model ||
                            chunk.data?.model ||
                            meta.model ||
                            null,
                        role: chunk.role || chunk.data?.role || 'assistant',
                    },
                };
                break;
            }

            case 'text_delta': {
                yield* emitMessageStart();
                const text = chunk.text ?? chunk.data?.text ?? '';
                if (text) {
                    yield { type: 'text_delta', data: { text } };
                }
                break;
            }

            case 'thinking_delta': {
                break;
            }

            case 'tool_calls_delta': {
                yield* emitMessageStart();
                sawToolDelta = true;
                for (const toolCall of chunk.toolCalls || []) {
                    yield {
                        type: 'tool_call_delta',
                        data: {
                            index: toolCall.index ?? 0,
                            id: toolCall.id,
                            name: toolCall.function?.name || toolCall.name,
                            arguments:
                                toolCall.function?.arguments ||
                                toolCall.arguments ||
                                '',
                        },
                    };
                }
                break;
            }

            case 'usage': {
                usageEmitted = true;
                yield { type: 'usage', data: normalizeUsage(chunk) };
                break;
            }

            case 'done': {
                yield* emitMessageStart();

                if (chunk.usage && !usageEmitted) {
                    usageEmitted = true;
                    yield { type: 'usage', data: normalizeUsage(chunk.usage) };
                }

                if (!sawToolDelta && Array.isArray(chunk.toolCalls)) {
                    for (const [index, toolCall] of chunk.toolCalls.entries()) {
                        yield {
                            type: 'tool_call_delta',
                            data: {
                                index,
                                id: toolCall.id,
                                name: toolCall.function?.name || toolCall.name,
                                arguments:
                                    toolCall.function?.arguments ||
                                    toolCall.arguments ||
                                    '',
                            },
                        };
                    }
                }

                doneEmitted = true;
                yield {
                    type: 'done',
                    data: {
                        finish_reason:
                            chunk.stopReason ||
                            chunk.finish_reason ||
                            chunk.data?.finish_reason ||
                            'stop',
                        model:
                            meta.model ||
                            chunk.model ||
                            chunk.data?.model ||
                            null,
                    },
                };
                break;
            }

            case 'error': {
                yield {
                    type: 'error',
                    error:
                        chunk.error ||
                        new Error(
                            chunk.message ||
                                chunk.data?.message ||
                                'Provider stream error'
                        ),
                };
                break;
            }

            default:
                break;
        }
    }

    // If the stream ended without a `done` event, emit a synthetic one.
    if (!doneEmitted) {
        yield* emitMessageStart();
        yield {
            type: 'done',
            data: { finish_reason: 'stop', model: meta.model || null },
        };
    }
}


export function isWebchatEscapeControlChunk(chunk) {
    if (chunk === undefined || chunk === null) {
        return false;
    }

    const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk);

    return text.includes('\x1b') || text.includes('\u001b');
}

export function handleWebchatControlChunk(chunk, {
    isProcessing,
    abortController = null
}) {
    if (!isProcessing || !isWebchatEscapeControlChunk(chunk)) {
        return false;
    }

    if (abortController && typeof abortController.abort === 'function' && !abortController.signal?.aborted) {
        abortController.abort('esc');
    }

    return true;
}

function extractToolText(response) {
    const result = response && response.result ? response.result : response;
    if (typeof result === 'string') return result;
    if (result && Array.isArray(result.content)) {
        return result.content
            .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
            .map((entry) => entry.text)
            .join('\n');
    }
    if (result && typeof result.text === 'string') return result.text;
    return '';
}

export function extractToolJson(response) {
    const text = extractToolText(response).trim();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (error) {
        if (/^MCP error\b/i.test(text)) {
            throw new Error(text);
        }
        throw new Error(`invalid JSON tool response: ${error.message}`);
    }
}

export function openCodeGatewayModels(catalog) {
    if (!Array.isArray(catalog?.data) || catalog.data.length > 10000) {
        throw new Error('Soul Gateway returned an invalid model catalog.');
    }
    const entries = catalog.data.map((entry) => {
        if (typeof entry?.id !== 'string' || !entry.id.trim() || entry.id.length > 512
            || /[\x00-\x1f\x7f]/u.test(entry.id)) throw new Error('Soul Gateway returned an invalid model ID.');
        const model = { name: typeof entry.name === 'string' ? entry.name : entry.id };
        const context = entry._context?.window;
        const output = entry._context?.max_output_tokens;
        if (Number.isSafeInteger(context) && context > 0 && Number.isSafeInteger(output) && output > 0) {
            model.limit = { context, output };
        }
        const price = entry._pricing;
        if (price?.mode === 'token' && Number.isFinite(price.input_per_million) && price.input_per_million >= 0
            && Number.isFinite(price.output_per_million) && price.output_per_million >= 0) {
            model.cost = { input: price.input_per_million, output: price.output_per_million };
        }
        return [entry.id, model];
    });
    return Object.fromEntries(entries);
}

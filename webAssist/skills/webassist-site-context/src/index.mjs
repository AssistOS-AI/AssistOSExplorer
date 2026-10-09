import { loadAkuContext } from '../../../src/runtime/load-aku-context.mjs';

function parseInput(promptText) {
    try {
        const parsed = JSON.parse(String(promptText ?? '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        throw new Error('webassist-site-context expects promptText to be valid JSON.');
    }
}

// The site and session come only from the trusted runtime context; any
// `siteId`/`sessionId` the model writes into the payload is ignored.
export async function action({ promptText, context }) {
    const { message } = parseInput(promptText);
    const siteDataDir = context?.siteDataDir || '';
    const siteId = context?.siteId || '';
    const sessionId = context?.sessionId || '';
    if (!siteDataDir || !siteId || !sessionId) {
        throw new Error('webassist-site-context requires context.siteDataDir, context.siteId and context.sessionId.');
    }

    const akuContext = await loadAkuContext({
        siteDataDir,
        siteId,
        sessionId,
        message: message || '',
    });

    return akuContext.akuContextText || 'No relevant site context found.';
}

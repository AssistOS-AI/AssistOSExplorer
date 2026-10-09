import { updateSessionProfile } from '../../../src/runtime/update-session.mjs';

function parsePayload(promptText) {
    let payload;
    try {
        payload = JSON.parse(String(promptText ?? '{}'));
    } catch {
        throw new Error('webassist-session expects promptText to be valid JSON.');
    }

    if (!payload || typeof payload !== 'object') {
        throw new Error('webassist-session input must be an object.');
    }

    return payload;
}

// The site and session come only from the trusted runtime context; any
// `siteId`/`sessionId` the model writes into the payload is ignored.
export async function action({ promptText, context }) {
    const {
        profileDetails,
        contactInformation,
    } = parsePayload(promptText);

    const siteDataDir = context?.siteDataDir || '';
    const siteId = context?.siteId || '';
    const sessionId = context?.sessionId || '';
    if (!siteDataDir || !siteId || !sessionId) {
        throw new Error('webassist-session requires context.siteDataDir, context.siteId and context.sessionId.');
    }

    const saved = await updateSessionProfile({
        siteDataDir,
        siteId,
        sessionId,
        profileDetails: Array.isArray(profileDetails) ? profileDetails : [],
        contactInformation: contactInformation || {},
    });

    const detailCount = Array.isArray(profileDetails) ? profileDetails.length : 0;
    const contactKeys = contactInformation ? Object.keys(contactInformation).length : 0;
    return `[internal] Session profile persisted: ${detailCount} detail(s), ${contactKeys} contact field(s). Compose visitor-facing response.`;
}

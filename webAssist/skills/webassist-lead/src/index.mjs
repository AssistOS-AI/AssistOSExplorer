import { AgenticKnowledgeUnits } from 'achillesAgentLib';
import path from 'node:path';

function parseInput(promptText) {
    let parsed;
    try {
        parsed = JSON.parse(String(promptText ?? '{}'));
    } catch {
        throw new Error('webassist-lead expects promptText to be valid JSON.');
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('webassist-lead input must be an object.');
    }
    return parsed;
}

function normalizeContactInfo(contactInfo) {
    const entries = Object.entries(contactInfo ?? {})
        .map(([key, value]) => [String(key).trim(), String(value ?? '').trim()])
        .filter(([key, value]) => key && value);

    if (entries.length === 0) {
        throw new Error('webassist-lead requires at least one explicit contact detail.');
    }

    return Object.fromEntries(entries);
}

function getLeadKuId(sessionId) {
    return `ku_lead_${sessionId}`;
}

function getSessionKuId(sessionId) {
    return `ku_sess_${sessionId}`;
}

async function getAkuInstance(siteDataDir, siteId) {
    if (!siteDataDir) {
        throw new Error('webassist-lead requires context.siteDataDir.');
    }
    const akuRootDir = path.resolve(siteDataDir);
    const aku = new AgenticKnowledgeUnits({
        rootDir: akuRootDir,
        actor: `webassist/${siteId}`,
    });

    const akuExists = await aku.exists();
    if (!akuExists) {
        throw new Error(`AKU not initialized for site: ${siteId}`);
    }

    await aku.loadAKU();
    return aku;
}

// The site and session come only from the trusted runtime context; any
// `siteId`/`sessionId` the model writes into the payload is ignored.
export async function action({ promptText, context }) {
    const {
        profile,
        contactInfo,
    } = parseInput(promptText);

    const siteDataDir = context?.siteDataDir || '';
    const siteId = context?.siteId || '';
    const sessionId = context?.sessionId || '';
    if (!siteDataDir || !siteId || !sessionId) {
        throw new Error('webassist-lead requires context.siteDataDir, context.siteId and context.sessionId.');
    }
    if (!profile) {
        throw new Error('webassist-lead requires profile.');
    }

    const normalizedContactInfo = normalizeContactInfo(contactInfo);

    const aku = await getAkuInstance(siteDataDir, siteId);
    const leadKuId = getLeadKuId(sessionId);
    const sessionKuId = getSessionKuId(sessionId);
    const timestamp = new Date().toISOString();

    const stateLines = [
        `## Lead Information`,
        `- **Profile**: ${profile}`,
        `- **Session ID**: ${sessionId}`,
        `- **Created**: ${timestamp}`,
        '',
        `## Contact Information`,
        ...Object.entries(normalizedContactInfo).map(([k, v]) => `- **${k}**: ${v}`),
    ];

    let isUpdate = false;
    try {
        await aku.loadKU(leadKuId);
        isUpdate = true;
        await aku.updateKUState(leadKuId, {
            state: stateLines.join('\n'),
            summary: `Lead for profile: ${profile}`,
            metadata: {
                sessionId,
                profile,
                contactInfo: normalizedContactInfo,
                updatedAt: timestamp,
            },
        });
    } catch (error) {
        if (error?.message?.includes('not found')) {
            await aku.initKU({
                ku_id: leadKuId,
                ku_name: `Lead ${sessionId}`,
                ku_type: 'lead',
                keywords: ['lead', profile.toLowerCase(), sessionId],
                tags: ['lead', 'qualified'],
                summary: `Lead for profile: ${profile}`,
                state: stateLines.join('\n'),
                metadata: {
                    sessionId,
                    profile,
                    contactInfo: normalizedContactInfo,
                    createdAt: timestamp,
                },
            });
        } else {
            throw error;
        }
    }

    try {
        await aku.linkKU(sessionKuId, leadKuId, {
            relation: 'produced_result',
            summary: `Session produced lead for ${profile}`,
        });
    } catch {
    }

    const contactFields = Object.keys(normalizedContactInfo).join(', ');
    return `[internal] Lead ${isUpdate ? 'updated' : 'created'} for profile: ${profile}. Contact: ${contactFields}. Compose visitor-facing response.`;
}

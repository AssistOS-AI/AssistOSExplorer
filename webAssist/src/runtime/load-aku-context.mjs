import { AgenticKnowledgeUnits } from 'achillesAgentLib/AgenticKnowledgeUnits';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSiteDataDir } from './akuStore.mjs';

const SESSION_KU_PREFIX = 'ku_sess_';
const LEAD_KU_PREFIX = 'ku_lead_';
const MAX_HISTORY_EVENTS = 20;
const DEFAULT_DEBUG_DIR = '/code/debuglogs';

function isDebugEnabled() {
    const raw = String(process.env.ACHILLES_DEBUG || '').trim().toLowerCase();
    return raw && !['0', 'false', 'no', 'off'].includes(raw);
}

function resolveDebugDir() {
    return path.resolve(process.env.WEBASSIST_DEBUG_DIR || DEFAULT_DEBUG_DIR);
}

function safeFileSegment(value) {
    const normalized = String(value || '')
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
    return normalized || 'unknown';
}

function debugTimestamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

async function writeDebugJson(kind, { siteId, sessionId, payload }) {
    if (!isDebugEnabled()) {
        return null;
    }

    try {
        const debugDir = resolveDebugDir();
        await fs.mkdir(debugDir, { recursive: true });
        const fileName = `${kind}-${debugTimestamp()}-${safeFileSegment(siteId)}-${safeFileSegment(sessionId)}.json`;
        const filePath = path.join(debugDir, fileName);
        await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        return filePath;
    } catch {
        return null;
    }
}

function normalizeMetadataValue(value) {
    if (value === undefined || value === null) {
        return '';
    }
    return String(value).trim();
}

function parseSessionProfileFromState(state) {
    const lines = String(state ?? '').split('\n').map((line) => line.trim());
    let activeSection = '';
    const profileDetails = [];
    const contactInformation = {};

    for (const line of lines) {
        if (/^##\s*Profile\s*Details/i.test(line)) {
            activeSection = 'profile';
            continue;
        }
        if (/^##\s*Contact\s*Information/i.test(line)) {
            activeSection = 'contact';
            continue;
        }
        if (!line.startsWith('-')) {
            continue;
        }
        if (activeSection === 'profile') {
            const value = line.replace(/^-\s*/, '');
            if (value) {
                profileDetails.push(value);
            }
            continue;
        }
        if (activeSection === 'contact') {
            const match = line.match(/-\s*\*\*(.+?)\*\*:\s*(.+)$/);
            if (match) {
                contactInformation[normalizeMetadataValue(match[1]).toLowerCase()] = normalizeMetadataValue(match[2]);
            } else {
                const fallback = line.replace(/^-\s*/, '');
                const fallbackMatch = fallback.match(/^([^:]+):\s*(.+)$/);
                if (fallbackMatch) {
                    contactInformation[normalizeMetadataValue(fallbackMatch[1]).toLowerCase()] = normalizeMetadataValue(fallbackMatch[2]);
                }
            }
        }
    }

    return {
        profileDetails,
        contactInformation,
    };
}

function parseLeadFromState(state) {
    const lines = String(state ?? '').split('\n').map((line) => line.trim());
    let inContactSection = false;
    let profile = '';
    const contactInformation = {};

    for (const line of lines) {
        if (/^##\s*Lead\s*Information/i.test(line)) {
            inContactSection = false;
            continue;
        }
        if (/^##\s*Contact\s*Information/i.test(line)) {
            inContactSection = true;
            continue;
        }
        if (!line.startsWith('-')) {
            continue;
        }

        const profileMatch = line.match(/-\s*\*\*Profile\*\*:\s*(.+)$/i);
        if (profileMatch) {
            profile = normalizeMetadataValue(profileMatch[1]);
            continue;
        }

        if (inContactSection) {
            const contactMatch = line.match(/-\s*\*\*(.+?)\*\*:\s*(.+)$/i);
            if (contactMatch) {
                contactInformation[normalizeMetadataValue(contactMatch[1]).toLowerCase()] = normalizeMetadataValue(contactMatch[2]);
            }
        }
    }

    return { profile, contactInformation };
}

function getSessionKuId(sessionId) {
    return `${SESSION_KU_PREFIX}${sessionId}`;
}

function getLeadKuId(sessionId) {
    return `${LEAD_KU_PREFIX}${sessionId}`;
}

/**
 * Build a manual context pack from search results, including full state for KUs.
 * This avoids the redundancy filtering in buildScopedContextPack that treats
 * KUs and their events as redundant.
 */
async function buildManualContextPack(aku, searchResults, options = {}) {
    const { budgetChars = 6000, includeState = true, maxStateChars = 1500 } = options;
    
    // Deduplicate by ku_id, preferring KUs over events
    const kuMap = new Map();
    for (const result of searchResults) {
        const existing = kuMap.get(result.ku_id);
        if (!existing || (result.record_type === 'ku' && existing.record_type !== 'ku')) {
            kuMap.set(result.ku_id, result);
        }
    }
    
    const results = [];
    let usedChars = 0;
    
    for (const result of kuMap.values()) {
        // Load full KU details including state if requested
        let state = null;
        if (includeState && result.record_type === 'ku') {
            try {
                const ku = await aku.loadKU(result.ku_id);
                state = ku.state || null;
                // Truncate state to maxStateChars to fit more KUs in context
                if (state && state.length > maxStateChars) {
                    state = state.slice(0, maxStateChars) + '...';
                }
            } catch {
                // KU not found, skip state
            }
        }
        
        const item = {
            search_id: result.search_id,
            ku_id: result.ku_id,
            record_type: result.record_type,
            title: result.title || '',
            summary: result.summary || '',
            status: result.status,
            tags: result.tags || [],
            keywords: result.keywords || [],
            path: result.path || '',
            score: result.score,
            matched_on: result.matched_on || [],
            state: state,
        };
        
        // Estimate chars for this item
        const itemChars = JSON.stringify(item).length;
        if (usedChars + itemChars > budgetChars) {
            break;  // Budget exceeded
        }
        
        results.push(item);
        usedChars += itemChars;
    }
    
    return {
        context_pack_id: `manual_${Date.now()}`,
        query: '',
        algorithm: 'manual_search_with_state',
        budget_chars: budgetChars,
        used_chars: usedChars,
        generated_at: new Date().toISOString(),
        results,
        omitted: {
            count: searchResults.length - results.length,
            reason: 'budget limit or deduplication',
        },
    };
}

function formatConversationHistory(events, maxMessages = 10) {
    if (!Array.isArray(events) || events.length === 0) {
        return 'No previous conversation history found.';
    }

    const turnEvents = events
        .filter(e => e.event_type === 'turn' && e.metadata?.speaker && e.metadata?.message)
        .slice(-maxMessages);

    if (turnEvents.length === 0) {
        return 'No previous conversation history found.';
    }

    return turnEvents
        .map(e => `- **${e.metadata.speaker}**: ${e.metadata.message}`)
        .join('\n');
}

function isProfileRecord(record) {
    const tags = Array.isArray(record?.tags) ? record.tags.map(tag => String(tag).toLowerCase()) : [];
    const kuId = String(record?.ku_id || '');
    const kuType = String(record?.ku_type || '').toLowerCase();
    if (kuId.startsWith('ku_sess_') || kuId.startsWith('ku_lead_') || kuType === 'session-profile') {
        return false;
    }
    return tags.includes('profile')
        || kuId.startsWith('ku_profile_')
        || kuType === 'profile';
}

async function readProfileDocumentText(aku, ku) {
    const sourceDoc = (ku.documents || []).find((document) => String(document?.path || '').endsWith('/source.md'))
        || (ku.documents || [])[0];
    if (!sourceDoc?.path) {
        return '';
    }

    try {
        const sourcePath = path.join(aku.store.akuRoot, sourceDoc.path);
        return (await fs.readFile(sourcePath, 'utf8')).trim();
    } catch {
        return '';
    }
}

async function loadProfileCatalog(aku) {
    const profileRecords = (await aku.listKUs())
        .filter(isProfileRecord)
        .sort((first, second) => String(first.title || first.ku_id).localeCompare(String(second.title || second.ku_id)));

    const profiles = [];
    for (const record of profileRecords) {
        try {
            const ku = await aku.loadKU(record.ku_id);
            const documentText = await readProfileDocumentText(aku, ku);
            profiles.push({
                kuId: record.ku_id,
                name: ku.manifest?.ku_name || record.title || record.ku_id,
                summary: ku.manifest?.summary || record.summary || '',
                state: ku.state || '',
                content: documentText || ku.state || ku.manifest?.summary || '',
            });
        } catch {
            // Ignore a stale index entry; the AKU doctor/search path will surface broader corruption.
        }
    }

    return profiles;
}

function formatProfileCatalogForPrompt(profiles) {
    if (!Array.isArray(profiles) || profiles.length === 0) {
        return 'No predefined target profiles found.';
    }

    return profiles.map((profile) => [
        `[Profile] ${profile.name}`,
        `KU ID: ${profile.kuId}`,
        profile.summary ? `Summary: ${profile.summary}` : '',
        profile.content ? `Definition:\n${profile.content}` : '',
    ].filter(Boolean).join('\n')).join('\n\n');
}

function formatSessionProfile(state, metadata = {}) {
    if (!state || !state.trim()) {
        return {
            isNewSession: true,
            profileDetails: [],
            contactInformation: {},
            sessionProfileText: 'No previous session record found. This is a new session.',
        };
    }

    const parsedState = parseSessionProfileFromState(state);
    const metadataProfileDetails = Array.isArray(metadata.profileDetails) ? metadata.profileDetails : [];
    const metadataContactInformation = metadata.contactInformation && typeof metadata.contactInformation === 'object' && !Array.isArray(metadata.contactInformation)
        ? metadata.contactInformation
        : {};
    const profileDetails = [
        ...metadataProfileDetails,
        ...parsedState.profileDetails,
    ];
    const contactInformation = {
        ...parsedState.contactInformation,
        ...metadataContactInformation,
    };

    return {
        isNewSession: false,
        profileDetails,
        contactInformation,
        sessionProfileText: state,
    };
}

export async function loadAkuContext({
    siteDataDir = '',
    siteId,
    sessionId,
    message,
    contextBudgetChars = 6000,
}) {
    if (!siteId) {
        throw new Error('loadAkuContext requires a siteId.');
    }
    if (!sessionId) {
        throw new Error('loadAkuContext requires a sessionId.');
    }

    const akuRootDir = siteDataDir
        ? path.resolve(siteDataDir)
        : resolveSiteDataDir(siteId);
    const aku = new AgenticKnowledgeUnits({
        rootDir: akuRootDir,
        actor: `webassist/${siteId}`,
        contextBudgetChars,
    });

    const akuExists = await aku.exists();
    if (!akuExists) {
        return {
            siteId,
            sessionId,
            akuContext: null,
            sessionProfile: {
                isNewSession: true,
                profileDetails: [],
                contactInformation: {},
                sessionProfileText: 'No previous session record found.',
            },
            conversationHistoryText: 'No previous conversation history found.',
            currentLead: { exists: false },
            akuContextText: 'No site context available.',
            profileCatalog: [],
            profileCatalogText: 'No predefined target profiles found.',
        };
    }

    await aku.loadAKU();
    const profileCatalog = await loadProfileCatalog(aku);
    const profileCatalogText = formatProfileCatalogForPrompt(profileCatalog);

    const sessionKuId = getSessionKuId(sessionId);
    const leadKuId = getLeadKuId(sessionId);
    const query = message || '';
    const searchOptions = {
        explain: true,
        limit: 20,
        maxResultsPerKU: 0,
    };
    
    // Use direct search instead of buildScopedContextPack to avoid redundancy filtering
    // that treats KUs and their events as redundant
    const searchResult = await aku.search(query, searchOptions);
    
    // Manually build context pack with KUs and their state
    const akuContext = await buildManualContextPack(aku, searchResult.results, {
        budgetChars: contextBudgetChars,
        includeState: true,
    });

    let sessionProfile;
    let conversationHistoryText;
    let sessionKU = null;

    try {
        sessionKU = await aku.loadKU(sessionKuId);
        const profileMetadata = sessionKU.manifest?.metadata || {};
        sessionProfile = formatSessionProfile(sessionKU.state, profileMetadata);

        const allEvents = sessionKU.events || [];
        conversationHistoryText = formatConversationHistory(allEvents, 10);
    } catch (error) {
        if (error?.code === 'AKU_NOT_FOUND' || error?.message?.includes('not found')) {
            sessionProfile = {
                isNewSession: true,
                profileDetails: [],
                contactInformation: {},
                sessionProfileText: 'No previous session record found. This is a new session.',
            };
            conversationHistoryText = 'No previous conversation history found.';
        } else {
            throw error;
        }
    }

    let currentLead = { exists: false };

    try {
        const leadKU = await aku.loadKU(leadKuId);
        const leadState = leadKU.state || '';
        const parsedLead = parseLeadFromState(leadState);
        const leadMetadata = leadKU.manifest?.metadata || {};
        currentLead = {
            exists: true,
            kuId: leadKuId,
            profile: normalizeMetadataValue(parsedLead.profile || leadMetadata.profile),
            sessionId,
            contactInfo: {
                ...(parsedLead.contactInformation || {}),
                ...(leadMetadata.contactInfo || {}),
            },
            state: leadState,
        };
    } catch {
        currentLead = { exists: false };
    }

    const akuContextText = formatAkuContextForPrompt(akuContext);
    await writeDebugJson('aku-search', {
        siteId,
        sessionId,
        payload: {
            timestamp: new Date().toISOString(),
            siteId,
            sessionId,
            akuRootDir,
            query,
            searchOptions,
            rawResults: Array.isArray(searchResult.results) ? searchResult.results.map((result) => ({
                search_id: result.search_id,
                record_type: result.record_type,
                ku_id: result.ku_id,
                ku_type: result.ku_type,
                title: result.title,
                summary: result.summary,
                score: result.score,
                matched_on: result.matched_on,
                path: result.path,
                tags: result.tags,
                keywords: result.keywords,
            })) : [],
            rawResultCount: Array.isArray(searchResult.results) ? searchResult.results.length : 0,
            profileCatalog: profileCatalog.map((profile) => ({
                kuId: profile.kuId,
                name: profile.name,
                summary: profile.summary,
            })),
            contextPack: akuContext,
            akuContextText,
        },
    });

    return {
        siteId,
        sessionId,
        akuContext,
        sessionProfile: {
            siteId,
            sessionId,
            ...sessionProfile,
        },
        sessionProfileText: sessionProfile.sessionProfileText,
        contactInformation: sessionProfile.contactInformation,
        profileDetails: sessionProfile.profileDetails,
        conversationHistoryText,
        currentLead,
        profileCatalog,
        profileCatalogText,
        akuContextText,
    };
}

function formatAkuContextForPrompt(contextPack) {
    if (!contextPack || !contextPack.results || contextPack.results.length === 0) {
        return 'No relevant site context found.';
    }

    const lines = [];
    const kuResults = contextPack.results.filter(r => r.record_type === 'ku');

    for (const result of kuResults) {
        const kuType = result.ku_type || result.type || 'unknown';
        const kuName = result.title || result.ku_name || result.ku_id;
        const summary = result.summary || '';
        // Use full state if available, otherwise fall back to summary
        const content = result.state || summary;

        lines.push(`[KU:${kuType}] ${kuName} — score: ${result.score?.toFixed(2) || 'N/A'}`);
        if (summary && !result.state) {
            lines.push(`  Summary: ${summary}`);
        }
        if (content) {
            lines.push(`  Content: ${content}`);
        }
        lines.push('');
    }

    return lines.join('\n').trim() || 'No relevant site context found.';
}

export async function getAkuInstance({ siteId, siteDataDir = '' }) {
    const akuRootDir = siteDataDir
        ? path.resolve(siteDataDir)
        : resolveSiteDataDir(siteId);
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

export { getSessionKuId, getLeadKuId, formatConversationHistory };

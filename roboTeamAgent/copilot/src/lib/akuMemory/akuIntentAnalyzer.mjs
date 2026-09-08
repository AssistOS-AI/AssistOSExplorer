import {
    COMMON_AKU_TYPE_POLICIES,
    getAKUTypePolicy,
    inferCommonKUTypeFromText,
    normalizePolicyKey,
} from './akuTypePolicies.mjs';

const DURABLE_CUE_RE = /\b(create|start|launch|set up|track|preserve|remember|record|save|store|initialize|initialise|open)\b/i;
const READ_CUE_RE = /\b(get|show|retrieve|find|search|read|recall|summari[sz]e|what were|what are)\b/i;
const UPDATE_CUE_RE = /\b(update|modify|change|revise|edit|set status|mark|discard|delete|obsolete|replace)\b/i;
const PRESERVE_CUE_RE = /\b(preserve|remember|record|save|store|keep|capture)\b/i;
const RESULT_CUE_RE = /\b(result|results|outcome|outcomes|finding|findings|validation|validations|run|runs)\b/i;
const KU_ID_RE = /\bku_[a-z0-9][a-z0-9_-]*\b/ig;

const NUMBER_WORDS = new Map([
    ['one', 1],
    ['two', 2],
    ['three', 3],
    ['four', 4],
    ['five', 5],
    ['six', 6],
    ['seven', 7],
    ['eight', 8],
    ['nine', 9],
    ['ten', 10],
]);

export function analyzeAKUMemoryIntent(packetOrText = {}) {
    const packet = typeof packetOrText === 'string'
        ? { rawUserText: packetOrText, promptText: packetOrText }
        : (packetOrText || {});
    const text = String(packet.rawUserText || packet.promptText || '').trim();
    const normalizedText = text.toLowerCase();
    const ordinalLabels = extractScopedOrdinalLabels(text);
    const folderMentions = extractFolderMentions(text, packet);
    const pathMentions = extractPathMentions(text, packet);
    const explicitKuIds = [...new Set([...text.matchAll(KU_ID_RE)].map((match) => match[0]))];
    const durableUnits = extractDurableUnits(text, packet);
    const readQueries = extractReadQueries(text, ordinalLabels);
    const candidateActions = extractCandidateActions(text, durableUnits);
    const hasDurableCue = DURABLE_CUE_RE.test(text) || durableUnits.length > 0 || PRESERVE_CUE_RE.test(text);
    const hasReadCue = READ_CUE_RE.test(text) || ordinalLabels.length > 0;
    const hasUpdateCue = UPDATE_CUE_RE.test(text);
    const hasPreserveCue = PRESERVE_CUE_RE.test(text);
    const ambiguity = detectAmbiguity({
        text,
        hasUpdateCue,
        ordinalLabels,
        explicitKuIds,
        durableUnits,
        candidateActions,
    });

    return {
        shouldUseAKU: Boolean(
            hasDurableCue
                || hasReadCue
                || hasUpdateCue
                || hasPreserveCue
                || explicitKuIds.length
                || packet.previousSessionState?.activeKuId,
        ),
        shouldInitializeAKU: durableUnits.some((unit) => unit.operation === 'create'),
        readQueries,
        candidateActions,
        durableUnits,
        folderMentions,
        pathMentions,
        ordinalLabels,
        explicitKuIds,
        cues: {
            durable: hasDurableCue,
            read: hasReadCue,
            update: hasUpdateCue,
            preserve: hasPreserveCue,
            result: RESULT_CUE_RE.test(normalizedText),
        },
        ambiguity,
    };
}

export function extractScopedOrdinalLabels(text = '') {
    const labels = [];
    const re = /\b(experiment|decision|article|validation|specification|spec|analysis|note|run|meeting|document|workstream|folder|[a-z][a-z_-]{2,40})\s+#?\s*(\d{1,3})\b/ig;
    for (const match of text.matchAll(re)) {
        const rawType = match[1].toLowerCase();
        labels.push({
            label: `${rawType} ${match[2]}`,
            kuType: inferTypeFromPhrase(rawType),
            ordinal: Number(match[2]),
            raw: match[0],
        });
    }
    return labels;
}

function extractDurableUnits(text, packet) {
    const units = [];
    const folderUnit = extractFolderUnit(text, packet);
    if (folderUnit) {
        units.push(folderUnit);
    }

    const pluralUnits = extractPluralDurableUnits(text);
    for (const unit of pluralUnits) {
        units.push({
            ...unit,
            parentLabel: folderUnit?.label ?? null,
        });
    }

    if (!pluralUnits.length) {
        const singleUnit = extractSingleDurableUnit(text);
        if (singleUnit && !units.some((unit) => unit.label === singleUnit.label && unit.kuType === singleUnit.kuType)) {
            units.push(singleUnit);
        }
    }

    if (PRESERVE_CUE_RE.test(text) && !units.length) {
        units.push({
            operation: 'create',
            label: extractPreserveLabel(text),
            kuType: RESULT_CUE_RE.test(text) ? 'reusable_pattern' : 'research_note',
            confidence: 0.74,
            evidence: ['preserve or record durable information'],
            scopeRole: null,
        });
    }

    return units;
}

function extractFolderUnit(text, packet) {
    const match = text.match(/\bcreate\s+(?:the\s+)?(?:folder|directory)\s+["']?([^"',.;\s]+)["']?/i)
        || text.match(/\b(?:folder|directory)\s+["']([^"']+)["']/i);
    if (!match) {
        return null;
    }
    const label = cleanLabel(match[1]);
    if (!label) {
        return null;
    }
    return {
        operation: 'create',
        label,
        kuType: 'workstream',
        confidence: 0.84,
        evidence: [match[0]],
        scopeRole: 'folder_scoped_parent',
        folderPath: packet.folderScopeHint?.path && packet.folderScopeHint.path !== '.'
            ? packet.folderScopeHint.path
            : label,
    };
}

function extractPluralDurableUnits(text) {
    const units = [];
    const re = /\b(?:launch|run|create|start|set up|open)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+([a-z][a-z _-]{2,80}?)(?:\s+that\s+(?:test|tests|validate|validates|check|checks|explore|explores)\s+([^.;]+))?(?=$|[.;,]|\s+and\s+|\s+for\s+)/ig;
    for (const match of text.matchAll(re)) {
        const count = parseCount(match[1]);
        if (!count || count > 25) {
            continue;
        }
        const typePhrase = singularizeTypePhrase(match[2]);
        const kuType = inferTypeFromPhrase(typePhrase);
        const topics = splitTopics(match[3] ?? '');
        for (let index = 1; index <= count; index += 1) {
            const topic = topics[index - 1] ?? null;
            units.push({
                operation: 'create',
                label: topic ? `${typePhrase} ${index}: ${topic}` : `${typePhrase} ${index}`,
                kuType,
                confidence: COMMON_AKU_TYPE_POLICIES[kuType] ? 0.82 : 0.72,
                evidence: [match[0]],
                scopeRole: null,
                ordinal: index,
                summary: topic ? `${typePhrase} ${index} for ${topic}` : '',
            });
        }
    }
    return units;
}

function extractSingleDurableUnit(text) {
    if (!DURABLE_CUE_RE.test(text)) {
        return null;
    }
    const match = text.match(/\b(?:create|start|open|record|preserve|save|remember|track)\s+(?:a|an|the)?\s*([a-z][a-z _-]{2,60}?)(?:\s+(?:called|named|for|about)\s+([^.;]+))?(?=$|[.;])/i);
    if (!match) {
        return null;
    }
    const typePhrase = singularizeTypePhrase(match[1]);
    if (!typePhrase || ['folder', 'directory'].includes(typePhrase)) {
        return null;
    }
    const kuType = inferTypeFromPhrase(typePhrase);
    const labelTail = cleanLabel(match[2] ?? '');
    return {
        operation: 'create',
        label: labelTail || typePhrase,
        kuType,
        confidence: COMMON_AKU_TYPE_POLICIES[kuType] ? 0.78 : 0.68,
        evidence: [match[0]],
        scopeRole: null,
    };
}

function extractReadQueries(text, ordinalLabels) {
    if (!READ_CUE_RE.test(text) && !ordinalLabels.length) {
        return [];
    }
    return [{
        query: text,
        requestedRecordTypes: RESULT_CUE_RE.test(text) ? ['result'] : [],
        ordinalLabels,
        confidence: ordinalLabels.length ? 0.78 : 0.64,
        evidence: ['read or retrieve cue'],
    }];
}

function extractCandidateActions(text, durableUnits) {
    const actions = durableUnits.map((unit) => ({
        operation: unit.operation,
        kuType: unit.kuType,
        label: unit.label,
        confidence: unit.confidence,
        evidence: unit.evidence,
    }));

    if (UPDATE_CUE_RE.test(text)) {
        actions.push({
            operation: 'update',
            confidence: 0.62,
            evidence: ['update cue'],
        });
    }
    if (PRESERVE_CUE_RE.test(text)) {
        actions.push({
            operation: 'record',
            confidence: 0.68,
            evidence: ['preserve or record cue'],
        });
    }
    return actions;
}

function extractFolderMentions(text, packet) {
    const mentions = [];
    if (packet.folderScopeHint?.path) {
        mentions.push({
            path: packet.folderScopeHint.path,
            source: 'packet',
        });
    }
    for (const match of text.matchAll(/\b(?:folder|directory|path)\s+["']?([^"',.;\s]+)["']?/ig)) {
        mentions.push({
            path: match[1],
            source: 'prompt',
        });
    }
    return mentions;
}

function extractPathMentions(text, packet) {
    const mentions = (packet.pathReferences ?? []).map((reference) => ({
        path: reference.path,
        type: reference.type,
        source: 'packet-reference',
    }));
    for (const match of text.matchAll(/(?:^|\s)([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)(?=$|\s|[.,;:])/g)) {
        mentions.push({
            path: match[1],
            type: null,
            source: 'prompt',
        });
    }
    return mentions;
}

function detectAmbiguity({ text, hasUpdateCue, ordinalLabels, explicitKuIds, durableUnits }) {
    if (!hasUpdateCue) {
        return null;
    }
    if (durableUnits.length || explicitKuIds.length || ordinalLabels.length) {
        return null;
    }
    return {
        requiresDisambiguation: true,
        impact: /\b(delete|discard|obsolete|replace)\b/i.test(text) ? 'destructive' : 'high',
        reason: 'Mutation request does not identify a specific Knowledge Unit.',
    };
}

function inferTypeFromPhrase(value) {
    const normalized = normalizePolicyKey(value);
    const direct = inferCommonKUTypeFromText(normalized);
    if (direct) {
        return direct;
    }
    const policy = getAKUTypePolicy(normalized);
    return policy.isGeneric ? normalized || 'knowledge_unit' : policy.kuType;
}

function singularizeTypePhrase(value) {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/\b(records|units|items|tasks|works)\b/g, '')
        .trim();
    if (!normalized) {
        return '';
    }
    if (normalized.endsWith('ies')) {
        return `${normalized.slice(0, -3)}y`;
    }
    if (normalized.endsWith('ses')) {
        return normalized.slice(0, -2);
    }
    if (normalized.endsWith('s') && !normalized.endsWith('ss')) {
        return normalized.slice(0, -1);
    }
    return normalized;
}

function parseCount(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (/^\d+$/.test(normalized)) {
        return Number(normalized);
    }
    return NUMBER_WORDS.get(normalized) ?? 0;
}

function splitTopics(value) {
    return String(value || '')
        .split(/\s*,\s*|\s+\band\b\s+/i)
        .map(cleanLabel)
        .filter(Boolean);
}

function extractPreserveLabel(text) {
    const match = text.match(/\b(?:finding|result|note|pattern)\s+["']?([^"'.;]+)["']?/i);
    return cleanLabel(match?.[1]) || 'Preserved memory';
}

function cleanLabel(value) {
    return String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/^["']|["']$/g, '');
}

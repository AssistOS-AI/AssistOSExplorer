export const COMMON_AKU_TYPE_POLICIES = Object.freeze({
    experiment: makePolicy('experiment', {
        cueTerms: ['experiment', 'experiments', 'benchmark', 'simulation', 'trial', 'run'],
        defaultTags: ['experiment'],
        defaultKeywords: ['experiment', 'result', 'validation'],
        preferredRecords: ['run', 'result', 'validation', 'file'],
        preferredApis: ['recordRun', 'recordResult', 'recordValidation', 'registerFile'],
        retrievalFields: ['results', 'runs', 'validations', 'reusable_findings'],
    }),
    specification: makePolicy('specification', {
        cueTerms: ['specification', 'spec', 'technical spec', 'functional spec', 'api spec'],
        defaultTags: ['specification'],
        defaultKeywords: ['specification', 'requirements', 'contract'],
        preferredRecords: ['document', 'event', 'file'],
        preferredApis: ['recordDocument', 'recordEvent', 'registerFile'],
        retrievalFields: ['summary', 'documents', 'files'],
    }),
    scientific_article: makePolicy('scientific_article', {
        cueTerms: ['scientific article', 'article', 'paper', 'whitepaper', 'position paper'],
        defaultTags: ['article'],
        defaultKeywords: ['article', 'paper', 'findings'],
        preferredRecords: ['document', 'result', 'file'],
        preferredApis: ['recordDocument', 'recordResult', 'registerFile'],
        retrievalFields: ['documents', 'reusable_findings', 'results'],
    }),
    internal_document: makePolicy('internal_document', {
        cueTerms: ['internal document', 'internal report', 'report', 'strategy document'],
        defaultTags: ['internal-document'],
        defaultKeywords: ['document', 'report'],
        preferredRecords: ['document', 'file', 'event'],
        preferredApis: ['recordDocument', 'registerFile', 'recordEvent'],
        retrievalFields: ['documents', 'files', 'summary'],
    }),
    architecture_decision: makePolicy('architecture_decision', {
        cueTerms: ['architecture decision', 'adr', 'technical decision', 'decision record'],
        defaultTags: ['architecture-decision'],
        defaultKeywords: ['decision', 'architecture', 'rationale'],
        preferredRecords: ['document', 'event', 'validation'],
        preferredApis: ['recordDocument', 'recordEvent', 'recordValidation'],
        retrievalFields: ['summary', 'documents', 'validations'],
    }),
    research_note: makePolicy('research_note', {
        cueTerms: ['research note', 'note', 'hypothesis', 'idea'],
        defaultTags: ['research-note'],
        defaultKeywords: ['research', 'note', 'hypothesis'],
        preferredRecords: ['event', 'document', 'result'],
        preferredApis: ['recordEvent', 'recordDocument', 'recordResult'],
        retrievalFields: ['summary', 'events', 'documents', 'reusable_findings'],
    }),
    data_analysis: makePolicy('data_analysis', {
        cueTerms: ['data analysis', 'analysis', 'dataset analysis', 'interpretation'],
        defaultTags: ['data-analysis'],
        defaultKeywords: ['analysis', 'data', 'results'],
        preferredRecords: ['result', 'validation', 'file', 'document'],
        preferredApis: ['recordResult', 'recordValidation', 'registerFile', 'recordDocument'],
        retrievalFields: ['results', 'validations', 'files'],
    }),
    code_work: makePolicy('code_work', {
        cueTerms: ['code work', 'implementation', 'refactor', 'bug fix', 'test work'],
        defaultTags: ['code-work'],
        defaultKeywords: ['code', 'implementation', 'tests'],
        preferredRecords: ['event', 'validation', 'file', 'result'],
        preferredApis: ['recordEvent', 'recordValidation', 'registerFile', 'recordResult'],
        retrievalFields: ['events', 'validations', 'files', 'summary'],
    }),
    validation: makePolicy('validation', {
        cueTerms: ['validation', 'validate', 'verification', 'check'],
        defaultTags: ['validation'],
        defaultKeywords: ['validation', 'verification', 'result'],
        preferredRecords: ['validation', 'result', 'file'],
        preferredApis: ['recordValidation', 'recordResult', 'registerFile'],
        retrievalFields: ['validations', 'results', 'files'],
    }),
    meeting_outcome: makePolicy('meeting_outcome', {
        cueTerms: ['meeting outcome', 'meeting notes', 'decision meeting', 'meeting'],
        defaultTags: ['meeting-outcome'],
        defaultKeywords: ['meeting', 'outcome', 'decision'],
        preferredRecords: ['document', 'event'],
        preferredApis: ['recordDocument', 'recordEvent'],
        retrievalFields: ['documents', 'events', 'summary'],
    }),
    business_analysis: makePolicy('business_analysis', {
        cueTerms: ['business analysis', 'commercial analysis', 'offer', 'pitch', 'strategy'],
        defaultTags: ['business-analysis'],
        defaultKeywords: ['business', 'analysis', 'strategy'],
        preferredRecords: ['document', 'result', 'file'],
        preferredApis: ['recordDocument', 'recordResult', 'registerFile'],
        retrievalFields: ['documents', 'results', 'summary'],
    }),
    grant_or_deliverable: makePolicy('grant_or_deliverable', {
        cueTerms: ['grant', 'deliverable', 'proposal', 'consortium'],
        defaultTags: ['deliverable'],
        defaultKeywords: ['grant', 'deliverable', 'proposal'],
        preferredRecords: ['document', 'file', 'event'],
        preferredApis: ['recordDocument', 'registerFile', 'recordEvent'],
        retrievalFields: ['documents', 'files', 'summary'],
    }),
    reusable_pattern: makePolicy('reusable_pattern', {
        cueTerms: ['reusable pattern', 'pattern', 'best practice', 'template'],
        defaultTags: ['reusable-pattern'],
        defaultKeywords: ['pattern', 'reusable', 'finding'],
        preferredRecords: ['event', 'document', 'result'],
        preferredApis: ['recordEvent', 'recordDocument', 'recordResult'],
        retrievalFields: ['reusable_findings', 'summary', 'documents'],
    }),
    failure_note: makePolicy('failure_note', {
        cueTerms: ['failure note', 'failure', 'failed run', 'bug', 'incident'],
        defaultTags: ['failure-note'],
        defaultKeywords: ['failure', 'lesson', 'follow-up'],
        preferredRecords: ['event', 'result', 'validation'],
        preferredApis: ['recordEvent', 'recordResult', 'recordValidation'],
        retrievalFields: ['events', 'results', 'summary'],
    }),
});

const POLICY_ALIASES = Object.freeze({
    adr: 'architecture_decision',
    decision: 'architecture_decision',
    decisions: 'architecture_decision',
    spec: 'specification',
    specs: 'specification',
    article: 'scientific_article',
    articles: 'scientific_article',
    paper: 'scientific_article',
    papers: 'scientific_article',
    document: 'internal_document',
    documents: 'internal_document',
    note: 'research_note',
    notes: 'research_note',
    analysis: 'data_analysis',
    validations: 'validation',
    experiments: 'experiment',
    meeting: 'meeting_outcome',
    meetings: 'meeting_outcome',
    grant: 'grant_or_deliverable',
    deliverable: 'grant_or_deliverable',
    pattern: 'reusable_pattern',
    failure: 'failure_note',
    workstream: 'workstream',
    folder: 'workstream',
});

export function getAKUTypePolicy(kuType) {
    const requestedType = normalizeKUType(kuType);
    const policyKey = normalizePolicyKey(requestedType);
    const commonKey = COMMON_AKU_TYPE_POLICIES[policyKey]
        ? policyKey
        : POLICY_ALIASES[policyKey];
    const commonPolicy = COMMON_AKU_TYPE_POLICIES[commonKey];
    if (commonPolicy) {
        return {
            ...commonPolicy,
            requestedType,
            isGeneric: false,
        };
    }

    return {
        kuType: requestedType,
        requestedType,
        isGeneric: true,
        cueTerms: [requestedType].filter(Boolean),
        defaultTags: ['knowledge-unit'],
        defaultKeywords: [requestedType, 'knowledge unit'].filter(Boolean),
        preferredRecords: ['event', 'document', 'file', 'result', 'run', 'validation'],
        preferredApis: [
            'initKU',
            'search',
            'updateKUState',
            'setKUStatus',
            'recordEvent',
            'recordDocument',
            'registerFile',
            'recordResult',
            'recordRun',
            'recordValidation',
            'registerFolderScope',
            'linkKU',
            'buildContextPack',
            'buildScopedContextPack',
        ],
        retrievalFields: ['summary', 'reusable_findings', 'documents', 'results', 'files', 'events'],
    };
}

export function applyAKUTypePolicyDefaults(metadata = {}) {
    const policy = getAKUTypePolicy(metadata.ku_type ?? metadata.type);
    const kuType = normalizeKUType(metadata.ku_type ?? metadata.type ?? policy.kuType);
    return {
        ...metadata,
        ku_type: kuType,
        tags: uniqueStrings([
            ...asArray(policy.defaultTags),
            ...asArray(metadata.tags),
        ]),
        keywords: uniqueStrings([
            ...asArray(policy.defaultKeywords),
            ...asArray(metadata.keywords),
        ]),
    };
}

export function inferCommonKUTypeFromText(text = '') {
    const normalized = normalizePolicyKey(text);
    for (const [kuType, policy] of Object.entries(COMMON_AKU_TYPE_POLICIES)) {
        if (policy.cueTerms.some((cue) => normalized.includes(normalizePolicyKey(cue)))) {
            return kuType;
        }
    }
    return null;
}

export function normalizeKUType(value, fallback = 'knowledge_unit') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

export function normalizePolicyKey(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

function makePolicy(kuType, config = {}) {
    return Object.freeze({
        kuType,
        cueTerms: config.cueTerms ?? [],
        defaultTags: config.defaultTags ?? [],
        defaultKeywords: config.defaultKeywords ?? [],
        preferredRecords: config.preferredRecords ?? [],
        preferredApis: config.preferredApis ?? [],
        retrievalFields: config.retrievalFields ?? [],
    });
}

function asArray(value) {
    if (value === undefined || value === null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values = []) {
    return [...new Set(values
        .map((value) => String(value ?? '').trim())
        .filter(Boolean))];
}

export class AKUSessionState {
    constructor(seed = {}) {
        const normalized = normalizeAKUSessionState(seed);
        this.activeKuId = normalized.activeKuId;
        this.activeScope = normalized.activeScope;
        this.recentKUs = normalized.recentKUs;
        this.ordinalLabels = normalized.ordinalLabels;
    }

    rememberActiveKU(ku, options = {}) {
        const kuId = typeof ku === 'string' ? ku : ku?.ku_id;
        if (!kuId) {
            return this.toJSON();
        }
        this.activeKuId = kuId;
        if (options.scope || options.scopeRole || options.folderPath || ku?.scopeRole || ku?.folderPath) {
            this.activeScope = {
                ...(this.activeScope ?? {}),
                kuId,
                scopeRole: options.scopeRole ?? ku?.scopeRole ?? this.activeScope?.scopeRole ?? null,
                folderPath: options.folderPath ?? ku?.folderPath ?? this.activeScope?.folderPath ?? null,
            };
        }
        this.recentKUs = uniqueByKuId([
            normalizeRecentKU(ku, options),
            ...this.recentKUs,
        ]).slice(0, 12);
        return this.toJSON();
    }

    rememberOrdinal(label, ku) {
        const normalizedLabel = normalizeLabel(label);
        const kuId = typeof ku === 'string' ? ku : ku?.ku_id;
        if (!normalizedLabel || !kuId) {
            return this.toJSON();
        }
        this.ordinalLabels = {
            ...this.ordinalLabels,
            [normalizedLabel]: kuId,
        };
        return this.toJSON();
    }

    updateFromActionOutcome(outcome = {}) {
        const created = Array.isArray(outcome.createdKUs) ? outcome.createdKUs : [];
        for (const item of created) {
            this.rememberActiveKU(item, {
                scopeRole: item.scopeRole,
                folderPath: item.folderPath,
            });
            if (item.label) {
                this.rememberOrdinal(item.label, item.ku_id);
            }
        }
        if (outcome.activeKuId) {
            this.rememberActiveKU(outcome.activeKuId);
        }
        return this.toJSON();
    }

    getActiveKuIds() {
        return uniqueStrings([
            this.activeKuId,
            this.activeScope?.kuId,
            ...this.recentKUs.map((item) => item.ku_id),
        ]);
    }

    toJSON() {
        return {
            activeKuId: this.activeKuId,
            activeScope: this.activeScope,
            recentKUs: this.recentKUs,
            ordinalLabels: this.ordinalLabels,
        };
    }
}

export function createAKUSessionState(seed = {}) {
    return new AKUSessionState(seed);
}

export function normalizeAKUSessionState(seed = {}) {
    if (seed instanceof AKUSessionState) {
        return seed.toJSON();
    }
    const input = seed && typeof seed === 'object' ? seed : {};
    return {
        activeKuId: normalizeString(input.activeKuId ?? input.active_ku_id),
        activeScope: normalizeScope(input.activeScope ?? input.active_scope),
        recentKUs: Array.isArray(input.recentKUs ?? input.recent_kus)
            ? (input.recentKUs ?? input.recent_kus).map(normalizeRecentKU).filter(Boolean).slice(0, 12)
            : [],
        ordinalLabels: normalizeOrdinalLabels(input.ordinalLabels ?? input.ordinal_labels),
    };
}

function normalizeScope(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return {
        kuId: normalizeString(value.kuId ?? value.ku_id),
        scopeRole: normalizeString(value.scopeRole ?? value.scope_role),
        folderPath: normalizeString(value.folderPath ?? value.folder_path),
    };
}

function normalizeRecentKU(value, options = {}) {
    const kuId = typeof value === 'string' ? value : normalizeString(value?.ku_id ?? value?.kuId);
    if (!kuId) {
        return null;
    }
    return {
        ku_id: kuId,
        ku_name: normalizeString(value?.ku_name ?? value?.title ?? value?.name),
        ku_type: normalizeString(value?.ku_type ?? value?.type),
        label: normalizeString(value?.label ?? options.label),
        scopeRole: normalizeString(value?.scopeRole ?? value?.scope_role ?? options.scopeRole),
        folderPath: normalizeString(value?.folderPath ?? value?.folder_path ?? options.folderPath),
    };
}

function normalizeOrdinalLabels(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    const out = {};
    for (const [key, kuId] of Object.entries(value)) {
        const label = normalizeLabel(key);
        const normalizedKuId = normalizeString(kuId);
        if (label && normalizedKuId) {
            out[label] = normalizedKuId;
        }
    }
    return out;
}

function normalizeLabel(value) {
    return normalizeString(value)?.toLowerCase() ?? null;
}

function normalizeString(value) {
    if (value === undefined || value === null) {
        return null;
    }
    const text = String(value).trim();
    return text || null;
}

function uniqueByKuId(values = []) {
    const seen = new Set();
    const out = [];
    for (const item of values.filter(Boolean)) {
        if (seen.has(item.ku_id)) {
            continue;
        }
        seen.add(item.ku_id);
        out.push(item);
    }
    return out;
}

function uniqueStrings(values = []) {
    return [...new Set(values
        .map((value) => String(value ?? '').trim())
        .filter(Boolean))];
}

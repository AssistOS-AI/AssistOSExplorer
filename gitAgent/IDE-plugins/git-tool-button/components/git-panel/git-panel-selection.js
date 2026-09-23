const ALL_PREFIX = '*';

export function normalizeRepoRelativePrefix(prefix) {
    if (prefix === ALL_PREFIX) return ALL_PREFIX;
    const normalized = String(prefix || '').replace(/^\/+/, '');
    if (!normalized) return '';
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export function createSelectionEntry() {
    return { files: new Set(), prefixes: new Set(), sectionsByFile: new Map(), excludedFiles: new Set() };
}

export function peekSelectionEntry(selectedFilesByRepo, repoPath) {
    if (!repoPath) return null;
    return selectedFilesByRepo?.[repoPath] || null;
}

export function ensureSelectionEntry(selectedFilesByRepo, repoPath) {
    if (!repoPath) return null;
    const store = selectedFilesByRepo || {};
    if (!store[repoPath]) {
        store[repoPath] = createSelectionEntry();
    } else {
        if (!store[repoPath].files) store[repoPath].files = new Set();
        if (!store[repoPath].prefixes) store[repoPath].prefixes = new Set();
        if (!store[repoPath].sectionsByFile) store[repoPath].sectionsByFile = new Map();
        if (!store[repoPath].excludedFiles) store[repoPath].excludedFiles = new Set();
    }
    return store[repoPath];
}

export function getCoveringPrefix(entry, relativePath) {
    if (!entry?.prefixes) return null;
    if (entry.prefixes.has(ALL_PREFIX)) return ALL_PREFIX;
    const rel = String(relativePath || '');
    for (const prefix of entry.prefixes.values()) {
        if (prefix && rel.startsWith(prefix)) return prefix;
    }
    return null;
}

export function getAncestorCoveringPrefix(entry, prefix) {
    const normalizedPrefix = normalizeRepoRelativePrefix(prefix);
    if (!entry?.prefixes) return null;
    if (entry.prefixes.has(ALL_PREFIX)) return ALL_PREFIX;
    if (!normalizedPrefix) return null;
    for (const candidate of entry.prefixes.values()) {
        if (!candidate) continue;
        if (candidate !== normalizedPrefix && normalizedPrefix.startsWith(candidate)) return candidate;
    }
    return null;
}

export function isPathSelected(entry, relativePath) {
    if (!entry) return false;
    const rel = String(relativePath || '');
    if (entry.excludedFiles?.has?.(rel)) return false;
    if (entry.files?.has?.(rel)) return true;
    return Boolean(getCoveringPrefix(entry, rel));
}

export function toggleFileSelection(entry, filePath, section, isSelected) {
    if (!entry || !filePath) return;
    const coveredByPrefix = Boolean(getCoveringPrefix(entry, filePath));
    if (isSelected) {
        entry.excludedFiles?.delete?.(filePath);
        if (!coveredByPrefix) {
            entry.files.add(filePath);
            if (section) entry.sectionsByFile.set(filePath, section);
        }
    } else {
        if (coveredByPrefix) {
            entry.excludedFiles?.add?.(filePath);
            return;
        }
        entry.files.delete(filePath);
        entry.sectionsByFile.delete(filePath);
        entry.excludedFiles?.delete?.(filePath);
    }
}

export function togglePrefixSelection(entry, prefix, isSelected) {
    if (!entry) return;
    if (prefix === ALL_PREFIX) {
        if (isSelected) {
            entry.files?.clear?.();
            entry.sectionsByFile?.clear?.();
            entry.prefixes?.clear?.();
            entry.excludedFiles?.clear?.();
            entry.prefixes?.add?.(ALL_PREFIX);
            return;
        }
        entry.prefixes?.delete?.(ALL_PREFIX);
        entry.excludedFiles?.clear?.();
        return;
    }
    const normalizedPrefix = normalizeRepoRelativePrefix(prefix);
    if (!normalizedPrefix) return;
    if (getAncestorCoveringPrefix(entry, normalizedPrefix)) return;

    const clearSubtree = () => {
        for (const filePath of Array.from(entry.files || [])) {
            if (String(filePath).startsWith(normalizedPrefix)) {
                entry.files.delete(filePath);
                entry.sectionsByFile.delete(filePath);
            }
        }
        for (const filePath of Array.from(entry.excludedFiles || [])) {
            if (String(filePath).startsWith(normalizedPrefix)) {
                entry.excludedFiles.delete(filePath);
            }
        }
        for (const candidate of Array.from(entry.prefixes || [])) {
            if (candidate !== normalizedPrefix && String(candidate).startsWith(normalizedPrefix)) {
                entry.prefixes.delete(candidate);
            }
        }
    };

    if (isSelected) {
        clearSubtree();
        entry.prefixes.add(normalizedPrefix);
    } else {
        entry.prefixes.delete(normalizedPrefix);
        clearSubtree();
    }
}

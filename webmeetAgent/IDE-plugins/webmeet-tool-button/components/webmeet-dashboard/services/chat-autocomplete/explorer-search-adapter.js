const DEFAULT_EXCLUDES = [
    'node_modules',
    '.git',
    '.ploinky',
    '.data',
    '.idea',
    '.vscode',
    'dist',
    'build',
    '.cache'
];

function deriveItems(results, leaf) {
    const safeResults = Array.isArray(results) ? results : [];
    const leafLower = String(leaf || '').toLowerCase();
    const seen = new Set();
    const items = [];
    for (const entry of safeResults) {
        if (!entry || typeof entry !== 'object' || !['folder', 'file'].includes(entry.kind)) continue;
        const raw = typeof entry.path === 'string' ? entry.path : '';
        const trimmed = String(raw || '').replace(/^\/+/, '').trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        const lastSlash = trimmed.lastIndexOf('/');
        const name = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
        if (leafLower && !trimmed.toLowerCase().includes(leafLower) && !name.toLowerCase().includes(leafLower)) {
            continue;
        }
        items.push({ path: trimmed, label: name, displayPath: trimmed, kind: entry.kind });
    }
    return items;
}

function parseJsonText(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

function extractToolPayload(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        return parseJsonText(result);
    }
    if (typeof result !== 'object') return null;
    if (result.json && typeof result.json === 'object') {
        return result.json;
    }
    if (typeof result.text === 'string') {
        return parseJsonText(result.text);
    }
    const textBlock = Array.isArray(result.content)
        ? result.content.find((block) => block?.type === 'text' && typeof block.text === 'string')
        : null;
    if (textBlock) {
        return parseJsonText(textBlock.text);
    }
    return result;
}

function normalizeResultPaths(payload) {
    if (!payload || typeof payload !== 'object') return [];
    return Array.isArray(payload.results) ? payload.results : [];
}

function joinExplorerPath(root, relativePath) {
    const base = String(root || '').replace(/\/+$/, '') || '/';
    const safeRelative = String(relativePath || '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!safeRelative) return base;
    return base === '/' ? `/${safeRelative}` : `${base}/${safeRelative}`;
}

function splitQuery(query) {
    const trimmed = String(query || '').replace(/^\/+/, '').trim();
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash === -1) return { folder: '', leaf: trimmed };
    return {
        folder: trimmed.slice(0, lastSlash),
        leaf: trimmed.slice(lastSlash + 1)
    };
}

export function createExplorerSearchAdapter({ callExplorerTool, resolveWorkspaceRoot, maxResults = 50 } = {}) {
    if (typeof callExplorerTool !== 'function') return null;

    let cachedRoot = '';
    async function workspaceRoot() {
        if (cachedRoot) return cachedRoot;
        if (typeof resolveWorkspaceRoot === 'function') {
            try {
                const resolved = await resolveWorkspaceRoot();
                if (resolved) {
                    cachedRoot = String(resolved);
                    return cachedRoot;
                }
            } catch (_) {
                // fall through
            }
        }
        return '';
    }

    async function searchPaths(query) {
        const { folder, leaf } = splitQuery(query);
        const root = await workspaceRoot();
        if (!root) return [];
        const searchRoot = joinExplorerPath(root, folder);
        const pattern = leaf || '*';
        const result = await callExplorerTool('search_files', {
            path: searchRoot,
            pattern,
            excludePatterns: DEFAULT_EXCLUDES,
            maxResults,
            includeKind: true
        }, { raw: true, withLoader: false });
        const payload = extractToolPayload(result);
        return deriveItems(normalizeResultPaths(payload), leaf);
    }

    return { searchPaths };
}

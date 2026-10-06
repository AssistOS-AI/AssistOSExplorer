import { callExplorerTool, ensureSuccess, parseToolResult } from '../infrastructure/explorerApi.js';
import { isDpuVirtualPath } from '../dpu/dpuPaths.js';

// Directory listings requested while Explorer is still loading the file browser modules. The file browser
// consumes each one at most once, and only while it is fresh, so a stale listing never replaces a live request.
export const INITIAL_LISTING_PREFETCH_TTL_MS = 10000;

const prefetched = new Map();

const normalizeListingPath = (value) => `/${String(value || '').split('/').filter(Boolean).join('/')}`;

// The one directory listing request of the file browser: the live call and the prefetch both go through it.
export async function requestDirectoryListing(path) {
    const raw = await callExplorerTool('list_directory_detailed', { path }, { raw: true, withLoader: false });
    ensureSuccess(raw);
    const parsed = parseToolResult(raw);
    if (typeof parsed === 'string') {
        return { text: parsed };
    }
    if (!Array.isArray(parsed)) {
        throw new Error('Invalid directory listing payload.');
    }
    return { text: JSON.stringify(parsed ?? []) };
}

// Listings the file-exp route reads first for an address: the workspace root and, for a deep link, the parent
// directory of its target. This mirrors loadStateFromURL in file-exp-navigation-controller.js.
export function resolveInitialListingPaths(hash) {
    const rawPath = String(hash || '').split('#file-exp')[1] || '/';
    let decoded = rawPath;
    try {
        decoded = decodeURIComponent(rawPath);
    } catch (_) {
        decoded = rawPath;
    }
    const target = normalizeListingPath(decoded);
    const paths = ['/'];
    if (target !== '/') {
        const segments = target.split('/').filter(Boolean);
        segments.pop();
        const parent = segments.length ? `/${segments.join('/')}` : '/';
        if (parent !== '/') paths.push(parent);
    }
    return paths.filter((path) => !isDpuVirtualPath(path));
}

export function start(paths, { now = Date.now } = {}) {
    for (const entry of Array.isArray(paths) ? paths : []) {
        const path = normalizeListingPath(entry);
        if (prefetched.has(path)) continue;
        const promise = requestDirectoryListing(path);
        // A prefetch nobody takes must not surface as an unhandled rejection; a taker still sees the rejection.
        promise.catch(() => {});
        prefetched.set(path, { promise, startedAt: now() });
    }
}

// Hands out the prefetched listing once. Returns null when there is none, when it was already taken, or when it
// is older than the time-to-live.
export function take(path, { now = Date.now } = {}) {
    const key = normalizeListingPath(path);
    const entry = prefetched.get(key);
    if (!entry) return null;
    prefetched.delete(key);
    if (now() - entry.startedAt >= INITIAL_LISTING_PREFETCH_TTL_MS) return null;
    return entry.promise;
}

export function clear() {
    prefetched.clear();
}

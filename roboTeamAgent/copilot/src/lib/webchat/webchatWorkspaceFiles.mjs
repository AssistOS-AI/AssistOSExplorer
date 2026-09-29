import fs from 'node:fs/promises';
import path from 'node:path';

const WEBCHAT_WORKSPACE_FILES_VERSION = 1;
const DEFAULT_REFRESH_INTERVAL_MS = 5000;
const SECRET_SEGMENT_RE = /^[^/]*\.secrets$/i;
const IGNORED_DIRECTORY_NAMES = new Set(['.achilles-cli', '.data', '.git', '.ploinky', 'node_modules']);

function isIndexableSegment(segment) {
    return Boolean(segment)
        && !/[\0\r\n]/.test(segment)
        && segment !== '.'
        && segment !== '..'
        && segment !== '.webchat-upload-metadata'
        && !SECRET_SEGMENT_RE.test(segment);
}

async function collectWorkspaceFiles(workingDir) {
    const root = path.resolve(workingDir);
    const files = [];

    async function walk(relativeDirectory) {
        const absoluteDirectory = relativeDirectory
            ? path.join(root, ...relativeDirectory.split('/'))
            : root;
        let entries;
        try {
            entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            if (!isIndexableSegment(entry.name) || entry.isSymbolicLink()) continue;
            if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
            const relativePath = relativeDirectory
                ? `${relativeDirectory}/${entry.name}`
                : entry.name;
            if (entry.isDirectory()) {
                await walk(relativePath);
            } else if (entry.isFile()) {
                files.push(relativePath);
            }
        }
    }

    await walk('');
    return files;
}

function diffFiles(previous, next) {
    const previousSet = new Set(previous);
    const nextSet = new Set(next);
    return {
        added: next.filter((filePath) => !previousSet.has(filePath)),
        removed: previous.filter((filePath) => !nextSet.has(filePath)),
    };
}

export function createWebchatWorkspaceFileIndex({
    workingDir,
    write,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    scan = collectWorkspaceFiles,
} = {}) {
    const output = typeof write === 'function'
        ? write
        : (value) => process.stdout.write(value);
    const intervalMs = Math.max(250, Number(refreshIntervalMs) || DEFAULT_REFRESH_INTERVAL_MS);
    let files = null;
    let version = 0;
    let timer = null;
    let refreshPromise = null;
    let stopped = false;

    function emit(payload) {
        output(`${JSON.stringify({
            __webchatWorkspaceFiles: 1,
            version: WEBCHAT_WORKSPACE_FILES_VERSION,
            indexVersion: version,
            ...payload,
        })}\n`);
    }

    async function refresh({ forceSnapshot = false, afterCurrent = false } = {}) {
        if (stopped) return { changed: false, files: files || [] };
        if (refreshPromise) {
            const activeRefresh = refreshPromise;
            if (!afterCurrent) return activeRefresh;
            await activeRefresh;
            return refresh({ forceSnapshot });
        }
        refreshPromise = Promise.resolve().then(async () => {
            const nextFiles = await scan(workingDir);
            const normalized = [...new Set(Array.isArray(nextFiles) ? nextFiles : [])].sort();
            if (files === null || forceSnapshot) {
                const changed = files === null || normalized.length !== files.length
                    || normalized.some((filePath, index) => filePath !== files[index]);
                files = normalized;
                version += 1;
                emit({ reset: true, files });
                return { changed, files: [...files], version };
            }
            const delta = diffFiles(files, normalized);
            if (!delta.added.length && !delta.removed.length) {
                return { changed: false, files: [...files], version };
            }
            files = normalized;
            version += 1;
            emit({ reset: false, ...delta });
            return { changed: true, files: [...files], version, ...delta };
        }).finally(() => {
            refreshPromise = null;
        });
        return refreshPromise;
    }

    async function start() {
        await refresh({ forceSnapshot: true });
        if (!stopped && !timer) {
            timer = setInterval(() => {
                void refresh().catch(() => {});
            }, intervalMs);
            timer.unref?.();
        }
    }

    function stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
    }

    return {
        start,
        stop,
        refresh,
        snapshot: () => ({ version, files: [...(files || [])] }),
    };
}

export const __testables = {
    collectWorkspaceFiles,
    diffFiles,
    isIndexableSegment,
};

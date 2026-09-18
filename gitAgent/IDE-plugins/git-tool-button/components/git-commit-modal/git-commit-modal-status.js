import { normalizeGitStatusPayload } from './git-commit-modal-utils.js';

export function toChangeRows(status, limit = 800) {
    const map = new Map();
    const staged = Array.isArray(status?.staged) ? status.staged : [];
    const ignored = Array.isArray(status?.ignored) ? status.ignored : [];
    const ignoredPaths = new Set(ignored.map((entry) => entry?.path).filter(Boolean));
    const stopTrackingIgnoredPaths = new Set(
        staged
            .filter((entry) => entry?.path && (entry.x === 'D' || entry.y === 'D'))
            .map((entry) => entry.path)
            .filter((filePath) => ignoredPaths.has(filePath))
    );
    const touch = (entry, flag) => {
        if (!entry) return;
        const pathValue = entry && typeof entry === 'object' ? entry.path : entry;
        const key = String(pathValue || '').trim();
        if (!key) return;
        const existing = map.get(key) || {
            path: key,
            flags: { staged: false, unstaged: false, untracked: false, conflicted: false, ignored: false, stopTrackingIgnored: false },
            origPath: null,
            x: ' ',
            y: ' '
        };
        existing.flags[flag] = true;
        existing.flags.stopTrackingIgnored = stopTrackingIgnoredPaths.has(key);
        if (entry?.origPath && !existing.origPath) existing.origPath = entry.origPath;
        if (typeof entry?.x === 'string' && entry.x.length && (existing.x === ' ' || existing.x === '?' || entry.x !== ' ')) {
            existing.x = entry.x;
        }
        if (typeof entry?.y === 'string' && entry.y.length && (existing.y === ' ' || existing.y === '?' || entry.y !== ' ')) {
            existing.y = entry.y;
        }
        map.set(key, existing);
    };

    const slice = (list) => (Array.isArray(list) ? list : []).slice(0, limit);
    for (const entry of slice(status?.conflicted)) touch(entry, 'conflicted');
    for (const entry of slice(status?.ignored)) touch(entry, 'ignored');
    for (const entry of slice(status?.untracked)) touch(entry, 'untracked');
    for (const entry of slice(status?.unstaged)) touch(entry, 'unstaged');
    for (const entry of slice(status?.staged)) touch(entry, 'staged');

    const rows = Array.from(map.values());
    for (const row of rows) {
        const flags = row.flags || {};
        row.kind = flags.stopTrackingIgnored ? 'stop-tracking-ignored'
            : flags.conflicted ? 'conflicted'
                : (flags.ignored && !flags.staged && !flags.unstaged && !flags.untracked) ? 'ignored'
                    : flags.untracked ? 'untracked'
                        : (flags.staged && flags.unstaged) ? 'staged+unstaged'
                            : flags.staged ? 'staged'
                                : flags.unstaged ? 'unstaged'
                                    : 'unknown';
    }
    rows.sort((left, right) => left.path.localeCompare(right.path));
    return rows;
}

export function mergeRepoOverviewWithStatus(repo, statusPayload) {
    const normalized = normalizeGitStatusPayload(statusPayload);
    const mergeInProgress = Boolean(statusPayload?.mergeInProgress);
    const mergeMessage = mergeInProgress ? String(statusPayload?.mergeMessage || '').trim() || null : null;
    const { raw, paths, counts } = normalized;
    const dirty = mergeInProgress || counts.staged + counts.unstaged + counts.untracked + counts.conflicted > 0;
    const changes = {
        staged: paths.staged,
        unstaged: paths.unstaged,
        untracked: paths.untracked,
        conflicted: paths.conflicted
    };

    return {
        ...repo,
        ok: true,
        mergeInProgress,
        mergeMessage,
        dirty,
        statusUnavailable: false,
        counts,
        changes,
        changesAll: toChangeRows(raw),
        sample: {
            staged: changes.staged.slice(0, 8),
            unstaged: changes.unstaged.slice(0, 8),
            untracked: changes.untracked.slice(0, 8),
            conflicted: changes.conflicted.slice(0, 8)
        },
        ignored: paths.ignored.slice(0, 800),
        ignoredCount: counts.ignored,
        changesLoaded: true,
        changesLoading: false,
        changesError: null
    };
}

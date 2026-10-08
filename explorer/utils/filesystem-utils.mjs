import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CACHE_CONFIG = {
  maxFileSizeBytes: 2 * 1024 * 1024, // 2MB
  maxFiles: 200,
  maxDirs: 200,
  ttlMs: Number.parseInt(process.env.FS_CACHE_TTL_MS || '5000', 10) // 5s
};

const pruneCache = (cache, limit) => {
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
};

const isFreshFile = (entry, stats, ttlMs) => {
  if (!entry) return false;
  if ((Date.now() - entry.cachedAt) > ttlMs) return false;
  return entry.mtimeMs === stats.mtimeMs && entry.size === stats.size;
};

const isFreshDir = (entry, stats, ttlMs) => {
  if (!entry) return false;
  if ((Date.now() - entry.cachedAt) > ttlMs) return false;
  return entry.mtimeMs === stats.mtimeMs;
};

export function isProtectedSecretName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return false;
  return normalized === '.secrets' || normalized.endsWith('.secrets');
}

export function isProtectedSecretPath(targetPath) {
  return isProtectedSecretName(path.basename(String(targetPath || '').trim()));
}

export async function describeDirectoryEntry(basePath, entry) {
  const entryPath = path.join(basePath, entry.name);
  let linkStats = null;
  let effectiveStats = null;
  let linkTarget = null;

  try {
    linkStats = await fs.lstat(entryPath);
    if (linkStats.isSymbolicLink()) {
      try {
        linkTarget = await fs.readlink(entryPath);
      } catch {
        linkTarget = null;
      }
    }
  } catch {
    linkStats = null;
  }

  if (linkStats && !linkStats.isSymbolicLink()) {
    // Ordinary file or directory: lstat already describes it, no second syscall.
    effectiveStats = linkStats;
  } else {
    // Symbolic link (follow it) or failed lstat (preserve the previous stat attempt).
    try {
      effectiveStats = await fs.stat(entryPath);
    } catch {
      effectiveStats = null;
    }
  }

  const stats = effectiveStats || linkStats;
  const type = stats?.isDirectory?.()
    ? 'directory'
    : stats?.isFile?.()
      ? 'file'
      : 'other';

  return {
    name: entry.name,
    type,
    size: stats ? stats.size : null,
    modified: stats?.mtime ? stats.mtime.toISOString() : null,
    isSymlink: Boolean(linkStats?.isSymbolicLink?.()),
    linkTarget
  };
}

export function createCacheHelpers({ readFileContent, config } = {}) {
  if (typeof readFileContent !== 'function') {
    throw new Error('createCacheHelpers requires a readFileContent function');
  }

  const cacheConfig = { ...DEFAULT_CACHE_CONFIG, ...(config || {}) };
  const fileCache = new Map();
  const dirCache = new Map();

  const invalidateCachesForPath = (targetPath) => {
    if (!targetPath) return;
    fileCache.delete(targetPath);
    dirCache.delete(targetPath);
    let current = path.dirname(targetPath);
    while (current && current !== path.dirname(current)) {
      dirCache.delete(current);
      current = path.dirname(current);
    }
  };

  const readFileWithCache = async (validPath, { skipReadForLarge = false } = {}) => {
    const stats = await fs.stat(validPath);
    const cached = fileCache.get(validPath);
    if (isFreshFile(cached, stats, cacheConfig.ttlMs)) {
      return { content: cached.content, stats };
    }

    if (stats.size > cacheConfig.maxFileSizeBytes && skipReadForLarge) {
      fileCache.delete(validPath);
      return { content: null, stats };
    }

    const content = await readFileContent(validPath);
    if (stats.size <= cacheConfig.maxFileSizeBytes) {
      fileCache.set(validPath, { content, mtimeMs: stats.mtimeMs, size: stats.size, cachedAt: Date.now() });
      pruneCache(fileCache, cacheConfig.maxFiles);
    } else {
      fileCache.delete(validPath);
    }
    return { content, stats };
  };

  // With `limit`, only the first `limit` visible entries are described when the
  // directory is larger; that partial result is flagged `truncated` and never cached.
  const listDirectoryDetailedWithCache = async (validPath, { limit } = {}) => {
    const stats = await fs.stat(validPath);
    const cached = dirCache.get(validPath);
    if (isFreshDir(cached, stats, cacheConfig.ttlMs)) {
      return cached.entries;
    }

    const entries = await fs.readdir(validPath, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) => !isProtectedSecretName(entry?.name));
    if (Number.isFinite(limit) && limit >= 0 && visibleEntries.length > limit) {
      const partial = await Promise.all(visibleEntries.slice(0, limit).map((entry) => describeDirectoryEntry(validPath, entry)));
      Object.defineProperty(partial, 'truncated', { value: true, enumerable: false });
      return partial;
    }
    const detailed = await Promise.all(visibleEntries.map((entry) => describeDirectoryEntry(validPath, entry)));

    dirCache.set(validPath, { entries: detailed, mtimeMs: stats.mtimeMs, cachedAt: Date.now() });
    pruneCache(dirCache, cacheConfig.maxDirs);
    return detailed;
  };

  return {
    readFileWithCache,
    listDirectoryDetailedWithCache,
    invalidateCachesForPath,
    cacheConfig
  };
}

export const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

export const copyRecursive = async (sourcePath, destinationPath, overwrite = false) => {
  const stats = await fs.lstat(sourcePath);

  if (stats.isDirectory()) {
    if (await pathExists(destinationPath)) {
      if (!overwrite) {
        throw new Error(`Destination ${destinationPath} already exists.`);
      }
      await fs.rm(destinationPath, { recursive: true, force: true });
    }
    await fs.cp(sourcePath, destinationPath, { recursive: true, force: overwrite, errorOnExist: !overwrite });
    return;
  }

  if (!overwrite && await pathExists(destinationPath)) {
    throw new Error(`Destination ${destinationPath} already exists.`);
  }

  const destinationDir = path.dirname(destinationPath);
  await fs.mkdir(destinationDir, { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
};

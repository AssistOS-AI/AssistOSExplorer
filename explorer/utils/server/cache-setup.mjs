import { describeDirectoryEntry, visibleEntriesByName } from '../filesystem-utils.mjs';

export function createCacheConfig(env) {
  return {
    maxFileSizeBytes: 2 * 1024 * 1024,
    maxFiles: 200,
    maxDirs: 200,
    ttlMs: Number.parseInt(env?.FS_CACHE_TTL_MS || '5000', 10)
  };
}

export function initCacheHelpers({ createCacheHelpers, readFileContent, visibleEntries = visibleEntriesByName, cacheConfig, fs, path }) {
  let readFileWithCache = async (validPath, { skipReadForLarge = false } = {}) => {
    const stats = await fs.stat(validPath);
    if (stats.size > cacheConfig.maxFileSizeBytes && skipReadForLarge) {
      return { content: null, stats };
    }
    const content = await readFileContent(validPath);
    return { content, stats };
  };

  let listDirectoryDetailedWithCache = async (validPath) => {
    const entries = await visibleEntries(validPath, await fs.readdir(validPath, { withFileTypes: true }));
    return Promise.all(entries.map((entry) => describeDirectoryEntry(validPath, entry)));
  };

  let invalidateCachesForPath = () => {};
  let updatedConfig = cacheConfig;

  const cacheHelpers = createCacheHelpers({ readFileContent, visibleEntries, config: cacheConfig });
  ({
    readFileWithCache,
    listDirectoryDetailedWithCache,
    invalidateCachesForPath,
    cacheConfig: updatedConfig
  } = cacheHelpers);

  return {
    readFileWithCache,
    listDirectoryDetailedWithCache,
    invalidateCachesForPath,
    cacheConfig: updatedConfig
  };
}

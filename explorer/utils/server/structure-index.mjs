export function createStructureIndex({ fs, path, listDirectoryDetailedWithCache }) {
  const structureIndex = new Map();

  async function indexDirectory(validDirPath, options) {
    const [dirStats, entries] = await Promise.all([
      fs.stat(validDirPath),
      listDirectoryDetailedWithCache(validDirPath, options)
    ]);
    // Partial (budget-limited) listings must not be stored as the directory index.
    if (entries.truncated) return entries;
    const childDirs = [];
    const childFiles = [];
    for (const entry of entries) {
      if (!entry?.name) continue;
      const childPath = path.join(validDirPath, entry.name);
      if (entry.type === 'directory') {
        childDirs.push(childPath);
      } else if (entry.type === 'file') {
        childFiles.push(childPath);
      }
    }
    structureIndex.set(validDirPath, {
      entries,
      mtimeMs: dirStats.mtimeMs,
      cachedAt: Date.now(),
      childDirs,
      childFiles
    });
    return entries;
  }

  function invalidateForPathAndParents(targetPath) {
    if (!targetPath) return;
    structureIndex.delete(targetPath);
    let current = path.dirname(targetPath);
    while (current && current !== path.dirname(current)) {
      structureIndex.delete(current);
      current = path.dirname(current);
    }
  }

  function invalidateSubtree(prefixPath) {
    if (!prefixPath) return;
    const normalizedPrefix = path.resolve(prefixPath);
    for (const key of structureIndex.keys()) {
      const normalizedKey = path.resolve(key);
      if (normalizedKey === normalizedPrefix || normalizedKey.startsWith(`${normalizedPrefix}${path.sep}`)) {
        structureIndex.delete(key);
      }
    }
  }

  return {
    structureIndex,
    indexDirectory,
    invalidateForPathAndParents,
    invalidateSubtree
  };
}


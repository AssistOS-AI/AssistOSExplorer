export async function buildDirectoryTree({
  rootPath,
  indexDirectory,
  path,
  maxDepth,
  maxNodes
}) {
  let nodes = 0;

  async function build(currentPath, depth) {
    if (nodes >= maxNodes) return [];
    if (depth > maxDepth) return [];
    // Only the remaining budget can be emitted, so ask for no more metadata than that.
    const entries = await indexDirectory(currentPath, { limit: maxNodes - nodes });
    const result = [];
    for (const entry of entries) {
      if (nodes >= maxNodes) break;
      if (!entry?.name) continue;
      // Every emitted entry, files included, counts toward maxNodes.
      nodes++;
      const entryData = { name: entry.name, type: entry.type === 'directory' ? 'directory' : 'file' };
      if (entry.type === 'directory') {
        entryData.children = await build(path.join(currentPath, entry.name), depth + 1);
      }
      result.push(entryData);
    }
    return result;
  }

  return build(rootPath, 0);
}


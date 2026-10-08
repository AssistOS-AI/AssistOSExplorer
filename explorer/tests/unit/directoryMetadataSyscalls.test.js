import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCacheHelpers, describeDirectoryEntry } from '../../utils/filesystem-utils.mjs';
import { createStructureIndex } from '../../utils/server/structure-index.mjs';
import { buildDirectoryTree } from '../../utils/server/directory-tree.mjs';

// Reference copy of the pre-optimisation behaviour (lstat + unconditional stat).
async function legacyDescribe(basePath, entry) {
  const entryPath = path.join(basePath, entry.name);
  let linkStats = null;
  let effectiveStats = null;
  let linkTarget = null;
  try {
    linkStats = await fs.lstat(entryPath);
    if (linkStats.isSymbolicLink()) {
      try { linkTarget = await fs.readlink(entryPath); } catch { linkTarget = null; }
    }
  } catch { linkStats = null; }
  try { effectiveStats = await fs.stat(entryPath); } catch { effectiveStats = null; }
  const stats = effectiveStats || linkStats;
  const type = stats?.isDirectory?.() ? 'directory' : stats?.isFile?.() ? 'file' : 'other';
  return {
    name: entry.name, type, size: stats ? stats.size : null,
    modified: stats?.mtime ? stats.mtime.toISOString() : null,
    isSymlink: Boolean(linkStats?.isSymbolicLink?.()), linkTarget
  };
}

async function makeDir(count) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dir-metadata-'));
  for (let i = 0; i < count; i++) {
    if (i % 10 === 0) await fs.mkdir(path.join(root, `d${i}`));
    else await fs.writeFile(path.join(root, `f${i}.txt`), 'x'.repeat(i));
  }
  return root;
}

function spy() {
  return { lstat: mock.method(fs, 'lstat'), stat: mock.method(fs, 'stat') };
}

test('listing 1000 ordinary entries uses one lstat each and no per-entry stat', async () => {
  const root = await makeDir(1000);
  const { listDirectoryDetailedWithCache } = createCacheHelpers({ readFileContent: async () => '' });
  const s = spy();
  try {
    const entries = await listDirectoryDetailedWithCache(root);
    assert.equal(entries.length, 1000);
    assert.equal(s.lstat.mock.callCount(), 1000);
    assert.equal(s.stat.mock.callCount(), 1); // the directory itself only
  } finally {
    mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stat is only called for symbolic links and output matches legacy behaviour', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dir-metadata-sym-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dir-metadata-out-'));
  try {
    await fs.writeFile(path.join(root, 'file.txt'), 'hello');
    await fs.mkdir(path.join(root, 'dir'));
    await fs.symlink(path.join(root, 'file.txt'), path.join(root, 'link-file'));
    await fs.symlink(path.join(root, 'dir'), path.join(root, 'link-dir'));
    await fs.symlink(path.join(root, 'missing'), path.join(root, 'link-broken'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'out');
    await fs.symlink(outside, path.join(root, 'link-escape-dir'));
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link-escape-file'));

    const names = (await fs.readdir(root)).sort();
    const expected = [];
    for (const name of names) expected.push(await legacyDescribe(root, { name }));

    const s = spy();
    const actual = [];
    for (const name of names) actual.push(await describeDirectoryEntry(root, { name }));
    const statCalls = s.stat.mock.callCount();
    mock.restoreAll();

    assert.deepEqual(actual, expected);
    assert.equal(statCalls, 5); // exactly the five symlinks
    const byName = Object.fromEntries(actual.map((e) => [e.name, e]));
    assert.equal(byName['link-broken'].type, 'other');
    assert.equal(byName['link-broken'].isSymlink, true);
    assert.equal(byName['link-escape-dir'].type, 'directory');
    assert.equal(byName['link-escape-file'].type, 'file');
  } finally {
    mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('directory_tree maxNodes=1 describes one entry; output equals unlimited prefix', async () => {
  const root = await makeDir(1000);
  const run = async (maxNodes) => {
    const { listDirectoryDetailedWithCache } = createCacheHelpers({ readFileContent: async () => '' });
    const { indexDirectory, structureIndex } = createStructureIndex({ fs, path, listDirectoryDetailedWithCache });
    const s = spy();
    const tree = await buildDirectoryTree({ rootPath: root, indexDirectory, path, maxDepth: 4, maxNodes });
    const counts = { lstat: s.lstat.mock.callCount(), stat: s.stat.mock.callCount() };
    mock.restoreAll();
    return { tree, counts, structureIndex };
  };
  try {
    const one = await run(1);
    assert.equal(one.tree.length, 1);
    assert.equal(one.counts.lstat, 1);
    assert.equal(one.counts.stat, 2); // root dir stat (index + cache), no per-entry stat
    assert.equal(one.structureIndex.size, 0, 'partial listing must not be stored');

    const five = await run(5);
    const all = await run(100000);
    assert.deepEqual(five.tree.map(({ children, ...n }) => n), all.tree.slice(0, 5).map(({ children, ...n }) => n));
    assert.equal(all.counts.lstat, 1000); // child dirs are empty
  } finally {
    mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

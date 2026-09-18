import fs from 'node:fs/promises';
import path from 'node:path';

export function createOverviewOps(ctx, ops) {
  const { resolveRepoPath } = ctx;

  async function gitReposOverview({ path: reposRootArg, maxRepos = 200 }) {
    const reposRoot = await resolveRepoPath(reposRootArg);
    const limit = Number.isFinite(maxRepos) ? Math.max(1, Math.min(500, Math.floor(maxRepos))) : 200;
  
    async function existsGitMarker(dirPath) {
      try {
        const stat = await fs.stat(path.join(dirPath, '.git'));
        return stat.isDirectory() || stat.isFile();
      } catch {
        return false;
      }
    }
  
    async function scanGitRepos(rootDir, { maxDepth = 4, maxRepos = limit } = {}) {
      const queue = [{ dir: rootDir, depth: 0 }];
      const repos = [];
      const seen = new Set();
  
      while (queue.length && repos.length < maxRepos) {
        const { dir, depth } = queue.shift();
        const resolved = path.resolve(dir);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
  
        if (depth > maxDepth) continue;
        const baseName = path.basename(dir);
        if (baseName === '.git') continue;
  
        if (dir !== rootDir && await existsGitMarker(dir)) {
          repos.push({
            path: dir,
            relativePath: path.posix.normalize(path.relative(rootDir, dir).split(path.sep).join('/')),
            name: path.basename(dir)
          });
          continue;
        }
  
        let children;
        try {
          children = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of children) {
          if (!entry?.isDirectory?.()) continue;
          if (entry.name.startsWith('.')) continue;
          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
      }
      return repos;
    }
  
    const candidates = await scanGitRepos(reposRoot, { maxDepth: 4, maxRepos: limit });
  
    const results = [];
    const concurrency = 4;
    let index = 0;
  
    const worker = async () => {
      while (index < candidates.length) {
        const current = candidates[index];
        index += 1;
        let info;
        try {
          info = await ops.gitInfo({ path: current.path });
        } catch {
          info = { ok: false };
        }
        if (!info || info.ok === false) {
          results.push({
            ...current,
            ok: false,
            branch: null,
            dirty: false,
            counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
            sample: { staged: [], unstaged: [], untracked: [], conflicted: [] }
          });
          continue;
        }
        try {
          // Include untracked so repos with only new files still show up as "dirty" (WebStorm-like).
          const statusPayload = await ops.gitStatusOverview({ path: current.path, includeUntracked: true });
          const status = statusPayload?.status || {};
          let mergeInProgress = Boolean(statusPayload?.mergeInProgress);
          let mergeMessage = mergeInProgress ? String(statusPayload?.mergeMessage || '').trim() || null : null;
          const staged = Array.isArray(status.staged) ? status.staged : [];
          const unstaged = Array.isArray(status.unstaged) ? status.unstaged : [];
          const untracked = Array.isArray(status.untracked) ? status.untracked : [];
          const conflicted = Array.isArray(status.conflicted) ? status.conflicted : [];
          const ignored = Array.isArray(status.ignored) ? status.ignored : [];
          const dirty = mergeInProgress || staged.length > 0 || unstaged.length > 0 || untracked.length > 0 || conflicted.length > 0;
  
          if (!dirty) {
            results.push({
              ...current,
              ok: true,
              branch: info.branch || null,
              mergeInProgress,
              mergeMessage,
              dirty: false,
              counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
              sample: { staged: [], unstaged: [], untracked: [], conflicted: [] },
              ignoredCount: ignored.length,
              changesLoaded: ignored.length === 0,
              ahead: info.ahead || 0,
              behind: info.behind || 0
            });
            continue;
          }
  
          results.push({
            ...current,
            ok: true,
            branch: info.branch || null,
            mergeInProgress,
            mergeMessage,
            dirty: true,
            counts: {
              staged: staged.length,
              unstaged: unstaged.length,
              untracked: untracked.length,
              conflicted: conflicted.length
            },
            sample: {
              staged: staged.slice(0, 8).map((e) => e?.path).filter(Boolean),
              unstaged: unstaged.slice(0, 8).map((e) => e?.path).filter(Boolean),
              untracked: untracked.slice(0, 8).map((e) => e?.path).filter(Boolean),
              conflicted: conflicted.slice(0, 8).map((e) => e?.path).filter(Boolean)
            },
            ignoredCount: ignored.length,
            changesLoaded: false,
            ahead: info.ahead || 0,
            behind: info.behind || 0
          });
        } catch {
          results.push({
            ...current,
            ok: true,
            branch: info.branch || null,
            dirty: false,
            statusUnavailable: true,
            changesLoaded: false,
            counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
            sample: { staged: [], unstaged: [], untracked: [], conflicted: [] },
            ahead: info.ahead || 0,
            behind: info.behind || 0
          });
        }
      }
    };
  
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
    results.sort((a, b) => (a.relativePath || a.name).localeCompare(b.relativePath || b.name));
    return { ok: true, reposRoot, repos: results };
  }

  return { gitReposOverview };
}

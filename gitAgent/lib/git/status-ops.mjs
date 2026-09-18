import fs from 'node:fs/promises';
import path from 'node:path';

import { runGit } from './run-git.mjs';
import { categorizeStatusEntries, parseStatusPorcelainV1Z } from './status-parser.mjs';

// A detailed status intentionally enumerates every untracked and matching ignored
// path. On large bind-mounted repositories this can take substantially longer
// than ordinary Git metadata operations, so it must not inherit runGit's generic
// 20-second deadline. The compact workspace overview retains its own 5-second
// deadline below and therefore remains responsive.
export const DETAILED_STATUS_TIMEOUT_MS = 120000;

export function createStatusOps(ctx) {
  const { resolveRepoWorkTreePath, getGitBinary } = ctx;

  async function readMergeState(repoPath, gitBinary) {
    const { stdout } = await runGit(
      repoPath,
      [gitBinary, 'rev-parse', '--verify', '-q', 'MERGE_HEAD'],
      { timeoutMs: 5000, okCodes: [0, 1] }
    );
    const mergeInProgress = Boolean(String(stdout || '').trim());
    if (!mergeInProgress) return { mergeInProgress: false, mergeMessage: null };
    try {
      const { stdout: mergeMessagePathOutput } = await runGit(
        repoPath,
        [gitBinary, 'rev-parse', '--git-path', 'MERGE_MSG'],
        { timeoutMs: 5000 }
      );
      const mergeMessagePath = String(mergeMessagePathOutput || '').trim();
      const resolvedPath = path.isAbsolute(mergeMessagePath)
        ? mergeMessagePath
        : path.resolve(repoPath, mergeMessagePath);
      const rawMessage = await fs.readFile(resolvedPath, 'utf8');
      const { stdout: cleanedMessage } = await runGit(
        repoPath,
        [gitBinary, 'stripspace', '--strip-comments'],
        { timeoutMs: 5000, input: rawMessage }
      );
      return {
        mergeInProgress: true,
        mergeMessage: String(cleanedMessage || '').trim() || null
      };
    } catch {
      return { mergeInProgress: true, mergeMessage: null };
    }
  }

  async function gitStatus({ path: repoPathArg, includeAhead = false }) {
    const repoPath = await resolveRepoWorkTreePath(repoPathArg);
    const gitBinary = await getGitBinary(repoPath);
    const { stdout } = await runGit(
      repoPath,
      [gitBinary, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--ignored=matching'],
      { timeoutMs: DETAILED_STATUS_TIMEOUT_MS }
    );
    const entries = parseStatusPorcelainV1Z(stdout);
    const status = categorizeStatusEntries(entries);
    const { mergeInProgress, mergeMessage } = await readMergeState(repoPath, gitBinary);
    if (!includeAhead) {
      return { ok: true, status, mergeInProgress, mergeMessage };
    }
    let branch = null;
    let upstream = null;
    let ahead = null;
    let behind = null;
    try {
      const { stdout: branchOut } = await runGit(repoPath, [gitBinary, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
      branch = String(branchOut || '').trim() || null;
    } catch {
      branch = null;
    }
    try {
      const { stdout: upstreamOut } = await runGit(repoPath, [gitBinary, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 5000 });
      upstream = String(upstreamOut || '').trim() || null;
    } catch {
      upstream = null;
    }
    if (upstream) {
      try {
        const { stdout: countsOut } = await runGit(repoPath, [gitBinary, 'rev-list', '--left-right', '--count', `${upstream}...HEAD`], { timeoutMs: 5000 });
        const [behindRaw, aheadRaw] = String(countsOut || '').trim().split(/\s+/);
        const behindNum = Number(behindRaw);
        const aheadNum = Number(aheadRaw);
        if (Number.isFinite(aheadNum)) ahead = aheadNum;
        if (Number.isFinite(behindNum)) behind = behindNum;
      } catch {
        ahead = null;
        behind = null;
      }
    }
    return { ok: true, status, mergeInProgress, mergeMessage, branch, upstream, ahead, behind };
  }
  
  async function gitStatusOverview({ path: repoPathArg, includeUntracked = false }) {
    const repoPath = await resolveRepoWorkTreePath(repoPathArg);
    const gitBinary = await getGitBinary(repoPath);
    const untrackedFlag = includeUntracked ? '-uall' : '-uno';
    const { stdout } = await runGit(
      repoPath,
      // `--no-optional-locks` is a global git option (must be before the subcommand).
      [
        gitBinary,
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        '-z',
        untrackedFlag,
        ...(includeUntracked ? ['--ignored=matching'] : [])
      ],
      { timeoutMs: 5000 }
    );
    const entries = parseStatusPorcelainV1Z(stdout);
    const status = categorizeStatusEntries(entries);
    if (!includeUntracked) {
      status.untracked = [];
      status.ignored = [];
    }
    const { mergeInProgress, mergeMessage } = await readMergeState(repoPath, gitBinary);
    return { ok: true, status, mergeInProgress, mergeMessage };
  }

  return {
    gitStatus,
    gitStatusOverview,
  };
}

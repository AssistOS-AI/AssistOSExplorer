import fs from 'node:fs/promises';
import path from 'node:path';

import { createDiffOps } from './git/diff-ops.mjs';
import { createFetchOps } from './git/fetch-ops.mjs';
import { createBranchOps } from './git/branch-ops.mjs';
import { createIgnoreOps } from './git/ignore-ops.mjs';
import { createOverviewOps } from './git/overview-ops.mjs';
import { createRemoteIdentityOps } from './git/remote-identity-ops.mjs';
import { createRepositoryOps } from './git/repository-ops.mjs';
import { createStashConflictOps } from './git/stash-conflict-ops.mjs';
import { createStageOps } from './git/stage-ops.mjs';
import { createStatusOps } from './git/status-ops.mjs';
import { normalizeErrorMessage, runGit } from './git/run-git.mjs';
import { normalizeGitRepoRelativePath } from './git/validators.mjs';

export function createGitService({ validatePath, workspaceRoots = [] }) {
  let gitBinaryPromise = null;
  let gitBinaryCwd = null;

  async function detectGitBinary(cwd) {
    // Use a known-good directory for binary detection. The user-provided cwd
    // may not exist yet, and spawn() throws ENOENT for both "binary not found"
    // and "cwd not found", making it impossible to distinguish the two cases.
    const probeCwd = '/tmp';
    const configured = process.env.ASSISTOS_GIT_BINARY || process.env.GIT_BINARY;
    if (configured) {
      await runGit(probeCwd, [configured, '--version'], { timeoutMs: 5000 });
      return configured;
    }

    const candidates = [
      'git',
      '/usr/bin/git',
      '/bin/git',
      '/usr/local/bin/git',
      '/opt/homebrew/bin/git',
    ];

    for (const candidate of candidates) {
      try {
        await runGit(probeCwd, [candidate, '--version'], { timeoutMs: 5000 });
        return candidate;
      } catch {
        continue;
      }
    }

    throw new Error('Git executable not found. Install git or set ASSISTOS_GIT_BINARY to the full path of the git binary.');
  }

  async function getGitBinary(cwd) {
    if (!gitBinaryPromise || (gitBinaryCwd && gitBinaryCwd !== cwd)) {
      gitBinaryCwd = cwd;
      gitBinaryPromise = detectGitBinary(cwd);
    }
    return gitBinaryPromise;
  }

  async function resolveRepoPath(repoPathArg) {
    return validatePath(repoPathArg || '/');
  }

  async function resolveRepoWorkTreePath(repoPathArg) {
    const context = await resolveGitTargetContext(repoPathArg);
    return context.repoPath;
  }

  async function resolveGitTargetContext(targetPathArg) {
    const validatedTargetPath = await validatePath(targetPathArg || '/');
    const targetPath = await fs.realpath(validatedTargetPath);
    const stats = await fs.lstat(targetPath);
    const probePath = stats.isDirectory() ? targetPath : path.dirname(targetPath);
    const gitBinary = await getGitBinary(probePath);
    const { stdout } = await runGit(probePath, [gitBinary, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 });
    const repoPathRaw = String(stdout || '').trim();
    const repoPath = repoPathRaw ? await fs.realpath(repoPathRaw) : '';
    if (!repoPath) {
      throw new Error('Not a git repository. Set the path to a file or folder inside a git repository.');
    }
    const relativePath = path.relative(repoPath, targetPath).split(path.sep).join('/');
    if (targetPath !== repoPath && (!relativePath || relativePath.startsWith('..'))) {
      throw new Error('Target path must be inside the git repository.');
    }
    return {
      targetPath,
      probePath,
      repoPath,
      gitBinary,
      stats,
      repoRelativePath: relativePath && relativePath !== '.' ? normalizeGitRepoRelativePath(relativePath) : '',
    };
  }

  const context = {
    validatePath,
    workspaceRoots,
    getGitBinary,
    resolveRepoPath,
    resolveRepoWorkTreePath,
    resolveGitTargetContext,
  };
  const ops = {};
  Object.assign(ops, createRepositoryOps(context));
  Object.assign(ops, createBranchOps(context));
  Object.assign(ops, createStatusOps(context));
  Object.assign(ops, createDiffOps(context));
  Object.assign(ops, createStageOps(context, ops));
  Object.assign(ops, createIgnoreOps(context, ops));
  Object.assign(ops, createOverviewOps(context, ops));
  Object.assign(ops, createStashConflictOps(context, ops));
  Object.assign(ops, createRemoteIdentityOps(context));
  Object.assign(ops, createFetchOps(context));
  const { gitStatusOverview, ...publicOps } = ops;

  return {
    ...publicOps,
    normalizeErrorMessage,
  };
}

#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGitService } from '../lib/git-service.mjs';
import {
  getGithubAuthStatus,
  beginGithubDeviceFlow,
  pollGithubDeviceFlow,
  disconnectGithubAuth,
  getGithubAuthAccessToken,
  storeManualGitAuthToken
} from '../lib/github-auth.mjs';
import {
  listGithubRepositories,
  listGithubRepositoryTargets
} from '../lib/git/github-remotes.mjs';
import gitCommitMessage from '../lib/git-commit-message.js';
import resolveConflict from '../lib/git-resolve-conflict.js';

async function loadInvocationAuth() {
  const candidates = [
    process.env.PLOINKY_INVOCATION_AUTH_MODULE,
    '/Agent/lib/invocation-auth.mjs',
    '../../shared/invocation-auth.mjs'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (_) {}
  }
  throw new Error('Unable to load invocation-auth helper.');
}

const { authInfoFromInvocation } = await loadInvocationAuth();

function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

async function readStdinFallback() {
  if (process.stdin.isTTY) {
    return '';
  }
  process.stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function normalizeInput(envelope) {
  let current = envelope;
  for (let i = 0; i < 4; i += 1) {
    if (!current || typeof current !== 'object') break;
    if (current.input && typeof current.input === 'object') {
      current = current.input;
      continue;
    }
    if (current.arguments && typeof current.arguments === 'object') {
      current = current.arguments;
      continue;
    }
    if (current.params?.arguments && typeof current.params.arguments === 'object') {
      current = current.params.arguments;
      continue;
    }
    if (current.params?.input && typeof current.params.input === 'object') {
      current = current.params.input;
      continue;
    }
    break;
  }
  return current && typeof current === 'object' ? current : {};
}

function extractInvocationGrant(envelope) {
  const metadata = envelope && typeof envelope === 'object' ? envelope.metadata : null;
  const grant = metadata && typeof metadata === 'object' ? metadata.invocation : null;
  return grant && typeof grant === 'object' ? grant : null;
}

function getWorkspaceRoots() {
  const roots = [
    process.env.ASSISTOS_FS_ROOT,
    process.env.WORKSPACE_ROOT,
    process.env.PLOINKY_WORKSPACE_ROOT
  ].filter((value) => typeof value === 'string' && value.trim());
  if (!roots.length) {
    roots.push(process.cwd());
  }
  return roots.map((root) => path.resolve(root));
}

function isWithinRoots(absPath, roots) {
  const resolved = path.resolve(absPath);
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

function validatePathArg(p, roots) {
  if (typeof p !== 'string' || !p.trim()) {
    throw new Error('Path must be a non-empty string.');
  }
  if (p.includes('\0')) {
    throw new Error('Invalid path (contains null byte).');
  }
  const candidate = p.trim();
  if (path.isAbsolute(candidate)) {
    if (!isWithinRoots(candidate, roots)) {
      throw new Error('Path is outside allowed roots.');
    }
    return candidate;
  }
  const root = roots[0];
  const safePart = candidate.startsWith('/') ? candidate.slice(1) : candidate;
  const resolved = path.join(root, safePart);
  if (!isWithinRoots(resolved, roots)) {
    throw new Error('Path is outside allowed roots.');
  }
  return resolved;
}

function normalizeArgs(toolName, args) {
  const input = args && typeof args === 'object' ? { ...args } : {};
  const requirePath = () => {
    if (!input.path || typeof input.path !== 'string') {
      throw new Error(`${toolName} requires a "path" string.`);
    }
  };

  switch (toolName) {
    case 'git_info':
    case 'git_branch_list':
    case 'git_init_repository':
    case 'git_clone_repository':
    case 'git_create_github_repository':
    case 'git_submodule_add':
    case 'git_status':
    case 'git_diagnose':
    case 'git_identity':
      requirePath();
      if (toolName === 'git_init_repository') {
        if (!input.name || typeof input.name !== 'string') {
          throw new Error('git_init_repository requires a "name" string.');
        }
        input.remote = input.remote ?? 'origin';
        if (!input.remoteUrl || typeof input.remoteUrl !== 'string') {
          throw new Error('git_init_repository requires a "remoteUrl" string.');
        }
      }
      if (toolName === 'git_clone_repository') {
        input.remote = input.remote ?? 'origin';
        if (!input.remoteUrl || typeof input.remoteUrl !== 'string') {
          throw new Error('git_clone_repository requires a "remoteUrl" string.');
        }
      }
      if (toolName === 'git_create_github_repository') {
        input.remote = input.remote ?? 'origin';
        input.visibility = input.visibility === 'public' ? 'public' : 'private';
        if (!input.owner || typeof input.owner !== 'string') {
          throw new Error('git_create_github_repository requires an "owner" string.');
        }
        if (!input.name || typeof input.name !== 'string') {
          throw new Error('git_create_github_repository requires a "name" string.');
        }
      }
      if (toolName === 'git_submodule_add') {
        if (!input.name || typeof input.name !== 'string') {
          throw new Error('git_submodule_add requires a "name" string.');
        }
        if (!input.remoteUrl || typeof input.remoteUrl !== 'string') {
          throw new Error('git_submodule_add requires a "remoteUrl" string.');
        }
      }
      if (toolName === 'git_status') {
        input.includeAhead = Boolean(input.includeAhead || false);
      }
      return input;
    case 'git_branch_checkout':
      requirePath();
      if (!input.branch || typeof input.branch !== 'string') {
        throw new Error('git_branch_checkout requires a "branch" string.');
      }
      return input;
    case 'git_branch_create':
      requirePath();
      if (!input.name || typeof input.name !== 'string') {
        throw new Error('git_branch_create requires a "name" string.');
      }
      input.startPoint = typeof input.startPoint === 'string' ? input.startPoint : '';
      input.checkout = input.checkout !== false;
      return input;
    case 'git_branch_merge':
      requirePath();
      if (!input.sourceBranch || typeof input.sourceBranch !== 'string') {
        throw new Error('git_branch_merge requires a "sourceBranch" string.');
      }
      input.noFf = Boolean(input.noFf || false);
      return input;
    case 'git_github_repository_targets':
      return input;
    case 'git_github_repositories':
      if (typeof input.maxRepos !== 'number') {
        input.maxRepos = 500;
      }
      input.query = typeof input.query === 'string' ? input.query : '';
      return input;
    case 'git_commit_message':
      if (!Array.isArray(input.diffs)) {
        throw new Error('git_commit_message requires diffs array.');
      }
      return input;
    case 'git_resolve_conflict':
      input.base = typeof input.base === 'string' ? input.base : '';
      input.ours = typeof input.ours === 'string' ? input.ours : '';
      input.theirs = typeof input.theirs === 'string' ? input.theirs : '';
      input.source = typeof input.source === 'string' ? input.source : '';
      return input;
    case 'git_remote_set':
      requirePath();
      input.remote = input.remote ?? 'origin';
      if (!input.url || typeof input.url !== 'string') {
        throw new Error('git_remote_set requires a "url" string.');
      }
      return input;
    case 'git_diff':
      requirePath();
      if (!input.file || typeof input.file !== 'string') {
        throw new Error('git_diff requires a "file" string.');
      }
      input.cached = Boolean(input.cached || false);
      input.ref = input.ref ?? null;
      return input;
    case 'git_stage':
    case 'git_stage_exact':
    case 'git_unstage':
    case 'git_untrack':
    case 'git_add_ignore':
    case 'git_remove_ignore':
    case 'git_check_ignore':
    case 'git_restore':
      requirePath();
      input.files = Array.isArray(input.files) ? input.files : [];
      return input;
    case 'git_conflict_versions':
      requirePath();
      if (!input.file || typeof input.file !== 'string') {
        throw new Error('git_conflict_versions requires a "file" string.');
      }
      return input;
    case 'git_checkout_conflict':
      requirePath();
      if (!input.file || typeof input.file !== 'string') {
        throw new Error('git_checkout_conflict requires a "file" string.');
      }
      if (!input.source || !['ours', 'theirs'].includes(input.source)) {
        throw new Error('git_checkout_conflict requires source to be "ours" or "theirs".');
      }
      return input;
    case 'git_stash':
      requirePath();
      input.includeUntracked = input.includeUntracked !== false;
      input.message = typeof input.message === 'string' ? input.message : '';
      return input;
    case 'git_stash_pop':
      requirePath();
      input.ref = input.ref ?? null;
      input.reinstateIndex = input.reinstateIndex !== false;
      return input;
    case 'git_stash_list':
      requirePath();
      return input;
    case 'git_check_large_files':
      requirePath();
      if (!['commit', 'push'].includes(input.operation)) throw new Error('operation must be commit or push.');
      return input;
    case 'git_commit':
      requirePath();
      input.message = typeof input.message === 'string' ? input.message : '';
      input.amend = Boolean(input.amend || false);
      input.signoff = Boolean(input.signoff || false);
      input.userName = input.userName ?? null;
      input.userEmail = input.userEmail ?? null;
      return input;
    case 'git_push':
      requirePath();
      input.remote = input.remote ?? null;
      input.branch = input.branch ?? null;
      input.setUpstream = Boolean(input.setUpstream || false);
      input.token = input.token ?? null;
      return input;
    case 'git_fetch':
      requirePath();
      input.token = input.token ?? null;
      return input;
    case 'git_pull':
      requirePath();
      input.remote = input.remote ?? null;
      input.branch = input.branch ?? null;
      input.rebase = Boolean(input.rebase || false);
      input.ffOnly = input.ffOnly !== false;
      input.token = input.token ?? null;
      return input;
    case 'git_auth_status':
    case 'git_auth_begin':
    case 'git_auth_poll':
    case 'git_auth_disconnect':
    case 'git_auth_store_token':
      return input;
    case 'git_repos_overview':
      requirePath();
      if (typeof input.maxRepos !== 'number') {
        input.maxRepos = 200;
      }
      return input;
    case 'git_set_identity':
      requirePath();
      input.scope = input.scope || 'local';
      if (!input.name || !input.email) {
        throw new Error('git_set_identity requires name and email.');
      }
      return input;
    default:
      throw new Error(`Unsupported tool: ${toolName}`);
  }
}

async function main() {
  let raw = await fs.readFile(0, 'utf8').catch(() => '');
  if (!raw) {
    raw = await readStdinFallback();
  }
  const envelope = raw && raw.trim() ? safeParseJson(raw) : null;
  const args = normalizeInput(envelope || {});
  const invocationGrant = extractInvocationGrant(envelope || {});
  const invocationToken = envelope?.metadata?.invocationToken || '';
  const authInfo = invocationGrant ? authInfoFromInvocation(invocationGrant, { invocationToken }) : null;
  const toolName = process.env.TOOL_NAME
    || process.argv[2]
    || envelope?.tool
    || envelope?.params?.name
    || envelope?.params?.tool_name
    || envelope?.name
    || envelope?.tool_name
    || args?.tool_name
    || args?.name;
  if (!toolName) {
    writeJson({ ok: false, error: 'Missing TOOL_NAME.' });
    return;
  }

  try {

    const roots = getWorkspaceRoots();
    const validatePath = (p) => validatePathArg(p, roots);
    const gitService = createGitService({ validatePath, workspaceRoots: roots });
    const workspaceRoot = roots[0] || process.cwd();

    const payload = normalizeArgs(toolName, args);
    if ((toolName === 'git_push' || toolName === 'git_pull' || toolName === 'git_fetch' || toolName === 'git_clone_repository' || toolName === 'git_create_github_repository' || toolName === 'git_submodule_add') && !payload.token) {
      const accessToken = String(authInfo?.github?.accessToken || '').trim();
      if (accessToken) {
        payload.token = accessToken;
      } else {
        const storedToken = await getGithubAuthAccessToken({ workspaceRoot, authInfo });
        if (storedToken) {
          payload.token = storedToken;
        }
      }
    }
    const getGithubToolToken = async () => {
      const accessToken = String(authInfo?.github?.accessToken || '').trim();
      if (accessToken) return accessToken;
      return getGithubAuthAccessToken({ workspaceRoot, authInfo });
    };
    let result;
    switch (toolName) {
      case 'git_auth_status':
        result = await getGithubAuthStatus({ workspaceRoot, authInfo });
        writeJson(result);
        return;
      case 'git_auth_begin':
        result = await beginGithubDeviceFlow({ workspaceRoot, authInfo });
        writeJson(result);
        return;
      case 'git_auth_poll':
        result = await pollGithubDeviceFlow({ workspaceRoot, authInfo });
        writeJson(result);
        return;
      case 'git_auth_disconnect':
        result = await disconnectGithubAuth({ workspaceRoot, authInfo });
        writeJson(result);
        return;
      case 'git_auth_store_token':
        result = await storeManualGitAuthToken({
          workspaceRoot,
          authInfo,
          token: String(payload.token || '')
        });
        writeJson(result);
        return;
      case 'git_info':
        result = await gitService.gitInfo(payload);
        writeJson(result);
        return;
      case 'git_branch_list':
        result = await gitService.gitBranchList(payload);
        writeJson(result);
        return;
      case 'git_branch_checkout':
        result = await gitService.gitBranchCheckout(payload);
        writeJson(result);
        return;
      case 'git_branch_create':
        result = await gitService.gitBranchCreate(payload);
        writeJson(result);
        return;
      case 'git_branch_merge':
        result = await gitService.gitBranchMerge(payload);
        writeJson(result);
        return;
      case 'git_init_repository':
        result = await gitService.gitInitRepository(payload);
        writeJson(result);
        return;
      case 'git_create_github_repository':
        result = await gitService.gitCreateGithubRepository(payload);
        writeJson(result);
        return;
      case 'git_clone_repository':
        result = await gitService.gitCloneRepository(payload);
        writeJson(result);
        return;
      case 'git_submodule_add':
        result = await gitService.gitSubmoduleAdd(payload);
        writeJson(result);
        return;
      case 'git_github_repository_targets':
        result = await listGithubRepositoryTargets({ token: await getGithubToolToken() });
        writeJson(result);
        return;
      case 'git_github_repositories':
        result = await listGithubRepositories({
          token: await getGithubToolToken(),
          query: payload.query,
          maxRepos: payload.maxRepos
        });
        writeJson(result);
        return;
      case 'git_commit_message':
        result = await gitCommitMessage(payload);
        writeJson({ ok: true, message: typeof result === 'string' ? result : String(result ?? '') });
        return;
      case 'git_resolve_conflict':
        result = await resolveConflict(payload);
        writeJson({ ok: true, content: typeof result === 'string' ? result : String(result ?? '') });
        return;
      case 'git_remote_set':
        result = await gitService.gitRemoteSet(payload);
        writeJson(result);
        return;
      case 'git_status':
        result = await gitService.gitStatus(payload);
        writeJson(result);
        return;
      case 'git_diff':
        result = await gitService.gitDiff(payload);
        process.stdout.write(String(result || ''));
        return;
      case 'git_stage':
        result = await gitService.gitStage(payload);
        writeJson(result);
        return;
      case 'git_stage_exact':
        result = await gitService.gitStageExact(payload);
        writeJson(result);
        return;
      case 'git_unstage':
        result = await gitService.gitUnstage(payload);
        writeJson(result);
        return;
      case 'git_untrack':
        result = await gitService.gitUntrack(payload);
        writeJson(result);
        return;
      case 'git_check_ignore':
        result = await gitService.gitCheckIgnore(payload);
        writeJson(result);
        return;
      case 'git_add_ignore':
        result = await gitService.gitAddIgnore(payload);
        writeJson(result);
        return;
      case 'git_remove_ignore':
        result = await gitService.gitRemoveIgnore(payload);
        writeJson(result);
        return;
      case 'git_restore':
        result = await gitService.gitRestore(payload);
        writeJson(result);
        return;
      case 'git_conflict_versions':
        result = await gitService.gitConflictVersions(payload);
        writeJson(result);
        return;
      case 'git_checkout_conflict':
        result = await gitService.gitCheckoutConflict(payload);
        writeJson(result);
        return;
      case 'git_stash':
        result = await gitService.gitStash(payload);
        writeJson(result);
        return;
      case 'git_stash_pop':
        result = await gitService.gitStashPop(payload);
        writeJson(result);
        return;
      case 'git_stash_list':
        result = await gitService.gitStashList(payload);
        writeJson(result);
        return;
      case 'git_check_large_files':
        writeJson(await gitService.gitCheckLargeFiles(payload));
        return;
      case 'git_commit':
        result = await gitService.gitCommit(payload);
        writeJson(result);
        return;
      case 'git_push':
        result = await gitService.gitPush(payload);
        writeJson(result);
        return;
      case 'git_fetch':
        result = await gitService.gitFetch(payload);
        writeJson(result);
        return;
      case 'git_pull':
        result = await gitService.gitPull(payload);
        writeJson(result);
        return;
      case 'git_diagnose':
        result = await gitService.gitDiagnose(payload);
        writeJson(result);
        return;
      case 'git_repos_overview':
        result = await gitService.gitReposOverview(payload);
        writeJson(result);
        return;
      case 'git_identity':
        result = await gitService.gitIdentity(payload);
        writeJson(result);
        return;
      case 'git_set_identity':
        result = await gitService.gitSetIdentity(payload);
        writeJson(result);
        return;
      default:
        throw new Error(`Unsupported tool: ${toolName}`);
    }
  } catch (error) {
    const message = error?.message || String(error);
    writeJson({ ok: false, error: message });
  }
}

main();

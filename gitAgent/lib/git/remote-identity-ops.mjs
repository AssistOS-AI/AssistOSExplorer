import { ensureGithubHttpsRemoteRepository, getGithubAccessTokenFromMeta, isGithubHttpsRemote, toBasicAuthHeader } from './github-remotes.mjs';
import { normalizeErrorMessage, runGit } from './run-git.mjs';
import { normalizeGitConfigValue } from './validators.mjs';
import { inspectLargeFiles } from './large-files.mjs';

export function createRemoteIdentityOps(ctx) {
  const { getGitBinary, resolveRepoWorkTreePath } = ctx;

  async function gitCheckLargeFiles({ path: repoPathArg, ...options }) {
    const repoPath = await resolveRepoWorkTreePath(repoPathArg);
    const gitBinary = await getGitBinary(repoPath);
    return inspectLargeFiles(repoPath, gitBinary, options);
  }

  async function gitCommit({ path: repoPathArg, message, amend = false, signoff = false, useExistingMessage = false, userName = null, userEmail = null, approvedLargeFileOids = [] }) {
    const repoPath = await resolveRepoWorkTreePath(repoPathArg);
    const gitBinary = await getGitBinary(repoPath);
    const warning = await inspectLargeFiles(repoPath, gitBinary, { operation: 'commit', approvedLargeFileOids });
    if (!warning.ok) return warning;
    const args = [gitBinary];
    const cleanName = userName ? String(userName).trim() : '';
    const cleanEmail = userEmail ? String(userEmail).trim() : '';
    if (cleanName) args.push('-c', `user.name=${cleanName}`);
    if (cleanEmail) args.push('-c', `user.email=${cleanEmail}`);
    args.push('commit');
    if (amend) args.push('--amend');
    if (signoff) args.push('--signoff');
    if (useExistingMessage) args.push('--no-edit');
    if (message && message.trim()) {
      args.push('-m', message.trim());
    }
    const { stdout, stderr } = await runGit(repoPath, args, { timeoutMs: 60000 });
    return { ok: true, stdout, stderr };
  }
  
  async function gitPush({ path: repoPathArg, remote = null, branch = null, setUpstream = false, token = null, _meta = null, params = null, approvedLargeFileOids = [] }) {
    const repoPath = await resolveRepoWorkTreePath(repoPathArg);
    const gitBinary = await getGitBinary(repoPath);
    const warning = await inspectLargeFiles(repoPath, gitBinary, { operation: 'push', remote, branch, setUpstream, approvedLargeFileOids });
    if (!warning.ok) return warning;
    const getCurrentBranch = async () => {
      try {
        const { stdout } = await runGit(repoPath, [gitBinary, 'branch', '--show-current'], { timeoutMs: 5000 });
        const value = String(stdout || '').trim();
        if (value) return value;
      } catch {}
      const { stdout } = await runGit(repoPath, [gitBinary, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
      const value = String(stdout || '').trim();
      if (!value || value === 'HEAD') {
        throw new Error('Cannot push because the repository is not on a named branch.');
      }
      return value;
    };
    const getCurrentUpstream = async () => {
      try {
        const { stdout } = await runGit(repoPath, [gitBinary, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 5000 });
        return String(stdout || '').trim();
      } catch {
        return '';
      }
    };
    const guessRemoteForPush = async () => {
      try {
        const { stdout } = await runGit(repoPath, [gitBinary, 'config', '--get', 'remote.pushDefault'], { timeoutMs: 5000 });
        const v = (stdout || '').trim();
        if (v) return v;
      } catch {}
      try {
        const { stdout } = await runGit(repoPath, [gitBinary, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 5000 });
        const upstream = (stdout || '').trim();
        if (upstream && upstream.includes('/')) return upstream.split('/')[0];
      } catch {}
      return null;
    };
  
    const remoteForAuth = remote || (await guessRemoteForPush()) || 'origin';
    let remoteUrl = '';
    try {
      const { stdout } = await runGit(repoPath, [gitBinary, 'remote', 'get-url', '--push', remoteForAuth], { timeoutMs: 5000 });
      remoteUrl = (stdout || '').trim();
    } catch {
      try {
        const { stdout } = await runGit(repoPath, [gitBinary, 'remote', 'get-url', remoteForAuth], { timeoutMs: 5000 });
        remoteUrl = (stdout || '').trim();
      } catch {
        remoteUrl = '';
      }
    }
  
    const explicitToken = token ? String(token).trim() : '';
    const metaGithubToken = getGithubAccessTokenFromMeta(_meta || (params && typeof params === 'object' ? params._meta : null) || { params });
    const isHttpRemote = remoteUrl.startsWith('http://') || remoteUrl.startsWith('https://');
    const effectiveToken = isHttpRemote
      ? (explicitToken || (isGithubHttpsRemote(remoteUrl) ? metaGithubToken : ''))
      : '';
    let extraHeader = null;
    if (effectiveToken) {
      extraHeader = toBasicAuthHeader({ username: 'x-access-token', token: effectiveToken });
    }
    if (isGithubHttpsRemote(remoteUrl)) {
      await ensureGithubHttpsRemoteRepository({
        repoPath,
        gitBinary,
        remoteName: remoteForAuth,
        remoteUrl,
        token: effectiveToken
      });
    }
  
    const args = [gitBinary];
    if (extraHeader) {
      args.push('-c', `http.extraHeader=${extraHeader}`);
    }
    args.push('push');
    const currentUpstream = await getCurrentUpstream();
    const shouldSetUpstream = Boolean(setUpstream || !currentUpstream);
    if (shouldSetUpstream) {
      const branchForPush = branch || await getCurrentBranch();
      const remoteForPush = remote || remoteForAuth;
      args.push('--set-upstream', remoteForPush, branchForPush);
    } else if (branch && !remote) {
      args.push(remoteForAuth, branch);
    } else {
      if (remote) args.push(remote);
      if (branch) args.push(branch);
    }
    const { stdout, stderr } = await runGit(repoPath, args, { timeoutMs: 120000 });
    return { ok: true, stdout, stderr };
  }
  
  async function gitPull({ path: repoPathArg, remote = null, branch = null, rebase = false, ffOnly = true, token = null, _meta = null, params = null }) {
    const repoPath = await resolveRepoWorkTreePath(repoPathArg);
    const gitBinary = await getGitBinary(repoPath);
  
    const guessRemoteForPull = async () => {
      try {
        const { stdout } = await runGit(repoPath, [gitBinary, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 5000 });
        const upstream = (stdout || '').trim();
        if (upstream && upstream.includes('/')) return upstream.split('/')[0];
      } catch {}
      try {
        const { stdout } = await runGit(repoPath, [gitBinary, 'config', '--get', 'remote.pushDefault'], { timeoutMs: 5000 });
        const v = (stdout || '').trim();
        if (v) return v;
      } catch {}
      return null;
    };
  
    const remoteForAuth = remote || (await guessRemoteForPull()) || 'origin';
    let remoteUrl = '';
    try {
      const { stdout } = await runGit(repoPath, [gitBinary, 'remote', 'get-url', remoteForAuth], { timeoutMs: 5000 });
      remoteUrl = (stdout || '').trim();
    } catch {
      remoteUrl = '';
    }
  
    const explicitToken = token ? String(token).trim() : '';
    const metaGithubToken = getGithubAccessTokenFromMeta(_meta || (params && typeof params === 'object' ? params._meta : null) || { params });
    const isHttpRemote = remoteUrl.startsWith('http://') || remoteUrl.startsWith('https://');
    const effectiveToken = isHttpRemote
      ? (explicitToken || (isGithubHttpsRemote(remoteUrl) ? metaGithubToken : ''))
      : '';
    let extraHeader = null;
    if (effectiveToken) {
      if (!remoteUrl) {
        throw new Error(`No remote '${remoteForAuth}' configured for repository at ${repoPath}. Ensure the repository has a remote configured.`);
      }
      extraHeader = toBasicAuthHeader({ username: 'x-access-token', token: effectiveToken });
    }
  
    const args = [gitBinary];
    if (extraHeader) {
      args.push('-c', `http.extraHeader=${extraHeader}`);
    }
    args.push('pull', '--no-autostash');
    // Newer git versions may require explicitly choosing the reconcile strategy when branches diverge.
    // Keep defaults safe: ff-only unless user explicitly chose merge/rebase.
    if (ffOnly) {
      args.push('--ff-only');
    } else if (rebase) {
      args.push('--rebase=true');
      args.push('--ff');
    } else {
      // Explicit merge strategy.
      args.push('--rebase=false');
      args.push('--ff');
    }
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    const { stdout, stderr } = await runGit(repoPath, args, { timeoutMs: 180000 });
    return { ok: true, stdout, stderr };
  }
  
  async function gitDiagnose({ path: repoPathArg }) {
    const repoPath = await resolveRepoWorkTreePath(repoPathArg);
    const configured = process.env.ASSISTOS_GIT_BINARY || process.env.GIT_BINARY || null;
    const envPath = process.env.PATH || null;
    const candidates = [
      'git',
      '/usr/bin/git',
      '/bin/git',
      '/usr/local/bin/git',
      '/opt/homebrew/bin/git'
    ];
    const results = [];
    for (const candidate of candidates) {
      const row = { candidate, version: null, error: null };
      try {
        const { stdout } = await runGit(repoPath, [candidate, '--version'], { timeoutMs: 5000 });
        row.version = stdout.trim() || null;
      } catch (error) {
        row.error = normalizeErrorMessage(error);
      }
      results.push(row);
    }
  
    let selected = null;
    let selectedError = null;
    try {
      selected = await getGitBinary(repoPath);
    } catch (error) {
      selectedError = normalizeErrorMessage(error);
    }
  
    return {
      ok: Boolean(selected),
      repoPath,
      cwd: process.cwd(),
      configured,
      envPath,
      selected,
      selectedError,
      candidates: results
    };
  }
  
  async function gitIdentity({ path: repoPathArg }) {
    const repoPath = await resolveRepoWorkTreePath(repoPathArg);
    const gitBinary = await getGitBinary(repoPath);
  
    const getValue = async (args) => {
      try {
        const { stdout } = await runGit(repoPath, [gitBinary, 'config', '--get', ...args], { timeoutMs: 5000 });
        return (stdout || '').trim();
      } catch {
        return '';
      }
    };
  
    const localName = await getValue(['user.name']);
    const localEmail = await getValue(['user.email']);
    const globalName = await getValue(['--global', 'user.name']);
    const globalEmail = await getValue(['--global', 'user.email']);
  
    const effectiveName = localName || globalName || '';
    const effectiveEmail = localEmail || globalEmail || '';
  
    return {
      ok: Boolean(effectiveName && effectiveEmail),
      repoPath,
      effective: {
        name: effectiveName || null,
        email: effectiveEmail || null,
        source: localName || localEmail ? 'local' : globalName || globalEmail ? 'global' : 'none'
      },
      local: { name: localName || null, email: localEmail || null },
      global: { name: globalName || null, email: globalEmail || null }
    };
  }
  
  async function gitSetIdentity({ path: repoPathArg, scope = 'local', name, email }) {
    const repoPath = await resolveRepoWorkTreePath(repoPathArg);
    const gitBinary = await getGitBinary(repoPath);
    const cleanName = normalizeGitConfigValue(name);
    const cleanEmail = normalizeGitConfigValue(email);
    if (!cleanName) throw new Error('Missing user.name');
    if (!cleanEmail) throw new Error('Missing user.email');
  
    const isGlobal = scope === 'global';
    const argsPrefix = isGlobal ? [gitBinary, 'config', '--global'] : [gitBinary, 'config'];
    await runGit(repoPath, [...argsPrefix, 'user.name', cleanName], { timeoutMs: 5000 });
    await runGit(repoPath, [...argsPrefix, 'user.email', cleanEmail], { timeoutMs: 5000 });
    return { ok: true, scope: isGlobal ? 'global' : 'local', repoPath };
  }

  return {
    gitCheckLargeFiles,
    gitCommit,
    gitPull,
    gitPush,
    gitDiagnose,
    gitIdentity,
    gitSetIdentity,
  };
}

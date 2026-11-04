import { Buffer } from 'node:buffer';

import { runGit } from './run-git.mjs';

export function toBasicAuthHeader({ username, token }) {
  const user = String(username || 'x-access-token');
  const pass = String(token || '');
  const encoded = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  return `Authorization: Basic ${encoded}`;
}

export function isGithubHttpsRemote(remoteUrl) {
  const value = String(remoteUrl || '').trim().toLowerCase();
  return value.startsWith('https://github.com/') || value.startsWith('http://github.com/');
}

export function parseGithubHttpsRepositoryRemote(remoteUrl) {
  const normalized = String(remoteUrl || '').trim().replace(/\/+$/g, '').replace(/\.git$/i, '');
  const match = normalized.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    canonicalUrl: `https://github.com/${match[1]}/${match[2]}.git`
  };
}

export async function readGithubApiError(response) {
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try {
    const payload = JSON.parse(text);
    return String(payload?.message || text).trim();
  } catch {
    return text.trim();
  }
}

function createGithubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ploinky-git-agent'
  };
  const authToken = String(token || '').trim();
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return headers;
}

async function fetchGithubJson(url, { token, method = 'GET', body = null } = {}) {
  const headers = createGithubHeaders(token);
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    throw new Error(await readGithubApiError(response) || `GitHub API request failed (${response.status}).`);
  }
  return response.json();
}

function sanitizeGithubOwner(owner) {
  const login = String(owner?.login || '').trim();
  if (!login) return null;
  return {
    login,
    type: String(owner?.type || '').trim() || 'User',
    avatarUrl: String(owner?.avatar_url || '').trim(),
    htmlUrl: String(owner?.html_url || `https://github.com/${login}`).trim(),
    repositoryUrl: `https://github.com/${login}`
  };
}

function sanitizeGithubRepository(repo) {
  const owner = sanitizeGithubOwner(repo?.owner);
  const name = String(repo?.name || '').trim();
  const fullName = String(repo?.full_name || '').trim();
  if (!owner || !name || !fullName) return null;
  return {
    id: Number.isFinite(Number(repo?.id)) ? Number(repo.id) : null,
    fullName,
    name,
    owner: owner.login,
    ownerType: owner.type,
    private: Boolean(repo?.private),
    htmlUrl: String(repo?.html_url || `https://github.com/${fullName}`).trim(),
    cloneUrl: String(repo?.clone_url || `https://github.com/${fullName}.git`).trim(),
    defaultBranch: String(repo?.default_branch || '').trim(),
    description: String(repo?.description || '').trim(),
    updatedAt: String(repo?.updated_at || '').trim()
  };
}

function parseGithubLinkHeader(value) {
  const links = {};
  for (const part of String(value || '').split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      links[match[2]] = match[1];
    }
  }
  return links;
}

async function fetchGithubPages(initialUrl, { token, maxItems = 500 } = {}) {
  const items = [];
  let nextUrl = initialUrl;
  while (nextUrl && items.length < maxItems) {
    const response = await fetch(nextUrl, {
      headers: createGithubHeaders(token)
    });
    if (!response.ok) {
      throw new Error(await readGithubApiError(response) || `GitHub API request failed (${response.status}).`);
    }
    const payload = await response.json().catch(() => []);
    if (Array.isArray(payload)) {
      items.push(...payload);
    }
    const links = parseGithubLinkHeader(response.headers.get('link'));
    nextUrl = links.next || '';
  }
  return items.slice(0, maxItems);
}

export async function listGithubRepositoryTargets({ token }) {
  const authToken = String(token || '').trim();
  if (!authToken) {
    return { ok: false, code: 'github_auth_required', error: 'Connect GitHub to load organizations.' };
  }
  const orgs = await fetchGithubPages('https://api.github.com/user/orgs?per_page=100', { token: authToken, maxItems: 300 });
  const targets = orgs
    .map((org) => sanitizeGithubOwner({ ...org, type: 'Organization' }))
    .filter(Boolean);
  const seen = new Set();
  return {
    ok: true,
    targets: targets.filter((target) => {
      const key = target.login.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
  };
}

export async function listGithubRepositories({ token, query = '', maxRepos = 500 }) {
  const authToken = String(token || '').trim();
  if (!authToken) {
    return { ok: false, code: 'github_auth_required', error: 'Connect GitHub to load repositories.' };
  }
  const url = 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member';
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const repositories = (await fetchGithubPages(url, { token: authToken, maxItems: maxRepos }))
    .map(sanitizeGithubRepository)
    .filter(Boolean)
    .filter((repo) => {
      if (!normalizedQuery) return true;
      return repo.fullName.toLowerCase().includes(normalizedQuery)
        || repo.description.toLowerCase().includes(normalizedQuery);
    });
  return { ok: true, repositories };
}

async function reconcileGithubRepository({ owner, name, visibility, token }) {
  const unknownOutcome = 'GitHub repository creation outcome is unknown. Verify the repository on GitHub before retrying.';
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(unknownOutcome));
    }, 5000);
  });
  const repoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const options = {
    method: 'GET',
    headers: createGithubHeaders(token),
    redirect: 'error',
    signal: controller.signal,
  };
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(repoUrl, options);
      if (!response.ok) throw new Error(unknownOutcome);
      const found = await response.json();
      if (!Number.isSafeInteger(found?.id) || found.id <= 0
        || typeof found.owner?.login !== 'string' || found.owner.login.toLowerCase() !== owner.toLowerCase()
        || typeof found.name !== 'string' || found.name.toLowerCase() !== name.toLowerCase()
        || typeof found.full_name !== 'string' || found.full_name.toLowerCase() !== `${owner}/${name}`.toLowerCase()
        || found.private !== (visibility !== 'public')
        || found.archived !== false || found.disabled !== false || found.fork !== false) {
        throw new Error(unknownOutcome);
      }
      const branchesResponse = await fetch(`${repoUrl}/branches?per_page=1`, options);
      if (!branchesResponse.ok) throw new Error(unknownOutcome);
      const branches = await branchesResponse.json();
      if (!Array.isArray(branches) || branches.length !== 0) throw new Error(unknownOutcome);
      const htmlUrl = `https://github.com/${encodeURIComponent(found.owner.login)}/${encodeURIComponent(found.name)}`;
      return {
        ok: true,
        reconciled: true,
        repository: {
          ...sanitizeGithubRepository(found),
          htmlUrl,
          cloneUrl: `${htmlUrl}.git`,
        },
      };
    })()]);
  } catch {
    throw new Error(unknownOutcome);
  } finally {
    clearTimeout(timer);
  }
}

export async function createGithubRepository({ owner, name, visibility = 'private', token }) {
  const authToken = String(token || '').trim();
  if (!authToken) {
    throw new Error('GitHub authentication is required to create the remote repository.');
  }
  const repoOwner = String(owner || '').trim();
  const repoName = String(name || '').trim();
  if (!repoOwner || !repoName) {
    throw new Error('GitHub owner and repository name are required.');
  }
  const user = await fetchGithubJson('https://api.github.com/user', { token: authToken });
  const login = String(user?.login || '').trim();
  const createUrl = repoOwner.toLowerCase() === login.toLowerCase()
    ? 'https://api.github.com/user/repos'
    : `https://api.github.com/orgs/${encodeURIComponent(repoOwner)}/repos`;
  const reconcile = () => reconcileGithubRepository({ owner: repoOwner, name: repoName, visibility, token: authToken });
  let response;
  try {
    response = await fetch(createUrl, {
      method: 'POST',
      headers: { ...createGithubHeaders(authToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: repoName,
        private: visibility !== 'public',
        auto_init: false,
      }),
    });
  } catch {
    return reconcile();
  }
  if (response.status >= 500 && response.status <= 599) return reconcile();
  if (!response.ok) {
    throw new Error(await readGithubApiError(response) || `GitHub API request failed (${response.status}).`);
  }
  let created;
  try {
    created = await response.json();
  } catch {
    return reconcile();
  }
  const repository = sanitizeGithubRepository(created);
  return {
    ok: true,
    reconciled: false,
    repository: repository || {
      fullName: `${repoOwner}/${repoName}`,
      name: repoName,
      owner: repoOwner,
      private: visibility !== 'public',
      htmlUrl: `https://github.com/${repoOwner}/${repoName}`,
      cloneUrl: `https://github.com/${repoOwner}/${repoName}.git`
    }
  };
}

export async function ensureGithubHttpsRemoteRepository({ repoPath, gitBinary, remoteName, remoteUrl, token }) {
  const parsed = parseGithubHttpsRepositoryRemote(remoteUrl);
  if (!parsed) return;

  if (parsed.canonicalUrl !== remoteUrl) {
    await runGit(repoPath, [gitBinary, 'remote', 'set-url', remoteName, parsed.canonicalUrl], { timeoutMs: 10000 });
  }

  const authToken = String(token || '').trim();
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ploinky-git-agent'
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const repoResponse = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    { method: 'HEAD', headers }
  );
  if (repoResponse.ok) return;
  if (repoResponse.status !== 404) {
    throw new Error(await readGithubApiError(repoResponse) || `GitHub repository lookup failed (${repoResponse.status}).`);
  }
  if (!authToken) {
    throw new Error('GitHub authentication is required to create the remote repository.');
  }

  const userResponse = await fetch('https://api.github.com/user', {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${authToken}`,
      'User-Agent': 'ploinky-git-agent'
    }
  });
  if (!userResponse.ok) {
    throw new Error('GitHub authentication is required to create the remote repository.');
  }
  const userPayload = await userResponse.json().catch(() => ({}));
  const login = String(userPayload?.login || '').trim();
  if (!login) {
    throw new Error('GitHub authentication did not return an account login.');
  }

  const createUrl = parsed.owner.toLowerCase() === login.toLowerCase()
    ? 'https://api.github.com/user/repos'
    : `https://api.github.com/orgs/${encodeURIComponent(parsed.owner)}/repos`;
  const createResponse = await fetch(createUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ploinky-git-agent'
    },
    body: JSON.stringify({
      name: parsed.repo,
      auto_init: false
    })
  });
  if (!createResponse.ok) {
    throw new Error(await readGithubApiError(createResponse) || `Cannot create GitHub repository ${parsed.owner}/${parsed.repo} (${createResponse.status}).`);
  }
}

export function getGithubAccessTokenFromMeta(meta) {
  const directMeta = meta && typeof meta === 'object' ? meta : null;
  const nestedMeta = directMeta && directMeta.params && typeof directMeta.params === 'object'
    ? (directMeta.params._meta && typeof directMeta.params._meta === 'object' ? directMeta.params._meta : null)
    : null;
  const resolvedMeta = directMeta?.auth ? directMeta : nestedMeta;
  const auth = resolvedMeta && typeof resolvedMeta === 'object' ? resolvedMeta.auth : null;
  const github = auth && typeof auth === 'object' ? auth.github : null;
  if (!github || typeof github !== 'object') return '';
  if (String(github.provider || '').trim().toLowerCase() !== 'github') return '';
  return String(github.accessToken || '').trim();
}

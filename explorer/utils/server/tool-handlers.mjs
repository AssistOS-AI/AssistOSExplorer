import { createReadStream } from 'node:fs';
import { EXPORT_LEDGER, skillTreeDigest, syncManagedSkillExports } from './managed-skill-exports.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jsonResponse, textResponse } from './responses.mjs';
import { createAvatarSettingsStore } from './avatar-settings/avatar-settings-store.mjs';
import { createMarkdownCrdtStore } from './markdown-crdt/markdown-crdt-store.mjs';
import { createScriptaCrdtService } from './markdown-crdt/scripta-crdt-service.mjs';
import { createWebMeetMediaStore } from './webmeet-media-store.mjs';
import { createExplorerPrivateDataBoundary } from './private-data-boundary.mjs';

function parseArgs(schema, args, name) {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for ${name}: ${parsed.error}`);
  }
  return parsed.data;
}

async function readFileAsBase64Stream(filePath) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      const finalBuffer = Buffer.concat(chunks);
      resolve(finalBuffer.toString('base64'));
    });
    stream.on('error', reject);
  });
}

async function runExplorerToolScript(scriptName, args, { timeoutMs = 30000 } = {}) {
  const scriptPath = fileURLToPath(new URL(`../../tools/${scriptName}`, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${scriptName} timed out.`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim() || '{}');
      } catch {
        reject(new Error(stderr.trim() || stdout.trim() || `${scriptName} returned invalid JSON.`));
        return;
      }
      if (code !== 0 || parsed?.ok === false) {
        reject(new Error(parsed?.error || stderr.trim() || `${scriptName} failed.`));
        return;
      }
      resolve(parsed);
    });
    child.stdin.end(JSON.stringify({ arguments: args || {} }));
  });
}

export function createToolHandlers({
  fs,
  path,
  schemas,
  validatePath,
  cacheConfig,
  readFileWithCache,
  listDirectoryDetailedWithCache,
  indexDirectory,
  invalidateCachesForPath,
  invalidateStructureIndexSubtree,
  formatSize,
  getFileStats,
  applyFileEdits,
  tailFile,
  headFile,
  writeFileContent,
  copyRecursive,
  aggregateIdePlugins,
  workspaceRoot,
  agentName = 'explorer',
  buildDirectoryTree,
  directoryTreeCache,
  buildCacheKey,
  searchFilesCache,
  searchTextCache,
  searchFilesWithinWorkspace,
  searchTextWithinWorkspace,
  replaceTextWithinWorkspace,
  MAX_TEXT_SEARCH_FILE_BYTES,
  SEARCH_TEXT_TIMEOUT_MS,
  REPLACE_TEXT_TIMEOUT_MS,
  DEFAULT_DIRECTORY_TREE_MAX_DEPTH,
  DEFAULT_DIRECTORY_TREE_MAX_NODES,
  getAllowedDirectories,
  commandMode = false,
  searchTextJobStorePath = '',
  getInvocationContext = () => ({})
}) {
  const privateData = createExplorerPrivateDataBoundary({ fs, path, workspaceRoot });
  const {
    ReadTextFileArgsSchema,
    ReadMediaFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    WriteBinaryFileArgsSchema,
    EditFileArgsSchema,
    CreateDirectoryArgsSchema,
    DeleteFileArgsSchema,
    DeleteDirectoryArgsSchema,
    ListDirectoryArgsSchema,
    ListDirectoryWithSizesArgsSchema,
    ListDirectoryDetailedArgsSchema,
    DirectoryTreeArgsSchema,
    MoveFileArgsSchema,
    CopyFileArgsSchema,
    SearchFilesArgsSchema,
    SearchTextArgsSchema,
    SearchTextStatusArgsSchema,
    SearchTextCancelArgsSchema,
    ReplaceTextArgsSchema,
    GetFileInfoArgsSchema,
    OpenMarkdownCrdtDocumentArgsSchema,
    ApplyMarkdownCrdtChangeArgsSchema,
    MergeMarkdownCrdtDocumentArgsSchema,
    SaveMarkdownCrdtDocumentArgsSchema,
    SyncMarkdownCrdtFromFileArgsSchema,
    ScriptaCrdtOpenArgsSchema,
    ScriptaCrdtEnsureFolderArgsSchema,
    ScriptaCrdtWorkspaceListArgsSchema,
    ScriptaCrdtCreateArgsSchema,
    ScriptaCrdtMutateArgsSchema,
    ScriptaCrdtDeleteArgsSchema,
    WebMeetMediaCommitArgsSchema,
    WebMeetMediaGetArgsSchema,
    ScriptaCollaborationOpenArgsSchema,
    ScriptaCollaborationPullArgsSchema,
    ScriptaCollaborationApplyArgsSchema,
    ScriptaCollaborationMergeMarkdownArgsSchema,
    LlmAutocompleteArgsSchema,
    CollectIDEPluginsArgsSchema,
    GetPluginSettingsArgsSchema,
    SetPluginEnabledArgsSchema,
    ReadSkillsManifestStateArgsSchema,
    AddSkillsManifestRepoArgsSchema,
    SetSkillsManifestSkillEnabledArgsSchema,
    RemoveSkillsManifestRepoArgsSchema,
    GetAvatarSettingsAgentsArgsSchema,
    UpdateAvatarSettingsAgentArgsSchema,
    SetAvatarSettingsAgentVisibilityArgsSchema
  } = schemas;
  const webMeetMediaStore = createWebMeetMediaStore({ fs, path, validatePath, agentName });
  const inflightSearchFiles = new Map();
  const inflightSearchText = new Map();
  const searchTextJobs = new Map();
  let searchTextJobIdSeq = 0;

  function createSearchTextJob(cacheKey) {
    const id = `search_job_${++searchTextJobIdSeq}_${Date.now()}`;
    const job = {
      id,
      status: 'running',
      createdAt: Date.now(),
      results: [],
      truncated: false,
      timedOut: false,
      error: null,
      cacheKey
    };
    searchTextJobs.set(id, job);
    return job;
  }

  function cleanupSearchTextJobs() {
    const now = Date.now();
    const maxAgeMs = 5 * 60 * 1000;
    for (const [id, job] of searchTextJobs) {
      if (now - job.createdAt > maxAgeMs) {
        searchTextJobs.delete(id);
      }
    }
  }
  setInterval(cleanupSearchTextJobs, 60 * 1000).unref?.();

  function createSearchTextJobId() {
    return `search_job_${++searchTextJobIdSeq}_${Date.now()}`;
  }

  async function writeSearchTextJobRecord(job) {
    if (!searchTextJobStorePath) return;
    const jobPath = await privateData.resolveFile(
      ['search-jobs', `${job.id}.json`],
      { createParent: true }
    );
    await fs.writeFile(jobPath, `${JSON.stringify(job)}\n`, 'utf8');
  }

  async function readSearchTextJobRecord(jobId) {
    if (!searchTextJobStorePath) return null;
    const safeJobId = String(jobId || '').trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(safeJobId)) return null;
    try {
      const jobPath = await privateData.resolveFile(['search-jobs', `${safeJobId}.json`]);
      const raw = await fs.readFile(jobPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  const pluginSettingsPath = path.join(workspaceRoot, '.data', 'explorer', 'plugin-settings.json');
  const skillsManifestFile = 'ploinky-skills-manifest.json';
  const reposCacheRoot = path.join(workspaceRoot, '.ploinky', 'repos');
  const canonicalAgentsDir = '.agents';
  const canonicalSkillsDir = path.join(canonicalAgentsDir, 'skills');
  const ploinkyRoot = path.join(workspaceRoot, 'ploinky');
  let ploinkyReposServicePromise = null;
  const avatarSettingsStore = createAvatarSettingsStore({ fs, path, workspaceRoot });
  const markdownCrdtStore = createMarkdownCrdtStore({
    fs,
    path,
    workspaceRoot,
    validatePath,
    writeFileContent,
    invalidateCachesForPath
  });
  const scriptaCrdtService = createScriptaCrdtService({
    fs,
    path,
    workspaceRoot,
    validatePath,
    markdownCrdtStore
  });

  async function loadPloinkyReposService() {
    if (!ploinkyReposServicePromise) {
      const modulePath = path.join(ploinkyRoot, 'cli', 'utils', 'repos.js');
      ploinkyReposServicePromise = import(pathToFileURL(modulePath).href);
    }
    return ploinkyReposServicePromise;
  }

  async function listKnownSkillRepositories() {
    const reposSvc = await loadPloinkyReposService();
    const predefined = reposSvc.getPredefinedRepos?.() || {};
    const sources = reposSvc.getRepoSources?.() || {};
    const installed = new Set(reposSvc.getInstalledRepos?.(reposCacheRoot) || []);
    const names = new Set([...Object.keys(predefined), ...Object.keys(sources), ...installed]);
    const result = [];
    for (const name of names) {
      const predefinedEntry = predefined[name] || {};
      const sourceEntry = sources[name] || {};
      const kind = predefinedEntry.kind || sourceEntry.kind || reposSvc.classifyRepoKind?.(name) || 'unknown';
      if (kind !== 'skills' && kind !== 'mixed') continue;
      const url = predefinedEntry.url || sourceEntry.url || '';
      if (!url) continue;
      if (!predefinedEntry.url && path.isAbsolute(url) && !await repoPathExists(url)) continue;
      result.push({
        name,
        label: predefinedEntry.description ? `${name} - ${predefinedEntry.description}` : name,
        url,
        branch: sourceEntry.branch || '',
        installed: installed.has(name),
        kind
      });
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  function deriveRepoNameFromUrl(url) {
    const rawUrl = String(url || '').trim();
    const withoutHash = rawUrl.split('#')[0].split('?')[0].replace(/\/+$/, '');
    const lastSegment = withoutHash.slice(withoutHash.lastIndexOf('/') + 1);
    const name = lastSegment.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    return name;
  }

  function normalizeRepoName(value) {
    const name = String(value || '').trim();
    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new Error('Invalid repository name.');
    }
    return name;
  }

  function normalizeSkillName(value) {
    const name = String(value || '').trim();
    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new Error('Invalid skill name.');
    }
    return name;
  }

  function normalizeBranch(value) {
    const branch = String(value || '').trim();
    return branch ? branch : null;
  }

  function looksLikeRepoUrl(value) {
    const candidate = String(value || '').trim();
    if (!candidate) return false;
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)
      || /^git@[^:]+:.+/.test(candidate)
      || candidate.startsWith('ssh://')
      || candidate.startsWith('file://')
      || candidate.endsWith('.git');
  }

  async function resolveSkillRepoInput(input, explicitName = '') {
    const value = String(input || '').trim();
    if (!value) throw new Error('Repository URL or name is required.');
    if (!looksLikeRepoUrl(value)) {
      const skillRepos = await listKnownSkillRepositories();
      const known = skillRepos.find((repo) => repo.name === value || repo.name.toLowerCase() === value.toLowerCase());
      if (!known) {
        throw new Error(`Unknown skill repository '${value}'. Use a git URL or a known repository name.`);
      }
      return {
        url: known.url,
        name: normalizeRepoName(explicitName || known.name || value),
        branch: normalizeBranch(known.branch)
      };
    }
    return {
      url: value,
      name: normalizeRepoName(explicitName || deriveRepoNameFromUrl(value)),
      branch: null
    };
  }

  async function skillsManifestPathForFolder(folderPath) {
    const folder = await validatePath(folderPath);
    const stat = await fs.stat(folder);
    if (!stat.isDirectory()) {
      throw new Error('Skills manifest target must be a directory.');
    }
    return {
      folder,
      manifestPath: path.join(folder, skillsManifestFile)
    };
  }

  function normalizeSkillsManifestEntry(entry, index, manifestPath) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid skills manifest '${manifestPath}': entry at index ${index} must be an object.`);
    }
    const url = String(entry.url || '').trim();
    if (!url) {
      throw new Error(`Invalid skills manifest '${manifestPath}': entry at index ${index} is missing url.`);
    }
    const name = normalizeRepoName(entry.name || deriveRepoNameFromUrl(url));
    const branch = normalizeBranch(entry.branch);
    if (!Array.isArray(entry.skills)) {
      throw new Error(`Invalid skills manifest '${manifestPath}': entry at index ${index} is missing skills array.`);
    }
    const skills = Array.from(new Set(entry.skills.map(normalizeSkillName)));
    return { url, name, branch, skills };
  }

  async function readSkillsManifestEntries(manifestPath) {
    let raw;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw || '[]');
    } catch (error) {
      throw new Error(`Invalid JSON in skills manifest '${manifestPath}': ${error?.message || error}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid skills manifest '${manifestPath}': expected an array of repository objects.`);
    }
    return parsed.map((entry, index) => normalizeSkillsManifestEntry(entry, index, manifestPath));
  }

  async function writeSkillsManifestEntries(manifestPath, entries) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const normalized = entries.map((entry) => ({
      url: entry.url,
      name: entry.name,
      branch: entry.branch || null,
      skills: Array.from(new Set((entry.skills || []).map(normalizeSkillName))).sort((a, b) => a.localeCompare(b))
    }));
    await fs.writeFile(manifestPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    invalidateCachesForPath(manifestPath);
  }

  async function repoPathExists(repoPath) {
    const stat = await fs.stat(repoPath).catch(() => null);
    return Boolean(stat?.isDirectory?.());
  }

  async function ensureSkillRepoCached(entry, { pull = false } = {}) {
    const repoName = normalizeRepoName(entry.name || deriveRepoNameFromUrl(entry.url));
    const repoPath = path.join(reposCacheRoot, repoName);
    await fs.mkdir(reposCacheRoot, { recursive: true });
    if (await repoPathExists(repoPath)) {
      if (pull) {
        const gitDir = path.join(repoPath, '.git');
        if (await repoPathExists(gitDir)) {
          execFileSync('git', ['-C', repoPath, 'pull', '--rebase', '--autostash'], { stdio: 'ignore' });
        }
      }
      return repoPath;
    }
    const args = ['clone', '--quiet'];
    if (entry.branch) args.push('--branch', entry.branch);
    args.push(entry.url, repoPath);
    execFileSync('git', args, { stdio: 'ignore' });
    return repoPath;
  }

  async function listRepoSkillNames(repoPath) {
    const skillsRoot = path.join(repoPath, 'skills');
    const stat = await fs.stat(skillsRoot).catch(() => null);
    if (!stat?.isDirectory?.()) return [];
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md');
      const skillStat = await fs.stat(skillFile).catch(() => null);
      if (skillStat?.isFile?.()) skills.push(entry.name);
    }
    return skills.sort((left, right) => left.localeCompare(right));
  }

  async function ensureClaudeSymlink(folder) {
    const claudePath = path.join(folder, '.claude');
    const target = canonicalAgentsDir;
    const stat = await fs.lstat(claudePath).catch(() => null);
    if (!stat) {
      await fs.symlink(target, claudePath, 'dir').catch(() => {});
      return;
    }
    if (stat.isSymbolicLink()) {
      const existing = await fs.readlink(claudePath).catch(() => '');
      if (existing === target) return;
    }
  }

  async function syncSkillsManifestInstall(folder, entries) {
    const sources = [];
    for (const entry of entries) {
      const repoPath = await ensureSkillRepoCached(entry);
      const available = new Set(await listRepoSkillNames(repoPath));
      for (const skill of entry.skills) {
        if (!available.has(skill)) {
          throw new Error(`Skill '${skill}' is listed for repo '${entry.name}' but is not available in cache.`);
        }
        sources.push({ name: skill, path: path.join(repoPath, 'skills', skill), source: { url: entry.url, name: entry.name, branch: entry.branch || null } });
      }
    }
    const result = syncManagedSkillExports({ folder, owner: 'manifest', sources });
    await ensureClaudeSymlink(folder);
    invalidateCachesForPath(path.join(folder, canonicalAgentsDir));
    return result;
  }

  async function readSkillExportState(folder, entries) {
    const selected = new Set(entries.flatMap((entry) => entry.skills || []));
    const diagnostics = [];
    const outputs = [];
    const agents = path.join(folder, canonicalAgentsDir);
    const skillsDir = path.join(folder, canonicalSkillsDir);
    for (const directory of [agents, skillsDir]) {
      const stat = await fs.lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) return { installedSkills: [], skillOutputs: [...selected].map((name) => ({ name, state: 'missing', selected: true })), diagnostics };
      if (!stat.isDirectory()) return { installedSkills: [], skillOutputs: [], diagnostics: [{ reason: 'export-directory-is-not-a-real-directory', path: directory }] };
    }
    let ledger = { entries: {} };
    const ledgerPath = path.join(agents, EXPORT_LEDGER);
    try {
      const stat = await fs.lstat(ledgerPath);
      if (!stat.isFile()) throw new Error('Ownership ledger is not a regular file.');
      ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
      if (ledger.version !== 1 || !ledger.entries || typeof ledger.entries !== 'object' || Array.isArray(ledger.entries)) throw new Error('Unsupported ownership ledger.');
    } catch (error) {
      if (error.code !== 'ENOENT') diagnostics.push({ reason: 'ownership-ledger-unavailable', message: error.message });
      ledger = { entries: {} };
    }
    const presentNames = new Set();
    for (const entry of await fs.readdir(skillsDir, { withFileTypes: true })) {
      presentNames.add(entry.name);
      const record = Object.hasOwn(ledger.entries, entry.name) ? ledger.entries[entry.name] : null;
      let state = 'local';
      if (record) {
        try { state = entry.isDirectory() && skillTreeDigest(path.join(skillsDir, entry.name)) === record.digest ? 'managed' : 'modified'; }
        catch { state = 'modified'; }
      }
      const descriptor = entry.isDirectory() ? await fs.lstat(path.join(skillsDir, entry.name, 'SKILL.md')).catch(() => null) : null;
      outputs.push({ name: entry.name, state, selected: selected.has(entry.name), installed: Boolean(descriptor?.isFile()), source: record?.source || null });
      if (state === 'modified' || (selected.has(entry.name) && state === 'local')) diagnostics.push({ name: entry.name, reason: `${state}-output-preserved` });
    }
    for (const name of selected) if (!presentNames.has(name)) outputs.push({ name, state: 'missing', selected: true, installed: false });
    outputs.sort((a, b) => a.name.localeCompare(b.name));
    return { installedSkills: outputs.filter((item) => item.installed).map((item) => item.name), skillOutputs: outputs, diagnostics };
  }

  async function buildSkillsManifestState(folder, manifestPath, entries) {
    const repositories = [];
    for (const entry of entries) {
      let repoPath = path.join(reposCacheRoot, entry.name);
      let cacheError = '';
      if (!await repoPathExists(repoPath)) {
        try {
          repoPath = await ensureSkillRepoCached(entry);
        } catch (error) {
          cacheError = error?.message || String(error || 'Could not cache repository.');
        }
      }
      const exists = await repoPathExists(repoPath);
      const availableSkills = exists ? await listRepoSkillNames(repoPath) : [];
      repositories.push({
        ...entry,
        repoPath,
        cached: exists,
        availableSkills,
        cacheError
      });
    }
    const exportState = await readSkillExportState(folder, entries);
    return {
      manifestPath,
      folderPath: folder,
      repositories,
      ...exportState,
      skillRepositories: await listKnownSkillRepositories().catch(() => [])
    };
  }

  async function readPluginSettings() {
    try {
      const safePluginSettingsPath = await privateData.resolveFile(['plugin-settings.json']);
      const raw = await fs.readFile(safePluginSettingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { plugins: {} };
      }
      const plugins = parsed.plugins && typeof parsed.plugins === 'object' && !Array.isArray(parsed.plugins)
        ? parsed.plugins
        : {};
      return { plugins };
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return { plugins: {} };
      }
      console.warn(`[filesystem-http] Failed to read plugin settings ${pluginSettingsPath}:`, error instanceof Error ? error.message : String(error));
      return { plugins: {} };
    }
  }

  async function writePluginSettings(settings) {
    const safePluginSettingsPath = await privateData.resolveFile(
      ['plugin-settings.json'],
      { createParent: true }
    );
    const normalized = {
      plugins: settings?.plugins && typeof settings.plugins === 'object' && !Array.isArray(settings.plugins)
        ? settings.plugins
        : {}
    };
    await fs.writeFile(safePluginSettingsPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    invalidateCachesForPath(safePluginSettingsPath);
  }

  async function handleReadText(args) {
    const data = parseArgs(ReadTextFileArgsSchema, args, 'read_text_file');
    const validPath = await validatePath(data.path);
    if (data.head && data.tail) throw new Error('Cannot specify both head and tail parameters simultaneously');
    if (data.tail) {
      const { content, stats } = await readFileWithCache(validPath, { skipReadForLarge: true });
      if (content !== null && stats.size <= cacheConfig.maxFileSizeBytes) {
        const lines = content.split(/\r?\n/);
        const sliced = lines.slice(-data.tail).join('\n');
        return textResponse(sliced);
      }
      const tailContent = await tailFile(validPath, data.tail);
      return textResponse(tailContent);
    }
    if (data.head) {
      const { content, stats } = await readFileWithCache(validPath, { skipReadForLarge: true });
      if (content !== null && stats.size <= cacheConfig.maxFileSizeBytes) {
        const lines = content.split(/\r?\n/);
        const sliced = lines.slice(0, data.head).join('\n');
        return textResponse(sliced);
      }
      const headContent = await headFile(validPath, data.head);
      return textResponse(headContent);
    }
    const { content } = await readFileWithCache(validPath);
    return textResponse(content);
  }

  async function handleReadMedia(args) {
    const data = parseArgs(ReadMediaFileArgsSchema, args, 'read_media_file');
    const validPath = await validatePath(data.path);
    const extension = path.extname(validPath).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.mjs': 'application/javascript',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.m4a': 'audio/mp4',
      '.mp4': 'video/mp4',
      '.m4v': 'video/mp4',
      '.webm': 'video/webm',
      '.ogv': 'video/ogg',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska'
    };
    const mimeType = mimeTypes[extension] || 'application/octet-stream';
    const data64 = await readFileAsBase64Stream(validPath);
    const name = path.basename(validPath);
    if (mimeType.startsWith('image/')) {
      return { content: [{ type: 'image', data: data64, mimeType }] };
    }
    if (mimeType.startsWith('audio/')) {
      return { content: [{ type: 'audio', data: data64, mimeType }] };
    }
    const dataUrl = `data:${mimeType};base64,${data64}`;
    return {
      content: [{
        type: 'resource',
        resource: {
          uri: dataUrl,
          name,
          mimeType,
          text: dataUrl
        }
      }]
    };
  }

  async function handleLlmAutocomplete(args) {
    const data = parseArgs(LlmAutocompleteArgsSchema, args, 'llm_autocomplete');
    return jsonResponse(await runExplorerToolScript('llm_autocomplete_tool.mjs', data));
  }

  async function handleReadMultiple(args) {
    const data = parseArgs(ReadMultipleFilesArgsSchema, args, 'read_multiple_files');
    const results = await Promise.all(data.paths.map(async (filePath) => {
      try {
        const validPath = await validatePath(filePath);
        const { content } = await readFileWithCache(validPath, { skipReadForLarge: true });
        if (content === null) {
          return `${filePath}: Error - File too large to cache for batch read`;
        }
        return `${filePath}:\n${content}\n`;
      } catch (error) {
        return `${filePath}: Error - ${error instanceof Error ? error.message : String(error)}`;
      }
    }));
    return textResponse(results.join('\n---\n'));
  }

  async function handleWriteFile(args) {
    const data = parseArgs(WriteFileArgsSchema, args, 'write_file');
    const validPath = await validatePath(data.path);
    await writeFileContent(validPath, data.content);
    invalidateCachesForPath(validPath);
    return textResponse(`Successfully wrote to ${data.path}`);
  }

  async function handleWriteBinaryFile(args) {
    const data = parseArgs(WriteBinaryFileArgsSchema, args, 'write_binary_file');
    const validPath = await validatePath(data.path);
    const dirName = path.dirname(validPath);
    await fs.mkdir(dirName, { recursive: true });
    const encoding = data.encoding ?? 'base64';
    const buffer = Buffer.from(data.content, encoding);
    await fs.writeFile(validPath, buffer);
    invalidateCachesForPath(validPath);
    return textResponse(`Successfully wrote binary data to ${data.path}`);
  }

  async function handleEditFile(args) {
    const data = parseArgs(EditFileArgsSchema, args, 'edit_file');
    const validPath = await validatePath(data.path);
    const result = await applyFileEdits(validPath, data.edits, data.dryRun);
    invalidateCachesForPath(validPath);
    return textResponse(result);
  }

  async function handleCreateDirectory(args) {
    const data = parseArgs(CreateDirectoryArgsSchema, args, 'create_directory');
    const validPath = await validatePath(data.path);
    await fs.mkdir(validPath, { recursive: true });
    invalidateCachesForPath(validPath);
    return textResponse(`Successfully created directory ${data.path}`);
  }

  async function handleDeleteFile(args) {
    const data = parseArgs(DeleteFileArgsSchema, args, 'delete_file');
    const validPath = await validatePath(data.path);
    await fs.unlink(validPath);
    invalidateCachesForPath(validPath);
    return textResponse(`Successfully deleted file ${data.path}`);
  }

  async function handleDeleteDirectory(args) {
    const data = parseArgs(DeleteDirectoryArgsSchema, args, 'delete_directory');
    const validPath = await validatePath(data.path);
    await fs.rm(validPath, { recursive: true, force: true });
    invalidateCachesForPath(validPath);
    return textResponse(`Successfully deleted directory ${data.path}`);
  }

  async function handleListDirectory(args) {
    const data = parseArgs(ListDirectoryArgsSchema, args, 'list_directory');
    const validPath = await validatePath(data.path);
    const detailed = await listDirectoryDetailedWithCache(validPath);
    const formatted = detailed.map(entry => `${entry.type === 'directory' ? '[DIR]' : '[FILE]'} ${entry.name}`).join('\n');
    return textResponse(formatted);
  }

  async function handleListDirectoryWithSizes(args) {
    const data = parseArgs(ListDirectoryWithSizesArgsSchema, args, 'list_directory_with_sizes');
    const validPath = await validatePath(data.path);
    const detailed = await indexDirectory(validPath);
    const enriched = detailed.map(entry => ({
      name: entry.name,
      isDirectory: entry.type === 'directory',
      size: entry.size || 0,
      mtime: entry.modified ? new Date(entry.modified) : new Date(0)
    }));
    const sorted = [...enriched].sort((a, b) => data.sortBy === 'size' ? b.size - a.size : a.name.localeCompare(b.name));
    const lines = sorted.map(entry => `${entry.isDirectory ? '[DIR]' : '[FILE]'} ${entry.name.padEnd(30)} ${entry.isDirectory ? '' : formatSize(entry.size).padStart(10)}`);
    const totalFiles = enriched.filter(e => !e.isDirectory).length;
    const totalDirs = enriched.filter(e => e.isDirectory).length;
    const totalSize = enriched.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.size), 0);
    const summary = ['', `Total: ${totalFiles} files, ${totalDirs} directories`, `Combined size: ${formatSize(totalSize)}`];
    return textResponse([...lines, ...summary].join('\n'));
  }

  async function handleListDirectoryDetailed(args) {
    const data = parseArgs(ListDirectoryDetailedArgsSchema, args, 'list_directory_detailed');
    const validPath = await validatePath(data.path);
    const detailed = await indexDirectory(validPath);
    const ordered = [...detailed].sort((a, b) => {
      const typeOrder = { directory: 0, file: 1, other: 2 };
      const diff = (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return jsonResponse(ordered);
  }

  async function handleDirectoryTree(args) {
    const data = parseArgs(DirectoryTreeArgsSchema, args, 'directory_tree');
    const validPath = await validatePath(data.path);
    const maxDepth = data.maxDepth ?? DEFAULT_DIRECTORY_TREE_MAX_DEPTH;
    const maxNodes = data.maxNodes ?? DEFAULT_DIRECTORY_TREE_MAX_NODES;

    const cacheKey = buildCacheKey('directory_tree', { path: validPath, maxDepth, maxNodes });
    const cached = directoryTreeCache.get(cacheKey);
    if (cached) {
      return textResponse(cached);
    }
    const treeData = await buildDirectoryTree({
      rootPath: validPath,
      indexDirectory,
      path,
      maxDepth,
      maxNodes
    });
    const text = JSON.stringify(treeData, null, 2);
    directoryTreeCache.set(cacheKey, text);
    return textResponse(text);
  }

  async function handleMoveFile(args) {
    const data = parseArgs(MoveFileArgsSchema, args, 'move_file');
    const validSource = await validatePath(data.source);
    const validDestination = await validatePath(data.destination);
    const sourceStat = await fs.lstat(validSource);
    await fs.rename(validSource, validDestination);
    if (sourceStat.isDirectory()) {
      invalidateStructureIndexSubtree(validSource);
      invalidateStructureIndexSubtree(validDestination);
    }
    invalidateCachesForPath(validSource);
    invalidateCachesForPath(validDestination);
    return textResponse(`Successfully moved ${data.source} to ${data.destination}`);
  }

  async function handleCopyFile(args) {
    const data = parseArgs(CopyFileArgsSchema, args, 'copy_file');
    const validSource = await validatePath(data.source);
    const validDestination = await validatePath(data.destination);
    if (validSource === validDestination) {
      throw new Error('Source and destination must be different.');
    }
    const sourceStat = await fs.lstat(validSource);
    if (sourceStat.isDirectory()) {
      const normalizedSource = path.resolve(validSource);
      const normalizedDestination = path.resolve(validDestination);
      if (normalizedDestination === normalizedSource || normalizedDestination.startsWith(`${normalizedSource}${path.sep}`)) {
        throw new Error('Cannot copy a directory into itself or one of its subdirectories.');
      }
    }
    const overwrite = Boolean(data.overwrite);
    await copyRecursive(validSource, validDestination, overwrite);
    invalidateStructureIndexSubtree(validDestination);
    invalidateCachesForPath(validDestination);
    return textResponse(`Successfully copied ${data.source} to ${data.destination}${overwrite ? ' (overwritten)' : ''}`);
  }

  async function handleSearchFiles(args) {
    const data = parseArgs(SearchFilesArgsSchema, args, 'search_files');
    const validPath = await validatePath(data.path);
    const cacheKey = buildCacheKey('search_files', {
      path: validPath,
      pattern: data.pattern,
      excludePatterns: data.excludePatterns,
      maxResults: data.maxResults,
      workspaceVersion: data.workspaceVersion
    });
    const cached = searchFilesCache.get(cacheKey);
    if (cached) {
      return jsonResponse(cached);
    }
    let pending = inflightSearchFiles.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const { results: relativeResults, truncated } = await searchFilesWithinWorkspace(validPath, data);
        const payload = { results: relativeResults, truncated: Boolean(truncated) };
        searchFilesCache.set(cacheKey, payload);
        return payload;
      })()
        .finally(() => {
          inflightSearchFiles.delete(cacheKey);
        });
      inflightSearchFiles.set(cacheKey, pending);
    }
    const payload = await pending;
    return jsonResponse(payload);
  }

  async function handleSearchText(args) {
    const data = parseArgs(SearchTextArgsSchema, args, 'search_text');
    const validPath = await validatePath(data.path);
    const scopedPaths = Array.isArray(data.paths)
      ? Array.from(new Set(data.paths.map((entry) => String(entry || '').trim()).filter(Boolean))).sort()
      : [];
    const cacheKey = buildCacheKey('search_text', {
      path: validPath,
      query: data.query,
      caseSensitive: data.caseSensitive,
      useRegex: data.useRegex,
      wholeWord: data.wholeWord,
      maxResults: data.maxResults,
      excludePatterns: data.excludePatterns,
      paths: scopedPaths,
      workspaceVersion: data.workspaceVersion
    });

    const cached = searchTextCache.get(cacheKey);
    if (cached) {
      const job = commandMode
        ? { id: createSearchTextJobId(), status: 'completed', createdAt: Date.now(), results: [], truncated: false, timedOut: false, error: null, cacheKey }
        : createSearchTextJob(cacheKey);
      try {
        const parsed = JSON.parse(cached);
        job.results = parsed.results || [];
        job.truncated = parsed.truncated;
        job.timedOut = parsed.timedOut;
        job.status = 'completed';
      } catch (_) {
        job.status = 'error';
        job.error = 'Failed to parse cached results.';
      }
      if (commandMode) {
        await writeSearchTextJobRecord(job);
      }
      return jsonResponse({ jobId: job.id, status: job.status });
    }

    if (commandMode) {
      const job = {
        id: createSearchTextJobId(),
        status: 'running',
        createdAt: Date.now(),
        results: [],
        truncated: false,
        timedOut: false,
        error: null,
        cacheKey
      };
      try {
        const searchArgs = scopedPaths.length > 0
          ? { ...data, paths: scopedPaths }
          : data;
        const { results, truncated, timedOut } = await searchTextWithinWorkspace(validPath, searchArgs, {
          maxBytesPerFile: MAX_TEXT_SEARCH_FILE_BYTES,
          timeoutMs: SEARCH_TEXT_TIMEOUT_MS
        });
        const payload = { results, truncated, timedOut: Boolean(timedOut) };
        searchTextCache.set(cacheKey, JSON.stringify(payload));
        job.results = results;
        job.truncated = truncated;
        job.timedOut = timedOut;
        job.status = timedOut ? 'timed_out' : 'completed';
      } catch (error) {
        job.status = 'error';
        job.error = error?.message || 'Search failed.';
      }
      await writeSearchTextJobRecord(job);
      return jsonResponse({ jobId: job.id, status: job.status });
    }

    const job = createSearchTextJob(cacheKey);

    (async () => {
      try {
        const searchArgs = scopedPaths.length > 0
          ? { ...data, paths: scopedPaths }
          : data;

        const onProgress = (results, truncated, timedOut) => {
          job.results = results;
          job.truncated = truncated;
          job.timedOut = timedOut;
        };

        const { results, truncated, timedOut } = await searchTextWithinWorkspace(validPath, searchArgs, {
          maxBytesPerFile: MAX_TEXT_SEARCH_FILE_BYTES,
          timeoutMs: SEARCH_TEXT_TIMEOUT_MS,
          onProgress
        });

        const payload = { results, truncated, timedOut: Boolean(timedOut) };
        const text = JSON.stringify(payload);
        searchTextCache.set(cacheKey, text);
        job.results = results;
        job.truncated = truncated;
        job.timedOut = timedOut;
        job.status = timedOut ? 'timed_out' : 'completed';
      } catch (error) {
        job.status = 'error';
        job.error = error?.message || 'Search failed.';
      }
    })();

    return jsonResponse({ jobId: job.id, status: 'running' });
  }

  async function handleSearchTextStatus(args) {
    const data = parseArgs(SearchTextStatusArgsSchema, args, 'search_text_status');
    const job = searchTextJobs.get(data.jobId) || await readSearchTextJobRecord(data.jobId);
    if (!job) {
      return jsonResponse({ status: 'not_found', error: 'Job not found or expired.' });
    }
    return jsonResponse({
      jobId: job.id,
      status: job.status,
      results: job.results,
      truncated: job.truncated,
      timedOut: job.timedOut,
      error: job.error
    });
  }

  async function handleCancelSearchText(args) {
    const data = parseArgs(SearchTextCancelArgsSchema, args, 'search_text_cancel');
    const job = searchTextJobs.get(data.jobId);
    if (!job && commandMode) {
      const storedJob = await readSearchTextJobRecord(data.jobId);
      if (storedJob) {
        storedJob.status = storedJob.status === 'running' ? 'cancelled' : storedJob.status;
        await writeSearchTextJobRecord(storedJob);
        return jsonResponse({ ok: true, jobId: storedJob.id });
      }
    }
    if (!job) {
      return jsonResponse({ ok: false, error: 'Job not found or expired.' });
    }
    job.status = 'cancelled';
    return jsonResponse({ ok: true, jobId: job.id });
  }

  async function handleReplaceText(args) {
    const data = parseArgs(ReplaceTextArgsSchema, args, 'replace_text');
    const validPath = await validatePath(data.path);
    const result = await replaceTextWithinWorkspace(validPath, data, {
      maxBytesPerFile: MAX_TEXT_SEARCH_FILE_BYTES,
      timeoutMs: REPLACE_TEXT_TIMEOUT_MS
    });
    if (Array.isArray(result.changedFilesAbs)) {
      result.changedFilesAbs.forEach((filePath) => invalidateCachesForPath(filePath));
    }
    const { changedFilesAbs, ...payload } = result;
    return jsonResponse(payload);
  }

  async function handleGetFileInfo(args) {
    const data = parseArgs(GetFileInfoArgsSchema, args, 'get_file_info');
    const validPath = await validatePath(data.path);
    const stats = await fs.stat(validPath);
    return jsonResponse({
      path: data.path,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      mtimeMs: Math.round(stats.mtimeMs),
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory()
    });
  }

  async function handleOpenMarkdownCrdtDocument(args) {
    const data = parseArgs(OpenMarkdownCrdtDocumentArgsSchema, args, 'open_markdown_crdt_document');
    return jsonResponse(await markdownCrdtStore.open(data.path));
  }

  async function handleApplyMarkdownCrdtChange(args) {
    const data = parseArgs(ApplyMarkdownCrdtChangeArgsSchema, args, 'apply_markdown_crdt_change');
    let parsedChange = null;
    if (typeof data.changeJson === 'string' && data.changeJson.trim()) {
      try {
        const candidate = JSON.parse(data.changeJson);
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          parsedChange = candidate;
        }
      } catch {
        throw new Error('Invalid arguments for apply_markdown_crdt_change: changeJson must be valid JSON.');
      }
    }
    const operation = data.operation || data.change?.type || parsedChange?.type || '';
    if (!operation) {
      throw new Error('Invalid arguments for apply_markdown_crdt_change: operation is required.');
    }
    return jsonResponse(await markdownCrdtStore.applyChange({
      ...data,
      change: {
        ...(data.change || {}),
        ...(parsedChange || {}),
        type: operation
      }
    }));
  }

  async function handleMergeMarkdownCrdtDocument(args) {
    const data = parseArgs(MergeMarkdownCrdtDocumentArgsSchema, args, 'merge_markdown_crdt_document');
    return jsonResponse(await markdownCrdtStore.merge(data));
  }

  async function handleSaveMarkdownCrdtDocument(args) {
    const data = parseArgs(SaveMarkdownCrdtDocumentArgsSchema, args, 'save_markdown_crdt_document');
    return jsonResponse(await markdownCrdtStore.save(data));
  }

  async function handleSyncMarkdownCrdtFromFile(args) {
    const data = parseArgs(SyncMarkdownCrdtFromFileArgsSchema, args, 'sync_markdown_crdt_from_file');
    return jsonResponse(await markdownCrdtStore.syncFromFile(data));
  }

  function assertWebMeetScriptaCaller() {
    const context = getInvocationContext?.() || {};
    const invocation = context.invocation && typeof context.invocation === 'object'
      ? context.invocation
      : {};
    const caller = invocation.caller && typeof invocation.caller === 'object'
      ? invocation.caller.id
      : invocation.caller || invocation.sub;
    const agentName = String(caller || '')
      .replace(/^agent:/i, '')
      .trim()
      .split('/')
      .pop()
      .toLowerCase();
    if (agentName !== 'webmeetagent') {
      throw new Error('SCRIPTA CRDT tools are restricted to webmeetAgent.');
    }
  }

  async function handleScriptaCrdtEnsureFolder(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(ScriptaCrdtEnsureFolderArgsSchema, args, 'scripta_crdt_ensure_folder');
    return jsonResponse(await scriptaCrdtService.ensureFolder(data));
  }

  async function handleScriptaCrdtWorkspaceList(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(ScriptaCrdtWorkspaceListArgsSchema, args, 'scripta_crdt_workspace_list');
    return jsonResponse(await scriptaCrdtService.listWorkspace(data));
  }

  async function handleScriptaCrdtCreate(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(ScriptaCrdtCreateArgsSchema, args, 'scripta_crdt_create');
    return jsonResponse(await scriptaCrdtService.create(data));
  }

  async function handleScriptaCrdtOpen(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(ScriptaCrdtOpenArgsSchema, args, 'scripta_crdt_open');
    return jsonResponse(await scriptaCrdtService.open(data));
  }

  async function handleScriptaCrdtMutate(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(ScriptaCrdtMutateArgsSchema, args, 'scripta_crdt_mutate');
    if (
      ['p-variant-image-insert', 'p-variant-image-replace'].includes(data.operation)
      || (data.operation === 'paragraph-add' && data.args?.assetId)
    ) {
      const roomId = String(data.args?.roomId || '').trim();
      const roomFolderPath = String(data.args?.roomFolderPath || '').trim();
      const assetId = String(data.args?.assetId || '').trim();
      const asset = await webMeetMediaStore.read({roomId, roomFolderPath, assetId});
      data.args = { ...data.args, workspaceUrl: asset.workspaceUrl, alt: data.args?.alt || asset.filename };
    }
    return jsonResponse(await scriptaCrdtService.mutate(data));
  }

  async function handleWebMeetMediaCommit(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(WebMeetMediaCommitArgsSchema, args, 'webmeet_media_commit');
    return jsonResponse({ ok: true, asset: await webMeetMediaStore.commit(data) });
  }

  async function handleWebMeetMediaGet(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(WebMeetMediaGetArgsSchema, args, 'webmeet_media_get');
    return jsonResponse({ ok: true, asset: await webMeetMediaStore.read(data) });
  }

  async function handleScriptaCrdtDelete(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(ScriptaCrdtDeleteArgsSchema, args, 'scripta_crdt_delete');
    return jsonResponse(await scriptaCrdtService.remove(data));
  }

  async function handleScriptaCollaborationOpen(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(ScriptaCollaborationOpenArgsSchema, args, 'scripta_collaboration_open');
    return jsonResponse(await scriptaCrdtService.collaborationOpen(data));
  }

  async function handleScriptaCollaborationPull(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(ScriptaCollaborationPullArgsSchema, args, 'scripta_collaboration_pull');
    return jsonResponse(await scriptaCrdtService.collaborationPull(data));
  }

  async function handleScriptaCollaborationApply(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(ScriptaCollaborationApplyArgsSchema, args, 'scripta_collaboration_apply');
    return jsonResponse(await scriptaCrdtService.collaborationApply(data));
  }

  async function handleScriptaCollaborationMergeMarkdown(args) {
    assertWebMeetScriptaCaller();
    const data = parseArgs(
      ScriptaCollaborationMergeMarkdownArgsSchema,
      args,
      'scripta_collaboration_merge_markdown'
    );
    return jsonResponse(await scriptaCrdtService.collaborationMergeMarkdown(data));
  }

  async function handleCollectIdePlugins(args) {
    parseArgs(CollectIDEPluginsArgsSchema, args, 'collect_ide_plugins');
    const pluginsByLocation = await aggregateIdePlugins(workspaceRoot);
    return jsonResponse(pluginsByLocation);
  }

  async function handleGetPluginSettings(args) {
    parseArgs(GetPluginSettingsArgsSchema, args, 'get_plugin_settings');
    const settings = await readPluginSettings();
    return jsonResponse(settings);
  }

  async function handleSetPluginEnabled(args) {
    const data = parseArgs(SetPluginEnabledArgsSchema, args, 'set_plugin_enabled');
    const settings = await readPluginSettings();
    const nextPlugins = {
      ...(settings.plugins || {}),
      [data.key]: {
        enabled: data.enabled
      }
    };
    const nextSettings = { plugins: nextPlugins };
    await writePluginSettings(nextSettings);
    return jsonResponse({
      ok: true,
      key: data.key,
      enabled: data.enabled,
      settings: nextSettings
    });
  }

  async function handleReadSkillsManifestState(args) {
    const data = parseArgs(ReadSkillsManifestStateArgsSchema, args, 'read_skills_manifest_state');
    const { folder, manifestPath } = await skillsManifestPathForFolder(data.folderPath);
    const entries = await readSkillsManifestEntries(manifestPath);
    return jsonResponse(await buildSkillsManifestState(folder, manifestPath, entries));
  }

  async function handleAddSkillsManifestRepo(args) {
    const data = parseArgs(AddSkillsManifestRepoArgsSchema, args, 'add_skills_manifest_repo');
    const { folder, manifestPath } = await skillsManifestPathForFolder(data.folderPath);
    const resolved = await resolveSkillRepoInput(data.url, data.name);
    const url = resolved.url;
    const name = resolved.name;
    const branch = normalizeBranch(data.branch) || resolved.branch || null;
    const repoEntry = { url, name, branch, skills: [] };
    const repoPath = await ensureSkillRepoCached(repoEntry);
    const availableSkills = await listRepoSkillNames(repoPath);
    if (!availableSkills.length) {
      return jsonResponse({
        ok: true,
        added: false,
        cached: true,
        message: `Repository '${name}' was cached but was not added to the skills manifest because no Anthropic skills were found. Expected at least one skills/*/SKILL.md file.`
      });
    }

    const entries = await readSkillsManifestEntries(manifestPath);
    const nextEntry = { ...repoEntry, skills: availableSkills };
    const existingIndex = entries.findIndex((entry) => entry.name === name || entry.url === url);
    const nextEntries = existingIndex === -1
      ? [...entries, nextEntry]
      : entries.map((entry, index) => index === existingIndex ? nextEntry : entry);
    const exportResult = await syncSkillsManifestInstall(folder, nextEntries);
    await writeSkillsManifestEntries(manifestPath, nextEntries);
    return jsonResponse({
      ...await buildSkillsManifestState(folder, manifestPath, nextEntries),
      exportResult,
      ok: true,
      added: true,
      cached: true,
      message: `${name} added.`
    });
  }

  async function handleSetSkillsManifestSkillEnabled(args) {
    const data = parseArgs(SetSkillsManifestSkillEnabledArgsSchema, args, 'set_skills_manifest_skill_enabled');
    const { folder, manifestPath } = await skillsManifestPathForFolder(data.folderPath);
    const repoName = normalizeRepoName(data.repoName);
    const skill = normalizeSkillName(data.skill);
    const entries = await readSkillsManifestEntries(manifestPath);
    const index = entries.findIndex((entry) => entry.name === repoName);
    if (index === -1) {
      throw new Error(`Repository '${repoName}' is not in the skills manifest.`);
    }
    const repoPath = await ensureSkillRepoCached(entries[index]);
    const availableSkills = await listRepoSkillNames(repoPath);
    if (!availableSkills.includes(skill)) {
      throw new Error(`Skill '${skill}' is not available in repository '${repoName}'.`);
    }
    const current = new Set(entries[index].skills || []);
    if (data.enabled) current.add(skill);
    else current.delete(skill);
    const nextEntries = entries.map((entry, entryIndex) => entryIndex === index
      ? { ...entry, skills: Array.from(current).sort((left, right) => left.localeCompare(right)) }
      : entry);
    const exportResult = await syncSkillsManifestInstall(folder, nextEntries);
    await writeSkillsManifestEntries(manifestPath, nextEntries);
    return jsonResponse({ ...await buildSkillsManifestState(folder, manifestPath, nextEntries), exportResult });
  }

  async function handleRemoveSkillsManifestRepo(args) {
    const data = parseArgs(RemoveSkillsManifestRepoArgsSchema, args, 'remove_skills_manifest_repo');
    const { folder, manifestPath } = await skillsManifestPathForFolder(data.folderPath);
    const repoName = normalizeRepoName(data.repoName);
    const entries = await readSkillsManifestEntries(manifestPath);
    const nextEntries = entries.filter((entry) => entry.name !== repoName);
    if (nextEntries.length === entries.length) {
      throw new Error(`Repository '${repoName}' is not in the skills manifest.`);
    }
    const exportResult = await syncSkillsManifestInstall(folder, nextEntries);
    await writeSkillsManifestEntries(manifestPath, nextEntries);
    return jsonResponse({ ...await buildSkillsManifestState(folder, manifestPath, nextEntries), exportResult });
  }

  function getInvocationIdentity() {
    const context = getInvocationContext?.() || {};
    const actor = context.invocation?.actor && typeof context.invocation.actor === 'object'
      ? context.invocation.actor
      : {};
    const roles = Array.isArray(actor.roles) ? actor.roles.map((role) => String(role || '').trim()) : [];
    const id = String(actor.id || '').trim();
    const username = id.replace(/^user:/, '');
    return {
      id,
      username,
      roles,
      isAdmin: roles.includes('admin') || username === 'admin' || id === 'local:admin'
    };
  }

  async function handleGetAvatarSettingsAgents(args) {
    parseArgs(GetAvatarSettingsAgentsArgsSchema, args, 'get_avatar_settings_agents');
    const identity = getInvocationIdentity();
    const agents = await avatarSettingsStore.listAgents();
    return jsonResponse({
      ok: true,
      canManageAgents: identity.isAdmin,
      agents
    });
  }

  async function handleUpdateAvatarSettingsAgent(args) {
    const data = parseArgs(UpdateAvatarSettingsAgentArgsSchema, args, 'update_avatar_settings_agent');
    const identity = getInvocationIdentity();
    if (!identity.isAdmin) {
      throw new Error('Only admins can update agent avatars.');
    }
    const config = await avatarSettingsStore.updateAgent(data.agentId, data.config || {}, {
      assetBaseUrl: '/explorer/shared/vendor/axi-face',
      env: process.env
    });
    return jsonResponse({ ok: true, agent: { id: data.agentId, config } });
  }

  async function handleSetAvatarSettingsAgentVisibility(args) {
    const data = parseArgs(SetAvatarSettingsAgentVisibilityArgsSchema, args, 'set_avatar_settings_agent_visibility');
    const identity = getInvocationIdentity();
    if (!identity.isAdmin) {
      throw new Error('Only admins can update agent avatars.');
    }
    const agent = await avatarSettingsStore.setAgentVisibility(data.agentId, data.enabled !== false);
    return jsonResponse({ ok: true, agent });
  }

  async function handleListAllowedDirectories() {
    const allowed = getAllowedDirectories ? getAllowedDirectories() : [];
    return textResponse(`Allowed directories:\n${allowed.join('\n')}`);
  }

  return {
    read_file: handleReadText,
    read_text_file: handleReadText,
    read_media_file: handleReadMedia,
    read_multiple_files: handleReadMultiple,
    write_file: handleWriteFile,
    write_binary_file: handleWriteBinaryFile,
    edit_file: handleEditFile,
    create_directory: handleCreateDirectory,
    delete_file: handleDeleteFile,
    delete_directory: handleDeleteDirectory,
    list_directory: handleListDirectory,
    list_directory_with_sizes: handleListDirectoryWithSizes,
    list_directory_detailed: handleListDirectoryDetailed,
    directory_tree: handleDirectoryTree,
    move_file: handleMoveFile,
    copy_file: handleCopyFile,
    search_files: handleSearchFiles,
    search_text: handleSearchText,
    search_text_status: handleSearchTextStatus,
    search_text_cancel: handleCancelSearchText,
    replace_text: handleReplaceText,
    get_file_info: handleGetFileInfo,
    open_markdown_crdt_document: handleOpenMarkdownCrdtDocument,
    apply_markdown_crdt_change: handleApplyMarkdownCrdtChange,
    merge_markdown_crdt_document: handleMergeMarkdownCrdtDocument,
    save_markdown_crdt_document: handleSaveMarkdownCrdtDocument,
    sync_markdown_crdt_from_file: handleSyncMarkdownCrdtFromFile,
    scripta_crdt_ensure_folder: handleScriptaCrdtEnsureFolder,
    scripta_crdt_workspace_list: handleScriptaCrdtWorkspaceList,
    scripta_crdt_create: handleScriptaCrdtCreate,
    scripta_crdt_open: handleScriptaCrdtOpen,
    scripta_crdt_mutate: handleScriptaCrdtMutate,
    scripta_crdt_delete: handleScriptaCrdtDelete,
    webmeet_media_commit: handleWebMeetMediaCommit,
    webmeet_media_get: handleWebMeetMediaGet,
    scripta_collaboration_open: handleScriptaCollaborationOpen,
    scripta_collaboration_pull: handleScriptaCollaborationPull,
    scripta_collaboration_apply: handleScriptaCollaborationApply,
    scripta_collaboration_merge_markdown: handleScriptaCollaborationMergeMarkdown,
    llm_autocomplete: handleLlmAutocomplete,
    collect_ide_plugins: handleCollectIdePlugins,
    get_plugin_settings: handleGetPluginSettings,
    set_plugin_enabled: handleSetPluginEnabled,
    read_skills_manifest_state: handleReadSkillsManifestState,
    add_skills_manifest_repo: handleAddSkillsManifestRepo,
    set_skills_manifest_skill_enabled: handleSetSkillsManifestSkillEnabled,
    remove_skills_manifest_repo: handleRemoveSkillsManifestRepo,
    get_avatar_settings_agents: handleGetAvatarSettingsAgents,
    update_avatar_settings_agent: handleUpdateAvatarSettingsAgent,
    set_avatar_settings_agent_visibility: handleSetAvatarSettingsAgentVisibility,
    list_allowed_directories: handleListAllowedDirectories
  };
}

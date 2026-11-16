import { importAxiFaceAssetLoader } from './axi-face-runtime.mjs';
import { createExplorerPrivateDataBoundary } from '../private-data-boundary.mjs';

const STORE_FILE = '.data/agents/explorer/avatar-overrides.json';
const STORE_FILE_SEGMENTS = Object.freeze(['avatar-overrides.json']);
const MANIFEST_CANDIDATES = Object.freeze([
  'explorer/manifest.json',
  '.ploinky/repos/AchillesIDE/explorer/manifest.json'
]);

const ALLOWED_EMOTIONS = new Set([
  'neutral',
  'idle',
  'listening',
  'thinking',
  'speaking',
  'happy',
  'amused',
  'confused',
  'concerned',
  'alert',
  'sleepy'
]);

const ALLOWED_THOUGHT_MODES = new Set(['none', 'bubble', 'caption', 'ticker', 'inside']);
const ALLOWED_MODES = new Set(['static', 'controlled', 'event-driven', 'autonomous']);
const ALLOWED_EXPRESSION_MODES = new Set(['audio', 'manual']);
const ALLOWED_SHAPES = new Set(['circle', 'square', 'rounded', 'none']);
const ALLOWED_THEMES = new Set(['light', 'dark', 'auto']);
const ALLOWED_ASSET_MODES = new Set(['img', 'inline']);
const ALLOWED_SOURCE_MODES = new Set(['generated', 'pack', 'svg']);
const ALLOWED_STYLES = new Set(['robot-soft', 'robot-minimal', 'sketch', 'emoji', 'terminal']);
const ALLOWED_COMPLEXITIES = new Set(['', 'low', 'minimal', 'medium', 'default', 'high', 'detailed']);

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === '';
}

function assertSafeUrl(value, fieldName) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/[\u0000-\u001f]/.test(raw)) {
    throw new Error(`${fieldName} contains control characters.`);
  }
  if (/^(javascript|data):/i.test(raw)) {
    throw new Error(`${fieldName} uses an unsafe URL scheme.`);
  }
  if (/^https:\/\//i.test(raw)) return raw;
  if (/^http:\/\//i.test(raw)) {
    throw new Error(`${fieldName} must use HTTPS for absolute URLs.`);
  }
  if (/^\/\//.test(raw)) {
    throw new Error(`${fieldName} must not use protocol-relative URLs.`);
  }
  return raw;
}

function normalizeEnum(value, allowed, fallback, fieldName) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (!allowed.has(raw)) {
    throw new Error(`Invalid ${fieldName}: ${raw}`);
  }
  return raw;
}

export function normalizeAxiFaceConfig(input = {}) {
  if (!isPlainObject(input)) {
    throw new Error('Avatar config must be an object.');
  }
  const config = {};
  const knownFields = new Set([
    'agentId',
    'agent-id',
    'src',
    'emotion',
    'expressionMode',
    'expression-mode',
    'size',
    'thought',
    'thoughtMode',
    'thought-mode',
    'mode',
    'shape',
    'theme',
    'packSrc',
    'pack-src',
    'animated',
    'listen',
    'assetMode',
    'asset-mode',
    'generated',
    'sourceMode',
    'source-mode',
    'seed',
    'style',
    'palette',
    'complexity'
  ]);
  for (const key of Object.keys(input)) {
    if (!knownFields.has(key)) {
      throw new Error(`Unknown avatar config field: ${key}`);
    }
  }

  const agentId = input.agentId ?? input['agent-id'];
  if (agentId !== undefined) config.agentId = String(agentId || '').trim();
  config.src = assertSafeUrl(input.src, 'src');
  config.packSrc = assertSafeUrl(input.packSrc ?? input['pack-src'], 'pack-src');
  config.emotion = normalizeEnum(input.emotion, ALLOWED_EMOTIONS, 'neutral', 'emotion');
  config.expressionMode = normalizeEnum(input.expressionMode ?? input['expression-mode'], ALLOWED_EXPRESSION_MODES, 'audio', 'expression-mode');
  config.size = String(input.size || '64').trim();
  config.thought = String(input.thought || '').slice(0, 240);
  config.thoughtMode = normalizeEnum(input.thoughtMode ?? input['thought-mode'], ALLOWED_THOUGHT_MODES, config.thought ? 'bubble' : 'none', 'thought-mode');
  config.mode = normalizeEnum(input.mode, ALLOWED_MODES, 'static', 'mode');
  config.shape = normalizeEnum(input.shape, ALLOWED_SHAPES, 'circle', 'shape');
  config.theme = normalizeEnum(input.theme, ALLOWED_THEMES, 'auto', 'theme');
  config.assetMode = normalizeEnum(input.assetMode ?? input['asset-mode'], ALLOWED_ASSET_MODES, 'img', 'asset-mode');
  config.sourceMode = normalizeEnum(input.sourceMode ?? input['source-mode'], ALLOWED_SOURCE_MODES, '', 'source-mode');
  config.generated = normalizeBoolean(input.generated ?? (!config.src && !config.packSrc));
  config.animated = input.animated === undefined ? true : normalizeBoolean(input.animated);
  config.listen = normalizeBoolean(input.listen);
  config.seed = String(input.seed || config.agentId || 'axi-face').trim();
  config.style = normalizeEnum(input.style, ALLOWED_STYLES, 'robot-soft', 'style');
  config.palette = String(input.palette || 'default').trim();
  const complexity = String(input.complexity || '').trim();
  if (!ALLOWED_COMPLEXITIES.has(complexity) && !/^(0(\.\d+)?|1(\.0+)?)$/.test(complexity)) {
    throw new Error(`Invalid complexity: ${complexity}`);
  }
  config.complexity = complexity;
  if (config.src) {
    config.sourceMode = 'svg';
    config.generated = false;
    config.packSrc = '';
  } else if (config.packSrc) {
    config.sourceMode = 'pack';
    config.generated = false;
  } else {
    config.sourceMode = config.sourceMode || (config.generated === false ? 'pack' : 'generated');
    if (config.sourceMode === 'generated') {
      config.generated = true;
    }
  }
  return config;
}

export async function validateAxiFaceConfig(input = {}, {
  fetchImpl = globalThis.fetch,
  assetBaseUrl = '',
  fs = null,
  path = null,
  workspaceRoot = '',
  env = process.env,
  assetLoader = null
} = {}) {
  const config = normalizeAxiFaceConfig(input);
  if (config.assetMode === 'inline' && config.src) {
    const resolvedAssetLoader = assetLoader || await importAxiFaceAssetLoader({
      fs,
      path,
      workspaceRoot,
      env
    });
    const { loadInlineSvg, resolveRelativeUrl } = resolvedAssetLoader;
    const resolvedSrc = resolveRelativeUrl(assetBaseUrl || 'http://localhost/', config.src);
    await loadInlineSvg(resolvedSrc, fetchImpl);
  }
  return config;
}

export function createDefaultAvatarConfig(id, overrides = {}) {
  return normalizeAxiFaceConfig({
    agentId: id,
    generated: true,
    seed: id,
    style: 'robot-soft',
    palette: 'default',
    emotion: 'neutral',
    expressionMode: 'audio',
    shape: 'circle',
    theme: 'auto',
    size: '64',
    ...overrides
  });
}

function normalizeStore(raw) {
  if (!isPlainObject(raw)) {
    return { version: 1, agents: {}, enabled: {} };
  }
  return {
    version: 1,
    agents: isPlainObject(raw.agents) ? raw.agents : {},
    enabled: isPlainObject(raw.enabled) ? raw.enabled : {}
  };
}

function parseAgentEnableRef(entry) {
  const raw = isPlainObject(entry)
    ? String(entry.agent || entry.ref || entry.name || '').trim()
    : String(entry || '').trim();
  if (!raw) return null;
  const source = raw.split(/\s+/)[0];
  const parts = source.split('/').filter(Boolean);
  const agentId = parts.pop() || '';
  if (!agentId) return null;
  return {
    agentId,
    repoName: parts.length > 0 ? parts[parts.length - 1] : ''
  };
}

function isPotentialAiAgent(agentId) {
  return /(?:llm|ai|assist|assistant)/i.test(agentId)
    || ['webAssist', 'audioAgent'].includes(agentId);
}

function extractAgentAvatarDefaults(manifest) {
  if (!isPlainObject(manifest)) return null;
  const candidates = [
    manifest.avatar,
    manifest.avatarConfig,
    manifest.defaultAvatar,
    manifest.axiFaceAvatar,
    manifest.explorer?.avatar,
    manifest.explorer?.avatarConfig
  ];
  return candidates.find((candidate) => isPlainObject(candidate)) || null;
}

export function createAvatarSettingsStore({ fs, path, workspaceRoot, fetchImpl = globalThis.fetch }) {
  const cwd = path.resolve(process.cwd());
  const fsApi = fs?.promises || fs;
  const privateData = createExplorerPrivateDataBoundary({ fs: fsApi, path, workspaceRoot });
  const manifestPaths = Array.from(new Set([
    ...MANIFEST_CANDIDATES.map((candidate) => path.join(workspaceRoot, candidate)),
    path.join(cwd, 'manifest.json'),
    path.join(cwd, 'explorer/manifest.json')
  ]));

  async function readJson(filePath, fallback) {
    try {
      return JSON.parse(await fsApi.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async function writeJson(filePath, value) {
    await fsApi.mkdir(path.dirname(filePath), { recursive: true });
    await fsApi.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  async function readStore() {
    const storePath = await privateData.resolveFile(STORE_FILE_SEGMENTS);
    return normalizeStore(await readJson(storePath, null));
  }

  async function readManifest() {
    for (const manifestPath of manifestPaths) {
      const manifest = await readJson(manifestPath, null);
      if (manifest && Array.isArray(manifest.enable)) {
        return { manifest, manifestPath };
      }
    }
    return { manifest: {}, manifestPath: '' };
  }

  function buildAgentManifestCandidates(ref, parentManifestPath) {
    const candidates = [];
    if (parentManifestPath) {
      const repoRoot = path.dirname(path.dirname(parentManifestPath));
      candidates.push(path.join(repoRoot, ref.agentId, 'manifest.json'));
      if (ref.repoName) {
        candidates.push(path.join(workspaceRoot, '.ploinky', 'repos', ref.repoName, ref.agentId, 'manifest.json'));
        candidates.push(path.join(path.dirname(repoRoot), ref.repoName, ref.agentId, 'manifest.json'));
      }
    }
    candidates.push(path.join(workspaceRoot, ref.agentId, 'manifest.json'));
    if (ref.repoName) {
      candidates.push(path.join(workspaceRoot, '.ploinky', 'repos', ref.repoName, ref.agentId, 'manifest.json'));
      candidates.push(path.join(workspaceRoot, ref.repoName, ref.agentId, 'manifest.json'));
    }
    return Array.from(new Set(candidates));
  }

  async function readAgentManifest(ref, parentManifestPath) {
    for (const candidate of buildAgentManifestCandidates(ref, parentManifestPath)) {
      const manifest = await readJson(candidate, null);
      if (isPlainObject(manifest)) {
        return manifest;
      }
    }
    return null;
  }

  async function listManifestAgents() {
    const { manifest, manifestPath } = await readManifest();
    const enabled = Array.isArray(manifest.enable) ? manifest.enable : [];
    const refs = enabled
      .map(parseAgentEnableRef)
      .filter((ref) => ref?.agentId && ref.agentId !== 'explorer')
      .filter((ref) => isPotentialAiAgent(ref.agentId));
    const uniqueRefs = Array.from(new Map(refs.map((ref) => [ref.agentId, ref])).values())
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
    return Promise.all(uniqueRefs.map(async (ref) => {
      const agentManifest = await readAgentManifest(ref, manifestPath);
      const manifestAvatar = extractAgentAvatarDefaults(agentManifest);
      return {
        id: ref.agentId,
        defaultConfig: manifestAvatar
          ? normalizeAxiFaceConfig({
            ...manifestAvatar,
            agentId: ref.agentId,
            seed: manifestAvatar.seed || ref.agentId
          })
          : null
      };
    }));
  }

  async function listAgents() {
    const [store, manifestAgents] = await Promise.all([readStore(), listManifestAgents()]);
    const manifestAgentMap = new Map(manifestAgents.map((agent) => [agent.id, agent]));
    const ids = Array.from(new Set([...manifestAgentMap.keys(), ...Object.keys(store.agents)])).sort((a, b) => a.localeCompare(b));
    return ids.map((agentId) => {
      const override = isPlainObject(store.agents[agentId]) ? normalizeAxiFaceConfig(store.agents[agentId]) : null;
      const manifestAgent = manifestAgentMap.get(agentId) || null;
      const inManifest = Boolean(manifestAgent);
      return {
        id: agentId,
        label: agentId,
        inManifest,
        missing: !inManifest,
        enabled: store.enabled[agentId] !== false,
        config: override || manifestAgent?.defaultConfig || createDefaultAvatarConfig(agentId)
      };
    });
  }

  async function updateAgent(agentId, config, options = {}) {
    const normalizedAgentId = String(agentId || '').trim();
    if (!normalizedAgentId) {
      throw new Error('Agent id is required.');
    }
    const store = await readStore();
    store.agents[normalizedAgentId] = await validateAxiFaceConfig({
      ...config,
      agentId: normalizedAgentId,
      seed: config?.seed || normalizedAgentId
    }, {
      fetchImpl,
      fs: fsApi,
      path,
      workspaceRoot,
      ...options
    });
    const storePath = await privateData.resolveFile(STORE_FILE_SEGMENTS, { createParent: true });
    await writeJson(storePath, store);
    return store.agents[normalizedAgentId];
  }

  async function setAgentVisibility(agentId, enabled) {
    const normalizedAgentId = String(agentId || '').trim();
    if (!normalizedAgentId) {
      throw new Error('Agent id is required.');
    }
    const store = await readStore();
    store.enabled[normalizedAgentId] = Boolean(enabled);
    const storePath = await privateData.resolveFile(STORE_FILE_SEGMENTS, { createParent: true });
    await writeJson(storePath, store);
    return { id: normalizedAgentId, enabled: store.enabled[normalizedAgentId] };
  }

  return {
    listAgents,
    updateAgent,
    setAgentVisibility,
    normalizeAxiFaceConfig,
    validateAxiFaceConfig,
    createDefaultAvatarConfig
  };
}

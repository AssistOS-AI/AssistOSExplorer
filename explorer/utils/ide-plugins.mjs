import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

async function realPathWithin(directory, root) {
    try {
        const physical = await fs.realpath(directory);
        const relative = path.relative(root, physical);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? physical : null;
    } catch { return null; }
}

async function repositoryOrigin(directory) {
    try {
        // A containing workspace's origin must never identify this repository.
        await fs.lstat(path.join(directory, '.git'));
        const { stdout } = await runFile('git', ['-C', directory, 'config', '--local', '--get', 'remote.origin.url'], {
            timeout: 2000, maxBuffer: 16 * 1024,
        });
        const raw = stdout.trim().replace(/^git@([^:]+):/, 'ssh://git@$1/');
        try {
            const url = new URL(raw);
            const pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
            const hostname = url.hostname.toLowerCase();
            return `${hostname}${url.port ? `:${url.port}` : ''}${hostname === 'github.com' ? pathname.toLowerCase() : pathname}`;
        } catch { return raw.replace(/\/+$/, '').replace(/\.git$/, ''); }
    } catch { return ''; }
}

export const SKIP_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'out',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.mcp-cache',
  'coverage',
  'tmp'
]);

export const DOCUMENT_PLUGIN_CATEGORY = 'document';
export const APPLICATION_PLUGIN_CATEGORY = 'application';
export const DEFAULT_DOCUMENT_PLUGIN_LOCATIONS = ['document', 'chapter', 'paragraph', 'infoText'];
export const APPLICATION_PLUGIN_LOCATION_PATTERN = /^[a-z0-9-]+(?::[a-z0-9-]+)+$/i;
export const APPLICATION_PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/i;
const VALID_PLUGIN_TYPES = new Set(['embedded', 'modal', 'global']);
const VALID_APPLICATION_CONTRIBUTION_TYPES = new Set(['mount', 'menu']);
const AGENT_SETTING_KEY_PATTERN = /^[a-z][a-z0-9-]*$/i;
const AGENT_SETTING_PLUGIN_KEY_PATTERN = /^[a-z0-9_.-]+\/[a-z][a-z0-9-]*$/i;
const SETTINGS_COMPONENT_PATTERN = /^[a-z][a-z0-9]*-[a-z0-9-]*$/i;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizePluginDependencies(rawDependencies, configPath) {
  if (rawDependencies === undefined) {
    return [];
  }
  if (!Array.isArray(rawDependencies)) {
    console.warn(`[filesystem-http] Invalid dependencies in ${configPath}: expected an array.`);
    return null;
  }

  const normalized = [];
  for (const dependency of rawDependencies) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
      console.warn(`[filesystem-http] Invalid dependency entry in ${configPath}: expected an object.`);
      return null;
    }

    const dependencyName = isNonEmptyString(dependency.component)
      ? dependency.component.trim()
      : isNonEmptyString(dependency.name)
        ? dependency.name.trim()
        : '';

    if (!dependencyName) {
      console.warn(`[filesystem-http] Invalid dependency entry in ${configPath}: missing "component" or "name".`);
      return null;
    }

    const normalizedDependency = {
      ...dependency,
      component: dependencyName
    };

    if (normalizedDependency.name === undefined) {
      normalizedDependency.name = dependencyName;
    }

    if (normalizedDependency.presenter !== undefined && !isNonEmptyString(normalizedDependency.presenter)) {
      console.warn(`[filesystem-http] Invalid dependency presenter for "${dependencyName}" in ${configPath}.`);
      return null;
    }

    if (normalizedDependency.path !== undefined && !isNonEmptyString(normalizedDependency.path)) {
      console.warn(`[filesystem-http] Invalid dependency path for "${dependencyName}" in ${configPath}.`);
      return null;
    }

    if (normalizedDependency.directory !== undefined && !isNonEmptyString(normalizedDependency.directory)) {
      console.warn(`[filesystem-http] Invalid dependency directory for "${dependencyName}" in ${configPath}.`);
      return null;
    }

    if (normalizedDependency.type !== undefined && !VALID_PLUGIN_TYPES.has(normalizedDependency.type)) {
      console.warn(`[filesystem-http] Invalid dependency type for "${dependencyName}" in ${configPath}: ${normalizedDependency.type}`);
      return null;
    }

    normalized.push(normalizedDependency);
  }

  return normalized;
}

function validateAndNormalizePluginConfig(parsedConfig, pluginEntryName, configPath) {
  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
    console.warn(`[filesystem-http] Invalid plugin config in ${configPath}: expected an object.`);
    return null;
  }

  const pluginCategory = isNonEmptyString(parsedConfig.pluginCategory) ? parsedConfig.pluginCategory.trim() : '';
  if (!pluginCategory || (pluginCategory !== DOCUMENT_PLUGIN_CATEGORY && pluginCategory !== APPLICATION_PLUGIN_CATEGORY)) {
    console.warn(`[filesystem-http] Plugin ${configPath} must declare pluginCategory as "${DOCUMENT_PLUGIN_CATEGORY}" or "${APPLICATION_PLUGIN_CATEGORY}".`);
    return null;
  }

  const contributionType = pluginCategory === APPLICATION_PLUGIN_CATEGORY && isNonEmptyString(parsedConfig.contributionType)
    ? parsedConfig.contributionType.trim()
    : 'mount';

  if (pluginCategory === APPLICATION_PLUGIN_CATEGORY && !VALID_APPLICATION_CONTRIBUTION_TYPES.has(contributionType)) {
    console.warn(`[filesystem-http] Plugin ${configPath} has invalid contributionType "${parsedConfig.contributionType}".`);
    return null;
  }

  const locationsRaw = parsedConfig.location;
  const locations = Array.isArray(locationsRaw)
    ? locationsRaw.map((loc) => (typeof loc === 'string' ? loc.trim() : '')).filter(Boolean)
    : typeof locationsRaw === 'string' && locationsRaw.trim()
      ? [locationsRaw.trim()]
      : [];

  if (pluginCategory === DOCUMENT_PLUGIN_CATEGORY && !locations.length) {
    console.warn(`[filesystem-http] Plugin ${configPath} does not specify a valid location; skipping.`);
    return null;
  }

  if (pluginCategory === DOCUMENT_PLUGIN_CATEGORY) {
    const invalidLocations = locations.filter((location) => !DEFAULT_DOCUMENT_PLUGIN_LOCATIONS.includes(location));
    if (invalidLocations.length > 0) {
      console.warn(`[filesystem-http] Plugin ${configPath} has unsupported document locations: ${invalidLocations.join(', ')}`);
      return null;
    }
  } else {
    const invalidLocations = locations.filter((location) => location && !APPLICATION_PLUGIN_LOCATION_PATTERN.test(location));
    if (invalidLocations.length > 0) {
      console.warn(`[filesystem-http] Plugin ${configPath} has invalid application slots: ${invalidLocations.join(', ')}`);
      return null;
    }
  }

  const component = isNonEmptyString(parsedConfig.component) ? parsedConfig.component.trim() : (contributionType === 'mount' ? pluginEntryName : '');
  if (contributionType === 'mount' && !component) {
    console.warn(`[filesystem-http] Plugin ${configPath} is missing a valid component name.`);
    return null;
  }

  if (parsedConfig.presenter !== undefined && !isNonEmptyString(parsedConfig.presenter)) {
    console.warn(`[filesystem-http] Plugin ${configPath} has an invalid presenter.`);
    return null;
  }

  if (parsedConfig.tooltip !== undefined && !isNonEmptyString(parsedConfig.tooltip)) {
    console.warn(`[filesystem-http] Plugin ${configPath} has an invalid tooltip.`);
    return null;
  }

  if (parsedConfig.label !== undefined && !isNonEmptyString(parsedConfig.label)) {
    console.warn(`[filesystem-http] Plugin ${configPath} has an invalid label.`);
    return null;
  }

  if (parsedConfig.id !== undefined) {
    const pluginId = isNonEmptyString(parsedConfig.id) ? parsedConfig.id.trim() : '';
    if (!pluginId || !APPLICATION_PLUGIN_ID_PATTERN.test(pluginId)) {
      console.warn(`[filesystem-http] Plugin ${configPath} has an invalid id. Use letters, numbers, and dashes, starting with a letter.`);
      return null;
    }
  }

  if (parsedConfig.icon !== undefined && !isNonEmptyString(parsedConfig.icon)) {
    console.warn(`[filesystem-http] Plugin ${configPath} has an invalid icon path.`);
    return null;
  }

  if (parsedConfig.iconPresenter !== undefined && !isNonEmptyString(parsedConfig.iconPresenter)) {
    console.warn(`[filesystem-http] Plugin ${configPath} has an invalid iconPresenter.`);
    return null;
  }

  if (parsedConfig.iconComponent !== undefined && !isNonEmptyString(parsedConfig.iconComponent)) {
    console.warn(`[filesystem-http] Plugin ${configPath} has an invalid iconComponent.`);
    return null;
  }

  if (parsedConfig.menuModule !== undefined && !isNonEmptyString(parsedConfig.menuModule)) {
    console.warn(`[filesystem-http] Plugin ${configPath} has an invalid menuModule.`);
    return null;
  }

  const settingsUrl = parsedConfig.settingsUrl !== undefined
    ? (isNonEmptyString(parsedConfig.settingsUrl) ? parsedConfig.settingsUrl.trim() : '')
    : undefined;
  if (parsedConfig.settingsUrl !== undefined && (!settingsUrl || !settingsUrl.startsWith('/') || settingsUrl.startsWith('//'))) {
    console.warn(`[filesystem-http] Plugin ${configPath} has an invalid settingsUrl. Use a router-relative path.`);
    return null;
  }

  if (contributionType === 'menu' && !isNonEmptyString(parsedConfig.menuModule)) {
    console.warn(`[filesystem-http] Menu plugin ${configPath} must declare menuModule.`);
    return null;
  }

  if (contributionType === 'menu' && parsedConfig.type !== undefined) {
    console.warn(`[filesystem-http] Menu plugin ${configPath} must not declare type.`);
    return null;
  }

  if (contributionType === 'mount' && parsedConfig.type !== undefined && !VALID_PLUGIN_TYPES.has(parsedConfig.type)) {
    console.warn(`[filesystem-http] Plugin ${configPath} has an invalid type "${parsedConfig.type}".`);
    return null;
  }

  if (contributionType === 'mount' && parsedConfig.type === 'global' && pluginCategory !== APPLICATION_PLUGIN_CATEGORY) {
    console.warn(`[filesystem-http] Plugin ${configPath} can use type "global" only for application mount contributions.`);
    return null;
  }

  if (parsedConfig.autoPin !== undefined && typeof parsedConfig.autoPin !== 'boolean') {
    console.warn(`[filesystem-http] Plugin ${configPath} has a non-boolean autoPin value.`);
    return null;
  }

  const dependencies = normalizePluginDependencies(parsedConfig.dependencies, configPath);
  if (dependencies === null) {
    return null;
  }

  if (parsedConfig.toolbarModal !== undefined) {
    const descriptor = parsedConfig.toolbarModal;
    const mode = descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)
      ? String(descriptor.mode || '').trim()
      : '';
    const valid = (mode === 'iframe' && isNonEmptyString(descriptor?.url))
      || (mode === 'component' && isNonEmptyString(descriptor?.component));
    if (!valid) {
      console.warn(`[filesystem-http] Plugin ${configPath} has an invalid toolbarModal descriptor.`);
      delete parsedConfig.toolbarModal;
    }
  }

  const normalizedLocations = [...new Set(locations)];
  const effectiveLocations = pluginCategory === APPLICATION_PLUGIN_CATEGORY && normalizedLocations.length === 0
    ? ['']
    : normalizedLocations;

  return {
    locations: effectiveLocations,
    pluginConfig: {
      ...parsedConfig,
      pluginCategory,
      contributionType,
      component,
      ...(settingsUrl !== undefined ? { settingsUrl } : {}),
      dependencies
    }
  };
}

function validateAndNormalizeAgentSettings(parsedManifest, agentName, manifestPath) {
  const rawSettings = parsedManifest?.ideSettings;
  if (rawSettings === undefined) {
    return [];
  }
  if (!Array.isArray(rawSettings)) {
    console.warn(`[filesystem-http] Invalid ideSettings in ${manifestPath}: expected an array.`);
    return [];
  }

  const normalized = [];
  for (const rawSetting of rawSettings) {
    if (!rawSetting || typeof rawSetting !== 'object' || Array.isArray(rawSetting)) {
      console.warn(`[filesystem-http] Invalid ideSettings entry in ${manifestPath}: expected an object.`);
      continue;
    }

    const key = isNonEmptyString(rawSetting.key) ? rawSetting.key.trim() : '';
    if (!key || !AGENT_SETTING_KEY_PATTERN.test(key)) {
      console.warn(`[filesystem-http] Invalid ideSettings entry in ${manifestPath}: missing or invalid key.`);
      continue;
    }

    const label = isNonEmptyString(rawSetting.label) ? rawSetting.label.trim() : '';
    if (!label) {
      console.warn(`[filesystem-http] Invalid ideSettings entry "${key}" in ${manifestPath}: missing label.`);
      continue;
    }

    const pluginKey = isNonEmptyString(rawSetting.pluginKey) ? rawSetting.pluginKey.trim() : '';
    if (!pluginKey || !AGENT_SETTING_PLUGIN_KEY_PATTERN.test(pluginKey)) {
      console.warn(`[filesystem-http] Invalid ideSettings entry "${key}" in ${manifestPath}: invalid pluginKey.`);
      continue;
    }

    const scope = isNonEmptyString(rawSetting.scope) ? rawSetting.scope.trim() : 'workspace';
    if (scope !== 'workspace') {
      console.warn(`[filesystem-http] Invalid ideSettings entry "${key}" in ${manifestPath}: unsupported scope "${scope}".`);
      continue;
    }

    const settingsComponent = rawSetting.settingsComponent !== undefined
      ? (isNonEmptyString(rawSetting.settingsComponent) ? rawSetting.settingsComponent.trim() : '')
      : '';
    if (rawSetting.settingsComponent !== undefined && (!settingsComponent || !SETTINGS_COMPONENT_PATTERN.test(settingsComponent))) {
      console.warn(`[filesystem-http] Invalid ideSettings entry "${key}" in ${manifestPath}: invalid settingsComponent.`);
      continue;
    }

    const settingsUrl = rawSetting.settingsUrl !== undefined
      ? (isNonEmptyString(rawSetting.settingsUrl) ? rawSetting.settingsUrl.trim() : '')
      : '';
    if (rawSetting.settingsUrl !== undefined && (!settingsUrl || !settingsUrl.startsWith('/') || settingsUrl.startsWith('//'))) {
      console.warn(`[filesystem-http] Invalid ideSettings entry "${key}" in ${manifestPath}: invalid settingsUrl. Use a router-relative path.`);
      continue;
    }

    normalized.push({
      key,
      label,
      ownerAgent: agentName,
      scope,
      pluginKey,
      ...(settingsComponent ? { settingsComponent } : {}),
      ...(settingsUrl ? { settingsUrl } : {}),
      adminOnly: rawSetting.adminOnly === true
    });
  }
  return normalized;
}

export async function aggregateIdePlugins(rootDir) {
  if (!rootDir) throw new Error('Workspace root not configured.');

  const aggregated = {
    [DOCUMENT_PLUGIN_CATEGORY]: Object.create(null),
    [APPLICATION_PLUGIN_CATEGORY]: Object.create(null),
    agentSettings: []
  };
  const visitedAgents = new Set();
  let pluginCount = 0;

  const ensureBucket = (category, location) => {
    if (!aggregated[category][location]) {
      aggregated[category][location] = [];
    }
    return aggregated[category][location];
  };

  for (const location of DEFAULT_DOCUMENT_PLUGIN_LOCATIONS) {
    ensureBucket(DOCUMENT_PLUGIN_CATEGORY, location);
  }

  const candidateDirsProcessed = new Set();

  async function isDirectoryEntry(baseDir, entry) {
    if (!entry) {
      return false;
    }
    if (typeof entry.isDirectory === 'function' && entry.isDirectory()) {
      return true;
    }
    if (!(typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink())) {
      return false;
    }
    try {
      const targetStat = await fs.stat(path.join(baseDir, entry.name));
      return targetStat.isDirectory();
    } catch {
      return false;
    }
  }

  const processAgentDirectory = async (agentName, agentDir, confinedRoot = null) => {
    if (!agentName || SKIP_DIRECTORY_NAMES.has(agentName)) {
      return;
    }

    const idePluginsDir = path.join(agentDir, 'IDE-plugins');
    if (confinedRoot && (!(await realPathWithin(agentDir, confinedRoot)) || !(await realPathWithin(idePluginsDir, confinedRoot)))) return;

    let ideStat;
    try {
      ideStat = await fs.stat(idePluginsDir);
    } catch {
      return;
    }

    if (!ideStat.isDirectory()) {
      return;
    }

    if (visitedAgents.has(agentName)) {
      return;
    }
    visitedAgents.add(agentName);

    const manifestPath = path.join(agentDir, 'manifest.json');
    try {
      if (confinedRoot && !(await realPathWithin(manifestPath, confinedRoot))) return;
      const rawManifest = await fs.readFile(manifestPath, 'utf8');
      const parsedManifest = JSON.parse(rawManifest);
      aggregated.agentSettings.push(...validateAndNormalizeAgentSettings(parsedManifest, agentName, manifestPath));
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
        console.warn(`[filesystem-http] Unable to read agent manifest ${manifestPath}:`, error instanceof Error ? error.message : String(error));
      }
    }

    let pluginEntries;
    try {
      pluginEntries = await fs.readdir(idePluginsDir, { withFileTypes: true });
    } catch (error) {
      console.warn(`[filesystem-http] Unable to read IDE-plugins directory ${idePluginsDir}:`, error instanceof Error ? error.message : String(error));
      return;
    }

    for (const pluginEntry of pluginEntries) {
      if (!(await isDirectoryEntry(idePluginsDir, pluginEntry))) continue;
      const pluginDir = path.join(idePluginsDir, pluginEntry.name);
      const configPath = path.join(pluginDir, 'config.json');
      if (confinedRoot && !(await realPathWithin(configPath, confinedRoot))) continue;

      let rawConfig;
      try {
        rawConfig = await fs.readFile(configPath, 'utf8');
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
          continue;
        }
        console.warn(`[filesystem-http] Skipping plugin ${pluginDir}: unable to read config.json (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }

      let parsedConfig;
      try {
        parsedConfig = JSON.parse(rawConfig);
      } catch (error) {
        console.warn(`[filesystem-http] Invalid JSON in ${configPath}:`, error instanceof Error ? error.message : String(error));
        continue;
      }

      const normalizedConfig = validateAndNormalizePluginConfig(parsedConfig, pluginEntry.name, configPath);
      if (!normalizedConfig) {
        continue;
      }

      const {
        locations,
        pluginConfig
      } = normalizedConfig;
      const { location, ...pluginConfigWithoutLocation } = pluginConfig;
      const finalPluginConfig = pluginConfigWithoutLocation;
      finalPluginConfig.agent = agentName;

      const relativePluginDir = path.relative(rootDir, pluginDir);
      if (relativePluginDir && !relativePluginDir.startsWith('..') && !path.isAbsolute(relativePluginDir)) {
        finalPluginConfig.assetRootPath = relativePluginDir.split(path.sep).join('/');
      }

      for (const loc of locations) {
        const bucket = ensureBucket(finalPluginConfig.pluginCategory, loc);
        bucket.push({
          ...finalPluginConfig,
          location: loc
        });
        pluginCount += 1;
      }
    }
  };

  const scanAgentDirectories = async (baseDir, confinedRoot = null) => {
    if (!baseDir) return;
    let physical;
    try { physical = await fs.realpath(baseDir); } catch { return; }
    if (candidateDirsProcessed.has(physical)) return;
    candidateDirsProcessed.add(physical);

    let entries;
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true });
    } catch (error) {
      console.warn(`[filesystem-http] Unable to read agent base directory ${baseDir}:`, error instanceof Error ? error.message : String(error));
      return;
    }

    await processAgentDirectory(path.basename(baseDir), baseDir, confinedRoot);

    for (const entry of entries) {
      if (!(await isDirectoryEntry(baseDir, entry))) continue;
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
      await processAgentDirectory(entry.name, path.join(baseDir, entry.name), confinedRoot);
    }
  };

  const localRepositoryNames = new Set();
  const localRepositoryOrigins = new Set();

  const addWorkspaceRepositories = async () => {
    let physicalRoot;
    let entries;
    try {
      physicalRoot = await fs.realpath(rootDir);
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRECTORY_NAMES.has(entry.name) || !(await isDirectoryEntry(rootDir, entry))) continue;
      const directory = path.join(rootDir, entry.name);
      if (!(await realPathWithin(directory, physicalRoot))) continue;
      let children;
      try { children = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
      // Match Ploinky's bounded repository shape: immediate agent directories
      // declare manifests. Do not recurse through arbitrary workspace content.
      let hasAgents = false;
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith('.') || SKIP_DIRECTORY_NAMES.has(child.name)) continue;
        if (await realPathWithin(path.join(directory, child.name, 'manifest.json'), physicalRoot)) { hasAgents = true; break; }
      }
      if (!hasAgents) continue;
      localRepositoryNames.add(entry.name);
      const origin = await repositoryOrigin(directory);
      if (origin) localRepositoryOrigins.add(origin);
      await scanAgentDirectories(directory, physicalRoot);
    }
  };

  const addRepoCollections = async (baseDir, applyLocalOverrides = false) => {
    if (!baseDir) return;

    const repoRoot = path.join(baseDir, '.ploinky', 'repos');
    let repoEntries;
    try {
      const repoStat = await fs.stat(repoRoot);
      if (!repoStat.isDirectory()) {
        return;
      }
      repoEntries = await fs.readdir(repoRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of repoEntries) {
      if (!(await isDirectoryEntry(repoRoot, entry))) continue;
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
      const directory = path.join(repoRoot, entry.name);
      if (applyLocalOverrides && (localRepositoryNames.has(entry.name)
          || localRepositoryOrigins.has(await repositoryOrigin(directory)))) continue;
      await scanAgentDirectories(directory);
    }
  };

  await scanAgentDirectories(rootDir);
  await addWorkspaceRepositories();
  await addRepoCollections(rootDir, true);

  if (pluginCount === 0 && localRepositoryNames.size === 0) {
    const parentDir = path.dirname(rootDir);
    if (parentDir && parentDir !== rootDir) {
      await scanAgentDirectories(parentDir);
      await addRepoCollections(parentDir);
    }
  }

  for (const buckets of [aggregated[DOCUMENT_PLUGIN_CATEGORY], aggregated[APPLICATION_PLUGIN_CATEGORY]]) {
    for (const plugins of Object.values(buckets)) {
      plugins.sort((a, b) => {
        const aKey = (a?.component || '').toLowerCase();
        const bKey = (b?.component || '').toLowerCase();
        return aKey.localeCompare(bKey);
      });
    }
  }

  return aggregated;
}

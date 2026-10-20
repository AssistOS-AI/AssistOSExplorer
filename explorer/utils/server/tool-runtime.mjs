import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { minimatch } from 'minimatch';
import { zod as mcpZod } from 'mcp-sdk';

import {
  copyRecursive,
  createCacheHelpers,
  describeDirectoryEntry,
  headFromHandle,
  tailFromHandle
} from '../filesystem-utils.mjs';
import {
  BOUND_OPEN_REFUSAL,
  PROTECTED_DESCENDANT_REFUSAL,
  WORKSPACE_ROOT_REFUSAL,
  classifyCanonicalWorkspaceTarget,
  classifyWorkspacePath,
  crossesUnresolvedLink,
  findProtectedDescendant,
  isVisibleWorkspaceEntry,
  openClassifiedWorkspaceFile,
  protectedPathError,
  withClassifiedWorkspaceFile
} from './protected-workspace-paths.mjs';
import { aggregateIdePlugins } from '../ide-plugins.mjs';
import { createTimedCache, buildCacheKey } from './timed-cache.mjs';
import { createStructureIndex } from './structure-index.mjs';
import { createWorkspaceSearch } from './workspace-search.mjs';
import { buildDirectoryTree } from './directory-tree.mjs';
import { loadFilesystemDeps } from './deps.mjs';
import { getRequestedRoots, resolveAllowedDirectories } from './env-config.mjs';
import { createCacheConfig, initCacheHelpers } from './cache-setup.mjs';
import { createSchemas } from './schemas.mjs';
import { createToolHandlers } from './tool-handlers.mjs';
import { errorResponse } from './responses.mjs';

const { z } = mcpZod;

// Listing tools may open the workspace-root `.ploinky` directory, which they
// project as containing only `repos`; every other tool is refused there.
const LISTING_TOOLS = new Set(['list_directory', 'list_directory_with_sizes', 'list_directory_detailed', 'directory_tree']);

function createFatalRecorder() {
  let state = null;
  return {
    record(source, error) {
      if (state) return;
      const err = error instanceof Error ? error : new Error(String(error));
      state = {
        source,
        error: err,
        timestamp: new Date().toISOString(),
        cwd: process.cwd()
      };
      console.error(`[explorer-tool] fatal ${source}:`, err);
    },
    getState() {
      return state;
    }
  };
}

function getResolvedAllowedRoots(workspaceRoot, allowedDirectories) {
  const roots = [workspaceRoot, ...(allowedDirectories || [])]
    .filter(Boolean)
    .map((dir) => path.resolve(dir));
  return Array.from(new Set(roots));
}

function isPathWithinRoots(candidatePath, roots) {
  const resolvedCandidate = path.resolve(candidatePath);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    if (resolvedCandidate === resolvedRoot) return true;
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

async function resolveCanonicalPath(targetPath) {
  const normalizedTarget = path.resolve(targetPath);
  try {
    return await fs.realpath(normalizedTarget);
  } catch {
    let current = path.dirname(normalizedTarget);
    while (true) {
      try {
        const realCurrent = await fs.realpath(current);
        const suffix = path.relative(current, normalizedTarget);
        return path.resolve(realCurrent, suffix);
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
      }
    }
  }
}

async function openClassifiedFileOrRefuse(filePath) {
  const handle = await openClassifiedWorkspaceFile(filePath);
  if (!handle) throw protectedPathError(BOUND_OPEN_REFUSAL);
  return handle;
}

// User-facing reads of file content open the classified canonical path with a
// descriptor-bound open, so a symlink swapped in after validation cannot
// redirect them into a protected entry.
const readClassifiedFileContent = (filePath) => withClassifiedWorkspaceFile(filePath, (handle) => handle.readFile({ encoding: 'utf-8' }));
const readClassifiedFileBase64 = (filePath) => withClassifiedWorkspaceFile(filePath, async (handle) => (await handle.readFile()).toString('base64'));
const headClassifiedFile = (filePath, numLines) => withClassifiedWorkspaceFile(filePath, (handle) => headFromHandle(handle, numLines));
const tailClassifiedFile = (filePath, numLines) => withClassifiedWorkspaceFile(filePath, (handle) => tailFromHandle(handle, numLines));

export async function createExplorerToolRuntime({
  argv = [],
  env = process.env
} = {}) {
  const fatal = createFatalRecorder();
  const {
    normalizePath,
    expandHome,
    getValidRootDirectories,
    formatSize,
    validatePath: libraryValidatePath,
    getFileStats,
    writeFileContent,
    applyFileEdits,
    setAllowedDirectories
  } = await loadFilesystemDeps({ recordFatalError: fatal.record.bind(fatal) });
  const readFileContent = readClassifiedFileContent;

  const requestedRoots = getRequestedRoots(argv, env);
  let allowedDirectories = [];
  try {
    allowedDirectories = await resolveAllowedDirectories(requestedRoots, { expandHome, normalizePath, fs, path });
    setAllowedDirectories(allowedDirectories);
  } catch (error) {
    fatal.record('init:allowed-directories', error);
  }

  const workspaceRoot = allowedDirectories.length > 0 ? allowedDirectories[0] : path.resolve(process.cwd());
  const rootsForPathChecks = () => getResolvedAllowedRoots(workspaceRoot, allowedDirectories);
  const visibleEntries = async (directoryPath, entries) => {
    const roots = rootsForPathChecks();
    const visible = await Promise.all(entries.map((entry) => isVisibleWorkspaceEntry(roots, directoryPath, entry)));
    return entries.filter((_, index) => visible[index]);
  };
  let cacheConfig = createCacheConfig(env);
  let readFileWithCache = async (validPath, { skipReadForLarge = false } = {}) => {
    const stats = await fs.stat(validPath);
    if (stats.size > cacheConfig.maxFileSizeBytes && skipReadForLarge) {
      return { content: null, stats };
    }
    const content = await readFileContent(validPath);
    return { content, stats };
  };
  let listDirectoryDetailedWithCache = async (validPath, { limit } = {}) => {
    const entries = await visibleEntries(validPath, await fs.readdir(validPath, { withFileTypes: true }));
    if (Number.isFinite(limit) && limit >= 0 && entries.length > limit) {
      const partial = await Promise.all(entries.slice(0, limit).map((entry) => describeDirectoryEntry(validPath, entry)));
      Object.defineProperty(partial, 'truncated', { value: true, enumerable: false });
      return partial;
    }
    return Promise.all(entries.map((entry) => describeDirectoryEntry(validPath, entry)));
  };
  let invalidateCachesForPath = () => {};
  let indexDirectory = async (validDirPath, options) => listDirectoryDetailedWithCache(validDirPath, options);
  let structureIndex = new Map();
  let invalidateStructureIndexForPathAndParents = () => {};
  let invalidateStructureIndexSubtree = () => {};

  const searchCacheTtlMs = Number.parseInt(env.SEARCH_CACHE_TTL_MS || '5000', 10);
  const searchCacheMaxEntries = Number.parseInt(env.SEARCH_CACHE_MAX_ENTRIES || '100', 10);
  const searchFilesCache = createTimedCache({ ttlMs: searchCacheTtlMs, maxEntries: searchCacheMaxEntries });
  const searchTextCache = createTimedCache({ ttlMs: searchCacheTtlMs, maxEntries: searchCacheMaxEntries });
  const directoryTreeCache = createTimedCache({ ttlMs: searchCacheTtlMs, maxEntries: searchCacheMaxEntries });

  try {
    const cacheHelpers = initCacheHelpers({
      createCacheHelpers,
      readFileContent,
      visibleEntries,
      cacheConfig,
      fs,
      path
    });
    ({ readFileWithCache, listDirectoryDetailedWithCache, invalidateCachesForPath, cacheConfig } = cacheHelpers);
  } catch (error) {
    fatal.record('init:cache-helpers', error);
  }

  try {
    const structure = createStructureIndex({ fs, path, listDirectoryDetailedWithCache });
    ({ structureIndex, indexDirectory } = structure);
    invalidateStructureIndexForPathAndParents = structure.invalidateForPathAndParents;
    invalidateStructureIndexSubtree = structure.invalidateSubtree;
  } catch (error) {
    fatal.record('init:structure-index', error);
  }

  const baseInvalidateCachesForPath = invalidateCachesForPath;
  invalidateCachesForPath = (targetPath) => {
    baseInvalidateCachesForPath(targetPath);
    if (!targetPath) return;
    invalidateStructureIndexForPathAndParents(targetPath);
    searchFilesCache.clear();
    searchTextCache.clear();
    directoryTreeCache.clear();
  };

  // Every user-supplied path, for every tool and for both the source and the
  // destination of a move or copy, is classified here: its lexical form before
  // any filesystem access, then its canonical target. A protected path is
  // refused with an explicit denial, never reported as missing.
  async function resolvePathInAllowedRoots(inputPath, { allowControllerRoot = false } = {}) {
    if (typeof inputPath !== 'string') return inputPath;
    if (!workspaceRoot) throw new Error('Workspace root not configured.');
    if (inputPath.includes('\0')) throw new Error(`Invalid path: ${inputPath}`);
    const candidate = inputPath.trim();
    const roots = rootsForPathChecks();
    const workspaceResolved = path.resolve(workspaceRoot);
    const resolvedPath = path.isAbsolute(candidate) && isPathWithinRoots(candidate, roots)
      ? path.resolve(candidate)
      : path.resolve(workspaceResolved, candidate.replace(/^\/+/, ''));

    if (!isPathWithinRoots(resolvedPath, roots)) {
      throw new Error(`Access denied: path traversal attempt for "${inputPath}"`);
    }
    // Only the workspace-root `.ploinky`, named as such, is projected to a
    // listing tool; a link that leads there is refused like any other.
    const lexicalKind = classifyWorkspacePath(roots, resolvedPath);
    const refuseProtected = (kind) => {
      if (kind === 'protected' || (kind === 'controller' && !(allowControllerRoot && lexicalKind === 'controller'))) {
        throw protectedPathError(`Access denied: protected path "${inputPath}"`);
      }
    };
    refuseProtected(lexicalKind);
    if (await crossesUnresolvedLink(resolvedPath)) {
      throw protectedPathError(`Access denied: unresolved symbolic link in "${inputPath}"`);
    }
    const canonicalPath = await resolveCanonicalPath(resolvedPath);
    if (!canonicalPath || !isPathWithinRoots(canonicalPath, roots)) {
      throw new Error(`Access denied: symlink escape attempt for "${inputPath}"`);
    }
    refuseProtected(await classifyCanonicalWorkspaceTarget(roots, canonicalPath));
    return canonicalPath;
  }

  async function resolvePathsInArgs(name, args) {
    const originalArgs = args ?? {};
    const next = { ...originalArgs };
    const allowControllerRoot = LISTING_TOOLS.has(name);
    if (typeof next.path === 'string') next.path = await resolvePathInAllowedRoots(next.path, { allowControllerRoot });
    if (typeof next.source === 'string') next.source = await resolvePathInAllowedRoots(next.source);
    if (typeof next.destination === 'string') next.destination = await resolvePathInAllowedRoots(next.destination);
    if (Array.isArray(next.paths)) next.paths = await Promise.all(next.paths.map((entry) => resolvePathInAllowedRoots(entry)));
    return next;
  }

  const validatePath = async (targetPath, options) => resolvePathInAllowedRoots(targetPath, options);

  // A recursive delete, move or copy touches every entry below its target, so
  // it is refused when one of them is protected, and a workspace root is never
  // deleted, moved or copied.
  async function assertNoProtectedEntriesBelow(validPath) {
    const roots = rootsForPathChecks();
    if (roots.some((root) => path.resolve(root) === path.resolve(validPath))) {
      throw protectedPathError(WORKSPACE_ROOT_REFUSAL);
    }
    if (await findProtectedDescendant(roots, validPath)) {
      throw protectedPathError(PROTECTED_DESCENDANT_REFUSAL);
    }
  }
  const maxTextSearchFileBytes = Number.parseInt(env.SEARCH_TEXT_MAX_BYTES || '2097152', 10);
  const searchTextTimeoutMs = Number.parseInt(env.SEARCH_TEXT_TIMEOUT_MS || '30000', 10);
  const replaceTextTimeoutMs = Number.parseInt(env.REPLACE_TEXT_TIMEOUT_MS || '45000', 10);
  const defaultTextSearchExcludes = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.DS_Store'];
  const defaultDirectoryTreeMaxDepth = Number.parseInt(env.DIRECTORY_TREE_MAX_DEPTH || '10', 10);
  const defaultDirectoryTreeMaxNodes = Number.parseInt(env.DIRECTORY_TREE_MAX_NODES || '4000', 10);

  const { searchTextWithinWorkspace, searchFilesWithinWorkspace, replaceTextWithinWorkspace } = createWorkspaceSearch({
    fs,
    path,
    readline,
    minimatch,
    workspaceRoot,
    validatePath,
    getAllowedDirectories: () => allowedDirectories,
    readFileWithCache,
    writeFileContent,
    cacheConfig,
    indexDirectory,
    structureIndex,
    dirIndexTtlMs: cacheConfig.ttlMs,
    defaultExcludes: defaultTextSearchExcludes,
    maxTextSearchFileBytes,
    openFile: openClassifiedFileOrRefuse
  });

  const schemas = createSchemas(z);
  let activeInvocationContext = {};
  let disposed = false;
  const cleanups = [];
  let toolHandlers;
  function dispose() {
    if (disposed) return;
    disposed = true;
    activeInvocationContext = {};
    toolHandlers = null;
    for (const cleanup of cleanups.splice(0)) cleanup();
  }
  try {
    toolHandlers = createToolHandlers({
      fs,
      path,
      schemas,
      validatePath,
      cacheConfig,
      readFileWithCache,
      readFileAsBase64Stream: readClassifiedFileBase64,
      listDirectoryDetailedWithCache,
      indexDirectory,
      invalidateCachesForPath,
      invalidateStructureIndexSubtree,
      formatSize,
      getFileStats,
      applyFileEdits,
      tailFile: tailClassifiedFile,
      headFile: headClassifiedFile,
      writeFileContent,
      copyRecursive,
      assertNoProtectedEntriesBelow,
      aggregateIdePlugins,
      workspaceRoot,
      agentName: String(env.PLOINKY_AGENT_NAME || '').trim() || 'explorer',
      buildDirectoryTree,
      directoryTreeCache,
      buildCacheKey,
      searchFilesCache,
      searchTextCache,
      searchFilesWithinWorkspace,
      searchTextWithinWorkspace,
      replaceTextWithinWorkspace,
      MAX_TEXT_SEARCH_FILE_BYTES: maxTextSearchFileBytes,
      SEARCH_TEXT_TIMEOUT_MS: searchTextTimeoutMs,
      REPLACE_TEXT_TIMEOUT_MS: replaceTextTimeoutMs,
      DEFAULT_DIRECTORY_TREE_MAX_DEPTH: defaultDirectoryTreeMaxDepth,
      DEFAULT_DIRECTORY_TREE_MAX_NODES: defaultDirectoryTreeMaxNodes,
      getAllowedDirectories: () => allowedDirectories,
      commandMode: true,
      searchTextJobStorePath: path.join(workspaceRoot, '.data', 'explorer', 'search-jobs'),
      getInvocationContext: () => activeInvocationContext,
      registerCleanup: (cleanup) => cleanups.push(cleanup)
    });
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    async callTool(name, args = {}, context = {}) {
      if (disposed) throw new Error('Explorer tool runtime is disposed.');
      const fatalState = fatal.getState();
      if (fatalState) {
        throw new Error(`Explorer tool runtime failed during ${fatalState.source}: ${fatalState.error?.message || 'unknown error'}`);
      }
      activeInvocationContext = context && typeof context === 'object' ? context : {};
      try {
        const resolvedArgs = await resolvePathsInArgs(name, args);
        const handler = toolHandlers[name];
        if (!handler) throw new Error(`Unknown tool: ${name}`);
        return await handler(resolvedArgs);
      } finally {
        activeInvocationContext = {};
      }
    },
    errorResponse,
    dispose
  };
}

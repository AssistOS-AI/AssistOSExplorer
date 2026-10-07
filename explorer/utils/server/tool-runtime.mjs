import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { minimatch } from 'minimatch';
import { zod as mcpZod } from 'mcp-sdk';

import {
  copyRecursive,
  createCacheHelpers,
  describeDirectoryEntry,
  isProtectedSecretName,
  isProtectedSecretPath
} from '../filesystem-utils.mjs';
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

async function readFileAsBase64Stream(filePath) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    stream.on('error', reject);
  });
}

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
    readFileContent,
    writeFileContent,
    applyFileEdits,
    tailFile,
    headFile,
    setAllowedDirectories
  } = await loadFilesystemDeps({ recordFatalError: fatal.record.bind(fatal) });

  const requestedRoots = getRequestedRoots(argv, env);
  let allowedDirectories = [];
  try {
    allowedDirectories = await resolveAllowedDirectories(requestedRoots, { expandHome, normalizePath, fs, path });
    setAllowedDirectories(allowedDirectories);
  } catch (error) {
    fatal.record('init:allowed-directories', error);
  }

  const workspaceRoot = allowedDirectories.length > 0 ? allowedDirectories[0] : path.resolve(process.cwd());
  let cacheConfig = createCacheConfig(env);
  let readFileWithCache = async (validPath, { skipReadForLarge = false } = {}) => {
    const stats = await fs.stat(validPath);
    if (stats.size > cacheConfig.maxFileSizeBytes && skipReadForLarge) {
      return { content: null, stats };
    }
    const content = await readFileContent(validPath);
    return { content, stats };
  };
  let listDirectoryDetailedWithCache = async (validPath) => {
    const entries = await fs.readdir(validPath, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) => !isProtectedSecretName(entry?.name));
    return Promise.all(visibleEntries.map((entry) => describeDirectoryEntry(validPath, entry)));
  };
  let invalidateCachesForPath = () => {};
  let indexDirectory = async (validDirPath) => listDirectoryDetailedWithCache(validDirPath);
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

  const rootsForPathChecks = () => getResolvedAllowedRoots(workspaceRoot, allowedDirectories);
  async function resolvePathInAllowedRoots(inputPath) {
    if (typeof inputPath !== 'string') return inputPath;
    if (!workspaceRoot) throw new Error('Workspace root not configured.');
    if (inputPath.includes('\0')) throw new Error(`Invalid path: ${inputPath}`);
    const candidate = inputPath.trim();
    const roots = rootsForPathChecks();
    const workspaceResolved = path.resolve(workspaceRoot);
    const resolvedPath = path.isAbsolute(candidate) && isPathWithinRoots(candidate, roots)
      ? path.resolve(candidate)
      : path.resolve(workspaceResolved, candidate.startsWith('/') ? candidate.slice(1) : candidate);

    if (!isPathWithinRoots(resolvedPath, roots)) {
      throw new Error(`Access denied: path traversal attempt for "${inputPath}"`);
    }
    if (isProtectedSecretPath(resolvedPath)) {
      throw new Error(`Access denied: protected file "${inputPath}"`);
    }
    const canonicalPath = await resolveCanonicalPath(resolvedPath);
    if (!canonicalPath || !isPathWithinRoots(canonicalPath, roots)) {
      throw new Error(`Access denied: symlink escape attempt for "${inputPath}"`);
    }
    if (isProtectedSecretPath(canonicalPath)) {
      throw new Error(`Access denied: protected file "${inputPath}"`);
    }
    return canonicalPath;
  }

  async function resolvePathsInArgs(args) {
    const originalArgs = args ?? {};
    const next = { ...originalArgs };
    if (typeof next.path === 'string') next.path = await resolvePathInAllowedRoots(next.path);
    if (typeof next.source === 'string') next.source = await resolvePathInAllowedRoots(next.source);
    if (typeof next.destination === 'string') next.destination = await resolvePathInAllowedRoots(next.destination);
    if (Array.isArray(next.paths)) next.paths = await Promise.all(next.paths.map(resolvePathInAllowedRoots));
    return next;
  }

  const validatePath = async (targetPath) => resolvePathInAllowedRoots(targetPath);
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
    maxTextSearchFileBytes
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
      readFileAsBase64Stream,
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
        const resolvedArgs = await resolvePathsInArgs(args);
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

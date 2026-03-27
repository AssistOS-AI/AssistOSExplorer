import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { upsertMiddleware, listMiddlewares, markUndiscovered } from '../db/middlewares-dao.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('middleware-loader');
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIDDLEWARES_DIR = join(__dirname, '..', 'middlewares');

/** In-memory cache: fileName -> loaded module default export */
const loaded = new Map();

/**
 * Get a loaded middleware module by file name.
 */
export function getLoadedMiddleware(fileName) {
  return loaded.get(fileName) || null;
}

/**
 * Scan the middlewares directory, import all .mjs files, validate and register them.
 * Returns array of discovered file names.
 */
export async function scanMiddlewares() {
  if (!existsSync(MIDDLEWARES_DIR)) {
    log.info('Middlewares directory not found, skipping scan', { dir: MIDDLEWARES_DIR });
    return [];
  }

  const files = readdirSync(MIDDLEWARES_DIR).filter(f => f.endsWith('.mjs'));
  if (files.length === 0) {
    log.info('No middleware files found');
    return [];
  }

  const discovered = [];

  for (const file of files) {
    try {
      const fullPath = join(MIDDLEWARES_DIR, file);
      // Cache-bust: append timestamp query param to force reimport on rescan
      const mod = await import(`file://${fullPath}?t=${Date.now()}`);
      const mw = mod.default;

      // Validate interface
      if (!mw || typeof mw.name !== 'string' || !mw.name) {
        log.warn(`Skipping ${file}: missing or invalid 'name'`);
        continue;
      }
      const type = mw.type || 'both';
      if (!['pre', 'post', 'both'].includes(type)) {
        log.warn(`Skipping ${file}: invalid type '${type}'`);
        continue;
      }
      if (type !== 'post' && typeof mw.before !== 'function') {
        log.warn(`Skipping ${file}: type '${type}' requires before()`);
        continue;
      }
      if (type !== 'pre' && typeof mw.after !== 'function') {
        log.warn(`Skipping ${file}: type '${type}' requires after()`);
        continue;
      }

      loaded.set(file, mw);
      discovered.push(file);

      // Upsert into DB
      await upsertMiddleware({
        name: mw.name,
        description: mw.description || '',
        file_name: file,
        type,
        supports_streaming: !!mw.supportsStreaming,
        default_settings: mw.defaultSettings || {},
        version: mw.version || '1.0.0',
      });

      log.info(`Loaded middleware: ${mw.name} (${file})`);
    } catch (err) {
      log.error(`Failed to load middleware ${file}`, { error: err.message });
    }
  }

  // Mark middlewares that are in DB but no longer on disk
  try {
    const all = await listMiddlewares();
    const undiscoveredFiles = all
      .filter(m => m.is_discovered && !discovered.includes(m.file_name))
      .map(m => m.file_name);
    if (undiscoveredFiles.length > 0) {
      await markUndiscovered(undiscoveredFiles);
      log.info(`Marked ${undiscoveredFiles.length} middleware(s) as undiscovered`);
    }
  } catch (err) {
    log.error('Failed to mark undiscovered middlewares', { error: err.message });
  }

  log.info(`Middleware scan complete: ${discovered.length} loaded`);
  return discovered;
}

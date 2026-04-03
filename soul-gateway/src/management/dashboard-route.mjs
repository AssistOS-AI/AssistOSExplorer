/**
 * Dashboard static file serving routes.
 *
 * GET /management          — serve dashboard HTML
 * GET /management/static/* — serve static assets
 */

import { join, extname, resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { CONTENT_TYPES, ERROR_MESSAGES, HEADER_NAMES, HTTP_STATUS } from '../core/constants.mjs';
import { sendNotFound, sendForbidden, sendInternalError, sendStaticMissing } from './route-response-helpers.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * GET /management
 * Serve the dashboard index.html.
 */
export async function handleDashboard(ctx) {
  const { res, appCtx } = ctx;
  const staticDir = appCtx.config.env.DASHBOARD_STATIC_DIR;
  const indexPath = join(staticDir, 'index.html');

  try {
    const html = await readFile(indexPath, 'utf8');
    res.writeHead(HTTP_STATUS.OK, {
      [HEADER_NAMES.CONTENT_TYPE]: CONTENT_TYPES.HTML_UTF8,
      [HEADER_NAMES.CONTENT_LENGTH]: Buffer.byteLength(html),
      [HEADER_NAMES.CACHE_CONTROL]: 'no-cache',
    });
    res.end(html);
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendStaticMissing(res);
    } else {
      sendInternalError(res, ERROR_MESSAGES.DASHBOARD_READ_FAILED);
    }
  }
}

/**
 * GET /management/css/* and /management/js/*
 * Serve static dashboard assets. The URL path after /management/ maps to the file
 * inside DASHBOARD_STATIC_DIR (e.g., /management/css/app.css → dashboard/css/app.css).
 */
export async function handleStatic(ctx) {
  const { req, res, appCtx } = ctx;
  const staticDir = appCtx.config.env.DASHBOARD_STATIC_DIR;

  // Extract the path after /management/
  const url = req.url.split('?')[0];
  const requestedPath = url.replace(/^\/management\//, '');

  // Prevent path traversal
  const safePath = requestedPath.replace(/\.\./g, '');
  const resolvedDir = resolve(staticDir);
  const filePath = resolve(staticDir, safePath);

  // Ensure file is within static dir
  if (!filePath.startsWith(resolvedDir)) {
    sendForbidden(res);
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendNotFound(res);
      return;
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const body = await readFile(filePath);

    res.writeHead(HTTP_STATUS.OK, {
      [HEADER_NAMES.CONTENT_TYPE]: contentType,
      [HEADER_NAMES.CONTENT_LENGTH]: body.length,
      [HEADER_NAMES.CACHE_CONTROL]: ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendNotFound(res);
    } else {
      sendInternalError(res);
    }
  }
}

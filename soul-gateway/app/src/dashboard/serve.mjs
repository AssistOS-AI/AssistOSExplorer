import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Cache files in memory for performance
const fileCache = new Map();

function getFile(filePath) {
  if (fileCache.has(filePath)) return fileCache.get(filePath);
  const fullPath = join(PUBLIC_DIR, filePath);
  if (!existsSync(fullPath)) return null;
  const content = readFileSync(fullPath);
  fileCache.set(filePath, content);
  return content;
}

export function serveDashboard(req, res, pathname) {
  // Map / to /index.html
  let filePath = pathname === '/' ? '/index.html' : pathname;

  const content = getFile(filePath);
  if (!content) {
    // SPA fallback — serve index.html for client-side routes
    const indexContent = getFile('/index.html');
    if (indexContent) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indexContent);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(content);
}

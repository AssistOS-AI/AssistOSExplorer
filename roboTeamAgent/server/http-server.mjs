import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestActor } from './request-identity.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(MODULE_DIR, '..', 'public');
const BODY_LIMIT = 64 * 1024;

const CONTENT_TYPES = Object.freeze({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
});

function normalizeBasePath(value) {
    const raw = String(value || '/').trim();
    const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
    return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

function sendJson(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': payload.length,
        'cache-control': 'no-store',
    });
    res.end(payload);
}

function sendError(res, status, message) {
    sendJson(res, status, { ok: false, error: message });
}

async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_LIMIT) throw new Error('request body is too large');
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON object body is required');
    }
    return parsed;
}

async function serveFile(res, root, relativePath, { cache = false } = {}) {
    const rootPath = path.resolve(root);
    const candidate = path.resolve(rootPath, relativePath);
    if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${path.sep}`)) {
        sendError(res, 404, 'not found');
        return;
    }
    let stats;
    try {
        stats = await fsp.stat(candidate);
    } catch {
        sendError(res, 404, 'not found');
        return;
    }
    if (!stats.isFile()) {
        sendError(res, 404, 'not found');
        return;
    }
    res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(candidate)] || 'application/octet-stream',
        'content-length': stats.size,
        'cache-control': cache ? 'public, max-age=3600' : 'no-store',
        'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(candidate).pipe(res);
}

function proxyAgentServer(req, res, mcpPort) {
    const headers = { ...req.headers, host: `127.0.0.1:${mcpPort}` };
    const upstream = http.request({
        host: '127.0.0.1',
        port: mcpPort,
        method: req.method,
        path: req.url,
        headers,
    }, (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
    });
    upstream.once('error', () => sendError(res, 502, 'MCP runtime is unavailable'));
    req.pipe(upstream);
}

function websocketFailure(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

function proxyWebSocket(req, socket, head, upstreamPort) {
    const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort });
    upstream.once('connect', () => {
        const headers = [];
        const allowed = [
            'upgrade',
            'connection',
            'sec-websocket-key',
            'sec-websocket-version',
            'sec-websocket-protocol',
            'origin',
            'user-agent',
        ];
        headers.push('GET / HTTP/1.1');
        headers.push(`Host: 127.0.0.1:${upstreamPort}`);
        for (const name of allowed) {
            const value = req.headers[name];
            if (value) headers.push(`${name}: ${value}`);
        }
        upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
    });
    upstream.once('error', () => websocketFailure(socket, 502, 'Bad Gateway'));
    socket.once('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
}

function publicProfile(profile, desktopStatus, publicBasePath) {
    return {
        id: profile.id,
        name: profile.name,
        specialization: profile.specialization,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        desktop: desktopStatus,
        desktopUrl: `${publicBasePath}desktop.html?profile=${encodeURIComponent(profile.id)}`,
    };
}

function matchProfilePath(pathname, suffix) {
    const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = pathname.match(new RegExp(`^/api/profiles/([a-z0-9][a-z0-9-]{2,63})${escapedSuffix}$`));
    return match?.[1] || null;
}

export function createRoboTeamServer(options) {
    const profileStore = options.profileStore;
    const desktopManager = options.desktopManager;
    const internalToken = String(options.internalToken || '');
    const publicBasePath = normalizeBasePath(options.publicBasePath);
    const routeKey = String(options.routeKey || 'roboTeamAgent');
    const publicDir = path.resolve(options.publicDir || DEFAULT_PUBLIC_DIR);
    const noVncRoot = path.resolve(options.noVncRoot || '/usr/share/novnc');
    const mcpPort = Number(options.mcpPort) || 7001;

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const pathname = url.pathname;

            if (['/mcp', '/health', '/getTaskStatus', '/task'].includes(pathname)) {
                proxyAgentServer(req, res, mcpPort);
                return;
            }
            if (pathname === '/status' && req.method === 'GET') {
                sendJson(res, 200, { ok: true, service: 'RoboTeamAgent', desktopRuntime: desktopManager.commands });
                return;
            }

            const actor = requestActor(req, internalToken);
            if (!actor) {
                sendError(res, 401, 'authenticated Ploinky user is required');
                return;
            }

            if (pathname === '/' && req.method === 'GET') {
                await serveFile(res, publicDir, 'index.html');
                return;
            }
            if (pathname === '/desktop.html' && req.method === 'GET') {
                const profileId = url.searchParams.get('profile') || '';
                const profile = await profileStore.getOwned(profileId, actor.id);
                if (!profile) {
                    sendError(res, 404, 'profile not found');
                    return;
                }
                await serveFile(res, publicDir, 'desktop.html');
                return;
            }
            if (pathname === '/config.js' && req.method === 'GET') {
                const body = `globalThis.ROBOTEAM_CONFIG=${JSON.stringify({ publicBasePath, routeKey })};\n`;
                res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
                res.end(body);
                return;
            }
            if (pathname === '/styles.css' && req.method === 'GET') {
                await serveFile(res, publicDir, 'styles.css');
                return;
            }
            if (pathname === '/app.js' && req.method === 'GET') {
                await serveFile(res, publicDir, 'app.js');
                return;
            }
            if (pathname === '/desktop.js' && req.method === 'GET') {
                await serveFile(res, publicDir, 'desktop.js');
                return;
            }
            if (pathname.startsWith('/vendor/novnc/') && req.method === 'GET') {
                await serveFile(res, noVncRoot, pathname.slice('/vendor/novnc/'.length), { cache: true });
                return;
            }

            if (pathname === '/api/profiles' && req.method === 'GET') {
                const profiles = await profileStore.list(actor.id);
                sendJson(res, 200, {
                    ok: true,
                    profiles: profiles.map((profile) => publicProfile(profile, desktopManager.status(profile.id), publicBasePath)),
                });
                return;
            }
            if (pathname === '/api/profiles' && req.method === 'POST') {
                const body = await readJsonBody(req);
                const profile = await profileStore.create({
                    ownerUserId: actor.id,
                    name: body.name,
                    specialization: body.specialization,
                });
                sendJson(res, 201, { ok: true, profile: publicProfile(profile, desktopManager.status(profile.id), publicBasePath) });
                return;
            }

            const statusProfileId = matchProfilePath(pathname, '/desktop');
            if (statusProfileId && req.method === 'GET') {
                const profile = await profileStore.getOwned(statusProfileId, actor.id);
                if (!profile) return sendError(res, 404, 'profile not found');
                sendJson(res, 200, { ok: true, profile: publicProfile(profile, desktopManager.status(profile.id), publicBasePath) });
                return;
            }
            const startProfileId = matchProfilePath(pathname, '/desktop/start');
            if (startProfileId && req.method === 'POST') {
                const profile = await profileStore.getOwned(startProfileId, actor.id);
                if (!profile) return sendError(res, 404, 'profile not found');
                const desktop = await desktopManager.start(profile);
                sendJson(res, 200, { ok: true, profile: publicProfile(profile, desktop, publicBasePath) });
                return;
            }
            const stopProfileId = matchProfilePath(pathname, '/desktop/stop');
            if (stopProfileId && req.method === 'POST') {
                const profile = await profileStore.getOwned(stopProfileId, actor.id);
                if (!profile) return sendError(res, 404, 'profile not found');
                const desktop = await desktopManager.stop(profile.id);
                sendJson(res, 200, { ok: true, profile: publicProfile(profile, desktop, publicBasePath) });
                return;
            }

            sendError(res, 404, 'not found');
        } catch (error) {
            const isBadRequest = error instanceof SyntaxError || /required|invalid|at most|too large/.test(String(error?.message));
            sendError(res, isBadRequest ? 400 : 500, isBadRequest ? error.message : 'request failed');
        }
    });

    server.on('upgrade', async (req, socket, head) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const profileId = matchProfilePath(url.pathname, '/desktop/ws');
            if (!profileId) return websocketFailure(socket, 404, 'Not Found');
            const actor = requestActor(req, internalToken);
            if (!actor) return websocketFailure(socket, 401, 'Unauthorized');
            const profile = await profileStore.getOwned(profileId, actor.id);
            if (!profile) return websocketFailure(socket, 404, 'Not Found');
            const upstreamPort = desktopManager.activeWebsockifyPort(profile.id);
            if (!upstreamPort) return websocketFailure(socket, 409, 'Conflict');
            proxyWebSocket(req, socket, head, upstreamPort);
        } catch {
            websocketFailure(socket, 500, 'Internal Server Error');
        }
    });

    return server;
}

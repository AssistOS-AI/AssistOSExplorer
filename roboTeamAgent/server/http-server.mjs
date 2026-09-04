import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdminActor, requestActor } from './request-identity.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(MODULE_DIR, '..', 'public');
const BODY_LIMIT = 64 * 1024;
const ROBOT_ID = '[a-z0-9][a-z0-9-]{2,63}';

const CONTENT_TYPES = Object.freeze({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
});

function normalizeBasePath(value) {
    const raw = String(value || '/').trim();
    const leading = raw.startsWith('/') ? raw : `/${raw}`;
    return leading.endsWith('/') ? leading : `${leading}/`;
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object body is required');
    return parsed;
}

async function serveFile(res, root, relativePath) {
    const rootPath = path.resolve(root);
    const candidate = path.resolve(rootPath, relativePath);
    if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${path.sep}`)) return sendError(res, 404, 'not found');
    let stats;
    try {
        stats = await fsp.stat(candidate);
    } catch {
        return sendError(res, 404, 'not found');
    }
    if (!stats.isFile()) return sendError(res, 404, 'not found');
    res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(candidate)] || 'application/octet-stream',
        'content-length': stats.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(candidate).pipe(res);
}

function proxyAgentServer(req, res, mcpPort) {
    const headers = { ...req.headers, host: `127.0.0.1:${mcpPort}` };
    const upstream = http.request({ host: '127.0.0.1', port: mcpPort, method: req.method, path: req.url, headers }, (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
    });
    upstream.once('error', () => sendError(res, 502, 'MCP runtime is unavailable'));
    req.pipe(upstream);
}

function sessionHeaders(req, port) {
    const headers = { host: `127.0.0.1:${port}` };
    for (const name of ['accept', 'accept-encoding', 'accept-language', 'cache-control', 'content-length', 'content-type', 'cookie', 'origin', 'pragma', 'range', 'user-agent']) {
        if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    headers['x-forwarded-proto'] = 'https';
    return headers;
}

function sessionUpstreamPath(req, publicBasePath) {
    const relative = String(req.url || '/').startsWith('/') ? String(req.url || '/') : `/${req.url}`;
    return `${publicBasePath.slice(0, -1)}${relative}`;
}

function proxySessionHttp(req, res, port, publicBasePath) {
    const upstream = http.request({
        host: '127.0.0.1',
        port,
        method: req.method,
        path: sessionUpstreamPath(req, publicBasePath),
        headers: sessionHeaders(req, port),
    }, (response) => {
        const headers = { ...response.headers, 'cache-control': 'no-store' };
        res.writeHead(response.statusCode || 502, headers);
        response.pipe(res);
    });
    upstream.once('error', () => sendError(res, 502, 'robot session is unavailable'));
    req.pipe(upstream);
}

function websocketFailure(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

function proxySessionWebSocket(req, socket, head, port, publicBasePath) {
    const upstream = net.connect({ host: '127.0.0.1', port });
    upstream.once('connect', () => {
        const headers = [`GET ${sessionUpstreamPath(req, publicBasePath)} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
        for (const name of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'origin', 'user-agent', 'cookie']) {
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

function publicRobot(robot, run) {
    return {
        id: robot.id,
        name: robot.name,
        specialization: robot.specialization,
        createdAt: robot.createdAt,
        updatedAt: robot.updatedAt,
        run,
    };
}

function matchRobotPath(pathname, suffix) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return pathname.match(new RegExp(`^/api/robots/(${ROBOT_ID})${escaped}$`))?.[1] || null;
}

function sessionRobotId(pathname) {
    return pathname.match(new RegExp(`^/api/robots/(${ROBOT_ID})/session(?:/|$)`))?.[1] || null;
}

export function createRoboTeamServer(options) {
    const robotStore = options.robotStore;
    const runtimeManager = options.runtimeManager;
    const internalToken = String(options.internalToken || '');
    const publicBasePath = normalizeBasePath(options.publicBasePath);
    const routeKey = String(options.routeKey || 'roboTeamAgent');
    const publicDir = path.resolve(options.publicDir || DEFAULT_PUBLIC_DIR);
    const mcpPort = Number(options.mcpPort) || 7000;

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const pathname = url.pathname;
            if (['/mcp', '/health', '/getTaskStatus', '/task'].includes(pathname)) return proxyAgentServer(req, res, mcpPort);
            if (pathname === '/status' && req.method === 'GET') {
                return sendJson(res, 200, { ok: true, service: 'RoboTeamAgent', modes: ['browser', 'desktop'] });
            }
            const actor = requestActor(req, internalToken);
            if (!actor) return sendError(res, 401, 'authenticated Ploinky user is required');

            const sessionId = sessionRobotId(pathname);
            if (sessionId && req.method === 'GET') {
                const robot = await robotStore.get(sessionId);
                if (!robot) return sendError(res, 404, 'robot not found');
                const port = runtimeManager.activePort(robot.id);
                if (!port) return sendError(res, 409, 'robot is not running');
                return proxySessionHttp(req, res, port, publicBasePath);
            }
            if (pathname === '/' && req.method === 'GET') return serveFile(res, publicDir, 'index.html');
            if (pathname === '/config.js' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
                res.end(`globalThis.ROBOTEAM_CONFIG=${JSON.stringify({ publicBasePath, routeKey })};\n`);
                return;
            }
            if (pathname === '/styles.css' && req.method === 'GET') return serveFile(res, publicDir, 'styles.css');
            if (pathname === '/app.js' && req.method === 'GET') return serveFile(res, publicDir, 'app.js');

            if (pathname === '/api/robots' && req.method === 'GET') {
                const robots = await robotStore.list();
                return sendJson(res, 200, { ok: true, robots: robots.map((robot) => publicRobot(robot, runtimeManager.status(robot.id))) });
            }
            if (pathname === '/api/robots' && req.method === 'POST') {
                if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                const body = await readJsonBody(req);
                const robot = await robotStore.create({ name: body.name, specialization: body.specialization });
                return sendJson(res, 201, { ok: true, robot: publicRobot(robot, runtimeManager.status(robot.id)) });
            }
            if (pathname === '/api/control' && req.method === 'POST') {
                const body = await readJsonBody(req);
                const robot = await robotStore.getByName(body.robotName);
                if (!robot) return sendError(res, 404, 'robot not found');
                const operation = String(body.operation || '');
                if (operation === 'robot-delete') {
                    if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                    const status = runtimeManager.status(robot.id);
                    if (status.state !== 'stopped' || runtimeManager.hasUnfinishedTasks?.(robot.id)
                        || ['queued', 'starting', 'running', 'stopping'].includes(status.task?.state)) {
                        return sendError(res, 409, 'stop the robot before deleting it');
                    }
                    await robotStore.delete(robot.id);
                    return sendJson(res, 200, { ok: true, deleted: robot.name });
                }
                if (operation === 'open-desktop') {
                    return sendJson(res, 202, { ok: true, robotName: robot.name, run: await runtimeManager.openDesktop(robot, body.cwd) });
                }
                const startTypes = { 'start-desktop-task': 'desktop', 'start-browser-task': 'browser', 'start-simple-task': 'simple' };
                if (startTypes[operation]) {
                    const task = runtimeManager.startTask(robot, startTypes[operation], {
                        cwd: body.cwd, task: String(body.task || ''), skillSets: body.skillSets || null,
                        model: body.model || null, ca: body.ca || 'codex',
                    });
                    return sendJson(res, 202, { ok: true, robotName: robot.name, ...task });
                }
                const stopTypes = { 'stop-desktop-task': 'desktop', 'stop-browser-task': 'browser', 'stop-simple-task': 'simple' };
                if (stopTypes[operation]) return sendJson(res, 202, { ok: true, robotName: robot.name, ...runtimeManager.stopTask(robot, stopTypes[operation], body.taskId) });
                if (operation === 'take-control') return sendJson(res, 202, { ok: true, robotName: robot.name, ...runtimeManager.stopTask(robot) });
                if (operation === 'resume-task') return sendJson(res, 202, { ok: true, robotName: robot.name, ...runtimeManager.resumeTask(robot) });
                if (operation === 'task-status') return sendJson(res, 200, { ok: true, robotName: robot.name, task: runtimeManager.taskStatus(robot.id, body.taskId) });
                if (operation === 'desktop-url' || operation === 'browser-url') {
                    const mode = operation.startsWith('desktop') ? 'desktop' : 'browser';
                    return sendJson(res, 200, { ok: true, robotName: robot.name, sessionUrl: runtimeManager.sessionUrl(robot.id, mode) });
                }
                if (operation === 'stop-desktop-container' || operation === 'stop-browser-container') {
                    const mode = operation.includes('desktop') ? 'desktop' : 'browser';
                    return sendJson(res, 200, { ok: true, robotName: robot.name, run: await runtimeManager.stopContainer(robot.id, mode) });
                }
                return sendError(res, 400, 'unsupported RoboTeam control operation');
            }
            const runId = matchRobotPath(pathname, '/run');
            if (runId && req.method === 'GET') {
                const robot = await robotStore.get(runId);
                if (!robot) return sendError(res, 404, 'robot not found');
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, runtimeManager.status(robot.id)) });
            }
            if (runId && req.method === 'POST') {
                const robot = await robotStore.get(runId);
                if (!robot) return sendError(res, 404, 'robot not found');
                const body = await readJsonBody(req);
                const run = await runtimeManager.start(robot, body.mode);
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, run) });
            }
            if (runId && req.method === 'DELETE') {
                const robot = await robotStore.get(runId);
                if (!robot) return sendError(res, 404, 'robot not found');
                const run = await runtimeManager.stop(robot.id);
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, run) });
            }
            const logsId = matchRobotPath(pathname, '/logs');
            if (logsId && req.method === 'GET') {
                const robot = await robotStore.get(logsId);
                if (!robot) return sendError(res, 404, 'robot not found');
                return sendJson(res, 200, { ok: true, logs: await runtimeManager.logs(robot.id, url.searchParams.get('tail')) });
            }
            sendError(res, 404, 'not found');
        } catch (error) {
            const message = String(error?.message || '');
            const badRequest = error instanceof SyntaxError || /required|invalid|at most|too large|must be browser or desktop/.test(message);
            const conflict = /already running|active robot limit|occupied|active task|different cwd|stop the|interrupted GUI/.test(message);
            sendError(res, badRequest ? 400 : conflict ? 409 : 500, badRequest || conflict ? message : 'request failed');
        }
    });

    server.on('upgrade', async (req, socket, head) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const robotId = sessionRobotId(url.pathname);
            if (!robotId) return websocketFailure(socket, 404, 'Not Found');
            const actor = requestActor(req, internalToken);
            if (!actor) return websocketFailure(socket, 401, 'Unauthorized');
            const robot = await robotStore.get(robotId);
            if (!robot) return websocketFailure(socket, 404, 'Not Found');
            const port = runtimeManager.activePort(robot.id);
            if (!port) return websocketFailure(socket, 409, 'Conflict');
            proxySessionWebSocket(req, socket, head, port, publicBasePath);
        } catch {
            websocketFailure(socket, 500, 'Internal Server Error');
        }
    });
    return server;
}

export const httpServerInternals = { normalizeBasePath, sessionUpstreamPath, matchRobotPath, sessionRobotId };

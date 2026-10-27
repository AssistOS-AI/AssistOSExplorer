import { RobotModels } from './robot-models.mjs';
import { conversationSummaries, workflowSummaries } from './impact-summaries.mjs';
import { requiredHumanReportSkill } from './required-skills.mjs';
import { streamFlowEvents } from './roboflow/flow-events.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdminActor, requestActor } from './request-identity.mjs';
import { ROBOFLOW_ENTITLEMENT_ERROR, ROBOTEAM_ENTITLEMENT_ERROR, authorizeRobotListing, authorizeWorkspaceRequest, liveSessionsAccess } from './listing-access.mjs';
import { projectRobotView } from './robot-projection.mjs';
import { importEmailRobots } from './robot-import.mjs';
import { createCodingAgentStatus } from './coding-agent-status.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/execution/alaInstallation.mjs';
import { RobotSkillsets, publicSkillsets, publicRepositories, individualSkillRepositories } from './robot-skillsets.mjs';
import { listTerminalProfiles, resolveTerminalProfile, robotTerminalDirectory, terminalProfileAccess } from './robot-terminal.mjs';
import { prepareRobotShell } from './robot-shell.mjs';
import { robotCodingAgents } from './coding-agents.mjs';
import { findProjectRecord, projectForSessionRecord } from './project-storage.mjs';
import { matchConversationSkillsPath, readConversationSkills, setConversationSkill } from './conversation-skills-api.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';
import { renderAlaTurnLog } from '../copilot/src/lib/webchat/webchatTurnLog.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(MODULE_DIR, '..', 'public');
const BODY_LIMIT = 64 * 1024;
// A Live Sessions message carries up to 32768 characters; as JSON a control
// character escapes to six bytes, so its route accepts a larger body.
const LIVE_MESSAGE_BODY_LIMIT = 256 * 1024;
const RAW_BODY = Symbol('roboteam.rawBody');
const ACCESS = Symbol('roboteam.access');
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

// The request stream is consumed once. The exact bytes are kept on the request
// so the signature check, the JSON parser and the session proxy all see them.
async function readRawBody(req, limit = BODY_LIMIT) {
    if (Buffer.isBuffer(req[RAW_BODY])) return req[RAW_BODY];
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('request body is too large');
        chunks.push(chunk);
    }
    req[RAW_BODY] = Buffer.concat(chunks);
    return req[RAW_BODY];
}

async function readJsonBody(req) {
    const raw = (await readRawBody(req)).toString('utf8');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object body is required');
    return parsed;
}

// Static assets are revalidated on every request (no-cache + validators), never
// served from a freshness window. Callers invoke this only after authorization.
function notModified(req, etag, mtime) {
    const header = req.headers['if-none-match'];
    if (header !== undefined) {
        const strip = (tag) => tag.trim().replace(/^W\//, '');
        return String(header).split(',').some((tag) => tag.trim() === '*' || strip(tag) === strip(etag));
    }
    const since = Date.parse(req.headers['if-modified-since'] || '');
    return Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) * 1000 <= since;
}

async function serveFile(req, res, root, relativePath) {
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
    const etag = `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}-${stats.ino.toString(16)}"`;
    const headers = {
        'cache-control': 'private, no-cache',
        etag,
        'last-modified': stats.mtime.toUTCString(),
        'x-content-type-options': 'nosniff',
    };
    if (notModified(req, etag, stats.mtime)) {
        res.writeHead(304, headers);
        return res.end();
    }
    res.writeHead(200, {
        ...headers,
        'content-type': CONTENT_TYPES[path.extname(candidate)] || 'application/octet-stream',
        'content-length': stats.size,
    });
    fs.createReadStream(candidate).pipe(res);
}

// A main-conversation "View Thinking" log is the coding-agent output ALA
// recorded for the turn. The session id locates the opened folder through the
// project registry; the assistant message id selects the turn.
function readWebchatTurnLog(robotStore, workspaceRoot, sessionId, messageId) {
    let sessionFile;
    try { sessionFile = findProjectRecord({ dataDir: robotStore.dataDir, workspaceRoot }, 'session', sessionId); }
    catch { return null; }
    if (!sessionFile) return null;
    const workingDir = projectForSessionRecord(sessionFile);
    const found = lookupRecordedTurn(workingDir, sessionId, messageId);
    if (!found) return null;
    const { turn, ala } = found;
    if (!ala) return null;
    return renderRecordedTurn(() => ({ log: renderAlaTurnLog(ala), finalResponse: turn.status === 'completed' ? ala.final || '' : '' }));
}

// A missing record is an ordinary "not found". A record that exists but cannot
// be read or rendered is a defect: it is reported once per error class and
// code, without transcript content, paths or ids, and the caller still
// answers "not found".
const reportedTurnFailures = new Set();
const MISSING_TURN_ERRORS = new Set(['invalid_session_id', 'assistant_message_not_found']);

function errorKind(error) {
    return `${error?.name || 'Error'}${error?.code !== undefined && error?.code !== null ? `:${String(error.code).slice(0, 64)}` : ''}`;
}

function reportTurnFailure(action, error) {
    const kind = errorKind(error);
    if (reportedTurnFailures.has(`${action}|${kind}`)) return;
    reportedTurnFailures.add(`${action}|${kind}`);
    console.error(`[roboTeamAgent] a recorded turn could not be ${action} (${kind})`);
}

function lookupRecordedTurn(workingDir, sessionId, messageId) {
    try { return new ConversationSessionStore({ workingDir }).turnForMessage(sessionId, messageId); }
    catch (error) {
        if (error?.code !== 'ENOENT' && !MISSING_TURN_ERRORS.has(error?.message)) reportTurnFailure('read', error);
        return null;
    }
}

function renderRecordedTurn(render) {
    try { return render(); }
    catch (error) {
        reportTurnFailure('rendered', error);
        return null;
    }
}

// HTML pages live under route paths such as /flow-types/new, so their relative
// asset URLs need an explicit base. It is injected in the markup (not by script)
// so the browser's preload scanner resolves the assets correctly on first fetch.
async function servePage(res, root, relativePath, basePath) {
    const rootPath = path.resolve(root);
    const candidate = path.resolve(rootPath, relativePath);
    if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${path.sep}`)) return sendError(res, 404, 'not found');
    let html;
    try { html = await fsp.readFile(candidate, 'utf8'); } catch { return sendError(res, 404, 'not found'); }
    const href = String(basePath || './').replace(/"/g, '&quot;');
    const injected = /<base[\s>]/i.test(html) ? html : html.replace(/<head(\s[^>]*)?>/i, match => `${match}\n  <base href="${href}">`);
    const payload = Buffer.from(injected);
    res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': payload.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(payload);
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
    // The gate already consumed the stream; send the bytes it verified.
    if (Buffer.isBuffer(req[RAW_BODY])) upstream.end(req[RAW_BODY]);
    else req.pipe(upstream);
}

function websocketFailure(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

const DENIAL_REASONS = Object.freeze({ 401: 'Unauthorized', 403: 'Forbidden', 503: 'Service Unavailable' });

// Gate refusal for an upgrade: a JSON body like the HTTP refusals. Only the
// status and the path are logged, never headers or the query string. The
// socket is destroyed once the response has flushed, so a peer that never
// closes its side cannot keep the connection open; the timer is a safety net.
function websocketDenial(socket, status, error, pathname) {
    console.warn(`[roboTeamAgent] WebSocket upgrade ${pathname} rejected (${status})`);
    socket.on('error', () => {});
    const payload = Buffer.from(JSON.stringify({ ok: false, error }));
    socket.write(`HTTP/1.1 ${status} ${DENIAL_REASONS[status] || 'Forbidden'}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${payload.length}\r\n\r\n`);
    const safety = setTimeout(() => socket.destroy(), 2000);
    safety.unref();
    socket.once('close', () => clearTimeout(safety));
    socket.end(payload, () => socket.destroy());
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

// view: { privileged, workspaceRoot }. Without proven verified-admin context
// every caller receives the restricted projection.
function publicRobot(robot, run, view = {}) {
    return projectRobotView({
        id: robot.id,
        name: robot.name,
        codingAgents: robotCodingAgents(robot),
        skillsets: publicSkillsets(robot),
        skillRepositories: individualSkillRepositories(robot),
        repositories: publicRepositories(robot),
        createdAt: robot.createdAt,
        updatedAt: robot.updatedAt,
        run,
    }, view);
}

function matchRobotPath(pathname, suffix) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return pathname.match(new RegExp(`^/api/robots/(${ROBOT_ID})${escaped}$`))?.[1] || null;
}

function sessionRobotId(pathname) {
    return pathname.match(new RegExp(`^/api/robots/(${ROBOT_ID})/session(?:/|$)`))?.[1] || null;
}

// Live Sessions owner of work started by this request: the signed principal
// of a verified direct user. Internal-token callers start system work.
function signedOwner(req) {
    const access = req[ACCESS];
    return access?.internal === false && typeof access.principal === 'string' ? access.principal : null;
}

function isLiveSessionsPath(pathname) {
    return pathname === '/api/live-sessions' || pathname.startsWith('/api/live-sessions/') || pathname.startsWith('/live-sessions/');
}

// Readers for Live Session transcripts. They take only server-bound metadata
// captured when the run was admitted, never a caller-supplied path.
function turnTranscriptText({ turn, ala }) {
    if (!ala) return null;
    const log = renderAlaTurnLog(ala);
    const finalResponse = turn.status === 'completed' ? ala.final || '' : '';
    if (!finalResponse || log.includes(finalResponse)) return log;
    return log ? `${log}\n\n${finalResponse}` : finalResponse;
}

export function readTaskTurnTranscript({ cwd, sessionId, assistantMessageId }) {
    const found = lookupRecordedTurn(cwd, sessionId, assistantMessageId);
    return found ? renderRecordedTurn(() => turnTranscriptText(found)) : null;
}

export function webchatTranscriptReader(robotStore, workspaceRoot) {
    return (sessionId, messageId) => {
        let sessionFile;
        try { sessionFile = findProjectRecord({ dataDir: robotStore.dataDir, workspaceRoot }, 'session', sessionId); }
        catch { return null; }
        if (!sessionFile) return null;
        return readTaskTurnTranscript({ cwd: projectForSessionRecord(sessionFile), sessionId, assistantMessageId: messageId });
    };
}

const LIVE_ACTION = /^\/api\/live-sessions\/([A-Za-z0-9_-]{1,128})\/(stream|messages|stop|transcript)$/u;
const LIVE_VIEW = /^\/live-sessions\/([A-Za-z0-9_-]{1,128})$/u;
const LIVE_MESSAGES_PATH = /^\/api\/live-sessions\/[A-Za-z0-9_-]{1,128}\/messages$/u;
const LIVE_STREAM_LIFETIME_MS = 25 * 60 * 1000;

function sendTranscript(res, status, text) {
    const payload = Buffer.from(String(text ?? ''));
    res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': payload.length,
        'cache-control': 'no-store',
        'content-disposition': 'inline',
        'x-content-type-options': 'nosniff',
    });
    res.end(payload);
}

// The text-only view page. Its one inline script is allowed by hash; the page
// cannot be framed and loads nothing else.
async function serveLiveSessionPage(res, publicDir, publicBasePath) {
    let html;
    try { html = await fsp.readFile(path.join(publicDir, 'live-session.html'), 'utf8'); } catch { return sendError(res, 404, 'not found'); }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]);
    const hashes = scripts.map((script) => `'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`).join(' ');
    const href = String(publicBasePath || './').replace(/"/g, '&quot;');
    const payload = Buffer.from(html.replace(/<head(\s[^>]*)?>/iu, (match) => `${match}\n  <base href="${href}">`));
    res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': payload.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(payload);
}

// Every Live Sessions route. Authority is only the viewer's signed principal
// and signed administrator decision; forwarded identity is never consulted.
async function handleLiveSessions({ req, res, pathname, viewer, registry, publicDir, publicBasePath, streamLifetimeMs }) {
    if (pathname === '/api/live-sessions' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, version: 1, sessions: registry.list(viewer) });
    }
    const view = pathname.match(LIVE_VIEW);
    if (view && req.method === 'GET') {
        if (!registry.authorize(view[1], viewer).ok) return sendError(res, 404, 'live session not found');
        return serveLiveSessionPage(res, publicDir, publicBasePath);
    }
    const action = pathname.match(LIVE_ACTION);
    if (!action) return sendError(res, 404, 'not found');
    const [, id, name] = action;
    if (name === 'stream' && req.method === 'GET') {
        const attached = registry.attach(id, viewer, res, req.headers['last-event-id']);
        if (!attached.ok) return sendError(res, attached.status, attached.error);
        // The administrator decision is a snapshot of this request. Each stream
        // ends within one admission lifetime, below the relay's 30-minute cut,
        // so the client's reconnect is authorized again.
        const timer = setTimeout(() => res.end(), streamLifetimeMs);
        timer.unref?.();
        res.once('close', () => clearTimeout(timer));
        return;
    }
    if (name === 'transcript' && req.method === 'GET') {
        let result;
        try { result = await registry.transcript(id, viewer); }
        catch (error) {
            console.error(`[live-sessions] a transcript could not be read (${errorKind(error)})`);
            return sendTranscript(res, 500, 'The transcript is unavailable.');
        }
        if (!result.ok) return sendTranscript(res, 404, 'Live session not found.');
        if (result.text === null) return sendTranscript(res, 404, 'The transcript is not available yet.');
        return sendTranscript(res, 200, result.text);
    }
    if (name === 'messages' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (Object.keys(body).length !== 1 || typeof body.message !== 'string' || !body.message.trim()) {
            return sendError(res, 400, 'message must contain 1 to 32768 characters');
        }
        const result = await registry.message(id, viewer, body.message);
        if (!result.ok) return sendError(res, result.status, result.error);
        if (result.outcome === 'delivered' || result.outcome === 'queued') return sendJson(res, 200, { delivery: result.outcome });
        if (result.outcome === 'rejected') return sendJson(res, 409, { error: 'rejected', ...(result.detail ? { detail: result.detail } : {}) });
        if (result.outcome === 'run_ended') return sendJson(res, 409, { error: 'run_ended' });
        return sendJson(res, 504, { error: 'delivery_unknown' });
    }
    if (name === 'stop' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (Object.keys(body).length !== 0) return sendError(res, 400, 'stop takes an empty JSON object');
        const result = await registry.stop(id, viewer);
        if (!result.ok) return sendError(res, result.status, result.error);
        return sendJson(res, 200, { ok: true });
    }
    return sendError(res, 404, 'not found');
}

const FLOW_PATH = '/api/roboflow/flows/(flow_[0-9a-f]{24})';
const WORKFLOW_PATH = '/api/roboflow/workflows/([a-z0-9][a-z0-9-]{2,63})';
const GENERATION_PATH = /^\/api\/roboflow\/generations\/([0-9a-f-]{36})$/;

function sendText(res, status, body) {
    const payload = Buffer.from(String(body ?? ''));
    res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': payload.length,
        'cache-control': 'no-store',
    });
    res.end(payload);
}

async function handleRoboFlow({ req, res, url, pathname, actor, roboflow, publicDir, publicBasePath }) {
    if (!pathname.startsWith('/api/roboflow') && !['/flows', '/flow-types', '/flow-types/new', '/flow-types/generate-new'].includes(pathname)) {
        return false;
    }
    if (pathname === '/flows' && req.method === 'GET') {
        await servePage(res, publicDir, url.searchParams.get('flowId') ? 'roboflow.html' : 'flows.html', publicBasePath);
        return true;
    }
    if (pathname === '/flow-types/generate-new' && req.method === 'GET') {
        await servePage(res, publicDir, 'generate.html', publicBasePath);
        return true;
    }
    if ((pathname === '/flow-types' || pathname === '/flow-types/new') && req.method === 'GET') {
        await servePage(res, publicDir, 'editor.html', publicBasePath);
        return true;
    }

    if (pathname === '/api/roboflow/creator-skill' && req.method === 'GET') {
        const content = await fs.promises.readFile(new URL('../copilot/src/skills/workflow-creator/SKILL.md', import.meta.url), 'utf8');
        sendJson(res, 200, { name: 'workflow-creator', content, readOnly: true }); return true;
    }
    if (pathname === '/api/roboflow/skillsets' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...await roboflow.catalog() }); return true;
    }
    if (pathname === '/api/roboflow/validate' && req.method === 'POST') {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        sendJson(res, 200, { ok: true, ...await roboflow.validateDraft(await readJsonBody(req)) }); return true;
    }
    if (pathname === '/api/roboflow/generate' && req.method === 'POST') {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        const result = await roboflow.generateWorkflow(await readJsonBody(req), { signal: controller.signal });
        sendJson(res, 200, { ok: true, ...result }); return true;
    }
    if (pathname === '/api/roboflow/generations' && req.method === 'POST') {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        sendJson(res, 202, { ok: true, ...await roboflow.startGeneration(await readJsonBody(req)) }); return true;
    }
    const generationId = pathname.match(GENERATION_PATH)?.[1];
    if (generationId && req.method === 'GET') {
        const generation = roboflow.generationInfo(generationId);
        if (!generation) { sendError(res, 404, 'generation not found'); return true; }
        sendJson(res, 200, { ok: true, ...generation }); return true;
    }
    if (generationId && req.method === 'DELETE') {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        const generation = roboflow.cancelGeneration(generationId);
        if (!generation) { sendError(res, 404, 'generation not found'); return true; }
        sendJson(res, 200, { ok: true, ...generation }); return true;
    }
    if (pathname === '/api/roboflow/schedule-folders' && ['GET', 'POST'].includes(req.method)) {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        const result = req.method === 'GET' ? await roboflow.scheduleFolders.list(url.searchParams.get('path') || '')
            : await roboflow.scheduleFolders.create(await readJsonBody(req));
        sendJson(res, req.method === 'GET' ? 200 : 201, { ok: true, ...result }); return true;
    }
    if (pathname === '/api/roboflow/schedules' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, schedules: await roboflow.listSchedules() }); return true;
    }
    if (pathname === '/api/roboflow/schedules' && req.method === 'POST') {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        sendJson(res, 201, { ok: true, schedule: await roboflow.saveSchedule(await readJsonBody(req), actor.id, undefined, { ownerPrincipal: signedOwner(req) }) }); return true;
    }
    const runScheduleId = pathname.match(/^\/api\/roboflow\/schedules\/(cron_[0-9a-f]{24})\/run-now$/)?.[1];
    if (runScheduleId && req.method === 'POST') {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        const input = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...await roboflow.runScheduleNow(runScheduleId, input?.revision, actor.id, { ownerPrincipal: signedOwner(req) }) }); return true;
    }
    const scheduleId = pathname.match(/^\/api\/roboflow\/schedules\/(cron_[0-9a-f]{24})$/)?.[1];
    if (scheduleId && ['PUT', 'DELETE'].includes(req.method)) {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        if (req.method === 'PUT') sendJson(res, 200, { ok: true, schedule: await roboflow.saveSchedule(await readJsonBody(req), actor.id, scheduleId, { ownerPrincipal: signedOwner(req) }) });
        else {
            const deleted = await roboflow.deleteSchedule(scheduleId);
            if (!deleted) sendError(res, 404, 'Cron job not found');
            else sendJson(res, 200, { ok: true, deleted });
        }
        return true;
    }
    if (pathname === '/api/roboflow/workflows' && req.method === 'GET') {
        const workflows = await roboflow.listWorkflows();
        sendJson(res, 200, { ok: true, workflows, workflowFileErrors: roboflow.workflowFileErrors() });
        return true;
    }
    if (pathname === '/api/roboflow/workflows' && req.method === 'POST') {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        sendJson(res, 201, { ok: true, workflow: await roboflow.createWorkflow(await readJsonBody(req)) });
        return true;
    }
    const workflowId = pathname.match(new RegExp(`^${WORKFLOW_PATH}$`))?.[1];
    if (workflowId && req.method === 'PUT') {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        sendJson(res, 200, { ok: true, workflow: await roboflow.updateWorkflow(workflowId, await readJsonBody(req)) });
        return true;
    }
    if (workflowId && req.method === 'DELETE') {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        sendJson(res, 200, { ok: true, deleted: await roboflow.deleteWorkflow(workflowId) });
        return true;
    }
    if (pathname === '/api/roboflow/flows' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, flows: await roboflow.listFlows({ folder: url.searchParams.get('folder') || undefined }) });
        return true;
    }
    if (pathname === '/api/roboflow/flows' && req.method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 201, { ok: true, flow: await roboflow.startFlow({ ...body, createdBy: actor.id, ownerPrincipal: signedOwner(req) }) });
        return true;
    }
    const eventsId = pathname.match(new RegExp(`^${FLOW_PATH}/events$`))?.[1];
    if (eventsId && req.method === 'GET') {
        await streamFlowEvents({ req, res, roboflow, flowId: eventsId, instanceId: url.searchParams.get('instanceId') || null });
        return true;
    }
    const flowId = pathname.match(new RegExp(`^${FLOW_PATH}$`))?.[1];
    if (flowId && req.method === 'GET') {
        const requested = String(url.searchParams.get('logs') || 'tail');
        const logMode = requested === 'full' ? 'full' : requested === 'none' ? 'none' : 'tail';
        sendJson(res, 200, { ok: true, flow: await roboflow.getFlow(flowId, { logMode }) });
        return true;
    }
    const answerId = pathname.match(new RegExp(`^${FLOW_PATH}/human-input/answer$`))?.[1];
    if (answerId && req.method === 'POST') {
        sendJson(res, 200, { ok: true, flow: await roboflow.answerHumanInput(answerId, await readJsonBody(req), actor.id) });
        return true;
    }
    const pauseId = pathname.match(new RegExp(`^${FLOW_PATH}/pause$`))?.[1];
    if (pauseId && req.method === 'POST') {
        sendJson(res, 200, { ok: true, flow: await roboflow.pauseFlow(pauseId) });
        return true;
    }
    const terminateId = pathname.match(new RegExp(`^${FLOW_PATH}/terminate$`))?.[1];
    if (terminateId && req.method === 'POST') {
        sendJson(res, 200, { ok: true, flow: await roboflow.terminateFlow(terminateId) });
        return true;
    }
    const resumeId = pathname.match(new RegExp(`^${FLOW_PATH}/resume$`))?.[1];
    if (resumeId && req.method === 'POST') {
        sendJson(res, 200, { ok: true, flow: await roboflow.resumeFlow(resumeId) });
        return true;
    }
    const instancePause = pathname.match(new RegExp(`^${FLOW_PATH}/instances/(inv_[0-9a-f]{24})/pause$`));
    if (instancePause && req.method === 'POST') {
        sendJson(res, 200, { ok: true, flow: await roboflow.pauseInstance(instancePause[1], instancePause[2]) });
        return true;
    }
    const instanceMessage = pathname.match(new RegExp(`^${FLOW_PATH}/instances/(inv_[0-9a-f]{24})/message$`));
    if (instanceMessage && req.method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...await roboflow.messageInstance(instanceMessage[1], instanceMessage[2], body.prompt) });
        return true;
    }
    const instanceResume = pathname.match(new RegExp(`^${FLOW_PATH}/instances/(inv_[0-9a-f]{24})/resume$`));
    if (instanceResume && req.method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, flow: await roboflow.resumeInstance(instanceResume[1], instanceResume[2], body.prompt) });
        return true;
    }
    const logMatch = pathname.match(new RegExp(`^${FLOW_PATH}/logs/(inv_[0-9a-f]{24}|step-\\d{1,6})$`))
        || pathname.match(new RegExp(`^${FLOW_PATH}/invocations/(inv_[0-9a-f]{24}|step-\\d{1,6})/log$`));
    if (logMatch && req.method === 'GET') {
        const log = await roboflow.getInvocationLog(logMatch[1], logMatch[2]);
        sendText(res, 200, log);
        return true;
    }
    return false;
}

// The proxy each robot holds in the shared pool, which proxyAgent administers. Administrator-only:
// the records name the outer infrastructure. Responses never carry credentials. Listing also
// releases leases of robots deleted while proxyAgent was unreachable. useProxy is the global switch;
// while it is off, workstations start with a direct connection and keep their leases.
async function handleRobotProxies({ req, res, pathname, actor, proxyPool, robotStore, runtimeManager }) {
    const releaseId = pathname.match(new RegExp(`^/api/robots/(${ROBOT_ID})/proxy$`))?.[1];
    if (pathname !== '/api/robot-proxies' && pathname !== '/api/proxy-settings' && !releaseId) return false;
    if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
    const settings = runtimeManager.proxySettings || null;
    if (pathname === '/api/proxy-settings' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (!settings || typeof body.useProxy !== 'boolean') { sendError(res, 400, 'useProxy must be true or false'); return true; }
        sendJson(res, 200, { ok: true, useProxy: await settings.setUseProxy(body.useProxy) }); return true;
    }
    if (pathname === '/api/robot-proxies' && req.method === 'GET') {
        const useProxy = settings ? await settings.useProxy() : true;
        if (!proxyPool) { sendJson(res, 200, { ok: true, available: false, active: false, useProxy, proxies: {} }); return true; }
        const robots = new Set((await robotStore.list()).map(robot => robot.id));
        const listing = await proxyPool.assignments(null);
        const proxies = {};
        for (const assignment of listing.assignments) {
            if (robots.has(assignment.subject)) proxies[assignment.subject] = assignment;
            else void proxyPool.release(assignment.subject);
        }
        sendJson(res, 200, { ok: true, available: listing.available, active: listing.active, useProxy, proxies }); return true;
    }
    if (releaseId && req.method === 'DELETE') {
        if (!proxyPool || !await robotStore.get(releaseId)) { sendError(res, 404, 'robot not found'); return true; }
        if (runtimeManager.status(releaseId).state !== 'stopped') {
            sendError(res, 409, 'stop the robot workstation before releasing its proxy'); return true;
        }
        sendJson(res, 200, { ok: true, released: await proxyPool.release(releaseId) }); return true;
    }
    sendError(res, 404, 'not found');
    return true;
}

// Terminal profiles let the Explorer and the Ploinky router pick a robot for a
// WebTTY shell. All three routes are decided on the access that the family
// gate verified for this very request; the compatibility actor and the
// internal token never grant anything here. Bodies were read, size-limited and
// signature-checked by the gate and are only parsed here.
const TERMINAL_PROFILES_PATH = /^\/api\/terminal-profiles(?:\/|$)/;
const TERMINAL_PROFILE_PREPARE = new RegExp(`^/api/terminal-profiles/(${ROBOT_ID})/prepare$`);

function emptyJsonBody(raw) {
    if (!raw.length) return true;
    const parsed = JSON.parse(raw.toString('utf8'));
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
}

async function handleTerminalProfiles({ req, res, pathname, access, robotStore, runtimeManager }) {
    if (!TERMINAL_PROFILES_PATH.test(pathname)) return false;
    const decision = terminalProfileAccess(access);
    if (!decision.ok) { sendError(res, decision.status, decision.error); return true; }
    const workspaceRoot = runtimeManager.workspaceRoot;
    if (pathname === '/api/terminal-profiles' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, profiles: await listTerminalProfiles(robotStore) });
        return true;
    }
    if (pathname === '/api/terminal-profiles/resolve' && req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readRawBody(req)).toString('utf8')); } catch { body = null; }
        const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
        if (keys.join() !== 'id,version' || body.version !== 1 || typeof body.id !== 'string') {
            sendError(res, 400, 'a version 1 profile id is required');
            return true;
        }
        sendJson(res, 200, await resolveTerminalProfile(robotStore, body.id, workspaceRoot));
        return true;
    }
    const prepareId = pathname.match(TERMINAL_PROFILE_PREPARE)?.[1];
    if (prepareId && req.method === 'POST') {
        if (!emptyJsonBody(await readRawBody(req))) { sendError(res, 400, 'prepare takes an empty JSON object'); return true; }
        const robot = await robotStore.get(prepareId);
        if (!robot) { sendError(res, 404, 'robot not found'); return true; }
        const root = await robotTerminalDirectory(robotStore, prepareId, workspaceRoot);
        const codingAgents = robotCodingAgents(robot);
        const tools = await runtimeManager.toolCache.prepareShellTools();
        await prepareRobotShell(path.join(robotStore.robotPath(prepareId), 'home'), {
            codingAgents, binPath: tools.binPath, cacheRoot: runtimeManager.toolCache.root,
        });
        await runtimeManager.prepareOpenCode?.(prepareId, { prepare: codingAgents.includes('opencode') });
        sendJson(res, 200, { ok: true, id: robot.id, label: robot.name, root });
        return true;
    }
    sendError(res, 404, 'not found');
    return true;
}

export function createRoboTeamServer(options) {
    const robotStore = options.robotStore;
    const runtimeManager = options.runtimeManager;
    const roboflow = options.roboflow || null;
    const proxyPool = options.proxyPool || runtimeManager.proxyPool || null;
    const robotModels = options.robotModels || new RobotModels({ robotStore, runtimeManager });
    const skillsets = options.skillsets || runtimeManager.skillsets || new RobotSkillsets({ robotStore,
        workspaceRoot: runtimeManager.workspaceRoot, alaCommand: runtimeManager.alaCommand });
    runtimeManager.skillsets = skillsets;
    const internalToken = String(options.internalToken || '');
    const publicBasePath = normalizeBasePath(options.publicBasePath);
    const routeKey = String(options.routeKey || 'roboTeamAgent');
    const publicDir = path.resolve(options.publicDir || DEFAULT_PUBLIC_DIR);
    const mcpPort = Number(options.mcpPort) || 7000;
    const codingAgentStatus = options.codingAgentStatus || createCodingAgentStatus({
        installation: () => resolveAlaInstallation({ env: { ...process.env, ACHILLES_ALA_COMMAND: runtimeManager.alaCommand || '' } }),
    });
    const liveSessions = options.liveSessions || null;
    const liveStreamLifetimeMs = Number.isSafeInteger(options.liveSessionsStreamLifetimeMs) && options.liveSessionsStreamLifetimeMs > 0
        ? options.liveSessionsStreamLifetimeMs : LIVE_STREAM_LIFETIME_MS;

    // The family gate verified this request once; its signed decision is reused.
    const robotView = (req) => ({
        privileged: req[ACCESS]?.internal === false && req[ACCESS].canAdmin === true,
        workspaceRoot: runtimeManager.workspaceRoot,
    });

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const pathname = url.pathname;
            if (['/mcp', '/health', '/getTaskStatus', '/task'].includes(pathname)) return proxyAgentServer(req, res, mcpPort);
            if (pathname === '/status' && req.method === 'GET') {
                return sendJson(res, 200, { ok: true, service: 'RoboTeamAgent', modes: ['browser', 'desktop'] });
            }
            // Robot listing is decided on the signed request before the
            // unsigned compatibility header is consulted.
            if (pathname === '/api/robots' && req.method === 'GET') {
                const listing = await authorizeRobotListing(req, url, { internalToken });
                if (!listing.ok) return sendError(res, listing.status, listing.error);
                const robots = await robotStore.list();
                const views = await Promise.all(robots.map(async (robot) => {
                    const view = publicRobot(robot, runtimeManager.status(robot.id), { privileged: listing.canAdmin, workspaceRoot: runtimeManager.workspaceRoot });
                    const home = path.join(robotStore.robotPath(robot.id), 'home');
                    // Logins name the outer accounts a robot holds, so only administrators see them.
                    return { ...view, codingAgent: await codingAgentStatus.activeAgent(home, view.codingAgents),
                        ...(listing.canAdmin ? { codingAgentLogins: await codingAgentStatus.logins(home) } : {}) };
                }));
                return sendJson(res, 200, { ok: true, canAdmin: listing.canAdmin, robots: views });
            }
            // Every other route needs an internal token or a verified, Explorer-entitled user.
            const access = await authorizeWorkspaceRequest(req, url, {
                internalToken,
                readBody: () => readRawBody(req, req.method === 'POST' && LIVE_MESSAGES_PATH.test(pathname) ? LIVE_MESSAGE_BODY_LIMIT : BODY_LIMIT),
                refusal: pathname.startsWith('/api/roboflow') ? ROBOFLOW_ENTITLEMENT_ERROR : ROBOTEAM_ENTITLEMENT_ERROR,
            });
            if (!access.ok) return sendError(res, access.status, access.error);
            req[ACCESS] = access;
            // Live Sessions decide on the signed principal and signed admin
            // decision only, before the unsigned actor is consulted.
            if (isLiveSessionsPath(pathname)) {
                const live = liveSessionsAccess(access);
                if (!live.ok) return sendError(res, live.status, live.error);
                if (!liveSessions) return sendError(res, 404, 'not found');
                return await handleLiveSessions({ req, res, pathname, viewer: { principal: live.principal, canAdmin: live.canAdmin },
                    registry: liveSessions, publicDir, publicBasePath, streamLifetimeMs: liveStreamLifetimeMs });
            }
            if (await handleTerminalProfiles({ req, res, pathname, access, robotStore, runtimeManager })) return;
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
            if (pathname === '/' && req.method === 'GET') return servePage(res, publicDir, 'index.html', publicBasePath);
            if (pathname === '/config.js' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
                res.end(`globalThis.ROBOTEAM_CONFIG=${JSON.stringify({ publicBasePath, routeKey })};\n`);
                return;
            }
            if (pathname === '/InterVariable.woff2' && req.method === 'GET') return serveFile(req, res, publicDir, 'InterVariable.woff2');
            if (pathname === '/styles.css' && req.method === 'GET') return serveFile(req, res, publicDir, 'styles.css');
            if (['/workflow-editor.js', '/workflow-board.js', '/workflow-routing.js', '/workflow-generator.js', '/workflow-editor.css',
                '/flows.js', '/editor.js', '/generate.js', '/roboflow.js', '/roboflow.css', '/roboflow-api.js', '/workflow-execution.css', '/workflow-phase-list.js', '/workflow-execution-state.js', '/workflow-live-updates.js',
                '/log-render.js', '/webchat-logs.js', '/robot-logs.js', '/robot-log-viewer.js', '/summary.js', '/conversation-skills.js', '/conversation-skills-model.js'].includes(pathname) && req.method === 'GET') return serveFile(req, res, publicDir, pathname.slice(1));
            if (pathname === '/dashboard-tabs.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'dashboard-tabs.js');
            if (pathname === '/robot-controls.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'robot-controls.js');
            if (pathname === '/page-navigation.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'page-navigation.js');
            if (pathname === '/app.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'app.js');
            if (pathname === '/cron-jobs.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'cron-jobs.js');
            if (pathname === '/robot-import.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'robot-import.js');
            if (pathname === '/robot-filters.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'robot-filters.js');
            if (pathname === '/schedule-folder-picker.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'schedule-folder-picker.js');
            if (pathname === '/skills-dialog.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'skills-dialog.js');
            if (pathname === '/terminal.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'terminal.js');

            if (pathname === '/summary' && req.method === 'GET') return servePage(res, publicDir, 'summary.html', publicBasePath);
            if (pathname === '/api/summary' && req.method === 'GET') {
                const session = url.searchParams.get('session');
                if (session) return sendJson(res, 200, await conversationSummaries(robotStore, runtimeManager.workspaceRoot, session));
                const flow = url.searchParams.get('flow');
                const instance = url.searchParams.get('instance');
                if (!roboflow || !/^flow_[a-f0-9]{24}$/.test(flow || '') || !/^inv_[a-f0-9]{24}$/.test(instance || '')) return sendError(res, 400, 'Invalid summary context');
                return sendJson(res, 200, await workflowSummaries(roboflow, flow, instance));
            }
            if (pathname === '/api/required-skills' && req.method === 'GET') {
                const skill = await requiredHumanReportSkill(skillsets);
                const content = await fs.promises.readFile(path.join(skill.sourcePath, 'SKILL.md'), 'utf8');
                return sendJson(res, 200, { skills: [{ name: skill.name, description: skill.description, content, required: true, readOnly: true }] });
            }

            if ((pathname === '/conversation-skills' || pathname.startsWith('/conversation-skills/')) && req.method === 'GET') {
                return servePage(res, publicDir, 'conversation-skills.html', publicBasePath);
            }
            const conversationSkills = matchConversationSkillsPath(pathname);
            if (conversationSkills) {
                if (!['GET', 'PATCH'].includes(req.method)) return sendError(res, 404, 'not found');
                if (actor.internal) return sendError(res, 403, 'conversation skills require a signed-in user');
                if (url.search) return sendError(res, 400, 'conversation skills requests take no query parameters');
                const context = { robotStore, skillsets };
                const catalog = req.method === 'GET' ? await readConversationSkills(context, conversationSkills)
                    : await setConversationSkill(context, { ...conversationSkills, body: await readJsonBody(req) });
                return sendJson(res, 200, { ok: true, robotId: conversationSkills.robotId, ...catalog });
            }

            const logsPage = pathname.match(/^\/webchat-logs\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/);
            if (logsPage && req.method === 'GET') return servePage(res, publicDir, 'webchat-logs.html', publicBasePath);
            const logsApi = pathname.match(/^\/api\/webchat\/logs\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/);
            if (logsApi && req.method === 'GET') {
                const result = readWebchatTurnLog(robotStore, runtimeManager.workspaceRoot, logsApi[1], logsApi[2]);
                if (result === null) return sendText(res, 404, 'log not found');
                let { log, finalResponse } = result;
                if (finalResponse) {
                    let offset = log.lastIndexOf(finalResponse);
                    if (offset < 0) {
                        log = log ? `${log}\n\n` : '';
                        offset = log.length;
                        log += finalResponse;
                    }
                    // Character offsets identify the final block without a JSON envelope.
                    res.setHeader('x-log-final-offset', String(offset));
                    res.setHeader('x-log-final-length', String(finalResponse.length));
                }
                return sendText(res, 200, log);
            }

            if (pathname === '/api/robots' && req.method === 'POST') {
                if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                const body = await readJsonBody(req);
                const robot = await robotStore.create({ name: body.name, codingAgents: body.codingAgents });
                await runtimeManager.prepareOpenCode?.(robot.id, { seed: false });
                runtimeManager.seedOpenCodeInBackground?.(robot);
                await roboflow?.refreshCoverage();
                return sendJson(res, 201, { ok: true, robot: publicRobot(robot, runtimeManager.status(robot.id), robotView(req)) });
            }
            if (pathname === '/api/robots/import-emails' && req.method === 'POST') {
                if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                const body = await readJsonBody(req);
                const result = await importEmailRobots(robotStore, body.addresses, { codingAgents: body.codingAgents });
                for (const robot of result.created) {
                    await runtimeManager.prepareOpenCode?.(robot.id, { seed: false });
                    runtimeManager.seedOpenCodeInBackground?.(robot);
                }
                if (result.created.length) await roboflow?.refreshCoverage();
                return sendJson(res, 200, { ok: true, created: result.created.map(robot => ({ id: robot.id, name: robot.name })),
                    existing: result.existing, invalid: result.invalid });
            }
            const modelsId = matchRobotPath(pathname, '/models');
            if (modelsId && req.method === 'GET') {
                if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                const robot = await robotStore.get(modelsId);
                if (!robot) return sendError(res, 404, 'robot not found');
                const controller = new AbortController();
                const abort = () => controller.abort(new Error('Model request closed'));
                const timeout = setTimeout(() => controller.abort(new Error('Model catalog timed out; try again.')), 90000);
                res.once('close', abort);
                try {
                    const result = await robotModels.list(robot, url.searchParams.get('agent'), { signal: controller.signal });
                    return sendJson(res, 200, { ok: true, ...result });
                } finally { clearTimeout(timeout); res.removeListener('close', abort); }
            }
            const codingAgentsId = matchRobotPath(pathname, '/coding-agents');
            if (codingAgentsId && req.method === 'GET') {
                if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                const robot = await robotStore.get(codingAgentsId);
                if (!robot) return sendError(res, 404, 'robot not found');
                return sendJson(res, 200, { ok: true, ...await robotModels.config(robot) });
            }
            if (codingAgentsId && req.method === 'PATCH') {
                if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                if (!await robotStore.get(codingAgentsId)) return sendError(res, 404, 'robot not found');
                if (runtimeManager.status(codingAgentsId).state !== 'stopped' || runtimeManager.hasUnfinishedTasks?.(codingAgentsId)) {
                    return sendError(res, 409, 'stop the robot workstation and tasks before changing coding agents');
                }
                const body = await readJsonBody(req);
                if (!Object.hasOwn(body, 'codingAgents')) return sendError(res, 400, 'codingAgents is required');
                if (body.effort != null) {
                    if (!Array.isArray(body.codingAgents) || body.codingAgents.length !== 1 || body.model === undefined) return sendError(res, 400, 'effort requires a model and one coding agent');
                    await robotModels.validateEffort(await robotStore.get(codingAgentsId), body.codingAgents[0], body.model, body.effort);
                }
                const robot = await robotStore.setCodingAgents(codingAgentsId, body.codingAgents, { model: body.model, effort: body.effort });
                await roboflow?.refreshCoverage();
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, runtimeManager.status(robot.id), robotView(req)) });
            }
            const skillsetsId = matchRobotPath(pathname, '/skillsets');
            if (skillsetsId && ['POST', 'DELETE', 'PATCH'].includes(req.method)) {
                if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                const body = await readJsonBody(req);
                if (req.method === 'POST') await skillsets.add(skillsetsId, body);
                else if (req.method === 'PATCH') await skillsets.setSkillsetEnabled(skillsetsId, body);
                else await skillsets.remove(skillsetsId, url.searchParams.get('name') ?? body.name);
                await roboflow?.refreshCoverage();
                return sendJson(res, 200, { ok: true });
            }
            if (pathname === '/api/control' && req.method === 'POST') {
                const body = await readJsonBody(req);
                const robot = body.robotId
                    ? await robotStore.get(body.robotId)
                    : await robotStore.getByName(body.robotName);
                if (!robot) return sendError(res, 404, 'robot not found');
                const operation = String(body.operation || '');
                if (operation === 'robot-delete') {
                    if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                    const status = runtimeManager.status(robot.id);
                    if (status.state !== 'stopped' || runtimeManager.hasUnfinishedTasks?.(robot.id)
                        || ['queued', 'starting', 'running', 'pausing'].includes(status.task?.state)) {
                        return sendError(res, 409, 'stop the robot before deleting it');
                    }
                    if (runtimeManager.deleteRobot) await runtimeManager.deleteRobot(robot.id, () => robotStore.delete(robot.id));
                    else await robotStore.delete(robot.id);
                    await roboflow?.refreshCoverage();
                    return sendJson(res, 200, { ok: true, deleted: robot.name });
                }
                if (operation === 'open-desktop') {
                    return sendJson(res, 202, { ok: true, robotName: robot.name, run: await runtimeManager.openDesktop(robot, body.cwd) });
                }
                const startTypes = { 'start-desktop-task': 'desktop', 'start-browser-task': 'browser', 'start-simple-task': 'simple' };
                if (startTypes[operation]) {
                    const task = await skillsets.start(robot, body, (current, skillSelection) => runtimeManager.startTask(current, startTypes[operation], {
                        cwd: body.cwd, task: String(body.task || ''), skillPolicyRef: skillSelection.policyId, alaSessionId: skillSelection.policyId,
                        model: body.model || null, ca: body.ca || 'auto', ownerPrincipal: signedOwner(req),
                    }));
                    return sendJson(res, 202, {
                        ok: true,
                        robotId: robot.id,
                        robotName: robot.name,
                        type: startTypes[operation],
                        ...task,
                    });
                }
                const stopTypes = { 'stop-desktop-task': 'desktop', 'stop-browser-task': 'browser', 'stop-simple-task': 'simple' };
                if (stopTypes[operation]) return sendJson(res, 202, { ok: true, robotName: robot.name, ...runtimeManager.stopTask(robot, stopTypes[operation], body.taskId) });
                if (operation === 'take-control') {
                    return sendJson(res, 202, {
                        ok: true,
                        robotName: robot.name,
                        ...runtimeManager.takeControl(robot, body.taskId),
                    });
                }
                if (operation === 'resume-task') {
                    const task = await runtimeManager.resumeTask(robot, body.taskId, body.prompt);
                    return sendJson(res, 202, {
                        ok: true,
                        robotId: robot.id,
                        robotName: robot.name,
                        type: runtimeManager.taskStatus(robot.id, task.taskId)?.type,
                        ...task,
                    });
                }
                if (operation === 'message-task') return sendJson(res, 200, {
                    ok: true, ...await runtimeManager.sendTaskMessage(robot, body.taskId, body.prompt)
                });
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
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, runtimeManager.status(robot.id), robotView(req)) });
            }
            if (runId && req.method === 'POST') {
                const robot = await robotStore.get(runId);
                if (!robot) return sendError(res, 404, 'robot not found');
                const body = await readJsonBody(req);
                const run = await runtimeManager.start(robot, body.mode);
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, run, robotView(req)) });
            }
            if (runId && req.method === 'DELETE') {
                const robot = await robotStore.get(runId);
                if (!robot) return sendError(res, 404, 'robot not found');
                const run = await runtimeManager.stop(robot.id);
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, run, robotView(req)) });
            }
            const logsPageId = pathname.match(new RegExp(`^/robots/(${ROBOT_ID})/logs$`))?.[1];
            if (logsPageId && req.method === 'GET') {
                const robot = await robotStore.get(logsPageId);
                if (!robot) return sendError(res, 404, 'robot not found');
                return servePage(res, publicDir, 'robot-logs.html', publicBasePath);
            }
            const logsId = matchRobotPath(pathname, '/logs');
            if (logsId && req.method === 'GET') {
                const robot = await robotStore.get(logsId);
                if (!robot) return sendError(res, 404, 'robot not found');
                return sendJson(res, 200, { ok: true, logs: await runtimeManager.logs(robot.id, url.searchParams.get('tail')) });
            }
            if (await handleRobotProxies({ req, res, pathname, actor, proxyPool, robotStore, runtimeManager })) return;
            if (roboflow && await handleRoboFlow({ req, res, url, pathname, actor, roboflow, publicDir, publicBasePath })) return;
            sendError(res, 404, 'not found');
        } catch (error) {
            const message = String(error?.message || '');
            const badRequest = error instanceof SyntaxError || /required|invalid|at most|too large|must be browser or desktop/.test(message);
            const conflict = /already running|active robot limit|occupied|active task|different cwd|stop the|interrupted GUI/.test(message);
            const explicit = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500;
            const status = explicit ? error.statusCode : badRequest ? 400 : conflict ? 409 : 500;
            if (status >= 500) {
                console.error(`[roboTeamAgent] ${req.method} ${req.url} failed:`, error?.stack || message);
            } else {
                console.warn(`[roboTeamAgent] ${req.method} ${req.url} rejected (${status}): ${message}`);
            }
            sendError(res, status, status < 500 ? message : 'request failed');
        }
    });

    server.on('upgrade', async (req, socket, head) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            // The Router mints upgrade auth-info over an empty body.
            const access = await authorizeWorkspaceRequest(req, url, { internalToken, refusal: ROBOTEAM_ENTITLEMENT_ERROR });
            if (!access.ok) return websocketDenial(socket, access.status, access.error, url.pathname);
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

export const httpServerInternals = { normalizeBasePath, sessionUpstreamPath, matchRobotPath, sessionRobotId, renderRecordedTurn, lookupRecordedTurn };

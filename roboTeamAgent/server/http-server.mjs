import { RobotModels } from './robot-models.mjs';
import { conversationSummaries, workflowSummaries } from './impact-summaries.mjs';
import { requiredHumanReportSkill } from './required-skills.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdminActor, requestActor } from './request-identity.mjs';
import { authorizeRobotListing, verifiedAdminRequest } from './listing-access.mjs';
import { projectRobotView } from './robot-projection.mjs';
import { RobotSkillsets, publicSkillsets, publicRepositories, individualSkillRepositories } from './robot-skillsets.mjs';
import { robotTerminalDirectory } from './robot-terminal.mjs';
import { prepareRobotShell } from './robot-shell.mjs';
import { robotCodingAgents } from './coding-agents.mjs';
import { findProjectRecord, projectForSessionRecord } from './project-storage.mjs';
import { matchConversationSkillsPath, readConversationSkills, setConversationSkill } from './conversation-skills-api.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';
import { renderAlaTurnLog } from '../copilot/src/lib/webchat/webchatTurnLog.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(MODULE_DIR, '..', 'public');
const BODY_LIMIT = 64 * 1024;
const RAW_BODY = Symbol('roboteam.rawBody');
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
    // The exact bytes are kept so the signed request can be verified later.
    req[RAW_BODY] = Buffer.concat(chunks);
    const raw = req[RAW_BODY].toString('utf8');
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
    try {
        const { turn, ala } = new ConversationSessionStore({ workingDir }).turnForMessage(sessionId, messageId);
        if (!ala) return null;
        return { log: renderAlaTurnLog(ala), finalResponse: turn.status === 'completed' ? ala.final || '' : '' };
    } catch { return null; }
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
        sendJson(res, 201, { ok: true, schedule: await roboflow.saveSchedule(await readJsonBody(req), actor.id) }); return true;
    }
    const runScheduleId = pathname.match(/^\/api\/roboflow\/schedules\/(cron_[0-9a-f]{24})\/run-now$/)?.[1];
    if (runScheduleId && req.method === 'POST') {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        const input = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...await roboflow.runScheduleNow(runScheduleId, input?.revision, actor.id) }); return true;
    }
    const scheduleId = pathname.match(/^\/api\/roboflow\/schedules\/(cron_[0-9a-f]{24})$/)?.[1];
    if (scheduleId && ['PUT', 'DELETE'].includes(req.method)) {
        if (!isAdminActor(actor)) { sendError(res, 403, 'administrator role is required'); return true; }
        if (req.method === 'PUT') sendJson(res, 200, { ok: true, schedule: await roboflow.saveSchedule(await readJsonBody(req), actor.id, scheduleId) });
        else {
            const deleted = await roboflow.deleteSchedule(scheduleId);
            if (!deleted) sendError(res, 404, 'Cron job not found');
            else sendJson(res, 200, { ok: true, deleted });
        }
        return true;
    }
    if (pathname === '/api/roboflow/workflows' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, workflows: await roboflow.listWorkflows() });
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
        sendJson(res, 201, { ok: true, flow: await roboflow.startFlow({ ...body, createdBy: actor.id }) });
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

export function createRoboTeamServer(options) {
    const robotStore = options.robotStore;
    const runtimeManager = options.runtimeManager;
    const roboflow = options.roboflow || null;
    const robotModels = options.robotModels || new RobotModels({ robotStore, runtimeManager });
    const skillsets = options.skillsets || runtimeManager.skillsets || new RobotSkillsets({ robotStore,
        workspaceRoot: runtimeManager.workspaceRoot, alaCommand: runtimeManager.alaCommand });
    runtimeManager.skillsets = skillsets;
    const internalToken = String(options.internalToken || '');
    const publicBasePath = normalizeBasePath(options.publicBasePath);
    const routeKey = String(options.routeKey || 'roboTeamAgent');
    const publicDir = path.resolve(options.publicDir || DEFAULT_PUBLIC_DIR);
    const mcpPort = Number(options.mcpPort) || 7000;

    const robotView = async (req, url) => ({
        privileged: await verifiedAdminRequest(req, url, { internalToken, body: req[RAW_BODY] || Buffer.alloc(0) }),
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
                return sendJson(res, 200, { ok: true, canAdmin: listing.canAdmin, robots: robots.map((robot) => publicRobot(robot, runtimeManager.status(robot.id), { privileged: listing.canAdmin, workspaceRoot: runtimeManager.workspaceRoot })) });
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
            if (pathname === '/' && req.method === 'GET') return servePage(res, publicDir, 'index.html', publicBasePath);
            if (pathname === '/config.js' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
                res.end(`globalThis.ROBOTEAM_CONFIG=${JSON.stringify({ publicBasePath, routeKey })};\n`);
                return;
            }
            if (pathname === '/InterVariable.woff2' && req.method === 'GET') return serveFile(req, res, publicDir, 'InterVariable.woff2');
            if (pathname === '/styles.css' && req.method === 'GET') return serveFile(req, res, publicDir, 'styles.css');
            if (['/workflow-editor.js', '/workflow-board.js', '/workflow-routing.js', '/workflow-generator.js', '/workflow-description-revision.js', '/workflow-editor.css',
                '/flows.js', '/editor.js', '/generate.js', '/roboflow.js', '/roboflow.css', '/roboflow-api.js',
                '/log-render.js', '/webchat-logs.js', '/robot-logs.js', '/robot-log-viewer.js', '/summary.js', '/conversation-skills.js', '/conversation-skills-model.js'].includes(pathname) && req.method === 'GET') return serveFile(req, res, publicDir, pathname.slice(1));
            if (pathname === '/dashboard-tabs.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'dashboard-tabs.js');
            if (pathname === '/robot-controls.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'robot-controls.js');
            if (pathname === '/page-navigation.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'page-navigation.js');
            if (pathname === '/app.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'app.js');
            if (pathname === '/cron-jobs.js' && req.method === 'GET') return serveFile(req, res, publicDir, 'cron-jobs.js');
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

            const terminalRobotId = matchRobotPath(pathname, '/terminal');
            if (terminalRobotId && req.method === 'POST') {
                if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                const robot = await robotStore.get(terminalRobotId);
                if (!robot) return sendError(res, 404, 'robot not found');
                const directory = await robotTerminalDirectory(robotStore, terminalRobotId, runtimeManager.workspaceRoot);
                const codingAgents = robotCodingAgents(robot);
                const tools = await runtimeManager.toolCache.prepareShellTools();
                await prepareRobotShell(path.join(robotStore.robotPath(terminalRobotId), 'home'), {
                    codingAgents, binPath: tools.binPath, cacheRoot: runtimeManager.toolCache.root,
                });
                await runtimeManager.prepareOpenCode?.(terminalRobotId);
                return sendJson(res, 200, { ok: true, directory });
            }

            if (pathname === '/api/robots' && req.method === 'POST') {
                if (!isAdminActor(actor)) return sendError(res, 403, 'administrator role is required');
                const body = await readJsonBody(req);
                const robot = await robotStore.create({ name: body.name, codingAgents: body.codingAgents });
                await runtimeManager.prepareOpenCode?.(robot.id);
                await roboflow?.refreshCoverage();
                return sendJson(res, 201, { ok: true, robot: publicRobot(robot, runtimeManager.status(robot.id), await robotView(req, url)) });
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
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, runtimeManager.status(robot.id), await robotView(req, url)) });
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
                        model: body.model || null, ca: body.ca || 'auto',
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
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, runtimeManager.status(robot.id), await robotView(req, url)) });
            }
            if (runId && req.method === 'POST') {
                const robot = await robotStore.get(runId);
                if (!robot) return sendError(res, 404, 'robot not found');
                const body = await readJsonBody(req);
                const run = await runtimeManager.start(robot, body.mode);
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, run, await robotView(req, url)) });
            }
            if (runId && req.method === 'DELETE') {
                const robot = await robotStore.get(runId);
                if (!robot) return sendError(res, 404, 'robot not found');
                const run = await runtimeManager.stop(robot.id);
                return sendJson(res, 200, { ok: true, robot: publicRobot(robot, run, await robotView(req, url)) });
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

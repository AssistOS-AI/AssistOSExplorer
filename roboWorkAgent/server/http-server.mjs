import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { authorizeWorkspaceRequest } from './listing-access.mjs';
import { fail } from './robot-paths.mjs';

function internal(req, token) {
    const supplied = Buffer.from(String(req.headers['x-robowork-internal-token'] || ''));
    const expected = Buffer.from(token);
    return expected.length > 0 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(req, maximum = 2 * 1024 * 1024) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maximum) throw fail('INVALID_INPUT', 'Request too large', 413);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export function createRoboWorkServer({ robots, runs, environment, gui = null, terminal = null, internalToken,
    publicBasePath = '/base-agent-additional-server/roboWorkAgent/3001/', proxyHttp, proxyWebSocket }) {
    const operations = {
        robot_ensure: value => robots.ensure(value), robot_delete: value => robots.delete(value),
        robot_status: value => robots.status(value), robot_config: value => robots.config(value),
        robot_config_set: value => robots.configSet(value), robot_models: value => robots.models(value),
        run_start: value => runs.start(value), run_read: value => runs.read(value), run_input: value => runs.input(value),
        run_stop: value => runs.stop(value), run_list: value => runs.list(value), run_release: value => runs.release(value),
        environment_list: () => environment.list(),
        gui_ensure: value => needGui().ensure(value), gui_stop: value => needGui().stop(value), gui_logs: value => needGui().logs(value),
        proxy_settings_set: async value => ({ useProxy: await needGui().proxySettings.setUseProxy(value.useProxy) }),
        proxy_assignments: value => needGui().proxyAssignments(value),
        proxy_release: value => needGui().releaseProxy(value),
    };
    function needGui() {
        if (!gui) throw fail('GUI_NOT_READY', 'GUI support is not ready', 503);
        return gui;
    }
    const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true });
            if (url.pathname.startsWith('/internal/')) {
                if (!internal(req, internalToken)) throw fail('CALLER_REFUSED', 'Internal authentication required', 403);
                const operation = url.pathname.slice('/internal/'.length);
                if (req.method !== 'POST' || !Object.hasOwn(operations, operation)) throw fail('UNKNOWN_TOOL', 'Unknown operation', 404);
                const input = JSON.parse((await readBody(req)).toString('utf8') || '{}');
                if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_INPUT', 'Input must be an object');
                return reply(res, 200, await operations[operation](input));
            }
            let rawBody;
            const access = await authorizeWorkspaceRequest(req, url, { refusal: 'Explorer access is required to use RoboWork',
                readBody: async () => { rawBody = await readBody(req); return rawBody; } });
            if (!access.ok) return reply(res, access.status, { code: 'CALLER_REFUSED', error: access.error });
            const pathname = url.pathname.startsWith(publicBasePath) ? '/' + url.pathname.slice(publicBasePath.length) : url.pathname;
            const session = pathname.match(/^\/api\/robots\/([a-z0-9-]+)\/session(?:\/|$)/u);
            if (session && gui && proxyHttp) {
                const port = gui.activePort(session[1]);
                if (!port) throw fail('GUI_STOPPED', 'GUI session is stopped', 404);
                req.url = pathname + url.search;
                return proxyHttp(req, res, port, publicBasePath, rawBody);
            }
            if (terminal && pathname.startsWith('/api/terminal-profiles')) return await terminal.handle(req, res, url, { ...access, body: rawBody });
            throw fail('NOT_FOUND', 'Route not found', 404);
        } catch (error) {
            reply(res, error.statusCode || (error instanceof SyntaxError ? 400 : 500), { code: error.code || 'INTERNAL_ERROR', error: error.statusCode ? error.message : 'RoboWork request failed' });
        }
    });
    server.on('upgrade', async (req, socket, head) => {
        const url = new URL(req.url, 'http://localhost');
        const access = await authorizeWorkspaceRequest(req, url, { refusal: 'Explorer access is required to use RoboWork' });
        const match = url.pathname.match(/\/api\/robots\/([a-z0-9-]+)\/session(?:\/|$)/u);
        const port = match && gui?.activePort(match[1]);
        if (!access.ok || !port || !proxyWebSocket) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
        if (url.pathname.startsWith(publicBasePath)) req.url = '/' + url.pathname.slice(publicBasePath.length) + url.search;
        proxyWebSocket(req, socket, head, port, publicBasePath);
    });
    return server;
}

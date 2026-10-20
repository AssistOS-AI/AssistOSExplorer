import http from 'node:http';

const UPSTREAM_TIMEOUT_MS = 30000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export function proxyAuthorization(upstream) {
    if (!upstream.username) return null;
    return `Basic ${Buffer.from(`${upstream.username}:${upstream.password || ''}`).toString('base64')}`;
}

function refuse(socket, status, reason) {
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// One relay serves one robot container. Chromium cannot answer proxy authentication by itself, so
// the container reaches this loopback listener without credentials and the relay adds the upstream
// Proxy-Authorization. Credentials therefore never enter the container, its arguments or its files.
export class ProxyRelay {
    constructor(upstream, { log = () => {} } = {}) {
        if (upstream?.scheme !== 'http') throw new Error('proxy relay supports http upstream proxies only');
        this.upstream = upstream;
        this.authorization = proxyAuthorization(upstream);
        this.log = log;
        this.sockets = new Set();
        this.server = http.createServer((req, res) => this._forwardRequest(req, res));
        this.server.on('connect', (req, socket, head) => this._forwardTunnel(req, socket, head));
        this.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
        });
        this.server.on('clientError', (error, socket) => refuse(socket, 400, 'Bad Request'));
    }

    async listen(host = '127.0.0.1') {
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, host, () => { this.server.off('error', reject); resolve(); });
        });
        return this.server.address().port;
    }

    get port() { return this.server.address()?.port || null; }

    async close() {
        for (const socket of this.sockets) socket.destroy();
        await new Promise(resolve => this.server.close(() => resolve()));
    }

    _upstreamHeaders(extra = {}) {
        return { ...extra, ...(this.authorization ? { 'proxy-authorization': this.authorization } : {}) };
    }

    _forwardTunnel(req, client, head) {
        const target = String(req.url || '');
        if (!/^[^\s/]+:\d{1,5}$/u.test(target)) return refuse(client, 400, 'Bad Request');
        client.on('error', () => {});
        const upstream = http.request({
            host: this.upstream.host, port: this.upstream.port, method: 'CONNECT', path: target,
            headers: this._upstreamHeaders({ host: target }), agent: false, timeout: UPSTREAM_TIMEOUT_MS,
        });
        upstream.once('connect', (response, socket, upstreamHead) => {
            if (response.statusCode !== 200) {
                this.log(`upstream refused CONNECT with ${response.statusCode}`);
                socket.destroy();
                return refuse(client, 502, 'Bad Gateway');
            }
            socket.on('error', () => client.destroy());
            client.on('error', () => socket.destroy());
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (upstreamHead?.length) client.write(upstreamHead);
            if (head?.length) socket.write(head);
            socket.pipe(client);
            client.pipe(socket);
        });
        upstream.once('timeout', () => upstream.destroy(new Error('upstream proxy timed out')));
        upstream.once('error', (error) => {
            this.log(`upstream CONNECT failed: ${error.message}`);
            refuse(client, 502, 'Bad Gateway');
        });
        upstream.end();
    }

    // Plain-HTTP requests arrive in absolute form and are sent to the upstream proxy unchanged
    // apart from hop-by-hop headers, which are replaced by the relay's own.
    _forwardRequest(req, res) {
        let target;
        try { target = new URL(req.url); } catch { target = null; }
        if (!target || target.protocol !== 'http:') {
            res.writeHead(400, { connection: 'close', 'content-length': 0 });
            return res.end();
        }
        const headers = {};
        for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
        const upstream = http.request({
            host: this.upstream.host, port: this.upstream.port, method: req.method, path: target.href,
            headers: this._upstreamHeaders(headers), agent: false, timeout: UPSTREAM_TIMEOUT_MS,
        }, (response) => {
            const responseHeaders = {};
            for (const [name, value] of Object.entries(response.headers)) if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value;
            res.writeHead(response.statusCode || 502, responseHeaders);
            response.pipe(res);
        });
        upstream.once('timeout', () => upstream.destroy(new Error('upstream proxy timed out')));
        upstream.once('error', (error) => {
            this.log(`upstream request failed: ${error.message}`);
            if (!res.headersSent) res.writeHead(502, { connection: 'close', 'content-length': 0 });
            res.end();
        });
        req.pipe(upstream);
    }
}


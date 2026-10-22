import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { ProxyRelay } from '../server/proxy-pool/proxy-relay.mjs';

const EXPECTED_AUTH = `Basic ${Buffer.from('user:pa:ss').toString('base64')}`;

const openSockets = new Set();

async function listen(server) {
    server.on('connection', (socket) => { openSockets.add(socket); socket.once('close', () => openSockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
}

test.afterEach(() => { for (const socket of openSockets) socket.destroy(); });

// A minimal authenticating upstream proxy: tunnels CONNECT to the requested loopback port and
// answers plain requests itself, recording what it saw.
async function startUpstream() {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ method: req.method, url: req.url, auth: req.headers['proxy-authorization'], connection: req.headers['proxy-connection'] });
        if (req.headers['proxy-authorization'] !== EXPECTED_AUTH) { res.writeHead(407); return res.end(); }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`plain ${req.url}`);
    });
    server.on('connect', (req, socket) => {
        seen.push({ method: 'CONNECT', url: req.url, auth: req.headers['proxy-authorization'] });
        if (req.headers['proxy-authorization'] !== EXPECTED_AUTH) return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        const target = net.connect(Number(req.url.split(':')[1]), '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            target.pipe(socket); socket.pipe(target);
        });
        target.on('error', () => socket.destroy());
    });
    return { server, seen, port: await listen(server) };
}

function connectThrough(relayPort, target) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: relayPort, method: 'CONNECT', path: target, agent: false });
        request.once('connect', (response, socket) => resolve({ status: response.statusCode, socket }));
        request.once('error', reject);
        request.end();
    });
}

test('the relay tunnels CONNECT with the upstream credentials it holds', async (t) => {
    const echo = net.createServer(socket => socket.pipe(socket));
    const echoPort = await listen(echo);
    const upstream = await startUpstream();
    const relay = new ProxyRelay({ scheme: 'http', host: '127.0.0.1', port: upstream.port, username: 'user', password: 'pa:ss' });
    const relayPort = await relay.listen();
    t.after(async () => { await relay.close(); upstream.server.close(); echo.close(); });

    const { status, socket } = await connectThrough(relayPort, `example.test:${echoPort}`);
    assert.equal(status, 200);
    const reply = await new Promise(resolve => { socket.once('data', chunk => resolve(String(chunk))); socket.write('ping'); });
    assert.equal(reply, 'ping');
    socket.destroy();
    assert.deepEqual(upstream.seen, [{ method: 'CONNECT', url: `example.test:${echoPort}`, auth: EXPECTED_AUTH }]);
});

test('the relay forwards plain HTTP in absolute form and drops client proxy headers', async (t) => {
    const upstream = await startUpstream();
    const relay = new ProxyRelay({ scheme: 'http', host: '127.0.0.1', port: upstream.port, username: 'user', password: 'pa:ss' });
    const relayPort = await relay.listen();
    t.after(async () => { await relay.close(); upstream.server.close(); });

    const body = await new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: relayPort, path: 'http://example.test/page?x=1', agent: false,
            headers: { 'proxy-authorization': 'Basic forged', 'proxy-connection': 'keep-alive' } }, (response) => {
            let text = ''; response.setEncoding('utf8');
            response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, text }));
        });
        request.once('error', reject);
        request.end();
    });
    assert.deepEqual(body, { status: 200, text: 'plain http://example.test/page?x=1' });
    assert.equal(upstream.seen[0].auth, EXPECTED_AUTH);
    assert.equal(upstream.seen[0].connection, undefined);
});

test('a refused upstream tunnel reaches the browser as a gateway error, never as a direct connection', async (t) => {
    const upstream = await startUpstream();
    const relay = new ProxyRelay({ scheme: 'http', host: '127.0.0.1', port: upstream.port, username: 'user', password: 'wrong' });
    const relayPort = await relay.listen();
    t.after(async () => { await relay.close(); upstream.server.close(); });
    const { status, socket } = await connectThrough(relayPort, 'example.test:443');
    socket.destroy();
    assert.equal(status, 502);
    assert.throws(() => new ProxyRelay({ scheme: 'socks5', host: '127.0.0.1', port: 1 }), /http upstream/u);
});

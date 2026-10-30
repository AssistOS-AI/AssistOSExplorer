#!/usr/bin/env node
// rwcoord LOCAL stand-in for Ploinky's private-listener coordinator hop (slice P7, PROOF-FIXTURE). Self-tests and
// `driver.mjs` local runs only: it is excluded from the rwp7 image build context (Containerfile checks its absence) and
// a live driver run refuses any configuration that names it.
//
// It exists only so the self-tests and `driver.mjs --local` can exercise the coordinator CLI, the HTTP front and the
// scenario runner without a Box. It mirrors the Router's forward (Ploinky `cli/server/executionProvider/coordinatorHop.mjs`
// `mintCoordinatorAdmissionRequest` with `invocationMinter.buildRouterRequest`): only the declared coordinator principals
// pass, and the forwarded request carries a provider-audience Router Request (HS256 with the provider's secret) bound to
// the exact method, agent-local path, query and body hash, in `x-ploinky-auth-info`. It does NOT authenticate the caller:
// the caller principal arrives in the `x-rwcoord-local-caller` header, which stands in for the verified private agent
// assertion. Results obtained through it are LOCAL, never live evidence.
//
//   RWCOORD_LOCAL_PROVIDER_SECRET=<hex> node localRouter.mjs --port <n> --provider-route <routeKey>
//       --provider-principal <agent:...> --callers <agent:...>[,<agent:...>] --front-port <n> [--route-port <n>]
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { COORDINATOR_ADMISSION_TOOL, computeRchHttp, rawBodyHash } from '../../../../server/coordinatorAuth.mjs';
import { AGENT_PORT_PREFIX, LOCAL_CALLER_HEADER } from './coordinator.mjs';

const BODY_BYTES = 64 * 1024;

function b64json(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

// The Router Request of one forwarded coordinator call. `owner` ({usr, delegation}) appears only when a verified grant
// would be present. `claims` overrides individual claims (self-tests forge with it).
export function mintRouterRequest({ secret, provider, caller, method, path: agentPath, query = '', body, nowS = Math.floor(Date.now() / 1000), owner = null, claims = {} }) {
    const upper = String(method).toUpperCase();
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: provider, sub: caller,
        actor: { kind: 'agent', id: caller, roles: [] }, caller: { kind: 'agent', id: caller, roles: ['agent'] },
        ...(owner ? { usr: owner.usr, delegation: owner.delegation } : {}),
        method: upper, path: agentPath, tool: COORDINATOR_ADMISSION_TOOL,
        rch: computeRchHttp({ method: upper, path: agentPath, query, bodyHash: rawBodyHash(body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat: nowS, exp: nowS + 30, ...claims
    };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    const input = `${b64json({ alg: 'HS256', typ: 'JWT' })}.${b64json(payload)}`;
    const token = `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
    return JSON.stringify({ invocationToken: token, invocationBody: { method: upper, path: agentPath, search: query } });
}

function parse(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        if (!['--port', '--provider-route', '--provider-principal', '--callers', '--front-port', '--route-port'].includes(flag) || index + 1 >= argv.length) {
            throw new Error(`unexpected argument ${flag}`);
        }
        options[flag] = argv[index + 1];
    }
    for (const required of ['--port', '--provider-route', '--provider-principal', '--callers', '--front-port']) {
        if (typeof options[required] !== 'string') throw new Error(`missing ${required}`);
    }
    return options;
}

function forward({ frontPort, agentPath, query, authInfo, body }) {
    return new Promise((resolve) => {
        const request = http.request({ host: '127.0.0.1', port: frontPort, method: 'POST', path: `${agentPath}${query}`, agent: false, headers: {
            'Content-Type': 'application/json', 'Content-Length': body.length, 'x-ploinky-auth-info': authInfo
        } }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
        });
        request.on('error', () => resolve({ status: 502, body: Buffer.from(JSON.stringify({ error: 'COORDINATOR_HOP_UNAVAILABLE' })) }));
        request.end(body);
    });
}

export function startLocalRouter({ port, providerRoute, providerPrincipal, callers, frontPort, routePort, secret }) {
    const prefix = `${AGENT_PORT_PREFIX}/${providerRoute}/${routePort}`;
    const server = http.createServer((req, res) => {
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => { total += chunk.length; if (total <= BODY_BYTES) chunks.push(chunk); });
        req.on('end', async () => {
            const send = (status, payload) => {
                const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
                res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length });
                res.end(bytes);
            };
            if (total > BODY_BYTES) return send(413, { error: 'request_too_large' });
            const raw = String(req.url || '');
            const queryIndex = raw.indexOf('?');
            const rawPath = queryIndex < 0 ? raw : raw.slice(0, queryIndex);
            const query = queryIndex < 0 ? '' : raw.slice(queryIndex);
            if (req.method !== 'POST' || !rawPath.startsWith(`${prefix}/`)) return send(404, { error: 'ROUTE_NOT_FOUND' });
            const caller = req.headers[LOCAL_CALLER_HEADER];
            if (typeof caller !== 'string' || !callers.includes(caller)) return send(403, { error: 'COORDINATOR_CALLER_DENIED' });
            const body = Buffer.concat(chunks);
            const agentPath = rawPath.slice(prefix.length);
            const authInfo = mintRouterRequest({ secret, provider: providerPrincipal, caller, method: 'POST', path: agentPath, query, body });
            const answer = await forward({ frontPort, agentPath, query, authInfo, body });
            send(answer.status, answer.body);
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

async function main(argv) {
    const options = parse(argv);
    const hex = String(process.env.RWCOORD_LOCAL_PROVIDER_SECRET || '');
    if (!/^[0-9a-f]{64,}$/i.test(hex)) throw new Error('RWCOORD_LOCAL_PROVIDER_SECRET must be a hex secret of at least 32 bytes');
    const server = await startLocalRouter({
        port: Number(options['--port']), providerRoute: options['--provider-route'], providerPrincipal: options['--provider-principal'],
        callers: options['--callers'].split(','), frontPort: Number(options['--front-port']), routePort: Number(options['--route-port'] ?? options['--front-port']),
        secret: Buffer.from(hex, 'hex')
    });
    process.stdout.write(`${JSON.stringify({ event: 'listening', port: server.address().port })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`localRouter: ${error.message}\n`);
        process.exitCode = 1;
    });
}

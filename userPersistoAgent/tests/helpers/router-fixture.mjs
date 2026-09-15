import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function createRouterSigner() {
    const runtimeRoot = [
        process.env.PLOINKY_AGENT_RUNTIME_ROOT,
        '/Agent',
        fileURLToPath(new URL('../../../../ploinky/Agent', import.meta.url)),
        fileURLToPath(new URL('../../../../../ploinky/Agent', import.meta.url)),
    ].filter(Boolean).find((root) => existsSync(join(root, 'lib/invocationAuth.mjs')));
    if (!runtimeRoot) throw new Error('Dashboard integration tests require PLOINKY_AGENT_RUNTIME_ROOT pointing to Ploinky/Agent.');
    process.env.PLOINKY_AGENT_RUNTIME_ROOT = runtimeRoot;
    const [{ signHmacJwt }, { computeRchHttp, sha256RawBodyHash }] = await Promise.all([
        import(pathToFileURL(join(runtimeRoot, 'lib/jwtSign.mjs')).href),
        import(pathToFileURL(join(runtimeRoot, 'lib/requestHash.mjs')).href),
    ]);
    const secret = randomBytes(32);
    const agentId = 'agent:AssistOSExplorer/userPersistoAgent';
    process.env.PLOINKY_AGENT_ID = agentId;
    process.env.PLOINKY_AGENT_SECRET = secret.toString('hex');

    return function headers({ method = 'GET', path, rawBody = '', userId, origin = 'https://account.example.test', claims = {}, carrierUserId = userId }) {
        const url = new URL(path, origin);
        const bodyHash = sha256RawBodyHash(rawBody);
        const now = Math.floor(Date.now() / 1000);
        const subject = `user:${userId}`;
        const payload = {
            typ: 'router-request', iss: 'ploinky-router', aud: agentId,
            sub: subject, actor: { kind: 'user', id: subject, roles: [] },
            method, path: url.pathname, tool: '__http_route__',
            rch: computeRchHttp({ method, path: url.pathname, query: url.search, bodyHash }),
            jti: randomBytes(12).toString('base64url'), iat: now, exp: now + 30,
            ...claims,
        };
        return {
            origin,
            'content-type': 'application/json; charset=utf-8',
            'x-forwarded-proto': url.protocol.slice(0, -1),
            'x-forwarded-host': url.host,
            'x-ploinky-auth-info': JSON.stringify({
                user: { id: carrierUserId, roles: ['admin'] },
                invocationToken: signHmacJwt({ payload, secret }),
                invocationBody: {
                    method, path: url.pathname, search: url.search, bodyHash,
                    externalPath: `/base-agent-additional-server/userPersistoAgent/7000${url.pathname}`,
                    routeKey: 'userPersistoAgent',
                },
            }),
        };
    };
}

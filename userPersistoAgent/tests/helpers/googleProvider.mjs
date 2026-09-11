import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, createHash, sign } from 'node:crypto';
import * as oidc from 'openid-client';
import { createGoogleProtocol } from '../../lib/auth/google.mjs';

export async function controlledGoogleProvider() {
    let keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let kid = 'fixture-1';
    let origin;
    const state = { claims: {}, subject: 'controlled-user', email: 'controlled@gmail.com', exchanges: 0, mode: '', tokenGate: null, coop: false,
        metadataStatus: 0, jwksStatus: 0, tokenStatus: 0 };
    const codes = new Map();
    const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, origin);
        const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
        const forcedStatus = { '/.well-known/openid-configuration': state.metadataStatus, '/jwks': state.jwksStatus, '/token': state.tokenStatus }[url.pathname];
        if (forcedStatus) return json(forcedStatus, { error: 'temporarily_unavailable' });
        if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
        if (url.pathname === '/jwks') return json(200, { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
        if (url.pathname === '/authorize') {
            if (state.coop) res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(`<h1>Controlled identity provider</h1><form method="get" action="/approve">${[...url.searchParams].map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`).join('')}<button>Continue with test identity</button></form>`);
        }
        if (url.pathname === '/approve') {
            const target = new URL(url.searchParams.get('redirect_uri'));
            target.searchParams.set('state', url.searchParams.get('state'));
            target.searchParams.set('iss', origin);
            if (state.mode === 'denied') target.searchParams.set('error', 'access_denied');
            else {
                const code = randomBytes(24).toString('base64url');
                codes.set(code, { params: url.searchParams, subject: state.subject, email: state.email, claims: { ...state.claims }, mode: state.mode });
                target.searchParams.set('code', code);
            }
            res.writeHead(303, { Location: target.href });
            return res.end();
        }
        if (url.pathname === '/token') {
            state.exchanges += 1;
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const params = new URLSearchParams(Buffer.concat(chunks).toString());
            const record = codes.get(params.get('code'));
            codes.delete(params.get('code'));
            if (state.tokenGate) await state.tokenGate;
            if (!record || params.get('client_id') !== 'controlled-google-client' || params.get('client_secret') !== 'controlled-google-secret'
                || params.get('redirect_uri') !== record.params.get('redirect_uri') || params.get('grant_type') !== 'authorization_code'
                || createHash('sha256').update(params.get('code_verifier') || '').digest('base64url') !== record.params.get('code_challenge')
                || record.params.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_grant' });
            const now = Math.floor(Date.now() / 1000);
            const claims = { iss: origin, sub: record.subject, aud: 'controlled-google-client', iat: now, exp: now + 300, nonce: record.params.get('nonce'),
                email: record.email, email_verified: true, ...record.claims };
            const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
            const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
            const signer = record.mode === 'bad-signature' ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : keys.privateKey;
            const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), signer).toString('base64url');
            return json(200, { access_token: 'unused-controlled-access-token', token_type: 'Bearer', expires_in: 300,
                ...(record.mode === 'no-id-token' ? {} : { id_token: `${header}.${payload}.${signature}` }) });
        }
        res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
    const protocol = createGoogleProtocol({ discover: (config) => oidc.discovery(new URL(origin), config.clientId,
        { id_token_signed_response_alg: 'RS256', [oidc.clockTolerance]: 30 }, oidc.ClientSecretPost(config.clientSecret),
        { timeout: 2, execute: [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks] }) });
    return { origin, state, protocol, rotate() { keys = generateKeyPairSync('rsa', { modulusLength: 2048 }); kid = randomBytes(6).toString('hex'); },
        async approve(authorizationUrl) { const url = new URL(authorizationUrl); url.pathname = '/approve'; const response = await fetch(url, { redirect: 'manual' }); return new URL(response.headers.get('location')); },
        async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

export class CookieBrowser {
    cookies = new Map();
    async fetch(url, options = {}) {
        const path = new URL(url).pathname;
        const cookies = [...this.cookies].filter(([, c]) => path.startsWith(c.path)).map(([name, c]) => `${name}=${c.value}`).join('; ');
        const response = await fetch(url, { ...options, redirect: 'manual', headers: { cookie: cookies, ...options.headers } });
        for (const raw of response.headers.getSetCookie()) {
            const [pair, ...attrs] = raw.split(';');
            const split = pair.indexOf('=');
            const name = pair.slice(0, split);
            if (attrs.some((attr) => /^\s*max-age=0$/i.test(attr))) this.cookies.delete(name);
            else this.cookies.set(name, { value: pair.slice(split + 1), path: attrs.find((attr) => /^\s*path=/i.test(attr))?.trim().slice(5) || '/' });
        }
        return response;
    }
    json(url, body, origin = new URL(url).origin) {
        return this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    }
    post(url, body, origin = new URL(url).origin) {
        return this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams(body) });
    }
}
export function csrf(html) { return html.match(/name="csrf" value="([^"]+)"/)?.[1]; }

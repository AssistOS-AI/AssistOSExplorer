import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertBrowserOrigin, sha256 } from './contracts.mjs';

export function prerequisite(message) {
    return Object.assign(new Error(message), { code: 'CONTROLLER_PREREQUISITE' });
}

export async function privateJson(file) {
    let handle;
    try {
        handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = await handle.stat();
        assert.ok(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0
            && stat.uid === process.getuid() && stat.size <= 1024 * 1024);
        const text = await handle.readFile('utf8'); const after = await handle.stat();
        for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], stat[key]);
        return JSON.parse(text);
    } catch { throw prerequisite('An owned private regular JSON input is required.'); }
    finally { if (handle) await handle.close(); }
}

export function cookieHeader(state, origin) {
    const url = new URL(origin);
    const cookies = (state?.cookies || []).filter(cookie => cookie.path === '/'
        && String(cookie.domain || '').replace(/^\./u, '') === url.hostname
        && (!cookie.secure || url.protocol === 'https:') && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
    assert.ok(cookies.length > 0, 'Authenticated browser state is stale or for a different origin.');
    return cookies.map(cookie => {
        assert.match(cookie.name, /^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/u);
        assert.equal(typeof cookie.value, 'string'); assert.doesNotMatch(cookie.value, /[;\r\n]/u);
        assert.equal(cookie.path, '/', 'Controller authentication requires root-scoped Router cookies.');
        return `${cookie.name}=${cookie.value}`;
    }).join('; ');
}

export function assertAdminToken(payload) {
    assert.ok(payload?.ok === true && payload.user && typeof (payload.user.id || payload.user.userId) === 'string',
        'Authenticated direct user is required.');
    assert.ok(Array.isArray(payload.user.roles) && payload.user.roles.some(role => String(role).toLowerCase() === 'admin'),
        'Authenticated administrator is required.');
    assert.ok(!payload.user.roles.some(role => String(role).toLowerCase() === 'guest'), 'Guest sessions cannot administer probes.');
    return sha256(String(payload.user.id || payload.user.userId));
}

export class ControllerSession {
    constructor(runtime, origin, request, close, fresh) {
        Object.assign(this, { runtime, origin, send: request, close, fresh });
    }

    async request(pathname, { method = 'GET', body, headers = {} } = {}) {
        assert.ok(pathname.startsWith('/') && !pathname.startsWith('//'));
        const target = new URL(pathname, this.origin); assert.equal(target.origin, this.origin);
        const response = await this.send(target.href, { method, headers: { origin: this.origin,
            accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const payload = await response.json();
        const status = typeof response.status === 'function' ? response.status() : response.status;
        const responseHeaders = typeof response.headers === 'function' ? response.headers() : Object.fromEntries(response.headers);
        this.runtime.receipts.push({ command: 'authenticated-controller-http', method,
            argumentHash: sha256(pathname), status, outputHash: sha256(JSON.stringify(payload)) });
        return { status, payload, headers: responseHeaders };
    }

    async proveAdmin() {
        const result = await this.request('/auth/token');
        assert.equal(result.status, 200, 'Administrator authentication is unavailable.');
        this.principalHash = assertAdminToken(result.payload);
        return { principalHash: this.principalHash, freshBrowserContext: this.fresh };
    }

    async mutationHeaders(routeKey) {
        assert.ok(['roboTeamAgent', 'explorer'].includes(routeKey));
        const result = await this.request(`/auth/token?mutationRoute=${routeKey}`);
        const proof = result.payload?.browserMutation;
        assert.ok(result.status === 200 && proof?.csrfToken && proof.routeKey === routeKey
            && proof.origin === this.origin && proof.generation, 'Fresh route-bound browser mutation proof is unavailable.');
        return { headers: { 'x-ploinky-browser-csrf-token': proof.csrfToken }, generation: proof.generation };
    }

    async roboTeam(method, apiPath, body) {
        assert.ok(['GET', 'POST', 'PATCH'].includes(method));
        assert.match(apiPath, /^api\/(?:robots(?:\/[a-z0-9][a-z0-9-]{2,63}\/coding-agents)?|control)$/u);
        const proof = method === 'GET' ? null : await this.mutationHeaders('roboTeamAgent');
        const result = await this.request(`/base-agent-additional-server/roboTeamAgent/3001/${apiPath}`,
            { method, body, headers: proof?.headers || {} });
        return { ...result, proofGeneration: proof?.generation };
    }
}

export async function openControllerSession(runtime) {
    const config = runtime.config.explorer;
    if (!config?.origin) throw prerequisite('Controller checks require the selected Box local Explorer origin.');
    const rows = JSON.parse(await runtime.command(runtime.config.engine, ['inspect', runtime.config.box.id]));
    assert.equal(rows.length, 1); assertBrowserOrigin(config.origin, rows[0]);
    try {
        const relative = path.relative(runtime.config.fixture, await fs.realpath(config.storageState));
        assert.ok(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
            'Private administrator state must remain outside the selected workspace.');
        const state = await privateJson(config.storageState);
        const cookie = cookieHeader(state, config.origin);
        const session = new ControllerSession(runtime, config.origin,
            (url, options) => fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(200000),
                headers: { ...options.headers, cookie } }), async () => {}, false);
        await session.proveAdmin(); return session;
    } catch { throw prerequisite('Current private authenticated administrator browser state is required.'); }
}

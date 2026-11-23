import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const zone = 'a'.repeat(32);
export const host = 'qa.example.test';
export const r1 = 'qa-cache-r1';
export const r2 = 'qa-cache-r2';
export const tokenEnv = 'TEST_RUNNER_RULES_TOKEN';
export const requestPhase = 'http_request_cache_settings';
export const responsePhase = 'http_response_cache_settings';
export const id = n => n.toString(16).padStart(32, '0');
export const definition = ['ref', 'description', 'expression', 'action', 'action_parameters', 'enabled'];
export const inventoryPath = phase => `/rulesets/phases/${phase}/entrypoint`;
export const entry = (phase, rules) => ({ id: id(phase === requestPhase ? 100 : 101), kind: 'zone', phase, rules });
export const foreign = n => ({
    id: id(n), ref: `unmanaged_${n}`, description: `Other rule ${n}`, enabled: true,
    expression: `(http.host eq "other${n}.example.test")`, action: 'set_cache_settings', action_parameters: { cache: false },
});

export function fixture(run) {
    const token = randomUUID();
    const env = { PUBLIC_HOST: host, CLOUDFLARE_ZONE_ID: zone, CLOUDFLARE_CACHE_R1_REF: r1,
        CLOUDFLARE_CACHE_R2_REF: r2, [tokenEnv]: token };
    const state = { request: null, response: entry(responsePhase, [foreign(11), foreign(12)]), calls: [], logs: [] };
    let next = 200;
    const success = result => Response.json({ success: true, result, errors: [] });
    const missing = () => Response.json({ success: false, errors: [{ code: 10003 }] }, { status: 404 });

    function dispatch({ path, method, body }) {
        if (method === 'GET' && !path) return success({ id: zone, name: 'example.test' });
        for (const [phase, key] of [[requestPhase, 'request'], [responsePhase, 'response']]) {
            if (method === 'GET' && path === inventoryPath(phase)) return state[key] ? success(state[key]) : missing();
        }
        if (method === 'POST' && path === '/rulesets') {
            assert.equal(state.request, null);
            assert.equal(body.kind, 'zone');
            assert.equal(body.phase, requestPhase);
            state.request = entry(requestPhase, structuredClone(body.rules).map(rule => ({ ...rule, id: id(next++) })));
            return success(state.request);
        }
        const set = state.request;
        assert.ok(set);
        const collection = `/rulesets/${set.id}/rules`;
        // Store copies so later edits to a stored rule cannot rewrite the recorded call.
        const { position, ...fields } = structuredClone(body);
        let rule;
        if (method === 'PATCH' && !definition.every(key => Object.hasOwn(fields, key))) {
            // Like the Rulesets API, a rule update must carry the full rule definition.
            return Response.json({ success: false, result: null, errors: [{ code: 20021 }] }, { status: 400 });
        }
        if (method === 'POST') {
            assert.equal(path, collection);
            assert.ok([r1, r2].includes(fields.ref));
            rule = { ...fields, id: id(next++) };
            set.rules.push(rule);
        } else {
            assert.equal(method, 'PATCH');
            rule = set.rules.find(item => path === `${collection}/${item.id}`);
            assert.ok(rule && [r1, r2].includes(rule.ref));
            Object.assign(rule, fields);
        }
        if (position) {
            set.rules.splice(set.rules.indexOf(rule), 1);
            const anchor = set.rules.findIndex(item => item.id === (position.before ?? position.after));
            assert.ok(anchor >= 0);
            set.rules.splice(anchor + Number(Boolean(position.after)), 0, rule);
        }
        return success(set);
    }

    // Surface fake-server assertions even when the reconciler redacts transport errors.
    let invalidCall;
    async function fetchImpl(address, options) {
        try {
            const base = `https://api.cloudflare.com/client/v4/zones/${zone}`;
            const url = String(address);
            assert.ok(url === base || url.startsWith(base + '/'));
            assert.equal(options.redirect, 'error');
            assert.ok(new Headers(options.headers).get('Authorization') === `Bearer ${token}`);
            const call = { method: options.method, path: url.slice(base.length), body: options.body && JSON.parse(options.body) };
            state.calls.push(call);
            const override = state.before?.(call);
            if (override) return override;
            const result = dispatch(call);
            if (call.method !== 'GET') state.afterWrite?.(call);
            return result;
        } catch (error) {
            if (error instanceof assert.AssertionError) invalidCall = error;
            throw error;
        }
    }
    async function argv(args, config = env) {
        try {
            return await run(args, { env: config, fetchImpl, log: (...parts) => state.logs.push(parts.join(' ')) });
        } finally {
            if (invalidCall) throw invalidCall;
            assert.ok(state.logs.every(line => !line.includes(token)), 'token was logged');
        }
    }
    return { state, env, token, argv, invoke: (command, ...flags) => argv([command, '--token-env', tokenEnv, ...flags]),
        writes: () => state.calls.filter(call => call.method !== 'GET'),
        owned: ref => state.request?.rules.find(rule => rule.ref === ref) };
}

export async function prepared(run) {
    const api = fixture(run);
    await api.invoke('ensure-r1');
    await api.invoke('r2-off');
    api.state.calls.length = 0;
    return api;
}

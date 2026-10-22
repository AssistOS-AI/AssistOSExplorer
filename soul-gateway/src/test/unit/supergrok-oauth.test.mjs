import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createSuperGrokAdapter } from '../../runtime/providers/oauth/xai-supergrok.mjs';
import { OAuthManager } from '../../runtime/providers/oauth-manager.mjs';
import { getProviderPresets } from '../../runtime/providers/provider-presets.mjs';

function setup(t, responses) {
    let time = 1_800_000_000_000;
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, params: new URLSearchParams(init.body), init });
        const next = responses.shift();
        assert.ok(next, 'Unexpected upstream request');
        return Response.json(next.body, { status: next.status || 200 });
    });
    return {
        adapter: createSuperGrokAdapter({ now: () => time }),
        calls,
        advance(ms) { time += ms; },
    };
}

const device = {
    body: {
        device_code: 'private-device-secret', user_code: 'ABCD',
        verification_uri: 'https://auth.x.ai/device',
        verification_uri_complete: 'https://auth.x.ai/device?user_code=ABCD',
        interval: 5, expires_in: 300,
    },
};
const pending = { status: 400, body: { error: 'authorization_pending' } };
const token = { body: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 } };

it('exposes SuperGrok OAuth alongside the xAI API-key template', () => {
    const presets = getProviderPresets();
    assert.equal(presets.xai.auth_strategy, 'api_key');
    const preset = presets['xai-supergrok'];
    assert.equal(preset.adapter_key, 'openai-api');
    assert.equal(preset.oauth_adapter_key, 'xai-supergrok');
    assert.equal(preset.auth_strategy, 'oauth');
    assert.equal(preset.base_url, 'https://api.x.ai/v1');
});

it('enforces polling intervals and increases backoff after slow_down', async (t) => {
    const s = setup(t, [device, pending,
        { status: 400, body: { error: 'slow_down' } }, token]);
    const flow = await s.adapter.startFlow();
    assert.equal(s.calls[0].url, 'https://auth.x.ai/oauth2/device/code');
    assert.match(s.calls[0].params.get('scope'), /offline_access.*api:access/);
    await assert.rejects(s.adapter.pollDeviceFlow(flow), { code: 'authorization_pending' });
    assert.equal(s.calls.length, 1);
    s.advance(5000);
    await assert.rejects(s.adapter.pollDeviceFlow(flow), { code: 'authorization_pending' });
    s.advance(5000);
    await assert.rejects(s.adapter.pollDeviceFlow(flow), { code: 'slow_down' });
    s.advance(5000);
    await assert.rejects(s.adapter.pollDeviceFlow(flow), { code: 'authorization_pending' });
    assert.equal(s.calls.length, 3);
    s.advance(5000);
    const credentials = await s.adapter.pollDeviceFlow(flow);
    assert.equal(credentials.accessToken, 'access');
    assert.equal(credentials.refreshToken, 'refresh');
    assert.equal(s.calls[3].params.get('device_code'), 'private-device-secret');
    assert.equal(s.calls[3].params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    await assert.rejects(s.adapter.pollDeviceFlow(flow), { code: 'expired_token' });
});

it('expires device authorization without making another upstream request', async (t) => {
    const s = setup(t, [device]);
    const flow = await s.adapter.startFlow();
    s.advance(300_000);
    await assert.rejects(s.adapter.pollDeviceFlow(flow), { code: 'expired_token', terminalOAuthFlow: true });
    assert.equal(flow.deviceState.code, null);
    assert.equal(s.calls.length, 1);
});

it('rejects denied authorization without exposing provider response details', async (t) => {
    const s = setup(t, [device, { status: 400, body: {
        error: 'access_denied', error_description: 'sensitive upstream details',
    } }]);
    const flow = await s.adapter.startFlow();
    s.advance(5000);
    await assert.rejects(s.adapter.pollDeviceFlow(flow), (err) => {
        assert.equal(err.code, 'access_denied');
        assert.equal(err.terminalOAuthFlow, true);
        assert.doesNotMatch(err.message, /sensitive/);
        return true;
    });
});

it('rejects malformed device and token responses', async (t) => {
    const s = setup(t, [{ body: {} }, device, { body: { access_token: 'access' } }]);
    await assert.rejects(s.adapter.startFlow(), /incomplete device/);
    const flow = await s.adapter.startFlow();
    s.advance(5000);
    await assert.rejects(s.adapter.pollDeviceFlow(flow), { code: 'invalid_token_response' });
});

it('uses JWT expiry when earlier and persists refresh-token rotation', async (t) => {
    const jwt = `e30.${Buffer.from(JSON.stringify({ exp: 1_800_000_100 })).toString('base64url')}.sig`;
    const s = setup(t, [
        { body: { access_token: jwt, refresh_token: 'rotated' } },
        { body: { access_token: 'next-access', expires_in: 600 } },
    ]);
    const first = await s.adapter.refreshTokens({ refreshToken: 'original' });
    assert.equal(first.accessTokenExpiresAt, new Date(1_800_000_100_000).toISOString());
    assert.equal(first.refreshToken, 'rotated');
    assert.equal(s.calls[0].params.get('grant_type'), 'refresh_token');
    assert.equal(s.calls[0].params.get('refresh_token'), 'original');
    const second = await s.adapter.refreshTokens(first);
    assert.equal(second.refreshToken, 'rotated');
    assert.equal(s.calls[1].params.get('refresh_token'), 'rotated');
});

it('completes through OAuthManager, keeping device secrets private and persisting tokens', async (t) => {
    const s = setup(t, [device, { status: 400, body: { error: 'slow_down' } }, token]);
    let stored;
    const manager = new OAuthManager({
        pool: {},
        accountsDao: { async upsertOAuth() { return { id: 'account-1' }; } },
        accountPool: {},
        oauthCredentialStore: {
            async allocatePath() { return '/test-credentials'; },
            async write(_path, payload) { stored = payload; },
        },
        log: { info() {}, warn() {}, error() {} },
    });
    manager.registerAdapter(s.adapter);
    const flow = await manager.startAuthFlow('provider-1', 'xai-supergrok');
    assert.equal(flow.userCode, 'ABCD');
    assert.doesNotMatch(JSON.stringify(flow), /private-device-secret|deviceState/);
    await assert.rejects(manager.pollPending('wrong-provider', flow.flowId), /mismatch/);
    s.advance(5000);
    assert.equal((await manager.pollPending('provider-1', flow.flowId)).status, 'pending');
    s.advance(10000);
    const result = await manager.pollPending('provider-1', flow.flowId);
    assert.equal(result.status, 'complete');
    assert.equal(stored.accessToken, 'access');
    assert.equal(stored.refreshToken, 'refresh');
    await assert.rejects(manager.pollPending('provider-1', flow.flowId), /not found/);
});

it('removes terminal flows from OAuthManager', async (t) => {
    const s = setup(t, [device]);
    const manager = new OAuthManager({ log: { info() {} } });
    manager.registerAdapter(s.adapter);
    const flow = await manager.startAuthFlow('provider-1', 'xai-supergrok');
    s.advance(300000);
    await assert.rejects(manager.pollPending('provider-1', flow.flowId), { code: 'expired_token' });
    await assert.rejects(manager.pollPending('provider-1', flow.flowId), /not found/);
});

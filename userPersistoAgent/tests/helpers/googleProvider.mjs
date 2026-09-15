import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createGoogleProtocol } from '../../lib/auth/google.mjs';

// Controlled GIS credentials still pass the production JOSE signature and claim
// verifier. Only Google's public-key source and browser SDK are substituted.
export async function controlledGoogleProvider() {
    let keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let kid = 'fixture-1';
    const state = { claims: {}, subject: 'controlled-user', email: 'controlled@gmail.com',
        verifications: 0, mode: '', verificationGate: null, verificationTimeout: 2_000, jwksStatus: 0 };
    const protocol = createGoogleProtocol({ jwks: async (header) => {
        state.verifications += 1;
        if (state.verificationGate) {
            let timer;
            try {
                await Promise.race([state.verificationGate, new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Controlled key lookup timed out.')), state.verificationTimeout);
                })]);
            } finally { clearTimeout(timer); }
        }
        if (state.jwksStatus || header.kid !== kid) throw new Error('Controlled signing key unavailable.');
        return keys.publicKey;
    } });
    const provider = {
        state, protocol,
        rotate() { keys = generateKeyPairSync('rsa', { modulusLength: 2048 }); kid = randomBytes(6).toString('hex'); },
        sign(nonce, clientId = 'controlled-google-client') {
            if (state.mode === 'no-id-token') return '';
            const now = Math.floor(Date.now() / 1000);
            const claims = { iss: 'https://accounts.google.com', sub: state.subject, aud: clientId, iat: now, exp: now + 300,
                nonce, email: state.email, email_verified: true, ...state.claims };
            const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
            const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
            const signer = state.mode === 'bad-signature' ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : keys.privateKey;
            return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), signer).toString('base64url')}`;
        },
        async credential(authorizationUrl, browser) {
            const response = await browser.fetch(authorizationUrl);
            assert.equal(response.status, 200, 'A live browser-bound GIS page is required to obtain the nonce.');
            const config = googleSignInConfig(await response.text());
            return { url: new URL(config.credentialUrl, authorizationUrl).href,
                body: { transaction: config.transaction, credential: provider.sign(config.nonce, config.clientId) }, config };
        },
        async submit(authorizationUrl, browser) {
            const credential = await provider.credential(authorizationUrl, browser);
            return browser.json(credential.url, credential.body);
        },
        async installBrowserSdk(context) {
            await context.exposeBinding('controlledGoogleCredential', (_source, nonce, clientId) => provider.sign(nonce, clientId));
            await context.route('https://accounts.google.com/gsi/client', route => route.fulfill({ status: 200,
                contentType: 'application/javascript', body: `(() => {
                    let configuration;
                    window.google = { accounts: { id: {
                        initialize(value) { configuration = value; },
                        renderButton(container) {
                            const button = document.createElement('button');
                            button.type = 'button';
                            button.textContent = 'Continue with test identity';
                            button.addEventListener('click', async () => configuration.callback({
                                credential: await window.controlledGoogleCredential(configuration.nonce, configuration.client_id),
                            }));
                            container.replaceChildren(button);
                        },
                        disableAutoSelect() {}, cancel() {},
                    } } };
                })();` }));
        },
        async close() {},
    };
    return provider;
}

export function googleSignInConfig(html) {
    const match = html.match(/<script id="google-sign-in-config" type="application\/json">([^<]+)<\/script>/);
    assert.ok(match, 'The sign-in page must provide its browser-bound GIS configuration.');
    return JSON.parse(match[1]);
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

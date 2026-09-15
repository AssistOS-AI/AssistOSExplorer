import { Provider, interactionPolicy } from 'oidc-provider';
import PersistoOidcAdapter from './adapter.mjs';
import { getOrCreateOidcKeys } from './secrets.mjs';
import { oidcIssuer } from './config.mjs';
import { getUserById, getUserRoles } from '../users.mjs';
import { getUserCapabilities } from '../authorization.mjs';
import { getClientMetadata } from './clients.mjs';
import { page } from './views.mjs';

let cached;

async function findAccount(_ctx, id) {
    const user = await getUserById(id);
    if (!user || user.status !== 'active') return undefined;
    return {
        accountId: user.id,
        async claims() {
            const fresh = await getUserById(id);
            if (!fresh || fresh.status !== 'active') return { sub: id };
            return {
                sub: fresh.id,
                // The email-less configured administrator has no email claim at all.
                ...(fresh.email ? { email: fresh.email, email_verified: Boolean(fresh.emailVerifiedAt) } : {}),
                ...(fresh.username ? { preferred_username: fresh.username } : {}),
                ...(fresh.displayName ? { name: fresh.displayName } : {}),
                roles: await getUserRoles(id),
                capabilities: await getUserCapabilities(id),
            };
        },
    };
}

async function activeToken(token) {
    if (!(await getClientMetadata(token.clientId))) return false;
    if (!token.accountId) return true;
    const user = await getUserById(token.accountId);
    return user?.status === 'active';
}

export async function createOidcProvider(issuer = oidcIssuer()) {
    if (!issuer) return null;
    const { jwks, cookieKeys } = await getOrCreateOidcKeys();
    const secure = issuer.protocol === 'https:';
    const policy = interactionPolicy.base();
    // A persisted session can outlive its active user. Reauthenticate before
    // consent instead of letting a stale accountId stand in for a live account.
    policy.get('login').checks.add(new interactionPolicy.Check(
        'active_account', 'End-User authentication is required', 'login_required',
        (ctx) => !ctx.oidc.account,
    ));
    const provider = new Provider(issuer.href, {
        adapter: PersistoOidcAdapter,
        clients: [],
        jwks,
        findAccount,
        claims: {
            openid: ['sub'],
            profile: ['name', 'preferred_username'],
            email: ['email', 'email_verified'],
            roles: ['roles'],
            capabilities: ['capabilities'],
        },
        scopes: ['openid', 'profile', 'email', 'offline_access', 'roles', 'capabilities', 'api'],
        extraParams: ['screen_hint'],
        subjectTypes: ['public'],
        responseTypes: ['code'],
        clientAuthMethods: ['none', 'client_secret_basic', 'client_secret_post'],
        pkce: { required: () => true },
        cookies: {
            keys: cookieKeys,
            names: { session: 'up_oidc_session', interaction: 'up_oidc_interaction', resume: 'up_oidc_resume' },
            long: { httpOnly: true, sameSite: 'lax', secure, path: issuer.pathname },
            short: { httpOnly: true, sameSite: 'lax', secure },
        },
        ttl: {
            AccessToken: 300,
            AuthorizationCode: 60,
            ClientCredentials: 300,
            Grant: 30 * 24 * 60 * 60,
            IdToken: 300,
            Interaction: 600,
            RefreshToken: 24 * 60 * 60,
            Session: 4 * 60 * 60,
        },
        rotateRefreshToken: true,
        revokeGrantPolicy: () => true,
        issueRefreshToken: (_ctx, client, code) => client.grantTypeAllowed('refresh_token') && code.scopes.has('offline_access'),
        interactions: { policy, url: (_ctx, interaction) => `${issuer.href}/interaction/${interaction.uid}` },
        features: {
            devInteractions: { enabled: false },
            registration: { enabled: false },
            clientIdMetadataDocument: { enabled: false },
            requestObjects: { enabled: false },
            pushedAuthorizationRequests: { enabled: false },
            resourceIndicators: { enabled: false },
            dPoP: { enabled: false },
            claimsParameter: { enabled: false },
            clientCredentials: { enabled: true },
            introspection: {
                enabled: true,
                allowedPolicy: async (_ctx, client, token) => client.clientAuthMethod !== 'none'
                    && token.clientId === client.clientId && await activeToken(token),
            },
            revocation: { enabled: true, allowedPolicy: (_ctx, client, token) => token.clientId === client.clientId },
            rpInitiatedLogout: {
                enabled: true,
                logoutSource: async (ctx, form) => {
                    ctx.body = page('Sign out', `<p>Sign out of your UserPersisto session?</p>${form}<button type="submit" form="op.logoutForm" name="logout" value="yes">Sign out</button>`);
                },
                postLogoutSuccessSource: async (ctx) => { ctx.body = page('Signed out', '<p>You have signed out of UserPersisto.</p>'); },
            },
        },
        routes: {
            authorization: '/authorize', token: '/token', userinfo: '/userinfo', jwks: '/jwks',
            introspection: '/introspect', revocation: '/revoke', end_session: '/logout',
        },
        enabledJWA: { idTokenSigningAlgValues: ['RS256'] },
        renderError: async (ctx, out) => {
            ctx.type = 'html';
            ctx.body = page('Unable to continue', `<p>${String(out.error || 'invalid_request').replace(/[^a-z_]/g, '')}</p><p>Return to the application and start again.</p>`);
        },
    });
    // Transport pins forwarded authority to the configured issuer before invoking
    // the provider; no request header can select an issuer or signing identity.
    provider.proxy = true;
    provider.use(async (ctx, next) => {
        await next();
        // Public metadata has no credentials. Reflect a syntactically valid
        // Origin so the Router can retain its exact-origin CORS response.
        if (ctx.oidc?.route === 'discovery' || ctx.oidc?.route === 'jwks') {
            const origin = ctx.get('origin');
            let parsed;
            try { parsed = new URL(origin); } catch { /* No browser Origin. */ }
            if (parsed && ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin) {
                ctx.set('Access-Control-Allow-Origin', origin);
                ctx.vary('Origin');
            }
        }
    });
    provider.on('server_error', () => {});
    return provider;
}

export async function getOidcProvider() {
    const issuer = oidcIssuer();
    if (!issuer) return null;
    const identity = `${issuer.href}\0${process.env.PERSISTENCE_FOLDER || ''}\0${process.env.USERPERSISTO_SETTINGS_KEY || ''}`;
    if (!cached || cached.identity !== identity) cached = { identity, promise: createOidcProvider(issuer) };
    return cached.promise;
}

export function resetOidcProviderForTests() { cached = undefined; }

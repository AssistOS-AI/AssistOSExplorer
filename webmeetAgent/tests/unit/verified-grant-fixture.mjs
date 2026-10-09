import { fileURLToPath } from 'node:url';

import { authInfoFromInvocation } from '../../../shared/invocation-auth.mjs';

// Builds WebMeet authInfo the way production does: the sibling Ploinky
// checkout's RouterRequestTokenService mints a router request, its Agent
// verifier checks it as AgentServer does, and the verified grant is normalized
// by authInfoFromInvocation. Importing this module fails if that checkout is
// missing, so listing tests cannot silently fall back to hand-written identities.
const PLOINKY_ROOT = new URL('../../../../ploinky/', import.meta.url);
// Ploinky's signer resolves AchillesAgentLib only from an explicit source.
process.env.PLOINKY_AGENTLIB_DIR ||= fileURLToPath(new URL('node_modules/achillesAgentLib', PLOINKY_ROOT));
const { RouterRequestTokenService } = await import(new URL('cli/server/security/tokens/RouterRequestTokenService.js', PLOINKY_ROOT).href);
const { verifyRouterRequestFromHeaders } = await import(new URL('Agent/lib/invocationAuth.mjs', PLOINKY_ROOT).href);
const { computeRchTool } = await import(new URL('Agent/lib/requestHash.mjs', PLOINKY_ROOT).href);

const WEBMEET_ID = 'agent:AchillesIDE/webmeetAgent';
const WEBMEET_SECRET = Buffer.alloc(32, 9);
const minter = new RouterRequestTokenService({ resolveAgentSecret: () => WEBMEET_SECRET });

async function verifiedAuthInfo(claims, tool) {
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool, arguments: {} });
    const { token } = await minter.mintWithPayload({ targetAgentId: WEBMEET_ID, method: 'POST', path: '/mcp', tool, rch, ...claims });
    const verified = verifyRouterRequestFromHeaders({ authorization: `Bearer ${token}` }, {
        env: { PLOINKY_AGENT_ID: WEBMEET_ID, PLOINKY_AGENT_SECRET: WEBMEET_SECRET.toString('hex') },
        method: 'POST', path: '/mcp', tool, rch,
    });
    if (!verified.ok) throw new Error(`fixture grant failed verification: ${verified.reason}`);
    return authInfoFromInvocation(verified.payload, { invocationToken: verified.rawToken });
}

// A direct browser user, as the Router mints it from the session user.
export async function directUserAuth({ id, roles = ['user'], capabilities, scope, tool = 'webmeet_room_list' }) {
    const subject = `user:${id}`;
    const lowered = roles.map((role) => String(role).trim().toLowerCase());
    return verifiedAuthInfo({
        sub: subject,
        actor: { kind: lowered.includes('guest') ? 'guest' : 'user', id: subject, roles, capabilities },
        ...(scope ? { scope } : {}),
    }, tool);
}

// A delegated agent call carrying a user's claims, as the Router mints it.
export async function delegatedUserAuth({ agentId, user, tool = 'webmeet_room_list' }) {
    return verifiedAuthInfo({
        sub: agentId,
        actor: { kind: 'agent', id: agentId, roles: [] },
        caller: { kind: 'agent', id: agentId, roles: ['agent'] },
        usr: user,
        delegation: { jti: 'fixture-delegation', scope: ['webmeet:rooms:list'], sourceAgentId: agentId },
    }, tool);
}

export const PRINCIPALS = Object.freeze({
    admin: { id: 'owner-1', roles: ['admin'], capabilities: ['explorer.access'] },
    explorerUser: { id: 'member-1', roles: ['user'], capabilities: ['explorer.access'] },
    selfRegistered: { id: 'self-1', roles: ['selfRegistered'], capabilities: ['selfregistered.dashboard.access'] },
    namedAdmin: { id: 'local:admin', roles: ['user'], capabilities: [] },
    adminGuest: { id: 'owner-2', roles: ['admin', 'guest'], capabilities: ['explorer.access'] },
});

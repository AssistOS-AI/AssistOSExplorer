import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Builds webAssist invocation grants the way production does: the sibling
// Ploinky checkout's RouterRequestTokenService mints a router request and its
// Agent verifier checks it as AgentServer does. The verified payload is what
// AgentServer places in `envelope.metadata.invocation`. Importing this module
// fails when that checkout is missing, so tests cannot silently fall back to
// hand-written identities.
const PLOINKY_ROOT = new URL('../../../../ploinky/', import.meta.url);
// Ploinky's signer resolves AchillesAgentLib only from an explicit source.
process.env.PLOINKY_AGENTLIB_DIR ||= fileURLToPath(new URL('node_modules/achillesAgentLib', PLOINKY_ROOT));
const { RouterRequestTokenService } = await import(new URL('cli/server/security/tokens/RouterRequestTokenService.js', PLOINKY_ROOT).href);
const { verifyRouterRequestFromHeaders } = await import(new URL('Agent/lib/invocationAuth.mjs', PLOINKY_ROOT).href);
const { computeRchTool } = await import(new URL('Agent/lib/requestHash.mjs', PLOINKY_ROOT).href);

export const PLOINKY_ROOT_PATH = fileURLToPath(PLOINKY_ROOT);
export const WEBASSIST_ID = 'agent:AchillesIDE/webAssist';
const WEBASSIST_SECRET = Buffer.alloc(32, 7);
const minter = new RouterRequestTokenService({ resolveAgentSecret: () => WEBASSIST_SECRET });

export async function verifiedGrant(claims, tool = 'web_cli_chat') {
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool, arguments: {} });
    const { token } = await minter.mintWithPayload({ targetAgentId: WEBASSIST_ID, method: 'POST', path: '/mcp', tool, rch, ...claims });
    const verified = verifyRouterRequestFromHeaders({ authorization: `Bearer ${token}` }, {
        env: { PLOINKY_AGENT_ID: WEBASSIST_ID, PLOINKY_AGENT_SECRET: WEBASSIST_SECRET.toString('hex') },
        method: 'POST', path: '/mcp', tool, rch,
    });
    if (!verified.ok) throw new Error(`fixture grant failed verification: ${verified.reason}`);
    return verified.payload;
}

// An anonymous visitor, as the Router mints it for the guest MCP route.
export async function guestGrant({ guestId = randomUUID(), roles = ['guest'], tool } = {}) {
    const subject = `user:guest:${guestId}`;
    return verifiedGrant({ sub: subject, actor: { kind: 'guest', id: subject, roles } }, tool);
}

// A direct browser user, as the Router mints it from the session user.
export async function userGrant({ id, roles = ['user'], capabilities = [], tool } = {}) {
    const subject = `user:${id}`;
    return verifiedGrant({ sub: subject, actor: { kind: 'user', id: subject, roles, capabilities } }, tool);
}

// A delegated agent call carrying a user's claims, as the Router mints it.
export async function delegatedGrant({ agentId = 'agent:AchillesIDE/explorer', user, tool } = {}) {
    return verifiedGrant({
        sub: agentId,
        actor: { kind: 'agent', id: agentId, roles: [] },
        caller: { kind: 'agent', id: agentId, roles: ['agent'] },
        usr: user,
        delegation: { jti: 'fixture-delegation', scope: ['webassist:chat'], sourceAgentId: agentId },
    }, tool);
}

// The stdin envelope AgentServer pipes to a tool command.
export function toolEnvelope(grant, input, tool = 'web_cli_chat') {
    return { tool, input, metadata: grant === undefined ? {} : { invocation: grant } };
}

export const PRINCIPALS = Object.freeze({
    admin: { id: 'owner-1', roles: ['admin'], capabilities: ['explorer.access'] },
    explorerUser: { id: 'member-1', roles: ['user'], capabilities: ['explorer.access'] },
    selfRegistered: { id: 'self-1', roles: ['selfRegistered'], capabilities: ['selfregistered.dashboard.access'] },
});

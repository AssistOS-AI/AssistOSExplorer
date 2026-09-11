import { getProfile, authorizeCapability, requireActiveActor } from '../lib/authorization.mjs';
import { updateUser, listUsers, setUserRoles } from '../lib/users.mjs';
import * as passkey from '../lib/auth/passkey.mjs';
import * as totp from '../lib/auth/totp.mjs';
import { consumeOperationGrant } from '../lib/auth/operationGrants.mjs';
import * as credits from '../lib/credits.mjs';
import * as billing from '../lib/billing.mjs';
import { getSettings as getAgentSettings, saveSettings as saveAgentSettings } from '../lib/settings.mjs';
import { getStore } from '../lib/store.mjs';
import { environmentPolicyOverrides, getAuthPolicy, isAuthMethodEnabled, updateAuthPolicy } from '../lib/policy.mjs';
import * as oidcClients from '../lib/oidc/clients.mjs';
import { getGoogleStatus } from '../lib/auth/google.mjs';

async function requireAdmin(context, capability = 'admin.users.manage') {
    const actor = requireActor(context);
    await requireActiveActor(actor, capability);
    return actor;
}

async function requireAuthMethod(method) {
    if (!(await isAuthMethodEnabled(method))) {
        throw Object.assign(new Error(`${method} authentication is not enabled.`), {
            code: 'auth_method_disabled',
            statusCode: 404,
        });
    }
}

function requireActor(context) {
    if (!context.actorUserId) {
        throw Object.assign(new Error('Authenticated user is required.'), {
            code: 'authentication_required',
            statusCode: 401,
        });
    }
    return context.actorUserId;
}

async function requireOwnedUser(args, context, capability = 'admin.billing.manage') {
    const actor = requireActor(context);
    await requireActiveActor(actor);
    const target = String(args.userId || '').trim();
    if (!target) throw Object.assign(new Error('userId is required.'), { code: 'user_id_required', statusCode: 400 });
    if (target !== actor) await requireAdmin(context, capability);
    return target;
}

const HANDLERS = {
    userpersisto_profile_get: async (_args, context) => {
        const actor = requireActor(context);
        await requireActiveActor(actor);
        return getProfile(actor);
    },
    userpersisto_profile_update: async (args, context) => {
        const actor = requireActor(context);
        await requireActiveActor(actor);
        await updateUser(actor, {
            ...(Object.prototype.hasOwnProperty.call(args, 'username') ? { username: args.username } : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'displayName') ? { displayName: args.displayName } : {}),
        }, { actorId: actor });
        return getProfile(actor);
    },
    userpersisto_authorize_capability: async (args) => authorizeCapability({
        userId: args.userId,
        capability: args.capability,
        resource: args.resource || ''
    }),
    userpersisto_user_list: async (args, context) => {
        await requireAdmin(context);
        return listUsers({
            start: args.start ?? 0,
            pageSize: args.pageSize ?? 50,
            search: args.search ?? '',
            excludeOnlyRole: args.excludeOnlyRole ?? '',
            includeRoleCounts: args.includeRoleCounts ?? false,
        });
    },
    userpersisto_user_update: async (args, context) => {
        const actorId = await requireAdmin(context);
        return updateUser(args.userId, {
            email: args.email,
            username: args.username,
            displayName: args.displayName,
            status: args.status,
        }, { actorId });
    },
    userpersisto_user_roles_update: async (args, context) => {
        await requireAdmin(context);
        return setUserRoles(args.userId, args.roles, { actorId: context.actorUserId });
    },
    // Enrollment starts only with a single-use grant from fresh My Account
    // re-authentication, bound to this actor, operation and account generation.
    userpersisto_passkey_registration_options: async (args, context) => {
        await requireAuthMethod('passkey');
        const actor = requireActor(context);
        await requireActiveActor(actor);
        const { generation } = await consumeOperationGrant({ userId: actor, operation: 'passkey.register', grant: args.grant });
        return passkey.registrationOptions({ userId: actor, origin: args.origin, rpId: args.rpId, generation });
    },
    userpersisto_passkey_registration_verify: async (args, context) => {
        await requireAuthMethod('passkey');
        const actor = requireActor(context);
        await requireActiveActor(actor);
        return passkey.registrationVerify({
            userId: actor,
            attestation: args.attestation,
            challengeKey: args.challengeKey,
            origin: args.origin,
        });
    },
    userpersisto_totp_setup_start: async (args, context) => {
        await requireAuthMethod('totp');
        const actor = requireActor(context);
        await requireActiveActor(actor);
        const { generation } = await consumeOperationGrant({ userId: actor, operation: 'totp.enroll', grant: args.grant });
        return totp.setupStart({ userId: actor, generation });
    },
    userpersisto_totp_setup_verify: async (args, context) => {
        await requireAuthMethod('totp');
        const actor = requireActor(context);
        await requireActiveActor(actor);
        return totp.setupVerify({ userId: actor, token: args.token, setupId: args.setupId });
    },
    userpersisto_credits_balance: async (args, context) => {
        const actor = requireActor(context);
        await requireActiveActor(actor);
        const target = args.userId && args.userId !== actor
            ? (await requireAdmin(context), args.userId)
            : actor;
        return credits.getBalance(target);
    },
    userpersisto_credits_grant: async (args, context) => {
        await requireAdmin(context, 'admin.billing.manage');
        return credits.grant({
            userId: args.userId,
            amount: args.amount,
            reason: args.reason || '',
            referenceId: args.referenceId || '',
            actorId: context.actorUserId
        });
    },
    userpersisto_credits_reserve: async (args, context) => credits.reserve({
        userId: await requireOwnedUser(args, context),
        amount: args.amount,
        reason: args.reason || '',
        referenceId: args.referenceId || ''
    }),
    userpersisto_credits_commit: async (args, context) => credits.commit({
        userId: await requireOwnedUser(args, context),
        amount: args.amount,
        referenceId: args.referenceId || ''
    }),
    userpersisto_credits_release: async (args, context) => credits.release({
        userId: await requireOwnedUser(args, context),
        amount: args.amount,
        referenceId: args.referenceId || ''
    }),
    userpersisto_credits_refund: async (args, context) => {
        await requireAdmin(context, 'admin.billing.manage');
        return credits.refund({
            userId: args.userId,
            amount: args.amount,
            reason: args.reason || '',
            referenceId: args.referenceId || '',
            actorId: context.actorUserId
        });
    },
    userpersisto_credits_ledger: async (args, context) => {
        const actor = requireActor(context);
        await requireActiveActor(actor);
        const target = args.userId && args.userId !== actor
            ? (await requireAdmin(context), args.userId)
            : actor;
        return credits.ledger({ userId: target, start: args.start || 0, pageSize: args.pageSize || 100 });
    },
    userpersisto_billing_checkout_create: async (args, context) => {
        const actor = requireActor(context);
        await requireActiveActor(actor);
        return billing.createCheckout({
            userId: actor,
            kind: args.kind,
            quantity: args.quantity ?? 1,
            idempotencyKey: args.idempotencyKey || '',
        });
    },
    userpersisto_billing_stripe_webhook_process: async (args) => billing.processStripeWebhook({
        rawBody: args.rawBody,
        signatureHeader: args.signatureHeader
    }),
    userpersisto_billing_subscription_get: async (args, context) => {
        const actor = requireActor(context);
        await requireActiveActor(actor);
        const target = args.userId && args.userId !== actor
            ? (await requireAdmin(context), args.userId)
            : actor;
        return billing.getSubscription(target);
    },
    userpersisto_billing_events_list: async (args, context) => {
        await requireAdmin(context, 'admin.billing.manage');
        return billing.listBillingEvents({ start: args.start || 0, pageSize: args.pageSize || 100 });
    },
    userpersisto_config_get: async (_args, context) => {
        await requireAdmin(context, 'admin.agentSettings.manage');
        return getAgentSettings();
    },
    userpersisto_config_set: async (args, context) => {
        await requireAdmin(context, 'admin.agentSettings.manage');
        await saveAgentSettings(args);
        return getAgentSettings();
    },
    userpersisto_auth_policy_get: async (_args, context) => {
        await requireAdmin(context, 'admin.agentSettings.manage');
        return {
            ...await getAuthPolicy(),
            registrationRole: 'selfRegistered',
            environmentOverrides: environmentPolicyOverrides(),
        };
    },
    userpersisto_auth_policy_set: async (args, context) => {
        const actorId = await requireAdmin(context, 'admin.agentSettings.manage');
        return updateAuthPolicy(args, { actorId });
    },
    userpersisto_google_status: async (_args, context) => {
        await requireAdmin(context, 'admin.agentSettings.manage');
        return getGoogleStatus();
    },
    userpersisto_oidc_clients_list: async (args, context) => oidcClients.listOidcClients(args, { actorId: requireActor(context) }),
    userpersisto_oidc_client_create: async (args, context) => oidcClients.createOidcClient(args, { actorId: requireActor(context) }),
    userpersisto_oidc_client_update: async (args, context) => oidcClients.updateOidcClient(args.client_id, args, { actorId: requireActor(context) }),
    userpersisto_oidc_client_delete: async (args, context) => oidcClients.deleteOidcClient(args.client_id, { actorId: requireActor(context) }),
    userpersisto_oidc_client_rotate_secret: async (args, context) => oidcClients.rotateOidcClientSecret(args.client_id, { actorId: requireActor(context) }),
    userpersisto_oidc_status: async (_args, context) => oidcClients.getOidcStatus({ actorId: requireActor(context) }),
    userpersisto_audit_events_list: async (args, context) => {
        await requireAdmin(context);
        const store = await getStore();
        return store.select('auditEvent', args.actorId ? { actorId: args.actorId } : {}, {
            sortBy: 'timestamp',
            descending: true,
            start: args.start || 0,
            pageSize: args.pageSize || 100
        });
    }
};

export function registerTools(map) {
    for (const [name, handler] of Object.entries(map || {})) {
        HANDLERS[name] = handler;
    }
}

export function hasTool(name) {
    return typeof HANDLERS[name] === 'function';
}

export async function runTool(name, args = {}, context = {}) {
    const handler = HANDLERS[name];
    if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
    }
    return handler(args, context);
}

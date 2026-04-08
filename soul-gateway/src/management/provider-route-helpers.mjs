import * as providersDao from '../db/dao/providers-dao.mjs';
import * as accountsDao from '../db/dao/provider-accounts-dao.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

export async function loadProviderOrRespond(ctx, providerId) {
    const provider = await providersDao.findById(ctx.appCtx.pool, providerId);
    if (!provider) {
        sendNotFound(ctx.res, 'Provider');
        return null;
    }
    return provider;
}

export function buildProviderLifecycleOptions(appCtx) {
    return {
        credentialManager: appCtx.services.credentialManager || null,
        services: appCtx.services.extensionServices || Object.freeze({}),
        logger: appCtx.log,
    };
}

export async function upsertProviderApiKeyAccount({
    appCtx,
    providerId,
    providerDisplayName,
    apiKey,
}) {
    if (!apiKey) {
        return null;
    }

    const { encrypt } = await import('../runtime/security/encryption.mjs');
    const encKey = appCtx.services.encryptionKey;
    const encrypted = encrypt(apiKey, encKey);
    const secretHint = apiKey.slice(0, 6) + '...' + apiKey.slice(-4);
    const existingAccounts = await accountsDao.listByProvider(
        appCtx.pool,
        providerId
    );
    const existing = existingAccounts.find(
        (account) => account.auth_type === 'api_key'
    );

    if (existing) {
        await appCtx.pool.query(
            `UPDATE soul_gateway.provider_accounts
       SET secret_ciphertext = $2, secret_iv = $3, secret_auth_tag = $4,
           secret_hint = $5, status = 'active', updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
            [
                existing.id,
                encrypted.ciphertext,
                encrypted.iv,
                encrypted.authTag,
                secretHint,
            ]
        );

        return { ...existing, secret_hint: secretHint, status: 'active' };
    }

    return accountsDao.create(appCtx.pool, {
        providerId,
        accountLabel: `${providerDisplayName} API Key`,
        authType: 'api_key',
        status: 'active',
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        secretHint,
    });
}

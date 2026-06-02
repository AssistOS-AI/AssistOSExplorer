import * as accountsDao from '../../db/dao/provider-accounts-dao.mjs';
import { encrypt } from '../security/encryption.mjs';

function buildSecretHint(apiKey) {
    if (apiKey.length <= 10) {
        return '********';
    }
    return apiKey.slice(0, 6) + '...' + apiKey.slice(-4);
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

    const encKey = appCtx.services.encryptionKey;
    if (!encKey) {
        throw new Error('Cannot store provider API key without encryptionKey');
    }

    const encrypted = encrypt(apiKey, encKey);
    const secretHint = buildSecretHint(apiKey);
    const existingAccounts = await accountsDao.listByProvider(
        appCtx.pool,
        providerId
    );
    const existing = existingAccounts.find(
        (account) => account.auth_type === 'api_key'
    );

    if (existing) {
        await appCtx.pool.query(
            `UPDATE provider_accounts
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

import * as providersDao from '../db/dao/providers-dao.mjs';
export { upsertProviderApiKeyAccount } from '../runtime/providers/api-key-account.mjs';
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

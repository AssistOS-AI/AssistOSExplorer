import * as modelsDao from '../db/dao/models-dao.mjs';
import * as modelAliasesDao from '../db/dao/model-aliases-dao.mjs';

export const COMPATIBILITY_MODEL_ALIASES = Object.freeze({
    'gpt-5.6-sol': 'fast',
});

export async function reconcileCompatibilityAliases({
    appCtx,
    aliases = COMPATIBILITY_MODEL_ALIASES,
    daos = { modelsDao, modelAliasesDao },
} = {}) {
    if (!appCtx?.pool) throw new TypeError('appCtx.pool is required');
    const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

    for (const [alias, targetKey] of Object.entries(aliases)) {
        const concreteAlias = await daos.modelsDao.findByKey(appCtx.pool, alias);
        if (concreteAlias) {
            summary.skipped += 1;
            appCtx.log?.warn?.('compatibility alias collides with a model key', {
                alias,
                targetKey,
            });
            continue;
        }

        const target = await daos.modelsDao.findByKey(appCtx.pool, targetKey);
        if (!target) {
            summary.skipped += 1;
            appCtx.log?.warn?.('compatibility alias target is unavailable', {
                alias,
                targetKey,
            });
            continue;
        }

        const existing = await daos.modelAliasesDao.findByAlias(
            appCtx.pool,
            alias
        );
        if (!existing) {
            await daos.modelAliasesDao.create(appCtx.pool, {
                alias,
                modelId: target.id,
            });
            summary.created += 1;
            continue;
        }
        if (existing.model_id === target.id) {
            summary.unchanged += 1;
            continue;
        }
        await daos.modelAliasesDao.updateModel(appCtx.pool, {
            alias,
            modelId: target.id,
        });
        summary.updated += 1;
    }

    appCtx.log?.info?.('compatibility model aliases reconciled', summary);
    return summary;
}

export default { reconcileCompatibilityAliases };

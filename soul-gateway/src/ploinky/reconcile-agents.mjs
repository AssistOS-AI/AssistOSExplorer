/**
 * reconcile-agents.mjs — reconcile discovered Ploinky agents into Soul
 * Gateway's provider/model catalog.
 *
 * The discovery client (`discovery-client.mjs`) returns the set of Ploinky
 * agents that speak the OpenAI chat-completions surface. This module mirrors
 * that set into the `providers` and `models` tables so request routing — which
 * resolves only against `appCtx.services.snapshot` — can reach those agents
 * through the `ploinky-agent-openai` backend.
 *
 * Each discovered agent maps to exactly one provider (stable key
 * `ploinky:<subjectId>`) and one model (stable id `ploinky/<repo>/<agent>`).
 * The granular discovery marker is stored ONLY in each row's `metadata` JSON
 * (`metadata.discoverySource === 'ploinky-agent-discovery'`); the column
 * `discovery_source` carries the schema enum value `synced`. Stale-disable and
 * "is this one of ours" decisions read the metadata marker, never the column,
 * so admin-configured providers/models (any other `discoverySource`) are never
 * touched.
 *
 * Stale-disable runs ONLY when the discovery response is complete
 * (`discovery.complete === true`). A partial or failed discovery
 * (`complete !== true`) still upserts the returned rows but never disables a
 * missing one, so a flaky probe can never tear down a previously discovered
 * agent.
 *
 * After any create/update/disable/re-enable, the runtime snapshot is rebuilt
 * via `performRuntimeRefresh(appCtx, { snapshot: true })`; if nothing changed,
 * no refresh is performed.
 *
 * DAO injection: real DAO modules are imported by default. Tests pass fake
 * `daos` (and may inject a spy `refresh`) without module mocking.
 */

import * as providersDao from '../db/dao/providers-dao.mjs';
import * as modelsDao from '../db/dao/models-dao.mjs';
import { performRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';

const DEFAULT_DAOS = Object.freeze({ providersDao, modelsDao });

// The metadata marker tagging rows this reconciler owns. Stale-disable and
// "ours vs admin" decisions key on this value, NOT on the `discovery_source`
// column (which carries the schema enum `synced`).
export const DISCOVERY_MARKER = 'ploinky-agent-discovery';

// Backend adapter key the reconciled providers route through (Task 7b backend).
const ADAPTER_KEY = 'ploinky-agent-openai';

const REFRESH_REASON = 'ploinky-agent-discovery.reconcile';

function readConfigField(config, key) {
    if (config?.env && typeof config.env === 'object' && config.env[key] != null) {
        return String(config.env[key]).trim();
    }
    if (config && config[key] != null) {
        return String(config[key]).trim();
    }
    return '';
}

/**
 * Stable provider key for a discovered agent.
 * @param {string} subjectId
 * @returns {string}
 */
export function providerKeyFor(subjectId) {
    return `ploinky:${subjectId}`;
}

/**
 * Stable model key for a discovered agent.
 * @param {string} repo
 * @param {string} agent
 * @returns {string}
 */
export function modelKeyFor(repo, agent) {
    return `ploinky/${repo}/${agent}`;
}

/**
 * Build the metadata marker object stored on both the provider and model rows.
 * @param {object} agent
 * @returns {object}
 */
function buildMetadata(agent) {
    return {
        discoverySource: DISCOVERY_MARKER,
        subjectId: agent.subjectId,
        routeKey: agent.routeKey,
        repo: agent.repo,
        agent: agent.agent,
        usesDefaultOpenAiResponder: agent.usesDefaultOpenAiResponder === true,
    };
}

/**
 * True when a row was written by this reconciler (metadata marker present).
 * @param {object} row
 * @returns {boolean}
 */
function isDiscoveredRow(row) {
    return row?.metadata?.discoverySource === DISCOVERY_MARKER;
}

/**
 * Upsert the provider row for a discovered agent. Returns
 * `{ row, mode }` where `mode` is `'created' | 'updated' | 'unchanged'`.
 */
async function upsertProvider({ pool, daos, agent, routerUrl }) {
    const providerKey = providerKeyFor(agent.subjectId);
    const desired = {
        displayName: `Ploinky agent ${agent.subjectId}`,
        kind: 'external_api',
        adapterKey: ADAPTER_KEY,
        authStrategy: 'none',
        providerMode: 'external_api',
        baseUrl: routerUrl || null,
        enabled: true,
        metadata: buildMetadata(agent),
    };

    const existing = await daos.providersDao.findByKey(pool, providerKey);
    if (!existing) {
        const row = await daos.providersDao.create(pool, {
            providerKey,
            ...desired,
        });
        return { row, mode: 'created' };
    }

    const update = providerUpdateDiff(existing, desired);
    if (Object.keys(update).length === 0) {
        return { row: existing, mode: 'unchanged' };
    }
    const row = await daos.providersDao.update(pool, existing.id, update);
    return { row: row || existing, mode: 'updated' };
}

/**
 * Compute the minimal update for an existing provider row so a no-op
 * reconciliation does not report a change (and so admin-set unrelated columns
 * are left alone).
 */
function providerUpdateDiff(existing, desired) {
    const update = {};
    if (existing.display_name !== desired.displayName) {
        update.displayName = desired.displayName;
    }
    if (existing.kind !== desired.kind) {
        update.kind = desired.kind;
    }
    if (existing.adapter_key !== desired.adapterKey) {
        update.adapterKey = desired.adapterKey;
    }
    if (existing.auth_strategy !== desired.authStrategy) {
        update.authStrategy = desired.authStrategy;
    }
    if (existing.provider_mode !== desired.providerMode) {
        update.providerMode = desired.providerMode;
    }
    if ((existing.base_url || null) !== (desired.baseUrl || null)) {
        update.baseUrl = desired.baseUrl;
    }
    if (!existing.enabled) {
        update.enabled = true;
    }
    if (!metadataEqual(existing.metadata, desired.metadata)) {
        update.metadata = desired.metadata;
    }
    return update;
}

/**
 * Upsert the model row for a discovered agent. Returns
 * `{ row, mode }` where `mode` is `'created' | 'updated' | 'unchanged'`.
 */
async function upsertModel({ pool, daos, agent, providerId }) {
    const modelKey = modelKeyFor(agent.repo, agent.agent);
    const desired = {
        displayName: agent.name || agent.agent,
        providerId,
        providerModelId: agent.subjectId,
        strategyKind: 'direct',
        discoverySource: 'synced',
        enabled: true,
        metadata: buildMetadata(agent),
    };

    const existing = await daos.modelsDao.findByKey(pool, modelKey);
    if (!existing) {
        const row = await daos.modelsDao.create(pool, {
            modelKey,
            ...desired,
        });
        return { row, mode: 'created' };
    }

    const update = modelUpdateDiff(existing, desired);
    if (Object.keys(update).length === 0) {
        return { row: existing, mode: 'unchanged' };
    }
    const row = await daos.modelsDao.update(pool, existing.id, update);
    return { row: row || existing, mode: 'updated' };
}

function modelUpdateDiff(existing, desired) {
    const update = {};
    if (existing.display_name !== desired.displayName) {
        update.displayName = desired.displayName;
    }
    if (existing.provider_id !== desired.providerId) {
        update.providerId = desired.providerId;
    }
    if (existing.provider_model_id !== desired.providerModelId) {
        update.providerModelId = desired.providerModelId;
    }
    if ((existing.strategy_kind || 'direct') !== desired.strategyKind) {
        update.strategyKind = desired.strategyKind;
    }
    if (existing.discovery_source !== desired.discoverySource) {
        update.discoverySource = desired.discoverySource;
    }
    if (!existing.enabled) {
        update.enabled = true;
    }
    if (!metadataEqual(existing.metadata, desired.metadata)) {
        update.metadata = desired.metadata;
    }
    return update;
}

/**
 * Stable-stringify comparison of two metadata objects. Both are plain JSON
 * objects written by `buildMetadata`, so key order is the only volatile
 * dimension; sort keys before comparing.
 */
function metadataEqual(a, b) {
    const objA = a && typeof a === 'object' ? a : {};
    const objB = b && typeof b === 'object' ? b : {};
    return stableStringify(objA) === stableStringify(objB);
}

function stableStringify(obj) {
    const keys = Object.keys(obj).sort();
    return JSON.stringify(obj, keys);
}

/**
 * Core reconciliation. Exported with explicit `daos`/`refresh` seams for tests.
 *
 * @param {object} args
 * @param {object} args.appCtx
 * @param {{ complete: boolean, agents: object[] }} args.discovery
 * @param {{ providersDao: object, modelsDao: object }} [args.daos]
 * @param {Function} [args.refresh] performRuntimeRefresh-compatible injection
 * @returns {Promise<object>} summary
 */
export async function reconcilePloinkyAgentRecords({
    appCtx,
    discovery,
    daos = DEFAULT_DAOS,
    refresh = performRuntimeRefresh,
}) {
    const { pool, log } = appCtx;
    const summary = {
        scanned: 0,
        created: 0,
        updated: 0,
        disabled: 0,
        skipped: 0,
        refreshed: false,
    };

    if (!pool) {
        return summary;
    }

    const config = appCtx.config || {};
    const selfSubjectId = readConfigField(config, 'PLOINKY_AGENT_ID');
    const routerUrl = readConfigField(config, 'PLOINKY_ROUTER_URL');

    const agents = Array.isArray(discovery?.agents) ? discovery.agents : [];
    const complete = discovery?.complete === true;

    let changed = false;
    // Keys we touched this pass — used to compute stale rows when complete.
    const seenProviderKeys = new Set();
    const seenModelKeys = new Set();

    for (const agent of agents) {
        summary.scanned += 1;

        // Skip Soul Gateway's own subject id BEFORE any upsert.
        if (selfSubjectId && agent.subjectId === selfSubjectId) {
            summary.skipped += 1;
            continue;
        }

        const providerResult = await upsertProvider({
            pool,
            daos,
            agent,
            routerUrl,
        });
        seenProviderKeys.add(providerKeyFor(agent.subjectId));
        applyTally(summary, providerResult.mode);
        if (providerResult.mode !== 'unchanged') {
            changed = true;
        }

        const modelResult = await upsertModel({
            pool,
            daos,
            agent,
            providerId: providerResult.row.id,
        });
        seenModelKeys.add(modelKeyFor(agent.repo, agent.agent));
        applyTally(summary, modelResult.mode);
        if (modelResult.mode !== 'unchanged') {
            changed = true;
        }
    }

    // Stale-disable ONLY when the discovery is complete. Never touch rows
    // lacking the metadata marker (admin/manual rows).
    if (complete) {
        const disabledCount = await disableStaleRows({
            pool,
            daos,
            seenProviderKeys,
            seenModelKeys,
            log,
        });
        if (disabledCount > 0) {
            summary.disabled += disabledCount;
            changed = true;
        }
    }

    if (changed) {
        await refresh(appCtx, { snapshot: true, reason: REFRESH_REASON });
        summary.refreshed = true;
    }

    log?.info?.('ploinky agent reconciliation complete', {
        scanned: summary.scanned,
        created: summary.created,
        updated: summary.updated,
        disabled: summary.disabled,
        skipped: summary.skipped,
        complete,
        refreshed: summary.refreshed,
    });

    return summary;
}

function applyTally(summary, mode) {
    if (mode === 'created') {
        summary.created += 1;
    } else if (mode === 'updated') {
        summary.updated += 1;
    }
}

/**
 * Disable discovered provider/model rows that are no longer returned by a
 * complete discovery. Only rows carrying the metadata marker are eligible;
 * everything else (admin/manual) is left untouched. Returns the number of rows
 * disabled.
 */
async function disableStaleRows({
    pool,
    daos,
    seenProviderKeys,
    seenModelKeys,
    log,
}) {
    let disabled = 0;

    // Models first, so a provider is never disabled while a still-enabled
    // discovered model references it.
    const allModels = await listAll(daos.modelsDao, pool);
    for (const model of allModels) {
        if (!isDiscoveredRow(model)) {
            continue;
        }
        if (seenModelKeys.has(model.model_key)) {
            continue;
        }
        if (model.enabled === false) {
            continue;
        }
        await daos.modelsDao.disable(pool, model.id);
        disabled += 1;
        log?.info?.('disabled stale discovered model', {
            modelKey: model.model_key,
        });
    }

    const allProviders = await listAll(daos.providersDao, pool);
    for (const provider of allProviders) {
        if (!isDiscoveredRow(provider)) {
            continue;
        }
        if (seenProviderKeys.has(provider.provider_key)) {
            continue;
        }
        if (provider.enabled === false) {
            continue;
        }
        await daos.providersDao.update(pool, provider.id, { enabled: false });
        disabled += 1;
        log?.info?.('disabled stale discovered provider', {
            providerKey: provider.provider_key,
        });
    }

    return disabled;
}

/**
 * List every row from a DAO that exposes `list(pool, opts)`, paging through if
 * the DAO honors limit/offset. Fake test DAOs may return everything in one
 * call; that is fine.
 */
async function listAll(dao, pool) {
    if (typeof dao.list !== 'function') {
        return [];
    }
    const pageSize = 500;
    const out = [];
    let offset = 0;
    // Guard against fake DAOs that ignore paging and would otherwise loop
    // forever by breaking when a page does not advance.
    for (let guard = 0; guard < 1000; guard += 1) {
        const page = await dao.list(pool, { limit: pageSize, offset });
        if (!Array.isArray(page) || page.length === 0) {
            break;
        }
        out.push(...page);
        if (page.length < pageSize) {
            break;
        }
        offset += pageSize;
    }
    return out;
}

/**
 * Public entry point. Imports real DAO modules by default; tests can override
 * `daos`.
 *
 * @param {object} args
 * @param {object} args.appCtx
 * @param {{ complete: boolean, agents: object[] }} args.discovery
 * @param {{ providersDao: object, modelsDao: object }} [args.daos]
 * @returns {Promise<object>}
 */
export async function reconcilePloinkyAgents({ appCtx, discovery, daos = DEFAULT_DAOS }) {
    return reconcilePloinkyAgentRecords({ appCtx, discovery, daos });
}

export default {
    DISCOVERY_MARKER,
    providerKeyFor,
    modelKeyFor,
    reconcilePloinkyAgents,
    reconcilePloinkyAgentRecords,
};

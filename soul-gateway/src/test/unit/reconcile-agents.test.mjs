import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    reconcilePloinkyAgentRecords,
    reconcilePloinkyAgents,
    providerKeyFor,
    modelKeyFor,
    DISCOVERY_MARKER,
} from '../../ploinky/reconcile-agents.mjs';
import { openDatabase, initializeSchema } from '../../db/sqlite-db.mjs';
import * as providersDao from '../../db/dao/providers-dao.mjs';
import * as modelsDao from '../../db/dao/models-dao.mjs';
import {
    installSnapshotServices,
    installRuntimeCoordinationServices,
} from '../../bootstrap/service-installers.mjs';
import { loadRuntimeSnapshot } from '../../runtime/registry/snapshot-loader.mjs';
import { runInitialPloinkyReconcile } from '../../ploinky/discovery-scheduler.mjs';

const SILENT_LOG = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

function agent(overrides = {}) {
    return {
        subjectId: 'agent:demo/echo',
        routeKey: 'demo-echo',
        repo: 'demo',
        agent: 'echo',
        name: 'Echo Agent',
        usesDefaultOpenAiResponder: true,
        ...overrides,
    };
}

// ── In-memory fake DAOs (camelCase create inputs → snake_case rows, like the
// real SQLite layer returns). ─────────────────────────────────────────────

function makeFakeProvidersDao(seed = []) {
    const rows = new Map(); // id -> row
    const byKey = new Map(); // provider_key -> id
    for (const r of seed) {
        rows.set(r.id, r);
        byKey.set(r.provider_key, r.id);
    }
    return {
        rows,
        async findByKey(_pool, providerKey) {
            const id = byKey.get(providerKey);
            return id ? rows.get(id) : null;
        },
        async create(_pool, input) {
            const id = randomUUID();
            const row = {
                id,
                provider_key: input.providerKey,
                display_name: input.displayName,
                kind: input.kind,
                adapter_key: input.adapterKey,
                auth_strategy: input.authStrategy,
                provider_mode: input.providerMode ?? 'external_api',
                base_url: input.baseUrl ?? null,
                enabled: input.enabled ?? true,
                metadata: input.metadata ?? {},
            };
            rows.set(id, row);
            byKey.set(row.provider_key, id);
            return row;
        },
        async update(_pool, id, fields) {
            const row = rows.get(id);
            if (!row) return null;
            const map = {
                displayName: 'display_name',
                kind: 'kind',
                adapterKey: 'adapter_key',
                authStrategy: 'auth_strategy',
                providerMode: 'provider_mode',
                baseUrl: 'base_url',
                enabled: 'enabled',
                metadata: 'metadata',
            };
            for (const [k, v] of Object.entries(fields)) {
                row[map[k] || k] = v;
            }
            return row;
        },
        async list(_pool) {
            return [...rows.values()];
        },
    };
}

function makeFakeModelsDao(seed = []) {
    const rows = new Map();
    const byKey = new Map();
    for (const r of seed) {
        rows.set(r.id, r);
        byKey.set(r.model_key, r.id);
    }
    return {
        rows,
        async findByKey(_pool, modelKey) {
            const id = byKey.get(modelKey);
            return id ? rows.get(id) : null;
        },
        async create(_pool, input) {
            const id = randomUUID();
            const row = {
                id,
                model_key: input.modelKey,
                display_name: input.displayName,
                provider_id: input.providerId,
                provider_model_id: input.providerModelId,
                strategy_kind: input.strategyKind ?? 'direct',
                discovery_source: input.discoverySource ?? 'manual',
                enabled: input.enabled ?? true,
                metadata: input.metadata ?? {},
            };
            rows.set(id, row);
            byKey.set(row.model_key, id);
            return row;
        },
        async update(_pool, id, fields) {
            const row = rows.get(id);
            if (!row) return null;
            const map = {
                displayName: 'display_name',
                providerId: 'provider_id',
                providerModelId: 'provider_model_id',
                strategyKind: 'strategy_kind',
                discoverySource: 'discovery_source',
                enabled: 'enabled',
                metadata: 'metadata',
            };
            for (const [k, v] of Object.entries(fields)) {
                row[map[k] || k] = v;
            }
            return row;
        },
        async disable(_pool, id) {
            const row = rows.get(id);
            if (!row) return null;
            row.enabled = false;
            return row;
        },
        async list(_pool) {
            return [...rows.values()];
        },
    };
}

function makeAppCtx({ env = {} } = {}) {
    return {
        pool: {},
        log: SILENT_LOG,
        config: {
            env: {
                PLOINKY_ROUTER_URL: 'http://router.local',
                PLOINKY_AGENT_ID: 'agent:proxies/soul-gateway',
                ...env,
            },
        },
        services: {},
    };
}

function spyRefresh() {
    const calls = [];
    const fn = async (appCtx, options) => {
        calls.push(options);
        return { reason: options.reason };
    };
    fn.calls = calls;
    return fn;
}

describe('reconcilePloinkyAgentRecords (fake daos)', () => {
    it('creates provider + model rows for a discovered agent (no chatCompletions needed)', async () => {
        const providersFake = makeFakeProvidersDao();
        const modelsFake = makeFakeModelsDao();
        const refresh = spyRefresh();
        const appCtx = makeAppCtx();

        const summary = await reconcilePloinkyAgentRecords({
            appCtx,
            discovery: { complete: true, agents: [agent()] },
            daos: { providersDao: providersFake, modelsDao: modelsFake },
            refresh,
        });

        assert.equal(summary.created, 2); // one provider, one model
        assert.equal(summary.refreshed, true);

        const provider = await providersFake.findByKey(
            null,
            providerKeyFor('agent:demo/echo')
        );
        assert.ok(provider);
        assert.equal(provider.kind, 'external_api');
        assert.equal(provider.provider_mode, 'external_api');
        assert.equal(provider.adapter_key, 'ploinky-agent-openai');
        assert.equal(provider.auth_strategy, 'none');
        assert.equal(provider.display_name, 'Ploinky agent agent:demo/echo');
        assert.equal(provider.base_url, 'http://router.local');
        assert.equal(provider.metadata.discoverySource, DISCOVERY_MARKER);
        assert.equal(provider.metadata.routeKey, 'demo-echo');

        const model = await modelsFake.findByKey(null, modelKeyFor('demo', 'echo'));
        assert.ok(model);
        assert.equal(model.model_key, 'ploinky/demo/echo');
        assert.equal(model.display_name, 'Echo Agent');
        assert.equal(model.provider_id, provider.id);
        assert.equal(model.provider_model_id, 'agent:demo/echo');
        assert.equal(model.strategy_kind, 'direct');
        assert.equal(model.discovery_source, 'synced');
        assert.equal(model.enabled, true);
        assert.equal(model.metadata.discoverySource, DISCOVERY_MARKER);
    });

    it('buildMetadata persists responderKind (default llm)', async () => {
        const providersFake = makeFakeProvidersDao();
        const modelsFake = makeFakeModelsDao();
        const appCtx = makeAppCtx();
        const discoveredAgent = agent({ responderKind: 'inert' });

        await reconcilePloinkyAgentRecords({
            appCtx,
            discovery: { complete: true, agents: [discoveredAgent] },
            daos: { providersDao: providersFake, modelsDao: modelsFake },
            refresh: spyRefresh(),
        });

        const provider = await providersFake.findByKey(
            null,
            providerKeyFor(discoveredAgent.subjectId)
        );
        assert.ok(provider);
        assert.equal(provider.metadata.responderKind, 'inert');

        const model = await modelsFake.findByKey(
            null,
            modelKeyFor(discoveredAgent.repo, discoveredAgent.agent)
        );
        assert.ok(model);
        assert.equal(model.metadata.responderKind, 'inert');
    });

    it('calls performRuntimeRefresh({ snapshot: true }) after row changes', async () => {
        const refresh = spyRefresh();
        await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx(),
            discovery: { complete: true, agents: [agent()] },
            daos: {
                providersDao: makeFakeProvidersDao(),
                modelsDao: makeFakeModelsDao(),
            },
            refresh,
        });
        assert.equal(refresh.calls.length, 1);
        assert.equal(refresh.calls[0].snapshot, true);
    });

    it('does NOT refresh when nothing changed (idempotent second pass)', async () => {
        const providersFake = makeFakeProvidersDao();
        const modelsFake = makeFakeModelsDao();
        const daos = { providersDao: providersFake, modelsDao: modelsFake };
        const discovery = { complete: true, agents: [agent()] };

        const first = spyRefresh();
        await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx(),
            discovery,
            daos,
            refresh: first,
        });
        assert.equal(first.calls.length, 1);

        const second = spyRefresh();
        const summary = await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx(),
            discovery,
            daos,
            refresh: second,
        });
        assert.equal(summary.created, 0);
        assert.equal(summary.updated, 0);
        assert.equal(summary.refreshed, false);
        assert.equal(second.calls.length, 0);
    });

    it("skips Soul Gateway's own subject id", async () => {
        const providersFake = makeFakeProvidersDao();
        const modelsFake = makeFakeModelsDao();
        const refresh = spyRefresh();

        const summary = await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx({
                env: { PLOINKY_AGENT_ID: 'agent:proxies/soul-gateway' },
            }),
            discovery: {
                complete: true,
                agents: [
                    agent({ subjectId: 'agent:proxies/soul-gateway' }),
                    agent(),
                ],
            },
            daos: { providersDao: providersFake, modelsDao: modelsFake },
            refresh,
        });

        assert.equal(summary.skipped, 1);
        assert.equal(summary.created, 2); // only the non-self agent
        assert.equal(providersFake.rows.size, 1);
        assert.equal(
            await providersFake.findByKey(
                null,
                providerKeyFor('agent:proxies/soul-gateway')
            ),
            null
        );
    });

    it('marks stale discovered rows but never touches manual rows, only when complete', async () => {
        // Seed: one stale discovered provider+model (NOT in this discovery) and
        // one admin/manual provider+model that must be left alone.
        const stalePid = 'prov-stale';
        const manualPid = 'prov-manual';
        const providersFake = makeFakeProvidersDao([
            {
                id: stalePid,
                provider_key: providerKeyFor('agent:old/gone'),
                display_name: 'Ploinky agent agent:old/gone',
                kind: 'external_api',
                adapter_key: 'ploinky-agent-openai',
                auth_strategy: 'none',
                provider_mode: 'external_api',
                base_url: 'http://router.local',
                enabled: true,
                metadata: {
                    discoverySource: DISCOVERY_MARKER,
                    subjectId: 'agent:old/gone',
                    routeKey: 'old-gone',
                    repo: 'old',
                    agent: 'gone',
                },
            },
            {
                id: manualPid,
                provider_key: 'openai',
                display_name: 'OpenAI',
                kind: 'external_api',
                adapter_key: 'openai-api',
                auth_strategy: 'api_key',
                provider_mode: 'external_api',
                base_url: 'https://api.openai.com',
                enabled: true,
                metadata: {}, // no marker
            },
        ]);
        const modelsFake = makeFakeModelsDao([
            {
                id: 'model-stale',
                model_key: 'ploinky/old/gone',
                display_name: 'Old Gone',
                provider_id: stalePid,
                provider_model_id: 'agent:old/gone',
                strategy_kind: 'direct',
                discovery_source: 'synced',
                enabled: true,
                metadata: { discoverySource: DISCOVERY_MARKER },
            },
            {
                id: 'model-manual',
                model_key: 'openai/gpt-4o',
                display_name: 'GPT-4o',
                provider_id: manualPid,
                provider_model_id: 'gpt-4o',
                strategy_kind: 'direct',
                discovery_source: 'manual',
                enabled: true,
                metadata: {}, // no marker
            },
        ]);
        const refresh = spyRefresh();

        const summary = await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx(),
            discovery: { complete: true, agents: [agent()] },
            daos: { providersDao: providersFake, modelsDao: modelsFake },
            refresh,
        });

        // Created the new agent's provider+model; disabled the stale pair.
        assert.equal(summary.created, 2);
        assert.equal(summary.disabled, 2);
        assert.equal(summary.refreshed, true);

        assert.equal(providersFake.rows.get(stalePid).enabled, false);
        assert.equal(modelsFake.rows.get('model-stale').enabled, false);
        // Manual rows untouched.
        assert.equal(providersFake.rows.get(manualPid).enabled, true);
        assert.equal(modelsFake.rows.get('model-manual').enabled, true);
    });

    it('partial discovery (complete=false) preserves existing discovered rows that are missing', async () => {
        const stalePid = 'prov-stale';
        const providersFake = makeFakeProvidersDao([
            {
                id: stalePid,
                provider_key: providerKeyFor('agent:old/gone'),
                display_name: 'Ploinky agent agent:old/gone',
                kind: 'external_api',
                adapter_key: 'ploinky-agent-openai',
                auth_strategy: 'none',
                provider_mode: 'external_api',
                base_url: 'http://router.local',
                enabled: true,
                metadata: { discoverySource: DISCOVERY_MARKER, subjectId: 'agent:old/gone' },
            },
        ]);
        const modelsFake = makeFakeModelsDao([
            {
                id: 'model-stale',
                model_key: 'ploinky/old/gone',
                display_name: 'Old Gone',
                provider_id: stalePid,
                provider_model_id: 'agent:old/gone',
                strategy_kind: 'direct',
                discovery_source: 'synced',
                enabled: true,
                metadata: { discoverySource: DISCOVERY_MARKER },
            },
        ]);
        const refresh = spyRefresh();

        const summary = await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx(),
            // complete=false → do not disable missing rows.
            discovery: { complete: false, agents: [agent()] },
            daos: { providersDao: providersFake, modelsDao: modelsFake },
            refresh,
        });

        assert.equal(summary.disabled, 0);
        assert.equal(providersFake.rows.get(stalePid).enabled, true);
        assert.equal(modelsFake.rows.get('model-stale').enabled, true);
        // New rows still created.
        assert.equal(summary.created, 2);
    });

    it('discovery failure (empty + incomplete) does not clear existing records', async () => {
        const stalePid = 'prov-stale';
        const providersFake = makeFakeProvidersDao([
            {
                id: stalePid,
                provider_key: providerKeyFor('agent:old/gone'),
                display_name: 'Ploinky agent agent:old/gone',
                kind: 'external_api',
                adapter_key: 'ploinky-agent-openai',
                auth_strategy: 'none',
                provider_mode: 'external_api',
                base_url: 'http://router.local',
                enabled: true,
                metadata: { discoverySource: DISCOVERY_MARKER, subjectId: 'agent:old/gone' },
            },
        ]);
        const modelsFake = makeFakeModelsDao([
            {
                id: 'model-stale',
                model_key: 'ploinky/old/gone',
                display_name: 'Old Gone',
                provider_id: stalePid,
                provider_model_id: 'agent:old/gone',
                strategy_kind: 'direct',
                discovery_source: 'synced',
                enabled: true,
                metadata: { discoverySource: DISCOVERY_MARKER },
            },
        ]);
        const refresh = spyRefresh();

        // This is what the discovery client returns on any failure.
        const summary = await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx(),
            discovery: { complete: false, agents: [] },
            daos: { providersDao: providersFake, modelsDao: modelsFake },
            refresh,
        });

        assert.equal(summary.scanned, 0);
        assert.equal(summary.disabled, 0);
        assert.equal(summary.refreshed, false);
        assert.equal(refresh.calls.length, 0);
        assert.equal(providersFake.rows.get(stalePid).enabled, true);
        assert.equal(modelsFake.rows.get('model-stale').enabled, true);
    });

    it('re-enables a previously disabled discovered row when it returns', async () => {
        const pid = 'prov-1';
        const providersFake = makeFakeProvidersDao([
            {
                id: pid,
                provider_key: providerKeyFor('agent:demo/echo'),
                display_name: 'Ploinky agent agent:demo/echo',
                kind: 'external_api',
                adapter_key: 'ploinky-agent-openai',
                auth_strategy: 'none',
                provider_mode: 'external_api',
                base_url: 'http://router.local',
                enabled: false,
                metadata: {
                    discoverySource: DISCOVERY_MARKER,
                    subjectId: 'agent:demo/echo',
                    routeKey: 'demo-echo',
                    repo: 'demo',
                    agent: 'echo',
                    usesDefaultOpenAiResponder: true,
                },
            },
        ]);
        const modelsFake = makeFakeModelsDao([
            {
                id: 'model-1',
                model_key: 'ploinky/demo/echo',
                display_name: 'Echo Agent',
                provider_id: pid,
                provider_model_id: 'agent:demo/echo',
                strategy_kind: 'direct',
                discovery_source: 'synced',
                enabled: false,
                metadata: {
                    discoverySource: DISCOVERY_MARKER,
                    subjectId: 'agent:demo/echo',
                    routeKey: 'demo-echo',
                    repo: 'demo',
                    agent: 'echo',
                    usesDefaultOpenAiResponder: true,
                },
            },
        ]);
        const refresh = spyRefresh();

        const summary = await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx(),
            discovery: { complete: true, agents: [agent()] },
            daos: { providersDao: providersFake, modelsDao: modelsFake },
            refresh,
        });

        assert.equal(summary.updated, 2);
        assert.equal(summary.refreshed, true);
        assert.equal(providersFake.rows.get(pid).enabled, true);
        assert.equal(modelsFake.rows.get('model-1').enabled, true);
    });
});

// ── Real SQLite + snapshot visibility, same process. ───────────────────────

async function withDb(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'soul-reconcile-'));
    const db = await openDatabase({ SQLITE_PATH: join(dir, 'gateway.sqlite3') });
    try {
        await initializeSchema(db);
        return await fn(db);
    } finally {
        await db.end();
        await rm(dir, { recursive: true, force: true });
    }
}

describe('reconcilePloinkyAgents (real SQLite + snapshot)', () => {
    it('writes schema-valid rows that pass the providers/models CHECK constraints', async () => {
        await withDb(async (db) => {
            const appCtx = {
                pool: db,
                log: SILENT_LOG,
                config: {
                    env: {
                        PLOINKY_ROUTER_URL: 'http://router.local',
                        PLOINKY_AGENT_ID: 'agent:proxies/soul-gateway',
                    },
                },
                services: {},
            };

            // Default refresh is performRuntimeRefresh; without snapshot
            // services installed it is a safe no-op.
            const summary = await reconcilePloinkyAgents({
                appCtx,
                discovery: { complete: true, agents: [agent()] },
            });
            assert.equal(summary.created, 2);

            // Read the persisted rows back; metadata is JSON-parsed by the
            // SQLite layer, and the row only exists if the CHECKs passed.
            const provider = await providersDao.findByKey(
                db,
                providerKeyFor('agent:demo/echo')
            );
            assert.ok(provider, 'provider row persisted');
            assert.equal(provider.auth_strategy, 'none');
            assert.equal(provider.metadata.discoverySource, DISCOVERY_MARKER);

            const model = await modelsDao.findByKey(db, 'ploinky/demo/echo');
            assert.ok(model, 'model row persisted');
            assert.equal(model.strategy_kind, 'direct');
            assert.equal(model.discovery_source, 'synced');
            assert.equal(model.provider_id, provider.id);
            assert.equal(model.provider_model_id, 'agent:demo/echo');
        });
    });

    it('a newly discovered model is visible in the runtime snapshot after reconciliation in the same process', async () => {
        await withDb(async (db) => {
            const appCtx = {
                pool: db,
                log: SILENT_LOG,
                config: {
                    env: {
                        PLOINKY_ROUTER_URL: 'http://router.local',
                        PLOINKY_AGENT_ID: 'agent:proxies/soul-gateway',
                    },
                },
                services: {},
            };

            // Install snapshot services FIRST (mirrors startup), capture the
            // baseline, then reconcile + refresh, then assert visibility. The
            // reconcile uses the real refresh (performRuntimeRefresh) which now
            // resolves to appCtx.services.reloadRuntimeSnapshot.
            await installSnapshotServices(appCtx);
            // Runtime coordination installs appCtx.services.refreshRuntime,
            // which performRuntimeRefresh delegates to. This mirrors the
            // runtime (timer) path, where the snapshot is live.
            installRuntimeCoordinationServices(appCtx);
            assert.equal(
                appCtx.services.snapshot.models.has('ploinky/demo/echo'),
                false
            );

            await reconcilePloinkyAgents({
                appCtx,
                discovery: { complete: true, agents: [agent()] },
            });

            // performRuntimeRefresh rebuilt appCtx.services.snapshot.
            const model = appCtx.services.snapshot.models.get('ploinky/demo/echo');
            assert.ok(model, 'discovered model present in refreshed snapshot');
            assert.equal(model.providerModelId, 'agent:demo/echo');
            assert.equal(model.strategyKind, 'direct');

            // And an independent fresh load agrees.
            const fresh = await loadRuntimeSnapshot(appCtx);
            assert.ok(fresh.models.has('ploinky/demo/echo'));
        });
    });

    it('startup reconcile runs BEFORE installSnapshotServices so the first snapshot includes discovered models', async () => {
        await withDb(async (db) => {
            const appCtx = {
                pool: db,
                log: SILENT_LOG,
                config: {
                    env: {
                        PLOINKY_ROUTER_URL: 'http://router.local',
                        PLOINKY_AGENT_ID: 'agent:proxies/soul-gateway',
                        PLOINKY_AGENT_SECRET: 'a'.repeat(64),
                    },
                },
                services: {},
            };

            // Seed the DB so the real discovery HTTP call is bypassed: drive
            // the reconciler directly the way bootstrap does, but assert the
            // ORDER contract — installSnapshotServices runs AFTER reconcile.
            // At reconcile time there is no snapshot service yet, so the
            // real performRuntimeRefresh is a no-op; the row must still be
            // present once installSnapshotServices loads the first snapshot.
            await reconcilePloinkyAgents({
                appCtx,
                discovery: { complete: true, agents: [agent()] },
            });
            assert.equal(appCtx.services.snapshot, undefined);

            await installSnapshotServices(appCtx);
            assert.ok(
                appCtx.services.snapshot.models.has('ploinky/demo/echo'),
                'first snapshot includes the reconcile output'
            );
        });
    });

    it('runInitialPloinkyReconcile no-ops cleanly when Ploinky env is absent', async () => {
        await withDb(async (db) => {
            const appCtx = {
                pool: db,
                log: SILENT_LOG,
                config: { env: {} },
                services: {},
            };
            const result = await runInitialPloinkyReconcile(appCtx);
            assert.equal(result, null);
            const providers = await providersDao.list(db, {});
            assert.equal(providers.length, 0);
        });
    });
});

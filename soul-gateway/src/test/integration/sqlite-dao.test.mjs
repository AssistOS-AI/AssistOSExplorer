import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, initializeSchema } from '../../db/sqlite-db.mjs';
import * as apiKeysDao from '../../db/dao/api-keys-dao.mjs';
import * as providersDao from '../../db/dao/providers-dao.mjs';
import * as providerAccountsDao from '../../db/dao/provider-accounts-dao.mjs';
import * as modelsDao from '../../db/dao/models-dao.mjs';
import * as middlewaresDao from '../../db/dao/middlewares-dao.mjs';
import * as middlewareBindingsDao from '../../db/dao/middleware-bindings-dao.mjs';
import * as sessionsDao from '../../db/dao/sessions-dao.mjs';
import * as cooldownsDao from '../../db/dao/cooldowns-dao.mjs';
import * as auditLogsDao from '../../db/dao/audit-logs-dao.mjs';
import { loadRuntimeSnapshot } from '../../runtime/registry/snapshot-loader.mjs';

async function withDb(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'soul-dao-'));
    const db = await openDatabase({ SQLITE_PATH: join(dir, 'gateway.sqlite3') });
    try {
        await initializeSchema(db);
        return await fn(db);
    } finally {
        await db.end();
        await rm(dir, { recursive: true, force: true });
    }
}

describe('SQLite DAO integration', () => {
    it('creates API key, provider, model, implicit session, and audit row with normalized values', async () => {
        await withDb(async (db) => {
            const key = await apiKeysDao.create(db, {
                label: 'agent:proxies/soul-gateway',
                keyHint: 'agent:...way',
                subjectId: 'agent:proxies/soul-gateway',
                subjectType: 'agent',
                metadata: { purpose: 'integration' },
            });
            assert.ok(key.id, 'api key id generated');
            assert.equal(key.metadata.purpose, 'integration');
            assert.equal(key.subject_id, 'agent:proxies/soul-gateway');
            assert.equal(key.subject_type, 'agent');
            assert.equal(key.source, 'signed-subject');

            // Lookup is by subject_id, not a key hash.
            const found = await apiKeysDao.findBySubjectId(
                db,
                'agent:proxies/soul-gateway'
            );
            assert.equal(found.id, key.id);

            // upsertSignedSubjectKey is idempotent on subject_id: a second
            // call for the same subject returns the existing logical row.
            const again = await apiKeysDao.upsertSignedSubjectKey(db, {
                subjectId: 'agent:proxies/soul-gateway',
                subjectType: 'agent',
            });
            assert.equal(again.id, key.id, 'same subject re-reads one logical row');

            const provider = await providersDao.create(db, {
                providerKey: 'openrouter',
                displayName: 'OpenRouter',
                kind: 'external_api',
                adapterKey: 'openai-api',
                authStrategy: 'api_key',
                baseUrl: 'https://openrouter.ai/api/v1',
                enabled: true,
                settings: { extra_headers: { 'X-Test': '1' } },
            });
            assert.equal(provider.settings.extra_headers['X-Test'], '1');
            assert.equal(provider.enabled, true, 'enabled normalized to boolean');

            const model = await modelsDao.create(db, {
                modelKey: 'openrouter/test',
                displayName: 'Test Model',
                providerId: provider.id,
                providerModelId: 'test/model',
                executionKind: 'provider_model',
                capabilities: { supportsTools: true },
                tags: ['chat'],
            });
            assert.deepEqual(model.tags, ['chat'], 'tags round-trip as JSON array');
            assert.equal(model.capabilities.supportsTools, true);

            const sessionResult = await sessionsDao.findOrCreateImplicit(db, {
                apiKeyId: key.id,
                agentName: 'agent',
                timeoutMinutes: 30,
            });
            assert.equal(sessionResult.created, true);

            // A second call within the window reuses the open session.
            const second = await sessionsDao.findOrCreateImplicit(db, {
                apiKeyId: key.id,
                agentName: 'agent',
                timeoutMinutes: 30,
            });
            assert.equal(second.created, false);
            assert.equal(second.session.id, sessionResult.session.id);

            const audit = await auditLogsDao.insertStart(db, {
                startedAt: new Date().toISOString(),
                requestId: 'req-1',
                requestFormat: 'openai_chat',
                apiKeyId: key.id,
                requestedModel: model.model_key,
                requestHeaders: { authorization: '[redacted]' },
                requestPayload: { model: model.model_key },
            });
            assert.equal(audit.request_payload.model, model.model_key);
            assert.ok(audit.log_id, 'audit log_id generated');

            // Summary aggregation exercises the SUM(CASE ...) / COUNT conversions.
            const summary = await auditLogsDao.summarizeByApiKey(db, {});
            assert.equal(summary.length, 1);
            assert.equal(Number(summary[0].request_count), 1);
        });
    });

    it('upserts an OAuth provider account idempotently via the partial unique index', async () => {
        await withDb(async (db) => {
            const provider = await providersDao.create(db, {
                providerKey: 'gemini',
                displayName: 'Gemini',
                kind: 'external_api',
                adapterKey: 'gemini-api',
                authStrategy: 'oauth',
                oauthAdapterKey: 'google-gemini',
            });

            const first = await providerAccountsDao.upsertOAuth(db, {
                providerId: provider.id,
                accountLabel: 'acct',
                externalAccountId: 'ext-1',
                credentialsPath: '/data/credentials/ext-1.json',
                metadata: { v: 1 },
            });
            const second = await providerAccountsDao.upsertOAuth(db, {
                providerId: provider.id,
                accountLabel: 'acct-renamed',
                externalAccountId: 'ext-1',
                credentialsPath: '/data/credentials/ext-1.json',
                metadata: { v: 2 },
            });
            assert.equal(first.id, second.id, 'same row updated, not duplicated');
            assert.equal(second.account_label, 'acct-renamed');
            assert.equal(second.metadata.v, 2);

            const list = await providerAccountsDao.listByProvider(db, provider.id);
            assert.equal(list.length, 1);
        });
    });

    it('stores and reads an active model cooldown', async () => {
        await withDb(async (db) => {
            const provider = await providersDao.create(db, {
                providerKey: 'p1',
                displayName: 'P1',
                kind: 'external_api',
                adapterKey: 'openai-api',
                authStrategy: 'api_key',
            });
            const model = await modelsDao.create(db, {
                modelKey: 'p1/m1',
                displayName: 'M1',
                providerId: provider.id,
                providerModelId: 'm1',
                executionKind: 'provider_model',
            });
            const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
            await cooldownsDao.create(db, {
                modelId: model.id,
                reasonType: 'rate_limit',
                expiresAt,
            });
            const active = await cooldownsDao.findActiveByModel(db, model.id);
            assert.ok(active, 'active cooldown found');
            assert.equal(active.reason_type, 'rate_limit');
        });
    });

    it('updates model tags as JSON and returns normalized arrays', async () => {
        await withDb(async (db) => {
            const provider = await providersDao.create(db, {
                providerKey: 'tag-provider',
                displayName: 'Tag Provider',
                kind: 'external_api',
                adapterKey: 'openai-api',
                authStrategy: 'api_key',
            });
            const model = await modelsDao.create(db, {
                modelKey: 'tag-provider/model',
                displayName: 'Tag Model',
                providerId: provider.id,
                providerModelId: 'model',
            });

            const updated = await modelsDao.update(db, model.id, {
                tags: ['chat', 'fast'],
            });

            assert.deepEqual(updated.tags, ['chat', 'fast']);
        });
    });

    it('loads middleware default settings from SQLite snapshots as objects', async () => {
        await withDb(async (db) => {
            await middlewaresDao.create(db, {
                middlewareKey: 'mw.defaults',
                displayName: 'Defaults Middleware',
                sourceType: 'builtin',
                modulePath: '/opt/soul-gateway/src/runtime/middleware/mw-defaults.mjs',
                version: '1',
                checksum: 'checksum',
                defaultSettings: { threshold: 3 },
            });
            await middlewareBindingsDao.create(db, {
                scope: 'gateway',
                middlewareKey: 'mw.defaults',
                settings: { enabled: true },
            });

            const snapshot = await loadRuntimeSnapshot({ pool: db });
            const binding = snapshot.middlewareBindings.gateway[0];

            assert.deepEqual(binding.middlewareDefaultSettings, {
                threshold: 3,
            });
        });
    });
});

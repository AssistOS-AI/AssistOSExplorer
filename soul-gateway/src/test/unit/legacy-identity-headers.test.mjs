/**
 * Legacy identity-header rejection tests.
 *
 * Task 10 ("Remove Legacy Identity Headers"): once Achilles stops injecting
 * `X-Soul-Agent`, the gateway rejects any request that still carries a legacy
 * Soul Gateway identity header. Identity comes solely from the signed-subject
 * API key.
 *
 * The auth middleware must:
 *   - reject `x-soul-id`, `x-agent-name`, and `x-soul-agent` with HTTP 400 and
 *     the exact OpenAI-compatible error body `{ error: { message, type } }`
 *     where `type === 'invalid_request_error'`;
 *   - let a request authenticated with a valid signed-subject key and none of
 *     those stale headers pass authentication.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { errorBoundaryMiddleware } from '../../runtime/route/error-boundary.mjs';
import { authenticateMiddleware } from '../../runtime/route/authenticate.mjs';
import { openDatabase, initializeSchema } from '../../db/sqlite-db.mjs';
import { makeSignedSubjectKey } from '../fixtures/signed-subject-key.mjs';

const EXPECTED_MESSAGE =
    'Legacy Soul Gateway identity headers are not supported; ' +
    'use the signed-subject API key.';
const STALE_HEADERS = ['x-soul-id', 'x-agent-name', 'x-soul-agent'];

// ── helpers (mirrors route-chain.test.mjs) ──────────────────────────────

function makeFakeReq({ headers = {} } = {}) {
    const stream = Readable.from([Buffer.from('{}')]);
    stream.headers = { 'content-type': 'application/json', ...headers };
    return stream;
}

function makeFakeRes() {
    const captured = { status: null, headers: {}, body: null, ended: false };
    return {
        captured,
        headersSent: false,
        writableEnded: false,
        setHeader(k, v) {
            captured.headers[k] = v;
        },
        writeHead(status, headers) {
            captured.status = status;
            Object.assign(captured.headers, headers);
            this.headersSent = true;
        },
        end(chunk) {
            if (chunk) captured.body = chunk;
            this.writableEnded = true;
            captured.ended = true;
        },
        write(chunk) {
            captured.body = (captured.body || '') + (chunk || '');
        },
    };
}

function makeAppCtx({ env = {}, pool = null } = {}) {
    return {
        config: {
            defaults: { requestIdPrefix: 'test-' },
            env: {
                DEFAULT_RPM_LIMIT: 60,
                DEFAULT_TPM_LIMIT: 100_000,
                ...env,
            },
        },
        pool,
        log: { debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
        services: {},
    };
}

function makeKernelCtx({ req, res, appCtx } = {}) {
    return createKernelContext({
        requestId: 'test-req-1',
        route: { kind: 'openai_chat', format: 'openai_chat' },
        services: appCtx?.services,
        log: appCtx?.log,
        appCtx,
        http: { req, res },
    });
}

/** Run authenticate behind the real error boundary and capture the response. */
async function runAuthChain(ctx) {
    const chain = compose([errorBoundaryMiddleware(), authenticateMiddleware()]);
    await chain(ctx);
}

async function withSignedDb(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'soul-legacy-hdr-'));
    const db = await openDatabase({ SQLITE_PATH: join(dir, 'gateway.sqlite3') });
    try {
        await initializeSchema(db);
        return await fn(db);
    } finally {
        await db.end();
        await rm(dir, { recursive: true, force: true });
    }
}

// ── rejection of each stale header ──────────────────────────────────────

describe('authenticate rejects legacy identity headers', () => {
    for (const header of STALE_HEADERS) {
        it(`returns 400 invalid_request_error for ${header}`, async () => {
            const res = makeFakeRes();
            const ctx = makeKernelCtx({
                req: makeFakeReq({ headers: { [header]: 'value-1' } }),
                res,
                appCtx: makeAppCtx({ env: { ALLOW_UNAUTHENTICATED: true } }),
            });

            await runAuthChain(ctx);

            assert.equal(res.captured.status, 400);
            const body = JSON.parse(res.captured.body);
            assert.equal(body.error.type, 'invalid_request_error');
            assert.equal(body.error.message, EXPECTED_MESSAGE);
            // Auth must not have run: the auth view stays at its initial null.
            assert.equal(ctx.auth, null);
        });
    }

    it('rejects an empty-string legacy header value', async () => {
        const res = makeFakeRes();
        const ctx = makeKernelCtx({
            req: makeFakeReq({ headers: { 'x-soul-agent': '' } }),
            res,
            appCtx: makeAppCtx({ env: { ALLOW_UNAUTHENTICATED: true } }),
        });

        await runAuthChain(ctx);

        assert.equal(res.captured.status, 400);
        assert.equal(JSON.parse(res.captured.body).error.type, 'invalid_request_error');
    });

    it('rejects even when several stale headers are present at once', async () => {
        const res = makeFakeRes();
        const ctx = makeKernelCtx({
            req: makeFakeReq({
                headers: {
                    'x-soul-id': 's',
                    'x-agent-name': 'a',
                    'x-soul-agent': 'sa',
                },
            }),
            res,
            appCtx: makeAppCtx({ env: { ALLOW_UNAUTHENTICATED: true } }),
        });

        await runAuthChain(ctx);

        assert.equal(res.captured.status, 400);
        assert.equal(JSON.parse(res.captured.body).error.message, EXPECTED_MESSAGE);
    });
});

// ── happy path: valid signed key, no stale headers ──────────────────────

describe('authenticate accepts a clean signed-subject request', () => {
    it('passes auth with a valid signed key and no legacy headers', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'agent:AssistOSExplorer/llmAssistant';
            const { apiKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
            const appCtx = makeAppCtx({
                pool: db,
                env: {
                    PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY: publicKeyBase64url,
                    API_KEY_HASH_PEPPER: 'test-pepper',
                    ENCRYPTION_KEY: '8'.repeat(64),
                },
            });
            const res = makeFakeRes();
            const ctx = makeKernelCtx({
                req: makeFakeReq({ headers: { authorization: `Bearer ${apiKey}` } }),
                res,
                appCtx,
            });

            let reachedNext = false;
            const chain = compose([
                errorBoundaryMiddleware(),
                authenticateMiddleware(),
                async () => {
                    reachedNext = true;
                },
            ]);
            await chain(ctx);

            // No error response was written, and auth resolved the signed subject.
            assert.equal(res.captured.status, null);
            assert.equal(reachedNext, true);
            assert.ok(ctx.auth, 'expected ctx.auth to be populated');
            assert.equal(ctx.auth.apiKeyRecord.subjectId, subjectId);
            assert.equal(ctx.auth.apiKeyRecord.apiKeySource, 'signed-subject');
        });
    });
});

#!/usr/bin/env node
/**
 * NVIDIA model sweep — sends a tiny prompt to every NVIDIA NIM model
 * exposed through Soul Gateway and reports which work and which fail.
 *
 * Usage
 * -----
 *   SOUL_API_KEY=sk-soul-... node soul-gateway/test-nvidia-all-models.mjs
 *
 * Environment variables (only SOUL_API_KEY is required):
 *
 *   GATEWAY_URL          base URL of the gateway        default http://localhost:8042
 *   SOUL_API_KEY         sk-soul-... bearer for /v1     REQUIRED
 *   DASHBOARD_PASSWORD   admin password for /management default soulpass!321
 *   CONCURRENCY          parallel test workers          default 5
 *   PROMPT               user prompt                    default short math question
 *   MAX_TOKENS           per-call max_tokens            default 16
 *   MAX_MODELS           cap on models tested           default Infinity
 *   MODEL_FILTER         comma-separated provider ids   default off (test all)
 *                        — when set, only those ids are
 *                        tested; useful for re-running
 *                        a subset (e.g. the timeouts)
 *                        without churning all 189 again
 *   KEEP_MODELS          "1" to skip cleanup of rows    default off
 *   TIMEOUT_MS           per-call request timeout       default 30000
 *
 * Flow
 * ----
 *   1. POST /management/auth/login           → admin session cookie + CSRF
 *   2. GET  /management/providers            → find provider_key === 'nvidia'
 *   3. POST .../discover-models              → live NVIDIA NIM catalog
 *   4. Register all models in parallel       → POST /management/models
 *   5. Wait `SNAPSHOT_WAIT_MS` for the gateway's debounced runtime
 *      snapshot rebuild to settle (handleCreateModel kicks off the
 *      rebuild fire-and-forget via requestRuntimeRefresh, so the new
 *      model_keys aren't immediately resolvable on /v1/chat/completions)
 *   6. Send /v1/chat/completions to each registered model in parallel
 *      with bounded concurrency. Captures:
 *        { ok, providerModelId, latencyMs, status, replyPreview, error, errorType }
 *      Streams a PASS/FAIL line per model as it completes.
 *   7. DELETE every registered row in parallel (skipped when KEEP_MODELS=1).
 *   8. Print a final summary: counts, latency stats on passing models,
 *      and a breakdown of failures grouped by errorType.
 *
 * Notes
 * -----
 *   - Models that fail because they're not chat-completion models
 *     (embeddings, rerankers, fim-only) show up as failures with the
 *     upstream's own error type — that's the point of the sweep.
 *   - The script never reuses an existing model_key; every row gets a
 *     unique `nvidia-sweep-<runId>/<sanitized-model-id>` key so two
 *     concurrent runs don't collide and so cleanup can find them via
 *     the per-run prefix.
 *   - The phased register-then-test structure exists because
 *     handleCreateModel does NOT await its snapshot rebuild — testing
 *     a model immediately after creating it returned "Model not found"
 *     for whichever model lost the race. Registering everything first
 *     and giving the rebuild a settle window solves this.
 */

// ── Configuration ───────────────────────────────────────────────────

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8042';
const SOUL_API_KEY = process.env.SOUL_API_KEY || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'soulpass!321';
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '5', 10);
const REGISTER_CONCURRENCY = parseInt(
    process.env.REGISTER_CONCURRENCY ?? '10',
    10
);
const PROMPT = process.env.PROMPT || 'What is 2+2? Reply with just the number.';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS ?? '16', 10);
const MAX_MODELS = process.env.MAX_MODELS
    ? parseInt(process.env.MAX_MODELS, 10)
    : Infinity;
const KEEP_MODELS = process.env.KEEP_MODELS === '1';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS ?? '30000', 10);
// Comma-separated list of provider model ids; when set, only those
// ids are tested (filtered out of the discovery response). Useful
// for re-running the subset of models that timed out or 5xx'd in
// a previous sweep without churning through the full 189 again.
const MODEL_FILTER = (process.env.MODEL_FILTER || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
// How long to wait between the register-all phase and the test-all
// phase so the gateway's debounced snapshot rebuild can pick up the
// new model rows. handleCreateModel calls requestRuntimeRefresh
// fire-and-forget, so without this delay the first batch of /v1
// requests races the rebuild and gets "Model not found".
const SNAPSHOT_WAIT_MS = parseInt(process.env.SNAPSHOT_WAIT_MS ?? '2000', 10);

if (!SOUL_API_KEY) {
    console.error('Error: SOUL_API_KEY env var is required.');
    console.error(
        '       It is the sk-soul-... bearer used to call /v1/chat/completions.'
    );
    console.error(
        '       Create one in the dashboard (Keys tab) or via POST /management/keys.'
    );
    process.exit(2);
}

// ── Tiny dashboard client (cookie + CSRF) ───────────────────────────

class GatewayClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.cookie = null;
        this.csrf = null;
    }

    async loginAdmin(password) {
        const res = await fetch(`${this.baseUrl}/management/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        if (!res.ok) {
            throw new Error(`admin login failed: HTTP ${res.status}`);
        }
        const setCookie = res.headers.get('set-cookie');
        if (!setCookie) {
            throw new Error('admin login: no Set-Cookie header in response');
        }
        this.cookie = setCookie.split(';')[0];
        const body = await res.json();
        this.csrf = body.csrfToken;
        if (!this.csrf) {
            throw new Error('admin login: no csrfToken in response body');
        }
    }

    async _adminCall(method, path, body = null) {
        return fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                cookie: this.cookie,
                'x-csrf-token': this.csrf,
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    }

    async listProviders() {
        const res = await this._adminCall('GET', '/management/providers');
        if (!res.ok) throw new Error(`listProviders: HTTP ${res.status}`);
        return (await res.json()).data || [];
    }

    async discoverModels(providerId) {
        const res = await this._adminCall(
            'POST',
            `/management/providers/${providerId}/discover-models`,
            {}
        );
        if (!res.ok) {
            const text = await res.text();
            throw new Error(
                `discoverModels: HTTP ${res.status} ${text.slice(0, 200)}`
            );
        }
        return (await res.json()).data || [];
    }

    async createModel(spec) {
        const res = await this._adminCall('POST', '/management/models', spec);
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        return (await res.json()).model;
    }

    async deleteModel(id) {
        const res = await this._adminCall('DELETE', `/management/models/${id}`);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
    }

    /**
     * Force a synchronous runtime snapshot rebuild via the rescan
     * endpoint. handleCreateModel kicks off its rebuilds via
     * requestRuntimeRefresh (fire-and-forget), so a freshly-registered
     * model isn't immediately resolvable on /v1/chat/completions —
     * the resolver still reads the stale snapshot until the async
     * rebuild lands. Rescan, in contrast, awaits performRuntimeRefresh,
     * so by the time this call returns the snapshot is current.
     */
    async forceRuntimeRescan() {
        const res = await this._adminCall(
            'POST',
            '/management/providers/rescan',
            {}
        );
        if (!res.ok) {
            throw new Error(`forceRuntimeRescan: HTTP ${res.status}`);
        }
        return res.json();
    }
}

// ── /v1/chat/completions caller with timeout ────────────────────────

async function sendCompletion(modelKey) {
    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${SOUL_API_KEY}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: modelKey,
                messages: [{ role: 'user', content: PROMPT }],
                max_tokens: MAX_TOKENS,
                stream: false,
            }),
            signal: ctrl.signal,
        });
        const latencyMs = Date.now() - start;

        let body;
        try {
            body = await res.json();
        } catch {
            body = { error: { message: 'invalid JSON response' } };
        }

        if (!res.ok || body.error) {
            return {
                ok: false,
                latencyMs,
                status: res.status,
                error: body.error?.message || `HTTP ${res.status}`,
                errorType: body.error?.type || `http_${res.status}`,
            };
        }

        const reply = body.choices?.[0]?.message?.content ?? '';
        return {
            ok: true,
            latencyMs,
            status: res.status,
            replyPreview: reply.slice(0, 60).replace(/\s+/g, ' ').trim(),
            promptTokens: body.usage?.prompt_tokens ?? 0,
            completionTokens: body.usage?.completion_tokens ?? 0,
        };
    } catch (err) {
        const latencyMs = Date.now() - start;
        const isAbort = err.name === 'AbortError';
        return {
            ok: false,
            latencyMs,
            status: 0,
            error: isAbort ? `timeout after ${TIMEOUT_MS}ms` : err.message,
            errorType: isAbort ? 'timeout' : 'transport',
        };
    } finally {
        clearTimeout(timer);
    }
}

// ── Per-phase workers ───────────────────────────────────────────────

function sanitizeForKey(s) {
    // model_key allows letters, digits, _ . / - … strip anything else
    return String(s)
        .replace(/[^a-zA-Z0-9_./-]+/g, '-')
        .slice(0, 200);
}

/**
 * Phase 4 worker: register one provider_model_id as a temporary
 * model row in soul-gateway. Returns either { id, modelKey,
 * providerModelId } on success or { providerModelId, registerError }
 * on failure (which propagates straight to the result list as a
 * register_failed entry, no test attempted).
 */
async function registerOne(client, providerId, providerModelId, runId) {
    const modelKey = `nvidia-sweep-${runId}/${sanitizeForKey(providerModelId)}`;
    try {
        const created = await client.createModel({
            modelKey,
            displayName: providerModelId,
            providerId,
            providerModelId,
        });
        return { id: created.id, modelKey, providerModelId };
    } catch (err) {
        return { providerModelId, registerError: err.message };
    }
}

/**
 * Phase 6 worker: send the test prompt to a registered model and
 * stamp the result with its provider_model_id so the result list
 * stays human-readable.
 */
async function testOne(registered) {
    const r = await sendCompletion(registered.modelKey);
    return { providerModelId: registered.providerModelId, ...r };
}

// ── Bounded-concurrency promise pool ────────────────────────────────

async function runWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;

    async function worker() {
        while (true) {
            const idx = next++;
            if (idx >= items.length) return;
            results[idx] = await fn(items[idx], idx);
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

// ── Output helpers ──────────────────────────────────────────────────

function pad(s, width) {
    const str = String(s);
    return str.length >= width
        ? str.slice(0, width)
        : str + ' '.repeat(width - str.length);
}

function lpad(s, width) {
    const str = String(s);
    return str.length >= width ? str : ' '.repeat(width - str.length) + str;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Main ────────────────────────────────────────────────────────────

async function main() {
    console.log(`[nvidia-sweep] gateway=${GATEWAY_URL}`);
    console.log(
        `[nvidia-sweep] register-concurrency=${REGISTER_CONCURRENCY}  test-concurrency=${CONCURRENCY}`
    );
    console.log(
        `[nvidia-sweep] timeout=${TIMEOUT_MS}ms  max_tokens=${MAX_TOKENS}  snapshot-wait=${SNAPSHOT_WAIT_MS}ms`
    );
    console.log(`[nvidia-sweep] prompt=${JSON.stringify(PROMPT)}`);
    console.log();

    const client = new GatewayClient(GATEWAY_URL);

    console.log('[nvidia-sweep] logging in to dashboard …');
    await client.loginAdmin(DASHBOARD_PASSWORD);

    console.log('[nvidia-sweep] resolving NVIDIA provider …');
    const providers = await client.listProviders();
    const nvidia = providers.find((p) => p.provider_key === 'nvidia');
    if (!nvidia) {
        console.error(
            'No provider with provider_key="nvidia" found in /management/providers.'
        );
        console.error(
            'Add the NVIDIA preset from the dashboard first, or set its api_key via PATCH.'
        );
        process.exit(3);
    }
    console.log(`  provider id : ${nvidia.id}`);
    console.log(`  base url    : ${nvidia.base_url}`);

    console.log('[nvidia-sweep] discovering models …');
    const discoveries = await client.discoverModels(nvidia.id);
    // Discovery view returns each model with `id` (the providerModelId);
    // fall back to other shapes just in case the view contract drifts.
    const allIds = discoveries
        .map((d) => d.id || d.providerModelId || d.modelId || d.model_id)
        .filter(Boolean);

    let candidates = allIds;
    let filterTag = '';
    if (MODEL_FILTER.length > 0) {
        const wanted = new Set(MODEL_FILTER);
        candidates = allIds.filter((id) => wanted.has(id));
        const missing = MODEL_FILTER.filter((id) => !allIds.includes(id));
        filterTag = ` (MODEL_FILTER: ${candidates.length}/${MODEL_FILTER.length} matched)`;
        if (missing.length > 0) {
            console.warn(
                `  warning: ${missing.length} filter ids not in NVIDIA discovery: ${missing.join(', ')}`
            );
        }
    }
    const modelIds = candidates.slice(0, MAX_MODELS);

    console.log(
        `  discovered  : ${allIds.length} models${filterTag}${MAX_MODELS < Infinity && MODEL_FILTER.length === 0 ? ` (testing first ${modelIds.length})` : ''}`
    );
    console.log();

    if (modelIds.length === 0) {
        console.error(
            'No models to test. Check that the NVIDIA provider has a valid api_key and your MODEL_FILTER matches.'
        );
        process.exit(4);
    }

    const runId = Date.now().toString(36);
    const sweepStart = Date.now();

    // ── Phase 4: register every model ───────────────────────────────
    console.log(
        `[nvidia-sweep] phase 1/4: registering ${modelIds.length} models …`
    );
    let registeredCount = 0;
    const registrations = await runWithConcurrency(
        modelIds,
        REGISTER_CONCURRENCY,
        async (providerModelId) => {
            const r = await registerOne(
                client,
                nvidia.id,
                providerModelId,
                runId
            );
            registeredCount += 1;
            if (
                registeredCount % 25 === 0 ||
                registeredCount === modelIds.length
            ) {
                console.log(
                    `  registered ${registeredCount}/${modelIds.length}`
                );
            }
            return r;
        }
    );
    const successfullyRegistered = registrations.filter(
        (r) => !r.registerError
    );
    const registerFailures = registrations
        .filter((r) => r.registerError)
        .map((r) => ({
            providerModelId: r.providerModelId,
            ok: false,
            latencyMs: 0,
            status: 0,
            error: `register: ${r.registerError}`,
            errorType: 'register_failed',
        }));
    console.log(
        `  registered : ${successfullyRegistered.length} / ${modelIds.length}`
    );
    if (registerFailures.length > 0) {
        console.log(`  register failures : ${registerFailures.length}`);
    }
    console.log();

    // ── Phase 5: force a synchronous snapshot rebuild ──────────────
    // POST /management/providers/rescan awaits performRuntimeRefresh,
    // unlike handleCreateModel which fires it async. After this returns
    // the runtime snapshot is guaranteed to be current. The follow-up
    // sleep is just paranoia for any in-flight rebuild started by an
    // earlier createModel that may still be racing this rescan.
    console.log(
        '[nvidia-sweep] phase 2/4: forcing synchronous runtime snapshot rebuild …'
    );
    try {
        const rescan = await client.forceRuntimeRescan();
        console.log(
            `  snapshot generation: ${rescan.snapshotGeneration ?? '?'}`
        );
    } catch (err) {
        console.warn(
            `  rescan failed (${err.message}); falling back to fixed wait`
        );
    }
    if (SNAPSHOT_WAIT_MS > 0) {
        await sleep(SNAPSHOT_WAIT_MS);
    }
    console.log();

    // ── Phase 6: test every registered model in parallel ───────────
    console.log(
        `[nvidia-sweep] phase 3/4: testing ${successfullyRegistered.length} models …`
    );
    let tested = 0;
    const testResults = await runWithConcurrency(
        successfullyRegistered,
        CONCURRENCY,
        async (registered) => {
            const r = await testOne(registered);
            tested += 1;
            const tag = r.ok ? 'PASS' : 'FAIL';
            const latency = lpad(`${r.latencyMs}ms`, 7);
            const tail = r.ok ? r.replyPreview : r.error;
            console.log(
                `  [${lpad(tested, 3)}/${successfullyRegistered.length}] ${tag}  ${pad(r.providerModelId, 60)}  ${latency}  ${tail}`
            );
            return r;
        }
    );
    console.log();

    // ── Phase 7: cleanup ────────────────────────────────────────────
    if (!KEEP_MODELS) {
        console.log(
            `[nvidia-sweep] phase 4/4: deleting ${successfullyRegistered.length} temporary model rows …`
        );
        let deleted = 0;
        let deleteFailures = 0;
        await runWithConcurrency(
            successfullyRegistered,
            REGISTER_CONCURRENCY,
            async (registered) => {
                try {
                    await client.deleteModel(registered.id);
                    deleted += 1;
                } catch {
                    deleteFailures += 1;
                }
                if (
                    deleted % 25 === 0 ||
                    deleted + deleteFailures === successfullyRegistered.length
                ) {
                    console.log(
                        `  deleted ${deleted}/${successfullyRegistered.length}${deleteFailures ? ` (${deleteFailures} failed)` : ''}`
                    );
                }
            }
        );
        console.log();
    }

    // ── Summary ─────────────────────────────────────────────────────
    const allResults = [...testResults, ...registerFailures];
    const elapsedSec = ((Date.now() - sweepStart) / 1000).toFixed(1);

    console.log(`[nvidia-sweep] done in ${elapsedSec}s`);
    const passing = allResults.filter((r) => r.ok);
    const failing = allResults.filter((r) => !r.ok);
    console.log(`  passing : ${passing.length} / ${allResults.length}`);
    console.log(`  failing : ${failing.length} / ${allResults.length}`);

    if (passing.length > 0) {
        const avg = (
            passing.reduce((acc, r) => acc + r.latencyMs, 0) / passing.length
        ).toFixed(0);
        const min = Math.min(...passing.map((r) => r.latencyMs));
        const max = Math.max(...passing.map((r) => r.latencyMs));
        console.log(
            `  latency on passing models: avg=${avg}ms  min=${min}ms  max=${max}ms`
        );
    }

    if (failing.length > 0) {
        console.log();
        console.log('[nvidia-sweep] failures by error type:');
        const byType = new Map();
        for (const r of failing) {
            const key = r.errorType || 'unknown';
            const list = byType.get(key) || [];
            list.push(r);
            byType.set(key, list);
        }
        const sorted = [...byType.entries()].sort(
            (a, b) => b[1].length - a[1].length
        );
        for (const [type, rows] of sorted) {
            console.log(`  ${type} (${rows.length}):`);
            for (const r of rows.slice(0, 5)) {
                console.log(`    - ${r.providerModelId}: ${r.error}`);
            }
            if (rows.length > 5) {
                console.log(`    … and ${rows.length - 5} more`);
            }
        }
    }

    if (KEEP_MODELS) {
        console.log();
        console.log(
            `[nvidia-sweep] KEEP_MODELS=1 — registered rows left in DB with key prefix "nvidia-sweep-${runId}/"`
        );
        console.log('  delete them with:');
        console.log(
            `    psql -c "DELETE FROM soul_gateway.models WHERE model_key LIKE 'nvidia-sweep-${runId}/%'"`
        );
    }

    // Exit non-zero only if literally every model failed — partial
    // failures are expected (embedding models, rerankers, etc.).
    process.exitCode = passing.length === 0 ? 1 : 0;
}

main().catch((err) => {
    console.error('[nvidia-sweep] fatal:', err.stack || err.message);
    process.exit(1);
});

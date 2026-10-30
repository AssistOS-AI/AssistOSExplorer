import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ExecutionSetupError } from './setupError.mjs';

// The worker-hosted Soul Gateway model channel (RoboWork r10, decisions M-26, M-43; M-10, M-12, base 8.1 and 8.3).
//
// An OpenCode robot whose effective model is `soul-gateway/<id>` runs in worker mode without any credential in its HOME, environment,
// ALA or workload. Only this trusted worker holds the upstream identity: it calls Soul Gateway with its own `PLOINKY_AGENT_API_KEY`
// (subject `agent:AchillesIDE/robo-work`, billed and budgeted as one shared row, M-43 (1)) through the canonical AchillesAgentLib Router
// transport, exactly as roboTeamAgent/server/soul-gateway-connection.mjs does for the legacy path.
//
// Path of a request (all inside one execution):
//   OpenCode workload -> http://127.0.0.1:<MODEL_RELAY_PORT>/v1 (in the execution network namespace)
//     -> the provider endpoint's TCP relay (providerEndpoint.mjs startRelays; it copies bytes and parses nothing)
//     -> <runtime>/x/<rid>/model/model.sock (this module's HTTP server)
//     -> routerHttpRequest with the worker's bearer -> Soul Gateway.
//
// Isolation of the socket (M-43, review change 2):
//   * model.sock is in its OWN runtime subdirectory `model/`, bound read-only into the provider endpoint sandbox ONLY
//     (executionSupervisor.mjs createEndpoint). It is not in the `channels/` directory, which every workload and the orchestration
//     domain (ALA) see, so neither can open the socket directly; the endpoint's netns relay is the only path.
//   * The endpoint refuses a `connect` from ALA to its own relay port from the moment it exists (providerEndpoint.mjs ownPorts), so
//     ALA cannot reach the relay either. A workload reaches it because it shares the execution's netns, as intended.
//   * Isolation from OTHER agents (RoboTeam and the rest of the workspace) relies on M-16: the Ploinky guard that masks each agent's
//     `.data/<persistentStorage key>` from every other agent's workspace mount, so the worker store (and this runtime directory, 0700,
//     inside it) is neither readable nor writable by them. M-16 was verified live (each agent sees the other's store empty and read-only).
//
// What the channel allows (M-43 (2); review changes 1, 3, 4):
//   * ONE model: the single effective model of this execution, `spec.model ?? managed.models.opencode` (spec.model is present only on an
//     override; ALA then runs `--model spec.model`). Every other model id gets 403, never the catalog. No channel is opened at all when
//     that id is not a gateway id (selectGatewayModel returns null). The `soul-gateway/` prefix is matched case-insensitively everywhere.
//   * Exactly `GET /v1/models` and `POST /v1/chat/completions` (exact `req.url`, so no query string), everything else is 404. No inbound
//     header is ever forwarded: the upstream call carries the transport's own headers and the worker's bearer only.
//   * The body is rebuilt from an allowlist of OpenAI chat fields and `model` is FORCED to the allowed id after the check; unknown and
//     routing keys never reach the gateway. `stream` is forced to false (buffered upstream call, legacy SSE emulation for streaming
//     clients, M-43 (6)).
//   * An upstream error passes its status through; its message comes ONLY from the transport's redacted `readErrorText()`, then is parsed,
//     stripped of control characters and cut to 300 characters. The worker's bearer never appears in anything the workload can read.
//   * Per execution, before any body is read (M-45): at most 2 request bodies in flight and a token bucket of 5 requests per second with a burst
//     of 10; a request over either gets 429 `rate_limited` and its connection is destroyed unread. The rewritten body is checked against the
//     transport's 2 MiB upload limit (413, not 502).
//   * M-33 activity is reported only for a 2xx chat response (M-43 (4)). The last upstream error (status and sanitized message) is kept
//     so that an `inactive_timeout` can tell the user why (M-43 (a)).
//   * Never logged: keys, prompts, completions or upstream message text. The log line is `model_request {executionId, model, status, ms}`.

export const MODEL_RELAY_PORT = 18843;
export const MODEL_SOCKET_NAME = 'model.sock';
// Where the endpoint sandbox sees the model directory, and where every workload sees the generated OpenCode configuration.
export const MODEL_DIRECTORY_VIEW = '/run/robo-work/model';
export const MODEL_SOCKET_VIEW = `${MODEL_DIRECTORY_VIEW}/${MODEL_SOCKET_NAME}`;
export const OPENCODE_CONFIG_NAME = 'opencode.json';
export const OPENCODE_CONFIG_VIEW = `/run/robo-work/channels/${OPENCODE_CONFIG_NAME}`;
export const PROVIDER_ID = 'soul-gateway';

const GATEWAY_PREFIX = /^soul-gateway\//iu;
const MAX_MODEL_ID = 512;
const MAX_BODY = 2 * 1024 * 1024;
// The transport refuses a JSON upload above this size; the REWRITTEN body (model forced, stream:false added, unknown fields dropped) is checked
// against it so that a client body that fits MAX_BODY but not the rewrite gets 413, not a 502 from the transport.
const MAX_UPSTREAM_BODY = 2 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 15000;
const UPSTREAM_TOTAL_MS = 510000;
// OpenCode's own request timeout for this provider must not be shorter than the upstream limit (the call is buffered, so the first byte
// arrives only after the upstream answered).
const OPENCODE_PROVIDER_TIMEOUT_MS = 600000;
const MAX_CONCURRENT = 8;
// Admission of a chat request, decided from the request line BEFORE any body byte is read (M-45): at most 2 request bodies are in flight per
// execution (from admission until the answer is written, so at most 2 x 2 MiB are held), and a token bucket of 10 requests refilled at 5 per
// second. A request over either limit gets 429 `rate_limited` and its connection is destroyed unread. The upstream cap above stays.
export const ADMISSION = Object.freeze({ maxBodies: 2, burst: 10, refillPerSecond: 5 });
const MAX_CONNECTIONS = 16;
const MAX_HEADER_BYTES = 16 * 1024;
const MESSAGE_MAX = 300;
const SOCKET_PATH_MAX = 100;
const EDGE_RETRY = Object.freeze({ firstMs: 250, maxMs: 4000, windowMs: 30000 });
const EDGE_REFUSAL = /(?:^|;\s*)cause=edge-generation-(?:inactive|changed)\s*(?:;|$)/u;
// The OpenAI chat fields a client may set (OpenCode 1.19.5 sends model, messages, tools, tool_choice, max_tokens, stream and
// stream_options; the others are the common sampling and format fields). Everything else is dropped.
const CHAT_FIELDS = Object.freeze(['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_tokens', 'max_completion_tokens',
    'temperature', 'top_p', 'stop', 'seed', 'frequency_penalty', 'presence_penalty', 'response_format', 'reasoning_effort']);

// ---- model selection -----------------------------------------------------------------------------------------------------------

export const isGatewayModel = (value) => typeof value === 'string' && GATEWAY_PREFIX.test(value.trim());

// The model string with a gateway prefix in its one canonical spelling. OpenCode looks providers up case-sensitively (probed on 1.19.5:
// `Soul-Gateway/x` fails with an unknown error), while the channel accepts the prefix in any case, so the model string ALA is given as
// `--model` is canonicalised at execution time (alaPlan). The stored managed configuration is NOT touched (M-44), see selectGatewayProvider.
export function canonicalModel(value) {
    return isGatewayModel(value) ? `${PROVIDER_ID}/${value.trim().replace(GATEWAY_PREFIX, '')}` : value;
}

// The gateway id of a `soul-gateway/<id>` model string (prefix matched case-insensitively), or null when it is not a gateway model or the
// id is not a plausible one.
export function gatewayModelId(value) {
    if (!isGatewayModel(value)) return null;
    const id = value.trim().replace(GATEWAY_PREFIX, '');
    if (!id || id.length > MAX_MODEL_ID || /[\u0000-\u001f\u007f]/u.test(id)) return null;
    return id;
}

// The one gateway model this execution may use, or null (no channel). `specification` is the admitted version-2 specification and
// `managed` the robot's managed ALA configuration (config/ala.json). The agent is `spec.codingAgent ?? managed.codingAgent`; only
// OpenCode is served. The model is what ALA will run: `spec.model` when present (ALA gets `--model spec.model`), else the managed one.
export function selectGatewayModel({ specification, managed }) {
    const agent = specification?.codingAgent ?? managed?.codingAgent;
    if (agent !== 'opencode') return null;
    return gatewayModelId(specification?.model ?? managed?.models?.opencode);
}

// The OpenCode provider id the channel's configuration must define for this execution. ALA runs `--model spec.model` for an override, and
// alaPlan canonicalises that string, so the provider is `soul-gateway`. Without an override ALA reads the managed model itself from the
// robot's stored ala.json, which is never rewritten (M-44: a stored case variant must not make a robot stale), so OpenCode splits that stored
// string at the first `/` and looks the provider up case-sensitively: the provider id is then the stored prefix verbatim.
export function selectGatewayProvider({ specification, managed }) {
    if (specification?.model !== undefined) return PROVIDER_ID;
    const stored = managed?.models?.opencode;
    return isGatewayModel(stored) ? stored.trim().slice(0, stored.trim().indexOf('/')) : PROVIDER_ID;
}

// The model metadata OpenCode can use from a Soul Gateway catalog (a port of roboTeamAgent/server/soul-gateway-models.mjs
// openCodeGatewayModels): exact ids, limits and prices where the gateway reports them, nothing invented.
export function openCodeGatewayModels(catalog) {
    if (!Array.isArray(catalog?.data) || catalog.data.length > 10000) throw new Error('Soul Gateway returned an invalid model catalog.');
    const entries = catalog.data.map((entry) => {
        if (typeof entry?.id !== 'string' || !entry.id.trim() || entry.id.length > MAX_MODEL_ID || /[\x00-\x1f\x7f]/u.test(entry.id)) {
            throw new Error('Soul Gateway returned an invalid model ID.');
        }
        const model = { name: typeof entry.name === 'string' ? entry.name : entry.id };
        const context = entry._context?.window;
        const output = entry._context?.max_output_tokens;
        if (Number.isSafeInteger(context) && context > 0 && Number.isSafeInteger(output) && output > 0) model.limit = { context, output };
        const price = entry._pricing;
        if (price?.mode === 'token' && Number.isFinite(price.input_per_million) && price.input_per_million >= 0
            && Number.isFinite(price.output_per_million) && price.output_per_million >= 0) {
            model.cost = { input: price.input_per_million, output: price.output_per_million };
        }
        return [entry.id, model];
    });
    return new Map(entries);
}

// The generated OpenCode configuration: one openai-compatible provider whose baseURL is the relay and whose apiKey is a constant
// placeholder that the channel ignores. It carries no secret. OpenCode merges it with the user's own configuration (probed on 1.19.5:
// `options` of the file named by OPENCODE_CONFIG win over the HOME file, the user's other providers keep working).
export function openCodeConfig({ id, model, port = MODEL_RELAY_PORT, providerId = PROVIDER_ID }) {
    return {
        $schema: 'https://opencode.ai/config.json',
        provider: {
            [providerId]: {
                npm: '@ai-sdk/openai-compatible',
                name: 'Soul Gateway',
                options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'robo-work', timeout: OPENCODE_PROVIDER_TIMEOUT_MS },
                models: { [id]: model }
            }
        }
    };
}

// ---- the upstream --------------------------------------------------------------------------------------------------------------

export class UpstreamError extends Error {
    constructor(code) {
        super(code);
        this.name = 'UpstreamError';
        this.code = code;
    }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A text from the transport's redacted `readErrorText()` as a short single line: the JSON `error.message` when the body is JSON, else
// the text itself; control characters (and so every line break) replaced, at most 300 characters.
export function sanitizeUpstreamMessage(text) {
    let message = String(text ?? '');
    try {
        const parsed = JSON.parse(message);
        const inner = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
        if (typeof inner === 'string') message = inner;
    } catch { /* not JSON: the text is the message */ }
    return message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').replace(/ {2,}/gu, ' ').trim().slice(0, MESSAGE_MAX);
}

// The upstream connection, loaded lazily (a worker without a Router descriptor or credential starts normally; only an execution that
// needs the channel fails, with `model_channel_unavailable`). It mirrors roboTeamAgent/server/soul-gateway-connection.mjs: the
// AchillesAgentLib descriptor and Router transport from PLOINKY_AGENTLIB_DIR, the bearer from PLOINKY_AGENT_API_KEY, the descriptor
// refreshed before each request.
//
//   request({ operation: 'models' | 'chat', json, signal, totalTimeoutMs }) ->
//       { ok: true, status, json } | { ok: false, status, message }     (message: redacted, single line, at most 300 characters)
//   throws UpstreamError for a transport failure (nothing was answered) and rethrows an abort.
//
// Edge retry (base 8.3, provisional until G5): a response marked `x-ploinky-refusal: ...cause=edge-generation-inactive|changed` is
// resent after 250 ms, doubling to 4 s, for at most 30 s in all. Any other response, marked or not, and every transport failure is
// final: an unmarked response is never resent.
export function createSoulGatewayUpstream({ env = process.env, sleep = defaultSleep, now = Date.now, edge = EDGE_RETRY, load = null } = {}) {
    let connecting = null;

    async function loadModules() {
        if (!env.PLOINKY_ROUTER_DESCRIPTOR_FILE) throw new UpstreamError('router_descriptor_unavailable');
        if (!env.PLOINKY_AGENTLIB_DIR) throw new UpstreamError('agentlib_unavailable');
        if (!env.PLOINKY_AGENT_API_KEY) throw new UpstreamError('credential_unavailable');
        const root = path.join(env.PLOINKY_AGENTLIB_DIR, 'utils/LLMProviders/transport');
        const [descriptors, transport] = load
            ? await load(root)
            : await Promise.all([
                import(pathToFileURL(path.join(root, 'generatedLocalRouterDescriptor.mjs')).href),
                import(pathToFileURL(path.join(root, 'routerHttpTransport.mjs')).href)
            ]);
        const descriptor = descriptors.loadGeneratedLocalRouterDescriptor({ env });
        if (!descriptor) throw new UpstreamError('router_descriptor_unavailable');
        descriptors.buildGeneratedLocalOperationURL(descriptor, descriptors.GENERATED_LOCAL_MODELS_PATH);
        return { descriptors, transport, descriptor };
    }

    async function connection() {
        connecting ??= loadModules().catch((error) => { connecting = null; throw error instanceof UpstreamError ? error : new UpstreamError('upstream_unavailable'); });
        return connecting;
    }

    async function once({ descriptors, transport, descriptor }, { operation, json, signal, totalTimeoutMs }) {
        const current = descriptors.refreshGeneratedLocalRouterDescriptor(descriptor, { env });
        const pathname = operation === 'models' ? descriptors.GENERATED_LOCAL_MODELS_PATH : descriptors.GENERATED_LOCAL_CHAT_PATH;
        descriptors.buildGeneratedLocalOperationURL(current, pathname);
        return transport.routerHttpRequest({
            descriptor: current, pathname, method: operation === 'models' ? 'GET' : 'POST', bearer: env.PLOINKY_AGENT_API_KEY, json, signal, totalTimeoutMs
        });
    }

    return {
        async request({ operation, json, signal, totalTimeoutMs = UPSTREAM_TOTAL_MS }) {
            if (operation !== 'models' && operation !== 'chat') throw new UpstreamError('unsupported_operation');
            const modules = await connection();
            const startedAt = now();
            let delay = edge.firstMs;
            for (;;) {
                let response;
                try {
                    response = await once(modules, { operation, json, signal, totalTimeoutMs: Math.max(1000, totalTimeoutMs - (now() - startedAt)) });
                } catch (error) {
                    if (signal?.aborted || error?.name === 'AbortError') throw error;
                    // The transport's own error text is redacted, but it is not needed: the code says what failed.
                    throw new UpstreamError(typeof error?.code === 'string' && /^PLOINKY_[A-Z_]{1,60}$/u.test(error.code) ? error.code : 'upstream_failed');
                }
                if (response.ok) {
                    try { return { ok: true, status: response.status, json: await response.json() }; } catch (error) {
                        if (signal?.aborted || error?.name === 'AbortError') throw error;
                        throw new UpstreamError('upstream_response_invalid');
                    }
                }
                let text = '';
                try { text = await response.readErrorText(); } catch (error) {
                    if (signal?.aborted || error?.name === 'AbortError') throw error;
                }
                const marked = EDGE_REFUSAL.test(String(response.headers?.['x-ploinky-refusal'] ?? ''));
                if (marked && now() - startedAt + delay <= edge.windowMs) {
                    await sleep(delay);
                    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
                    delay = Math.min(delay * 2, edge.maxMs);
                    continue;
                }
                return { ok: false, status: response.status, message: sanitizeUpstreamMessage(text) };
            }
        }
    };
}

// ---- the channel ---------------------------------------------------------------------------------------------------------------

// The request body as a Buffer, or null once it exceeds `limit` (the rest is read and discarded, never buffered, so that the 413 reaches
// the client: destroying the request would destroy its socket before the answer is flushed; the 60 s request timeout bounds the upload).
function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let over = false;
        req.on('data', (chunk) => {
            if (over) return;
            size += chunk.length;
            if (size > limit) { over = true; chunks.length = 0; resolve(null); } else chunks.push(chunk);
        });
        req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
        req.on('error', reject);
        req.on('close', () => reject(new Error('The request was closed')));
    });
}

function sendJson(res, status, value) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
    res.end(JSON.stringify(value));
}

const sendError = (res, status, message, type = 'invalid_request_error') => sendJson(res, status, { error: { message, type } });

// A completion is served only when every choice is an object whose message, when present, is an object and whose tool_calls, when present,
// is an array of objects. Anything else is a bad gateway answer, decided BEFORE any response byte is written.
function validCompletion(response) {
    if (!response || typeof response !== 'object' || !Array.isArray(response.choices)) return false;
    return response.choices.every((choice) => {
        if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return false;
        const { message } = choice;
        if (message === undefined) return true;
        if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
        const calls = message.tool_calls;
        return calls === undefined || (Array.isArray(calls) && calls.every((call) => call && typeof call === 'object' && !Array.isArray(call)));
    });
}

// The completed message as SSE for OpenCode (legacy emulation, roboTeamAgent/server/soul-gateway-opencode.mjs sendCompletion): tool calls,
// usage and the upstream finish reason are preserved. Both chunks are built from a validated completion before the first write.
function sendCompletion(res, response) {
    const chunk = {
        id: response.id, object: 'chat.completion.chunk', created: response.created, model: response.model,
        choices: response.choices.map((choice, index) => ({
            index: choice.index ?? index, finish_reason: null,
            delta: { ...choice.message, ...(choice.message?.tool_calls ? { tool_calls: choice.message.tool_calls.map((call, i) => ({ ...call, index: i })) } : {}) }
        }))
    };
    const last = {
        ...chunk, usage: response.usage,
        choices: response.choices.map((choice, index) => ({ index: choice.index ?? index, delta: {}, finish_reason: choice.finish_reason || 'stop' }))
    };
    const frames = [`data: ${JSON.stringify(chunk)}\n\n`, `data: ${JSON.stringify(last)}\n\n`, 'data: [DONE]\n\n'];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
    res.end(frames.join(''));
}

// Opens the channel of one execution. `allowed` is the single gateway model id (prefix stripped). `socketDirectory` is the execution's
// `model/` directory (bound into the endpoint only); `configDirectory` its `channels/` directory (where the OpenCode config goes, as a
// file every workload may read). Throws ExecutionSetupError('model_channel_unavailable') when the gateway cannot be reached or answers
// the catalog request badly, and ExecutionSetupError('model_unavailable') when the allowed id is not in its catalog.
export async function createModelChannel({
    socketDirectory, configDirectory, allowed, upstream, activity = () => {}, log = () => {}, executionId = null,
    now = Date.now, port = MODEL_RELAY_PORT, providerId = PROVIDER_ID, admission = ADMISSION
}) {
    const socketPath = path.join(socketDirectory, MODEL_SOCKET_NAME);
    if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX) throw new ExecutionSetupError('model_channel_unavailable');

    // The catalog check (15 s): the model must exist before anything is published, so a typo or a retired model fails fast and plainly.
    let metadata;
    try {
        const answer = await upstream.request({ operation: 'models', signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS), totalTimeoutMs: CATALOG_TIMEOUT_MS });
        if (!answer.ok) {
            log('model_channel_catalog_failed', { executionId, status: answer.status });
            throw new ExecutionSetupError('model_channel_unavailable');
        }
        metadata = openCodeGatewayModels(answer.json);
    } catch (error) {
        if (error instanceof ExecutionSetupError) throw error;
        log('model_channel_catalog_failed', { executionId, error: String(error?.code ?? error?.name ?? 'error').slice(0, 64) });
        throw new ExecutionSetupError('model_channel_unavailable');
    }
    if (!metadata.has(allowed)) throw new ExecutionSetupError('model_unavailable');

    const controllers = new Set();
    let closed = false;
    let lastError = null;
    let inFlight = 0;
    let bodies = 0;
    let tokens = admission.burst;
    let refilledAt = now();
    // Takes one token of the bucket (refilled by elapsed time, at most `burst`); false when it is empty.
    const takeToken = () => {
        const current = now();
        tokens = Math.min(admission.burst, tokens + ((current - refilledAt) / 1000) * admission.refillPerSecond);
        refilledAt = current;
        if (tokens < 1) return false;
        tokens -= 1;
        return true;
    };

    const fail = (status, message) => { lastError = { status, message }; };

    // Answers 429 `rate_limited` without having read the body, then destroys the request (and with it the upload).
    function rateLimited(req, res) {
        const startedAt = now();
        if (!res.headersSent) {
            res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '1', connection: 'close' });
            res.end(JSON.stringify({ error: { message: 'rate_limited', type: 'rate_limit_error', code: 'rate_limited' } }));
        }
        res.once('finish', () => req.destroy());
        res.once('close', () => req.destroy());
        log('model_request', { executionId, model: null, status: 429, ms: now() - startedAt });
    }

    async function chat(req, res) {
        const startedAt = now();
        let status = 0;
        let loggedModel = null;
        const reply = (code, value) => { status = code; sendJson(res, code, value); };
        const refuse = (code, message, type) => reply(code, { error: { message, type: type ?? 'invalid_request_error' } });
        try {
            const raw = await readBody(req, MAX_BODY);
            if (raw === null) { refuse(413, 'The request is too large'); return; }
            let body;
            try { body = JSON.parse(raw.toString('utf8')); } catch { refuse(400, 'Invalid JSON'); return; }
            if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
                refuse(400, 'Model and messages are required');
                return;
            }
            // The request names the model as OpenCode sends it (the key of the generated config); `soul-gateway/<id>` is accepted too.
            if (body.model !== allowed && gatewayModelId(body.model) !== allowed) { refuse(403, 'model_not_allowed', 'model_not_allowed'); return; }
            loggedModel = allowed;
            const streaming = body.stream === true;
            const payload = { model: allowed, stream: false };
            for (const field of CHAT_FIELDS) if (Object.hasOwn(body, field)) payload[field] = body[field];
            if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_UPSTREAM_BODY) { refuse(413, 'The request is too large'); return; }
            if (inFlight >= MAX_CONCURRENT) { refuse(429, 'Too many model requests at once', 'rate_limit_error'); return; }
            inFlight += 1;
            const controller = new AbortController();
            controllers.add(controller);
            res.on('close', () => { if (!res.writableEnded) controller.abort(); });
            try {
                const answer = await upstream.request({ operation: 'chat', json: payload, signal: controller.signal });
                if (!answer.ok) {
                    const code = Number.isInteger(answer.status) && answer.status >= 400 && answer.status < 600 ? answer.status : 502;
                    const message = answer.message || `Soul Gateway answered HTTP ${answer.status}`;
                    fail(answer.status, message);
                    refuse(code, message, 'upstream_error');
                    return;
                }
                if (!validCompletion(answer.json)) {
                    fail(502, 'Soul Gateway returned an invalid completion');
                    refuse(502, 'Soul Gateway returned an invalid completion', 'upstream_error');
                    return;
                }
                if (streaming) sendCompletion(res, answer.json); else sendJson(res, 200, answer.json);
                lastError = null;
                status = 200;
                // M-33: only a successful model response is activity of the attempt, counted after the response was written.
                try { activity(); } catch { /* the caller's counter must not break the reply */ }
            } catch (error) {
                if (controller.signal.aborted || res.destroyed) { status = 499; return; }
                if (error?.code === 'PLOINKY_ROUTER_REQUEST_TOO_LARGE') { refuse(413, 'The request is too large'); return; }
                fail(502, 'Soul Gateway could not be reached');
                log('model_request_failed', { executionId, error: String(error?.code ?? error?.name ?? 'error').slice(0, 64) });
                refuse(502, 'Soul Gateway request failed', 'upstream_error');
            } finally {
                inFlight -= 1;
                controllers.delete(controller);
            }
        } catch {
            if (!res.headersSent) refuse(500, 'The request could not be served', 'server_error');
        } finally {
            log('model_request', { executionId, model: loggedModel, status, ms: now() - startedAt });
        }
    }

    const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
        if (closed) { sendError(res, 503, 'The model channel is closed', 'server_error'); return; }
        // Exact request line only: no query string, no other path or method. No header of the request is read, let alone forwarded.
        if (req.method === 'GET' && req.url === '/v1/models') {
            sendJson(res, 200, { object: 'list', data: [{ id: allowed, object: 'model', owned_by: PROVIDER_ID }] });
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
            // Admission before the first body byte: the number of bodies in flight, then the request rate.
            if (bodies >= admission.maxBodies || !takeToken()) { rateLimited(req, res); return; }
            bodies += 1;
            chat(req, res).finally(() => { bodies -= 1; });
            return;
        }
        sendError(res, 404, 'Not found', 'not_found');
    });
    // Its own limits (like channels.mjs): headers within 15 s, the whole request within 60 s, no socket idle timeout while the buffered
    // upstream call runs (up to 510 s), a bounded number of connections (the relay allows 16).
    server.headersTimeout = 15000;
    server.requestTimeout = 60000;
    server.timeout = 0;
    server.keepAliveTimeout = 1000;
    server.maxConnections = MAX_CONNECTIONS;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });

    async function close() {
        closed = true;
        for (const controller of controllers) controller.abort();
        await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    }

    // The configuration is written after the socket listens, so a workload never sees a config without a channel.
    try {
        const config = `${JSON.stringify(openCodeConfig({ id: allowed, model: metadata.get(allowed), port, providerId }), null, 2)}\n`;
        await fs.writeFile(path.join(configDirectory, OPENCODE_CONFIG_NAME), config, { flag: 'wx', mode: 0o644 });
    } catch {
        await close();
        throw new ExecutionSetupError('model_channel_unavailable');
    }

    return Object.freeze({
        port, socketPath, allowed,
        // { status, message } of the last upstream error since the last successful response, or null (M-43 (a)).
        lastError: () => (lastError === null ? null : { ...lastError }),
        close
    });
}

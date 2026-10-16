import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import {
    BadRequestError,
    ConfigurationError,
    GatewayError,
    ModelNotFoundError,
    ProviderAccountsExhaustedError,
    TierExhaustedError,
    UnsupportedFormatError,
} from '../core/errors.mjs';
import { authenticateMiddleware } from '../runtime/route/authenticate.mjs';
import { normalizeModelName } from '../runtime/registry/model-name-normalizer.mjs';
import { resolveModel } from '../runtime/registry/model-registry.mjs';
import {
    normalizeModelRecord,
    normalizeProviderRecord,
} from '../runtime/providers/runtime-record-normalizer.mjs';

const EMBEDDINGS_TAG = 'embeddings';

export async function handleEmbeddingsRoute(ctx) {
    const authCtx = {
        requestId: ctx.requestId,
        appCtx: ctx.appCtx,
        http: { req: ctx.req, res: ctx.res },
        metadata: {},
        log: ctx.appCtx?.log,
    };

    await authenticateMiddleware()(authCtx, async () => {
        ctx.auth = authCtx.auth;
        const body = normalizeEmbeddingsRequest(await readJsonBody(ctx.req));
        const snapshot = ctx.appCtx?.services?.snapshot || null;
        if (!snapshot) {
            throw new ConfigurationError('Runtime snapshot is not available');
        }

        const resolved = resolveRequestedModel(snapshot, body.model);
        const response = await executeEmbeddingsRequest({
            appCtx: ctx.appCtx,
            snapshot,
            requestId: ctx.requestId,
            request: body,
            resolvedModel: resolved.model,
            log: ctx.appCtx?.log,
        });

        ctx.appCtx?.log?.info?.('embeddings request complete', {
            requestId: ctx.requestId,
            model: body.model,
            resolvedModel:
                response?._soul_gateway?.resolvedModel ||
                resolved.model?.modelKey ||
                resolved.model?.model_key ||
                null,
            inputCount: countInputs(body.input),
        });

        delete response?._soul_gateway;
        sendJson(ctx.res, 200, response);
    });
}

function normalizeEmbeddingsRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new BadRequestError('Embeddings request body must be a JSON object');
    }

    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
        throw new BadRequestError('Embeddings request requires a model');
    }

    if (!isValidInput(body.input)) {
        throw new BadRequestError(
            'Embeddings request input must be a string or a non-empty array'
        );
    }

    const request = {
        model,
        input: body.input,
    };
    if (body.encoding_format != null) {
        request.encoding_format = body.encoding_format;
    }
    if (body.dimensions != null) {
        request.dimensions = body.dimensions;
    }
    if (body.user != null) {
        request.user = body.user;
    }
    return request;
}

function isValidInput(input) {
    if (typeof input === 'string') return input.length > 0;
    return Array.isArray(input) && input.length > 0;
}

function countInputs(input) {
    return Array.isArray(input) ? input.length : 1;
}

function resolveRequestedModel(snapshot, requestedModel) {
    const { normalized } = normalizeModelName(requestedModel, snapshot);
    const result = resolveModel(snapshot, normalized);
    if (!result) throw new ModelNotFoundError(requestedModel);
    return result;
}

async function executeEmbeddingsRequest({
    appCtx,
    snapshot,
    requestId,
    request,
    resolvedModel,
    log,
}) {
    const strategyKind =
        resolvedModel?.strategyKind || resolvedModel?.strategy_kind || 'direct';
    if (strategyKind === 'direct') {
        return executeDirectEmbeddingModel({
            appCtx,
            snapshot,
            requestId,
            request,
            model: resolvedModel,
            log,
        });
    }

    if (strategyKind !== 'cascade') {
        throw new ConfigurationError(
            `Embeddings cannot execute model strategy '${strategyKind}'`
        );
    }

    const children = embeddingCascadeChildren(snapshot, resolvedModel);
    if (children.length === 0) {
        throw new TierExhaustedError(modelKeyOf(resolvedModel));
    }

    const trace = [];
    for (const child of children) {
        try {
            return await executeDirectEmbeddingModel({
                appCtx,
                snapshot,
                requestId,
                request,
                model: child,
                log,
            });
        } catch (error) {
            trace.push({
                model: modelKeyOf(child),
                error_type: error?.errorType || 'unknown',
                cascade: !!error?.cascade,
                timestamp: new Date().toISOString(),
            });
            if (!error?.cascade) throw error;
        }
    }

    const exhausted = new TierExhaustedError(modelKeyOf(resolvedModel));
    exhausted.detail = { trace };
    throw exhausted;
}

function embeddingCascadeChildren(snapshot, cascadeModel) {
    return (cascadeModel.children || [])
        .filter((child) => child.childEnabled !== false)
        .map((child) => snapshot.models.get(child.modelKey))
        .filter(Boolean)
        .filter((model) => isEmbeddingModel(model));
}

function isEmbeddingModel(model) {
    const tags = model?.tags;
    return Array.isArray(tags) && tags.includes(EMBEDDINGS_TAG);
}

async function executeDirectEmbeddingModel({
    appCtx,
    snapshot,
    requestId,
    request,
    model: rawModel,
    log,
}) {
    const model = normalizeModelRecord(rawModel);
    const providerKey = model.providerKey || model.provider_key;
    const provider = normalizeProviderRecord(
        snapshot.providers?.get?.(providerKey)
    );
    if (!provider) {
        throw new ConfigurationError(
            `Provider not found for model: ${model.modelKey}`
        );
    }

    const backendCatalog = appCtx?.services?.backendCatalog || null;
    const backend = backendCatalog?.getBackend?.(provider.backendKey);
    if (!backend) {
        throw new ConfigurationError(`Backend not loaded: ${provider.backendKey}`);
    }
    if (typeof backend.embed !== 'function') {
        throw new UnsupportedFormatError(
            `Provider backend '${provider.backendKey}' does not support embeddings`
        );
    }

    const releaseConcurrency = await acquireConcurrency(appCtx, model);
    const credentialManager = appCtx?.services?.credentialManager || null;
    const credentialLease = credentialManager
        ? await credentialManager.getCredentials(provider.id)
        : null;

    try {
        const response = await backend.embed({
            requestId,
            request,
            resolvedModel: model,
            providerRecord: provider,
            credentialLease,
            signal: null,
            logger: log,
            services: appCtx?.services || Object.freeze({}),
        });
        if (!response || typeof response !== 'object') {
            throw new ConfigurationError(
                `Provider backend '${provider.backendKey}' returned invalid embeddings response`
            );
        }
        response._soul_gateway = { resolvedModel: model.modelKey };
        return response;
    } catch (error) {
        throw classifyBackendError(backend, error, {
            requestId,
            request,
            resolvedModel: model,
            providerRecord: provider,
            credentialLease,
        });
    } finally {
        if (credentialLease && credentialManager) {
            credentialManager.release(credentialLease);
        }
        releaseConcurrency();
    }
}

async function acquireConcurrency(appCtx, model) {
    const controller = appCtx?.services?.concurrencyController || null;
    if (!controller) return () => {};

    const env = appCtx?.config?.env || {};
    const modelKey = model.modelKey || model.model_key;
    const max =
        model.concurrencyLimit ||
        model.concurrency_limit ||
        env.DEFAULT_MODEL_CONCURRENCY;
    const queueTimeoutMs =
        model.queueTimeoutMs ||
        model.queue_timeout_ms ||
        env.DEFAULT_QUEUE_TIMEOUT_MS;

    controller.configure(modelKey, max);
    return controller.acquire(modelKey, queueTimeoutMs);
}

function classifyBackendError(backend, error, executionCtx) {
    if (error instanceof GatewayError) return error;
    if (error instanceof ProviderAccountsExhaustedError) return error;
    if (typeof backend.classifyError !== 'function') return error;
    return backend.classifyError(error, executionCtx);
}

function modelKeyOf(model) {
    return model?.modelKey || model?.model_key || null;
}

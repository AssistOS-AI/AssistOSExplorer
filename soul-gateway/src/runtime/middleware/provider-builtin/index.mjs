/**
 * Native provider middlewares.
 *
 * These are the built-in provider-scope middlewares the gateway ships
 * with.  They use the unified kernel `(ctx, next)` contract directly.
 * Each module exports a `meta` block describing the middleware and a
 * `factory(settings)` function that returns the kernel middleware bound
 * with those settings.
 *
 * The runtime registry (`provider-middleware-registry.mjs`) holds these
 * factories and the planner (`compileProviderMiddlewareChain`) builds
 * one kernel chain per assignment.
 *
 * @module runtime/middleware/provider-builtin
 */

import * as contextCompacter from './provider-context-compacter.mjs';
import * as promptInjector from './provider-prompt-injector.mjs';
import * as outputCompressor from './provider-output-compressor.mjs';
import * as responseFilter from './provider-response-filter.mjs';

export const BUILTIN_PROVIDER_MIDDLEWARES = Object.freeze([
    contextCompacter,
    promptInjector,
    outputCompressor,
    responseFilter,
]);

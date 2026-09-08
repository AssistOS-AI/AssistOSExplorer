/**
 * Request lifecycle management with AbortController integration.
 *
 * Provides:
 * - AbortController/signal management for async operations
 * - Request timing and metadata
 * - Context propagation through async boundaries
 *
 * Usage:
 *   import { RequestContext } from './lib/RequestContext.mjs';
 *
 *   // Create context for an operation
 *   const ctx = new RequestContext({ skillName: 'my-skill' });
 *
 *   // Pass signal to async operations
 *   await fetch(url, { signal: ctx.signal });
 *
 *   // Cancel if needed
 *   ctx.abort('User cancelled');
 *
 *   // Check for cancellation in long operations
 *   ctx.throwIfAborted();
 */

import { SkillExecutionCancelledError } from './errors/index.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const requestStorage = new AsyncLocalStorage();

/**
 * Request context for managing async operation lifecycle.
 */
export class RequestContext {
    #abortController;
    #startTime;
    #metadata;
    #children = [];
    #parent = null;

    /**
     * Create a new RequestContext.
     *
     * @param {Object} [metadata={}] - Request metadata (skillName, prompt, etc.)
     * @param {RequestContext} [parent=null] - Parent context for nested operations
     */
    constructor(metadata = {}, parent = null) {
        this.#abortController = new AbortController();
        this.#startTime = Date.now();
        this.#metadata = { ...metadata, createdAt: new Date().toISOString() };
        this.#parent = parent;

        // If parent exists, link abort signals
        if (parent) {
            parent.#children.push(this);
            // Abort child when parent aborts
            parent.signal.addEventListener('abort', () => {
                this.abort(parent.signal.reason);
            });
        }
    }

    /**
     * Get the AbortSignal for this context.
     * Pass this to fetch, setTimeout, and other cancellable operations.
     *
     * @returns {AbortSignal}
     */
    get signal() {
        return this.#abortController.signal;
    }

    /**
     * Get elapsed time in milliseconds since context creation.
     *
     * @returns {number}
     */
    get elapsed() {
        return Date.now() - this.#startTime;
    }

    /**
     * Get request metadata.
     *
     * @returns {Object}
     */
    get metadata() {
        return { ...this.#metadata };
    }

    /**
     * Check if the operation has been aborted.
     *
     * @returns {boolean}
     */
    get aborted() {
        return this.#abortController.signal.aborted;
    }

    /**
     * Get the abort reason if aborted.
     *
     * @returns {*}
     */
    get abortReason() {
        return this.#abortController.signal.reason;
    }

    /**
     * Abort the operation and all child contexts.
     *
     * @param {string} [reason='User cancelled'] - Reason for cancellation
     */
    abort(reason = 'User cancelled') {
        if (!this.aborted) {
            this.#abortController.abort(reason);
            // Children are automatically aborted via event listener
        }
    }

    /**
     * Throw an error if the operation has been aborted.
     * Use this in long-running operations to check for cancellation.
     *
     * @throws {SkillExecutionCancelledError} If aborted
     */
    throwIfAborted() {
        if (this.aborted) {
            const skillName = this.#metadata.skillName || 'unknown';
            throw new SkillExecutionCancelledError(skillName);
        }
    }

    /**
     * Create a child context for nested operations.
     * Child contexts inherit parent abort signal.
     *
     * @param {Object} [metadata={}] - Additional metadata for child
     * @returns {RequestContext}
     */
    child(metadata = {}) {
        return new RequestContext(
            { ...this.#metadata, ...metadata },
            this
        );
    }

    /**
     * Add metadata to the context.
     *
     * @param {Object} metadata - Metadata to add
     * @returns {RequestContext} This instance for chaining
     */
    addMetadata(metadata) {
        Object.assign(this.#metadata, metadata);
        return this;
    }

    /**
     * Get a summary of the context for logging.
     *
     * @returns {Object}
     */
    toJSON() {
        return {
            elapsed: this.elapsed,
            aborted: this.aborted,
            abortReason: this.abortReason,
            metadata: this.#metadata,
            childCount: this.#children.length,
        };
    }

    /**
     * Execute a function with this context.
     * Sets this context as current during execution.
     *
     * @param {Function} fn - Function to execute, receives context as argument
     * @returns {*} Result of fn
     */
    run(fn) {
        return requestStorage.run(this, () => fn(this));
    }

    /**
     * Execute an async function with this context.
     *
     * @param {Function} fn - Async function to execute
     * @returns {Promise<*>} Result of fn
     */
    async runAsync(fn) {
        return requestStorage.run(this, () => fn(this));
    }

    /**
     * Current request context scoped to this asynchronous execution.
     * @type {RequestContext|null}
     */
    static get current() { return requestStorage.getStore() || null; }

    /**
     * Execute a function with a new context.
     * Convenience method that creates a context and runs the function.
     *
     * @param {Object} metadata - Context metadata
     * @param {Function} fn - Function to execute
     * @returns {*} Result of fn
     */
    static withContext(metadata, fn) {
        const ctx = new RequestContext(metadata);
        return ctx.run(fn);
    }

    /**
     * Execute an async function with a new context.
     *
     * @param {Object} metadata - Context metadata
     * @param {Function} fn - Async function to execute
     * @returns {Promise<*>} Result of fn
     */
    static async withContextAsync(metadata, fn) {
        const ctx = new RequestContext(metadata);
        return ctx.runAsync(fn);
    }

    /**
     * Get the current context or create a new one.
     *
     * @param {Object} [metadata={}] - Metadata if creating new context
     * @returns {RequestContext}
     */
    static getOrCreate(metadata = {}) {
        return RequestContext.current || new RequestContext(metadata);
    }
}

/**
 * Decorator-like function to wrap an async function with request context.
 *
 * @param {Function} fn - Function to wrap
 * @param {Object} [defaultMetadata={}] - Default metadata for context
 * @returns {Function} Wrapped function
 */
export function withRequestContext(fn, defaultMetadata = {}) {
    return async function (...args) {
        return RequestContext.withContextAsync(
            { ...defaultMetadata, args: args.length },
            () => fn.apply(this, args)
        );
    };
}

/**
 * Create a timeout that respects the abort signal.
 *
 * @param {number} ms - Timeout in milliseconds
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<void>}
 */
export function abortableTimeout(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error(signal.reason || 'Aborted'));
            return;
        }

        const timer = setTimeout(resolve, ms);

        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error(signal.reason || 'Aborted'));
        });
    });
}

/**
 * Race a promise against an abort signal.
 *
 * @param {Promise} promise - Promise to race
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise} Original promise result or abort error
 */
export function raceWithAbort(promise, signal) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            if (signal.aborted) {
                reject(new Error(signal.reason || 'Aborted'));
                return;
            }
            signal.addEventListener('abort', () => {
                reject(new Error(signal.reason || 'Aborted'));
            });
        }),
    ]);
}

export default RequestContext;

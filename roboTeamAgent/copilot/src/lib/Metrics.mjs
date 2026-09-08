/**
 * Metrics collection for achilles-cli.
 *
 * Provides:
 * - Counters for counting events
 * - Histograms for timing and distributions
 * - Hook system for metric consumers
 *
 * Usage:
 *   import { metrics } from './lib/Metrics.mjs';
 *
 *   // Count events
 *   metrics.increment('skill_executions', 1, { skillName: 'my-skill' });
 *
 *   // Record timing
 *   metrics.timing('skill_execution_ms', elapsed, { skillName: 'my-skill' });
 *
 *   // Subscribe to metrics
 *   const unsubscribe = metrics.onMetric(({ type, name, value, labels }) => {
 *       console.log(`Metric: ${name}=${value}`);
 *   });
 */

/**
 * Metrics collection class.
 */
class Metrics {
    #counters = new Map();
    #histograms = new Map();
    #hooks = [];
    #enabled = true;

    /**
     * Create a new Metrics instance.
     *
     * @param {Object} [options={}] - Metrics options
     * @param {boolean} [options.enabled=true] - Whether metrics are enabled
     */
    constructor(options = {}) {
        this.#enabled = options.enabled ?? true;
    }

    /**
     * Increment a counter.
     *
     * @param {string} name - Counter name
     * @param {number} [value=1] - Value to add
     * @param {Object} [labels={}] - Labels for grouping
     */
    increment(name, value = 1, labels = {}) {
        if (!this.#enabled) return;

        const key = this.#makeKey(name, labels);
        const current = this.#counters.get(key) || 0;
        this.#counters.set(key, current + value);

        this.#notify('counter', name, value, labels);
    }

    /**
     * Record a timing value.
     *
     * @param {string} name - Metric name
     * @param {number} duration - Duration in milliseconds
     * @param {Object} [labels={}] - Labels for grouping
     */
    timing(name, duration, labels = {}) {
        if (!this.#enabled) return;

        const key = this.#makeKey(name, labels);
        if (!this.#histograms.has(key)) {
            this.#histograms.set(key, []);
        }
        this.#histograms.get(key).push(duration);

        this.#notify('timing', name, duration, labels);
    }

    /**
     * Record a gauge value (point-in-time measurement).
     *
     * @param {string} name - Metric name
     * @param {number} value - Current value
     * @param {Object} [labels={}] - Labels for grouping
     */
    gauge(name, value, labels = {}) {
        if (!this.#enabled) return;

        const key = this.#makeKey(name, labels);
        // Store gauge as single value, overwriting previous
        this.#counters.set(key, value);

        this.#notify('gauge', name, value, labels);
    }

    /**
     * Time a function execution.
     *
     * @param {string} name - Metric name
     * @param {Function} fn - Function to execute
     * @param {Object} [labels={}] - Labels for grouping
     * @returns {*} Function result
     */
    time(name, fn, labels = {}) {
        const start = Date.now();
        try {
            return fn();
        } finally {
            this.timing(name, Date.now() - start, labels);
        }
    }

    /**
     * Time an async function execution.
     *
     * @param {string} name - Metric name
     * @param {Function} fn - Async function to execute
     * @param {Object} [labels={}] - Labels for grouping
     * @returns {Promise<*>} Function result
     */
    async timeAsync(name, fn, labels = {}) {
        const start = Date.now();
        try {
            return await fn();
        } finally {
            this.timing(name, Date.now() - start, labels);
        }
    }

    /**
     * Subscribe to metric events.
     *
     * @param {Function} hook - Callback for metric events
     * @returns {Function} Unsubscribe function
     */
    onMetric(hook) {
        this.#hooks.push(hook);
        return () => {
            const idx = this.#hooks.indexOf(hook);
            if (idx >= 0) this.#hooks.splice(idx, 1);
        };
    }

    /**
     * Get a counter value.
     *
     * @param {string} name - Counter name
     * @param {Object} [labels={}] - Labels
     * @returns {number} Current counter value
     */
    getCounter(name, labels = {}) {
        const key = this.#makeKey(name, labels);
        return this.#counters.get(key) || 0;
    }

    /**
     * Get histogram statistics.
     *
     * @param {string} name - Histogram name
     * @param {Object} [labels={}] - Labels
     * @returns {Object|null} Statistics or null if no data
     */
    getHistogram(name, labels = {}) {
        const key = this.#makeKey(name, labels);
        const values = this.#histograms.get(key);

        if (!values || values.length === 0) return null;

        const sorted = [...values].sort((a, b) => a - b);
        const sum = values.reduce((a, b) => a + b, 0);

        return {
            count: values.length,
            sum,
            avg: sum / values.length,
            min: sorted[0],
            max: sorted[sorted.length - 1],
            p50: this.#percentile(sorted, 0.5),
            p90: this.#percentile(sorted, 0.9),
            p99: this.#percentile(sorted, 0.99),
        };
    }

    /**
     * Get all statistics as a summary.
     *
     * @returns {Object} Summary object with counters and histograms
     */
    getStats() {
        const counters = {};
        for (const [key, value] of this.#counters) {
            counters[key] = value;
        }

        const histograms = {};
        for (const [key, values] of this.#histograms) {
            if (values.length > 0) {
                const sorted = [...values].sort((a, b) => a - b);
                const sum = values.reduce((a, b) => a + b, 0);
                histograms[key] = {
                    count: values.length,
                    avg: Math.round(sum / values.length),
                    min: sorted[0],
                    max: sorted[sorted.length - 1],
                };
            }
        }

        return { counters, histograms };
    }

    /**
     * Reset all metrics.
     */
    reset() {
        this.#counters.clear();
        this.#histograms.clear();
    }

    /**
     * Enable or disable metrics collection.
     *
     * @param {boolean} enabled - Whether to enable metrics
     */
    setEnabled(enabled) {
        this.#enabled = enabled;
    }

    /**
     * Check if metrics are enabled.
     *
     * @returns {boolean}
     */
    isEnabled() {
        return this.#enabled;
    }

    /**
     * Create a key from name and labels.
     *
     * @param {string} name - Metric name
     * @param {Object} labels - Labels
     * @returns {string}
     * @private
     */
    #makeKey(name, labels) {
        const labelStr = Object.keys(labels)
            .sort()
            .map((k) => `${k}=${labels[k]}`)
            .join(',');
        return labelStr ? `${name}{${labelStr}}` : name;
    }

    /**
     * Notify all hooks of a metric event.
     *
     * @param {string} type - Metric type
     * @param {string} name - Metric name
     * @param {number} value - Metric value
     * @param {Object} labels - Labels
     * @private
     */
    #notify(type, name, value, labels) {
        for (const hook of this.#hooks) {
            try {
                hook({ type, name, value, labels, timestamp: Date.now() });
            } catch {
                // Ignore hook errors
            }
        }
    }

    /**
     * Calculate percentile from sorted array.
     *
     * @param {number[]} sorted - Sorted array
     * @param {number} p - Percentile (0-1)
     * @returns {number}
     * @private
     */
    #percentile(sorted, p) {
        const idx = Math.ceil(sorted.length * p) - 1;
        return sorted[Math.max(0, idx)];
    }
}

/**
 * Predefined metric names for consistency.
 */
export const METRIC_NAMES = {
    // Skill execution
    SKILL_EXECUTIONS: 'skill_executions',
    SKILL_EXECUTION_MS: 'skill_execution_ms',
    SKILL_ERRORS: 'skill_errors',

    // LLM operations
    LLM_REQUESTS: 'llm_requests',
    LLM_REQUEST_MS: 'llm_request_ms',
    LLM_TOKENS_IN: 'llm_tokens_in',
    LLM_TOKENS_OUT: 'llm_tokens_out',

    // REPL operations
    REPL_COMMANDS: 'repl_commands',
    REPL_COMMAND_MS: 'repl_command_ms',

    // Repository operations
    REPO_OPERATIONS: 'repo_operations',
    REPO_OPERATION_MS: 'repo_operation_ms',
};

/**
 * Singleton metrics instance.
 */
export const metrics = new Metrics();

/**
 * Export the Metrics class for testing.
 */
export { Metrics };

export default metrics;

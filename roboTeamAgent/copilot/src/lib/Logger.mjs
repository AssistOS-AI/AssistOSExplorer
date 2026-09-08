/**
 * Structured logging for achilles-cli.
 *
 * Provides:
 * - Log levels (debug, info, warn, error)
 * - Structured JSON output
 * - Child loggers with inherited context
 * - Configurable output target
 *
 * Usage:
 *   import { logger } from './lib/Logger.mjs';
 *
 *   logger.info('Skill executed', { skillName: 'my-skill', elapsed: 123 });
 *   logger.error('Execution failed', { error: err.message });
 *
 *   // Create child logger with context
 *   const skillLogger = logger.child({ skillName: 'my-skill' });
 *   skillLogger.info('Starting execution'); // includes skillName automatically
 */

import { config } from './Config.mjs';

/**
 * Log level definitions with numeric priority.
 */
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

/**
 * ANSI color codes for terminal output.
 */
const COLORS = {
    debug: '\x1b[36m', // Cyan
    info: '\x1b[32m',  // Green
    warn: '\x1b[33m',  // Yellow
    error: '\x1b[31m', // Red
    reset: '\x1b[0m',
};

/**
 * Structured logger class.
 */
class Logger {
    #level;
    #output;
    #json;
    #color;
    #defaultData;

    /**
     * Create a new Logger instance.
     *
     * @param {Object} [options={}] - Logger options
     * @param {string} [options.level='info'] - Minimum log level
     * @param {Object} [options.output=console] - Output target
     * @param {boolean} [options.json=false] - Output as JSON
     * @param {boolean} [options.color=true] - Use colors in output
     * @param {Object} [options.defaultData={}] - Default data for all logs
     */
    constructor(options = {}) {
        this.#level = LOG_LEVELS[options.level || 'info'] ?? LOG_LEVELS.info;
        this.#output = options.output || console;
        this.#json = options.json ?? false;
        this.#color = options.color ?? true;
        this.#defaultData = options.defaultData || {};
    }

    /**
     * Log a message at the specified level.
     *
     * @param {string} level - Log level
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     * @private
     */
    #log(level, message, data = {}) {
        if (LOG_LEVELS[level] < this.#level) return;

        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...this.#defaultData,
            ...data,
        };

        // Handle error objects specially
        if (data.error instanceof Error) {
            entry.error = {
                name: data.error.name,
                message: data.error.message,
                code: data.error.code,
                stack: data.error.stack,
            };
        }

        if (this.#json) {
            this.#outputJson(level, entry);
        } else {
            this.#outputFormatted(level, entry);
        }
    }

    /**
     * Output as JSON.
     *
     * @param {string} level - Log level
     * @param {Object} entry - Log entry
     * @private
     */
    #outputJson(level, entry) {
        const output = JSON.stringify(entry);
        if (level === 'error') {
            this.#output.error(output);
        } else {
            this.#output.log(output);
        }
    }

    /**
     * Output formatted for human reading.
     *
     * @param {string} level - Log level
     * @param {Object} entry - Log entry
     * @private
     */
    #outputFormatted(level, entry) {
        const { timestamp, message, ...data } = entry;
        delete data.level; // Don't repeat level in data

        const levelStr = this.#color
            ? `${COLORS[level]}${level.toUpperCase().padEnd(5)}${COLORS.reset}`
            : level.toUpperCase().padEnd(5);

        const time = timestamp.slice(11, 23); // Extract HH:MM:SS.mmm

        let output = `${time} ${levelStr} ${message}`;

        // Add data if present
        const dataKeys = Object.keys(data);
        if (dataKeys.length > 0) {
            const dataStr = dataKeys
                .map((k) => {
                    const v = data[k];
                    if (typeof v === 'object') {
                        return `${k}=${JSON.stringify(v)}`;
                    }
                    return `${k}=${v}`;
                })
                .join(' ');
            output += ` ${dataStr}`;
        }

        if (level === 'error') {
            this.#output.error(output);
        } else {
            this.#output.log(output);
        }
    }

    /**
     * Log a debug message.
     *
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     */
    debug(message, data = {}) {
        this.#log('debug', message, data);
    }

    /**
     * Log an info message.
     *
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     */
    info(message, data = {}) {
        this.#log('info', message, data);
    }

    /**
     * Log a warning message.
     *
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     */
    warn(message, data = {}) {
        this.#log('warn', message, data);
    }

    /**
     * Log an error message.
     *
     * @param {string} message - Log message
     * @param {Object} [data={}] - Additional data
     */
    error(message, data = {}) {
        this.#log('error', message, data);
    }

    /**
     * Create a child logger with inherited context.
     *
     * @param {Object} defaultData - Default data for child logger
     * @returns {ChildLogger}
     */
    child(defaultData) {
        return new ChildLogger(this, { ...this.#defaultData, ...defaultData });
    }

    /**
     * Set the log level.
     *
     * @param {string} level - New log level
     */
    setLevel(level) {
        if (level in LOG_LEVELS) {
            this.#level = LOG_LEVELS[level];
        }
    }

    /**
     * Get the current log level.
     *
     * @returns {string}
     */
    getLevel() {
        return Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === this.#level);
    }

    /**
     * Check if a level is enabled.
     *
     * @param {string} level - Level to check
     * @returns {boolean}
     */
    isLevelEnabled(level) {
        return LOG_LEVELS[level] >= this.#level;
    }
}

/**
 * Child logger that inherits context from parent.
 */
class ChildLogger {
    #parent;
    #defaults;

    /**
     * Create a child logger.
     *
     * @param {Logger} parent - Parent logger
     * @param {Object} defaults - Default data for all logs
     */
    constructor(parent, defaults) {
        this.#parent = parent;
        this.#defaults = defaults;
    }

    debug(message, data = {}) {
        this.#parent.debug(message, { ...this.#defaults, ...data });
    }

    info(message, data = {}) {
        this.#parent.info(message, { ...this.#defaults, ...data });
    }

    warn(message, data = {}) {
        this.#parent.warn(message, { ...this.#defaults, ...data });
    }

    error(message, data = {}) {
        this.#parent.error(message, { ...this.#defaults, ...data });
    }

    /**
     * Create a grandchild logger.
     *
     * @param {Object} data - Additional default data
     * @returns {ChildLogger}
     */
    child(data) {
        return new ChildLogger(this.#parent, { ...this.#defaults, ...data });
    }
}

/**
 * Create a logger configured from environment.
 *
 * @returns {Logger}
 */
function createLogger() {
    const level = config.get('LOG_LEVEL');
    const colorEnabled = config.get('COLOR_OUTPUT');
    const debug = config.get('DEBUG');

    return new Logger({
        level: debug ? 'debug' : level,
        color: colorEnabled,
        json: process.env.LOG_FORMAT === 'json',
    });
}

/**
 * Singleton logger instance.
 */
export const logger = createLogger();

/**
 * Export classes for custom logger creation.
 */
export { Logger, ChildLogger, LOG_LEVELS, COLORS };

export default logger;

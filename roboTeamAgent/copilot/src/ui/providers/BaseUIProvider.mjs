/**
 * BaseUIProvider - Abstract base class for UI providers
 *
 * Provides shared functionality and defines the interface that all
 * UI providers must implement.
 *
 * @module providers/BaseUIProvider
 */

import { baseTheme, mergeTheme } from '../themes/base.mjs';
import { Spinner, createSpinner } from '../spinner.mjs';
import { renderMarkdown } from '../MarkdownRenderer.mjs';

/**
 * Abstract base class for UI providers
 *
 * Subclasses should override methods as needed to customize behavior.
 */
export class BaseUIProvider {
    /**
     * @param {Object} options - Provider options
     * @param {string} [options.name='base'] - Provider name
     * @param {Object} [options.theme] - Custom theme (merged with baseTheme)
     * @param {NodeJS.WriteStream} [options.stdout=process.stdout] - Output stream
     * @param {NodeJS.WriteStream} [options.stderr=process.stderr] - Error stream
     */
    constructor(options = {}) {
        this.name = options.name || 'base';
        this.theme = options.theme ? mergeTheme(options.theme) : baseTheme;
        this.stdout = options.stdout || process.stdout;
        this.stderr = options.stderr || process.stderr;

        // Create sub-providers
        this.input = this._createInputProvider();
        this.output = this._createOutputProvider();
        this.spinner = this._createSpinnerProvider();
        this.banner = this._createBannerProvider();
        this.help = this._createHelpProvider();
    }

    /**
     * Set a new theme
     * @param {Object} theme - Theme object to merge with base
     */
    setTheme(theme) {
        this.theme = mergeTheme(theme);
    }

    /**
     * Get the current theme
     * @returns {Object} Current theme
     */
    getTheme() {
        return this.theme;
    }

    /**
     * Dispose of resources
     */
    dispose() {
        // Override in subclasses if needed
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sub-provider factory methods (override in subclasses)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Create the input provider
     * @returns {Object} Input provider implementation
     * @protected
     */
    _createInputProvider() {
        const self = this;
        return {
            /**
             * Show a text prompt
             * @param {Object} options - Prompt options
             * @returns {Promise<string>} User input
             */
            async prompt(options = {}) {
                // Default implementation - subclasses should override
                throw new Error('Input.prompt not implemented');
            },

            /**
             * Show an interactive selector
             * @param {Array} items - Items to select from
             * @param {Object} options - Selector options
             * @returns {Promise<Object|null>} Selected item or null
             */
            async showSelector(items, options = {}) {
                throw new Error('Input.showSelector not implemented');
            },

            /**
             * Show a confirmation prompt
             * @param {string} message - Confirmation message
             * @param {Object} options - Confirmation options
             * @returns {Promise<boolean>} User's choice
             */
            async confirm(message, options = {}) {
                throw new Error('Input.confirm not implemented');
            },
        };
    }

    /**
     * Create the output provider
     * @returns {Object} Output provider implementation
     * @protected
     */
    _createOutputProvider() {
        const self = this;
        return {
            /**
             * Write text to output (no newline)
             * @param {string} text - Text to write
             */
            write(text) {
                self.stdout.write(text);
            },

            /**
             * Write a line to output (with newline)
             * @param {string} text - Text to write
             */
            writeLine(text = '') {
                self.stdout.write(text + '\n');
            },

            /**
             * Write to stderr
             * @param {string} text - Text to write
             */
            writeError(text) {
                self.stderr.write(text);
            },

            /**
             * Render markdown to terminal
             * @param {string} text - Markdown text
             * @returns {string} Rendered text
             */
            renderMarkdown(text) {
                return renderMarkdown(text, { theme: self.theme });
            },

            /**
             * Format a result for display
             * @param {*} result - Result to format
             * @returns {string} Formatted result
             */
            formatResult(result) {
                if (typeof result === 'string') return result;
                return JSON.stringify(result, null, 2);
            },

            /**
             * Format data as a table
             * @param {Array} data - Table data
             * @param {Object} options - Table options
             * @returns {string} Formatted table
             */
            formatTable(data, options = {}) {
                // Simple table implementation
                if (!Array.isArray(data) || data.length === 0) {
                    return '';
                }
                const headers = Object.keys(data[0]);
                const rows = data.map(row => headers.map(h => String(row[h] ?? '')));
                const widths = headers.map((h, i) =>
                    Math.max(h.length, ...rows.map(r => r[i].length))
                );

                const lines = [];
                lines.push(headers.map((h, i) => h.padEnd(widths[i])).join(' | '));
                lines.push(widths.map(w => '-'.repeat(w)).join('-+-'));
                for (const row of rows) {
                    lines.push(row.map((c, i) => c.padEnd(widths[i])).join(' | '));
                }
                return lines.join('\n');
            },

            /**
             * Format text in a box
             * @param {string} text - Text to box
             * @param {Object} options - Box options
             * @returns {string} Boxed text
             */
            formatBox(text, options = {}) {
                const { colors, box } = self.theme;
                const lines = text.split('\n');
                const maxLen = Math.max(...lines.map(l => l.length));
                const width = options.width || maxLen + 2;

                const result = [];
                result.push(`${colors.gray}${box.topLeft}${box.horizontal.repeat(width)}${box.topRight}${colors.reset}`);
                for (const line of lines) {
                    result.push(`${colors.gray}${box.vertical}${colors.reset} ${line.padEnd(width - 1)}${colors.gray}${box.vertical}${colors.reset}`);
                }
                result.push(`${colors.gray}${box.bottomLeft}${box.horizontal.repeat(width)}${box.bottomRight}${colors.reset}`);
                return result.join('\n');
            },
        };
    }

    /**
     * Create the spinner provider
     * @returns {Object} Spinner provider implementation
     * @protected
     */
    _createSpinnerProvider() {
        const self = this;
        return {
            /**
             * Create a new spinner
             * @param {Object} options - Spinner options
             * @returns {Object} Spinner instance
             */
            create(options = {}) {
                return new Spinner({
                    ...options,
                    theme: self.theme,
                    stream: self.stderr,
                });
            },

            /**
             * Create and start a spinner
             * @param {string} message - Spinner message
             * @param {Object} options - Spinner options
             * @returns {Object} Started spinner instance
             */
            start(message, options = {}) {
                return createSpinner(message, {
                    ...options,
                    theme: self.theme,
                    stream: self.stderr,
                });
            },
        };
    }

    /**
     * Create the banner provider
     * @returns {Object} Banner provider implementation
     * @protected
     */
    _createBannerProvider() {
        const self = this;
        const { colors, icons } = this.theme;

        return {
            /**
             * Show startup banner
             * @param {Object} info - Startup info
             */
            showStartup(info = {}) {
                const { title, version, subtitle } = info;
                if (title) {
                    self.stdout.write(`${colors.bold}${colors.cyan}${title}${colors.reset}`);
                    if (version) {
                        self.stdout.write(` ${colors.dim}v${version}${colors.reset}`);
                    }
                    self.stdout.write('\n');
                }
                if (subtitle) {
                    self.stdout.write(`${colors.dim}${subtitle}${colors.reset}\n`);
                }
            },

            /**
             * Show status message
             * @param {string} message - Status message
             */
            showStatus(message) {
                self.stdout.write(`${colors.dim}${message}${colors.reset}\n`);
            },

            /**
             * Show success message
             * @param {string} message - Success message
             */
            showSuccess(message) {
                self.stdout.write(`${colors.green}${icons.check}${colors.reset} ${message}\n`);
            },

            /**
             * Show error message
             * @param {string} message - Error message
             */
            showError(message) {
                self.stderr.write(`${colors.red}${icons.error}${colors.reset} ${message}\n`);
            },

            /**
             * Show warning message
             * @param {string} message - Warning message
             */
            showWarning(message) {
                self.stdout.write(`${colors.yellow}${icons.warning}${colors.reset} ${message}\n`);
            },

            /**
             * Show info message
             * @param {string} message - Info message
             */
            showInfo(message) {
                self.stdout.write(`${colors.cyan}${icons.info}${colors.reset} ${message}\n`);
            },
        };
    }

    /**
     * Create the help provider
     * @returns {Object} Help provider implementation
     * @protected
     */
    _createHelpProvider() {
        return {
            /**
             * Show help for a topic
             * @param {string} [topic] - Help topic
             * @returns {string} Help content
             */
            showHelp(topic) {
                return 'Help not available';
            },

            /**
             * Get quick reference
             * @returns {string} Quick reference text
             */
            getQuickReference() {
                return '';
            },

            /**
             * Get available help topics
             * @returns {Array} Array of topic objects
             */
            getTopics() {
                return [];
            },

            /**
             * Get command help entries
             * @returns {Array} Array of command help objects
             */
            getCommands() {
                return [];
            },
        };
    }
}

export default BaseUIProvider;

/**
 * MinimalUIProvider - Simple, minimal UI implementation
 *
 * Provides a basic readline-based UI without boxes, animations,
 * or other visual embellishments. Useful for non-TTY environments
 * or when a simpler interface is preferred.
 *
 * @module providers/MinimalUIProvider
 */

import readline from 'node:readline';
import { BaseUIProvider } from './BaseUIProvider.mjs';
import { mergeTheme } from '../themes/base.mjs';

/**
 * Minimal theme with no colors
 */
const minimalTheme = {
    name: 'minimal',
    colors: {
        reset: '',
        bold: '',
        dim: '',
        italic: '',
        underline: '',
        black: '',
        red: '',
        green: '',
        yellow: '',
        blue: '',
        magenta: '',
        cyan: '',
        white: '',
        gray: '',
        brightRed: '',
        brightGreen: '',
        brightYellow: '',
        brightBlue: '',
        brightMagenta: '',
        brightCyan: '',
        brightWhite: '',
    },
    icons: {
        bullet: '*',
        hollowBullet: 'o',
        check: '[OK]',
        cross: '[X]',
        arrow: '->',
        arrowRight: '>',
        arrowLeft: '<',
        arrowUp: '^',
        arrowDown: 'v',
        info: '[i]',
        warning: '[!]',
        error: '[X]',
        star: '*',
        dot: '.',
        ellipsis: '...',
        spinner: '-',
    },
    box: {
        topLeft: '+',
        topRight: '+',
        bottomLeft: '+',
        bottomRight: '+',
        horizontal: '-',
        vertical: '|',
    },
};

/**
 * Minimal UI provider
 *
 * Features:
 * - Simple text prompts using readline
 * - No colors or animations
 * - Plain text output
 * - Suitable for piping and non-TTY environments
 */
export class MinimalUIProvider extends BaseUIProvider {
    /**
     * @param {Object} options - Provider options
     * @param {boolean} [options.colors=false] - Enable colors (false by default)
     */
    constructor(options = {}) {
        const theme = options.colors
            ? options.theme
            : mergeTheme(minimalTheme);

        super({
            name: 'minimal',
            theme,
            ...options,
        });
    }

    /**
     * Create the input provider with minimal features
     * @returns {Object} Input provider implementation
     * @protected
     */
    _createInputProvider() {
        const self = this;

        return {
            /**
             * Show a simple text prompt
             * @param {Object} options - Prompt options
             * @returns {Promise<string>} User input
             */
            async prompt(options = {}) {
                const { message = '> ' } = options;

                return new Promise((resolve) => {
                    const rl = readline.createInterface({
                        input: process.stdin,
                        output: self.stdout,
                    });

                    rl.question(message, (answer) => {
                        rl.close();
                        resolve(answer);
                    });
                });
            },

            /**
             * Show a numbered list selector
             * @param {Array} items - Items to select from
             * @param {Object} options - Selector options
             * @returns {Promise<Object|null>} Selected item or null
             */
            async showSelector(items, options = {}) {
                const { prompt = 'Select an option: ' } = options;

                if (!items || items.length === 0) {
                    return null;
                }

                // Display numbered list
                self.stdout.write('\n');
                items.forEach((item, idx) => {
                    const name = item.name || item;
                    const desc = item.description ? ` - ${item.description}` : '';
                    self.stdout.write(`  ${idx + 1}. ${name}${desc}\n`);
                });
                self.stdout.write('\n');

                return new Promise((resolve) => {
                    const rl = readline.createInterface({
                        input: process.stdin,
                        output: self.stdout,
                    });

                    rl.question(prompt, (answer) => {
                        rl.close();

                        const idx = parseInt(answer, 10) - 1;
                        if (idx >= 0 && idx < items.length) {
                            resolve(items[idx]);
                        } else {
                            resolve(null);
                        }
                    });
                });
            },

            /**
             * Show a y/n confirmation prompt
             * @param {string} message - Confirmation message
             * @param {Object} options - Confirmation options
             * @returns {Promise<boolean>} User's choice
             */
            async confirm(message, options = {}) {
                const { defaultValue = false } = options;
                const hint = defaultValue ? '[Y/n]' : '[y/N]';

                return new Promise((resolve) => {
                    const rl = readline.createInterface({
                        input: process.stdin,
                        output: self.stdout,
                    });

                    rl.question(`${message} ${hint} `, (answer) => {
                        rl.close();

                        const normalized = answer.toLowerCase().trim();
                        if (normalized === 'y' || normalized === 'yes') {
                            resolve(true);
                        } else if (normalized === 'n' || normalized === 'no') {
                            resolve(false);
                        } else {
                            resolve(defaultValue);
                        }
                    });
                });
            },

            // Selector aliases for compatibility
            async showCommandSelector(commands, options = {}) {
                return this.showSelector(commands, options);
            },
            async showSkillSelector(skills, options = {}) {
                return this.showSelector(skills, options);
            },
            async showHelpSelector(topics, options = {}) {
                return this.showSelector(topics, options);
            },
            async showRepoSelector(repos, options = {}) {
                return this.showSelector(repos, options);
            },
        };
    }

    /**
     * Create the spinner provider with minimal features
     * @returns {Object} Spinner provider implementation
     * @protected
     */
    _createSpinnerProvider() {
        const self = this;

        // Minimal spinner that just shows status text
        class MinimalSpinner {
            constructor(message) {
                this.message = message;
                this.isSpinning = false;
            }

            start(message) {
                if (message) this.message = message;
                this.isSpinning = true;
                self.stderr.write(`${this.message}...`);
                return this;
            }

            update(message) {
                this.message = message;
                return this;
            }

            stop(finalMessage) {
                if (finalMessage) {
                    self.stderr.write(` ${finalMessage}\n`);
                } else {
                    self.stderr.write('\n');
                }
                this.isSpinning = false;
                return this;
            }

            succeed(message) {
                return this.stop(`[OK] ${message || ''}`);
            }

            fail(message) {
                return this.stop(`[FAIL] ${message || ''}`);
            }

            info(message) {
                return this.stop(`[INFO] ${message || ''}`);
            }

            pause() {
                return this;
            }

            resume() {
                return this;
            }
        }

        return {
            create(options = {}) {
                return new MinimalSpinner(options.message || '');
            },

            start(message, options = {}) {
                return new MinimalSpinner(message).start();
            },
        };
    }

    /**
     * Create the banner provider with minimal styling
     * @returns {Object} Banner provider implementation
     * @protected
     */
    _createBannerProvider() {
        const self = this;
        const { icons } = this.theme;

        return {
            showStartup(info = {}) {
                const { title, version, subtitle } = info;
                if (title) {
                    let line = title;
                    if (version) {
                        line += ` v${version}`;
                    }
                    self.stdout.write(`${line}\n`);
                }
                if (subtitle) {
                    self.stdout.write(`${subtitle}\n`);
                }
                self.stdout.write('\n');
            },

            showStatus(message) {
                self.stdout.write(`${message}\n`);
            },

            showSuccess(message) {
                self.stdout.write(`${icons.check} ${message}\n`);
            },

            showError(message) {
                self.stderr.write(`${icons.error} ${message}\n`);
            },

            showWarning(message) {
                self.stdout.write(`${icons.warning} ${message}\n`);
            },

            showInfo(message) {
                self.stdout.write(`${icons.info} ${message}\n`);
            },

            showSeparator(width) {
                const w = width || 40;
                self.stdout.write('-'.repeat(w) + '\n');
            },
        };
    }
}

export default MinimalUIProvider;

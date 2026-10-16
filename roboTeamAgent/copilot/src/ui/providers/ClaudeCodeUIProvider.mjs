/**
 * ClaudeCodeUIProvider - Claude Code style UI implementation
 *
 * Implements the boxed input style, interactive selectors, and
 * other Claude Code-inspired UI elements.
 *
 * @module providers/ClaudeCodeUIProvider
 */

import { BaseUIProvider } from './BaseUIProvider.mjs';
import { LineEditor } from '../LineEditor.mjs';
import {
    CommandSelector,
    showCommandSelector,
    showSkillSelector,
    showHelpSelector,
    showRepoSelector,
} from '../CommandSelector.mjs';

/**
 * Claude Code style UI provider
 *
 * Features:
 * - Boxed input with rounded corners
 * - Interactive command/skill selectors
 * - Animated spinners
 * - Styled markdown output
 */
export class ClaudeCodeUIProvider extends BaseUIProvider {
    /**
     * @param {Object} options - Provider options
     */
    constructor(options = {}) {
        super({
            name: 'claude-code',
            ...options,
        });
    }

    /**
     * Create the input provider with Claude Code features
     * @returns {Object} Input provider implementation
     * @protected
     */
    _createInputProvider() {
        const self = this;
        const baseInput = super._createInputProvider();

        return {
            ...baseInput,

            /**
             * Create a line editor with theme
             * @param {Object} options - Editor options
             * @returns {LineEditor} Line editor instance
             */
            createEditor(options = {}) {
                return new LineEditor({
                    ...options,
                    theme: self.theme,
                });
            },

            /**
             * Show an interactive command selector
             * @param {Array} commands - Commands to select from
             * @param {Object} options - Selector options
             * @returns {Promise<Object|null>} Selected command or null
             */
            async showCommandSelector(commands, options = {}) {
                return showCommandSelector(commands, {
                    ...options,
                    theme: self.theme,
                });
            },

            /**
             * Show an interactive skill selector
             * @param {Array} skills - Skills to select from
             * @param {Object} options - Selector options
             * @returns {Promise<Object|null>} Selected skill or null
             */
            async showSkillSelector(skills, options = {}) {
                return showSkillSelector(skills, {
                    ...options,
                    theme: self.theme,
                });
            },

            /**
             * Show an interactive help topic selector
             * @param {Array} topics - Topics to select from
             * @param {Object} options - Selector options
             * @returns {Promise<Object|null>} Selected topic or null
             */
            async showHelpSelector(topics, options = {}) {
                return showHelpSelector(topics, {
                    ...options,
                    theme: self.theme,
                });
            },

            /**
             * Show an interactive repository selector
             * @param {Array} repos - Repositories to select from
             * @param {Object} options - Selector options
             * @returns {Promise<Object|null>} Selected repo or null
             */
            async showRepoSelector(repos, options = {}) {
                return showRepoSelector(repos, {
                    ...options,
                    theme: self.theme,
                });
            },

            /**
             * Show a generic interactive selector
             * @param {Array} items - Items to select from
             * @param {Object} options - Selector options
             * @returns {Promise<Object|null>} Selected item or null
             */
            async showSelector(items, options = {}) {
                const { type = 'generic' } = options;

                switch (type) {
                    case 'command':
                        return this.showCommandSelector(items, options);
                    case 'skill':
                        return this.showSkillSelector(items, options);
                    case 'help':
                        return this.showHelpSelector(items, options);
                    case 'repo':
                        return this.showRepoSelector(items, options);
                    default:
                        // Use skill selector as default for generic items
                        return this.showSkillSelector(items, options);
                }
            },
        };
    }

    /**
     * Create the banner provider with Claude Code styling
     * @returns {Object} Banner provider implementation
     * @protected
     */
    _createBannerProvider() {
        const baseBanner = super._createBannerProvider();
        const self = this;
        const { colors, box, icons } = this.theme;

        return {
            ...baseBanner,

            /**
             * Show startup banner with boxed style
             * @param {Object} info - Startup info
             */
            showStartup(info = {}) {
                const { title, version, subtitle, workingDir } = info;

                // Top border
                const width = 60;
                self.stdout.write(`${colors.gray}${box.topLeft}${box.horizontal.repeat(width)}${box.topRight}${colors.reset}\n`);

                // Title line
                if (title) {
                    let line = `${colors.bold}${colors.cyan}${title}${colors.reset}`;
                    if (version) {
                        line += ` ${colors.dim}v${version}${colors.reset}`;
                    }
                    const visibleLen = (title + (version ? ` v${version}` : '')).length;
                    const padding = width - visibleLen - 1;
                    self.stdout.write(`${colors.gray}${box.vertical}${colors.reset} ${line}${' '.repeat(Math.max(0, padding))}${colors.gray}${box.vertical}${colors.reset}\n`);
                }

                // Subtitle line
                if (subtitle) {
                    const padding = width - subtitle.length - 1;
                    self.stdout.write(`${colors.gray}${box.vertical}${colors.reset} ${colors.dim}${subtitle}${colors.reset}${' '.repeat(Math.max(0, padding))}${colors.gray}${box.vertical}${colors.reset}\n`);
                }

                // Working directory line
                if (workingDir) {
                    const dirLine = `cwd: ${workingDir}`;
                    const padding = width - dirLine.length - 1;
                    self.stdout.write(`${colors.gray}${box.vertical}${colors.reset} ${colors.dim}${dirLine}${colors.reset}${' '.repeat(Math.max(0, padding))}${colors.gray}${box.vertical}${colors.reset}\n`);
                }

                // Bottom border
                self.stdout.write(`${colors.gray}${box.bottomLeft}${box.horizontal.repeat(width)}${box.bottomRight}${colors.reset}\n`);
                self.stdout.write('\n');
            },

            /**
             * Show a horizontal separator
             * @param {number} [width] - Separator width
             */
            showSeparator(width) {
                const cols = width || process.stdout.columns || 80;
                self.stdout.write(`${colors.gray}${box.horizontal.repeat(cols)}${colors.reset}\n`);
            },
        };
    }
}

export default ClaudeCodeUIProvider;

/**
 * QuickCommands - Handles built-in quick commands that don't need LLM.
 *
 * Extracted from REPLSession to improve modularity and reduce file size.
 */

import { printHelp, showHistory, searchHistory } from '../ui/HelpPrinter.mjs';

/**
 * QuickCommands class for handling built-in REPL commands.
 */
export class QuickCommands {
    /**
     * Create a new QuickCommands handler.
     *
     * @param {Object} options - Command handler options
     * @param {HistoryManager} options.historyManager - Command history manager
     */
    constructor(options) {
        this.historyManager = options.historyManager;
    }

    /**
     * Check if input is a quick command.
     * @param {string} input - User input
     * @returns {boolean}
     */
    isQuickCommand(input) {
        const lower = input.toLowerCase();
        return (
            lower === 'help' ||
            lower === 'history' ||
            lower === 'hist' ||
            lower.startsWith('history ') ||
            lower.startsWith('hist ')
        );
    }

    /**
     * Execute a quick command.
     * @param {string} input - User input
     * @returns {{ handled: boolean }} Result object
     */
    execute(input) {
        const lower = input.toLowerCase();

        // Help command
        if (lower === 'help') {
            printHelp();
            return { handled: true };
        }

        // History command (no args)
        if (lower === 'history' || lower === 'hist') {
            showHistory(this.historyManager);
            return { handled: true };
        }

        // History command (with args)
        if (lower.startsWith('history ') || lower.startsWith('hist ')) {
            return this._handleHistory(input);
        }

        return { handled: false };
    }

    /**
     * Handle history command with arguments.
     * @param {string} input - Full input string
     * @private
     */
    async _handleHistory(input) {
        const arg = input.split(/\s+/).slice(1).join(' ');

        if (arg === 'clear') {
            await this.historyManager.clear();
            console.log('\nHistory cleared.\n');
        } else if (arg.match(/^\d+$/)) {
            showHistory(this.historyManager, parseInt(arg, 10));
        } else {
        // Search history
            searchHistory(this.historyManager, arg);
        }

        return { handled: true };
    }
}

export default QuickCommands;

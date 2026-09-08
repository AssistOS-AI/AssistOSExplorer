/**
 * QuickCommands - Handles built-in quick commands that don't need LLM.
 *
 * Extracted from REPLSession to improve modularity and reduce file size.
 */

import { createSpinner } from '../ui/spinner.mjs';
import { printHelp, showHistory, searchHistory } from '../ui/HelpPrinter.mjs';

/**
 * QuickCommands class for handling built-in REPL commands.
 */
export class QuickCommands {
    /**
     * Create a new QuickCommands handler.
     *
     * @param {Object} options - Command handler options
     * @param {Function} options.getUserSkills - Callback to get user skills
     * @param {Function} options.getAllSkills - Callback to get all skills
     * @param {Function} options.reloadSkills - Callback to reload skills
     * @param {HistoryManager} options.historyManager - Command history manager
     * @param {string} [options.builtInSkillsDir] - Built-in skills directory for filtering
     */
    constructor(options) {
        this.getUserSkills = options.getUserSkills;
        this.getAllSkills = options.getAllSkills;
        this.reloadSkills = options.reloadSkills;
        this.historyManager = options.historyManager;
        this.builtInSkillsDir = options.builtInSkillsDir || null;
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
            lower === 'reload' ||
            lower === 'list' ||
            lower === 'ls' ||
            lower === 'list all' ||
            lower === 'ls -a' ||
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

        // Reload command
        if (lower === 'reload') {
            return this._handleReload();
        }

        // List user skills
        if (lower === 'list' || lower === 'ls') {
            return this._handleList(false);
        }

        // List all skills
        if (lower === 'list all' || lower === 'ls -a') {
            return this._handleList(true);
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
     * Handle reload command.
     * @private
     */
    async _handleReload() {
        const spinner = createSpinner('Reloading skills');
        try {
            const count = await this.reloadSkills();
            spinner.succeed(`Indexed ${count} skill(s).`);
            return { handled: true };
        } catch (error) {
            spinner.fail(error.message);
            return { handled: true, error: error.message };
        }
    }

    /**
     * Handle list command.
     * @param {boolean} showAll - Whether to show all skills including built-in
     * @private
     */
    _handleList(showAll) {
        if (showAll) {
            const skills = this.getAllSkills();
            const builtIn = this.builtInSkillsDir
                ? skills.filter(s => s.skillDir?.startsWith(this.builtInSkillsDir))
                : [];
            const user = this.builtInSkillsDir
                ? skills.filter(s => !s.skillDir?.startsWith(this.builtInSkillsDir))
                : skills;

            console.log('\nAll skills:');
            if (user.length > 0) {
                console.log('  User:');
                user.forEach(s => console.log(`    • [${s.type}] ${s.shortName || s.name}`));
            }
            if (builtIn.length > 0) {
                console.log('  Built-in:');
                builtIn.forEach(s => console.log(`    • [${s.type}] ${s.shortName || s.name}`));
            }
            console.log('');
        } else {
            const skills = this.getUserSkills();
            if (skills.length === 0) {
                console.log('\nNo user skills found.\n');
            } else {
                console.log('\nUser skills:');
                skills.forEach(s => console.log(`  • [${s.type}] ${s.shortName || s.name}`));
                console.log('');
            }
        }
        return { handled: true };
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

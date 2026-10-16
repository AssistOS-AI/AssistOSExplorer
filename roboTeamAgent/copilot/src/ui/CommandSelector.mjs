import readline from 'node:readline';
import { baseTheme, terminal } from './themes/base.mjs';
import { getTerminalSize } from './terminalSize.mjs';

/**
 * Terminal control sequences (not theme-dependent)
 */
const TERMINAL = {
    HIDE_CURSOR: terminal.hideCursor,
    SHOW_CURSOR: terminal.showCursor,
    CLEAR_LINE: terminal.clearLine,
    MOVE_UP: terminal.moveUp,
    MOVE_DOWN: terminal.moveDown,
    MOVE_TO_COL: terminal.moveToCol,
};

function terminalWidth(stream = process.stdout) {
    return getTerminalSize(stream).columns;
}

function visibleLength(value) {
    return String(value || '').replace(/\x1b\[[0-9;]*m/g, '').length;
}

function truncateText(value, width) {
    const text = String(value || '');
    if (width <= 0) return '';
    if (text.length <= width) return text;
    if (width === 1) return '…';
    return `${text.slice(0, width - 1)}…`;
}

export function listenForResize(render, stream = process.stdout, {
    pollIntervalMs = 100,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
} = {}) {
    let { columns: lastColumns, rows: lastRows } = getTerminalSize(stream);
    const redrawIfDimensionsChanged = () => {
        try { stream._refreshSize?.(); } catch {}
        const { columns, rows } = getTerminalSize(stream);
        if (columns === lastColumns && rows === lastRows) return;
        lastColumns = columns;
        lastRows = rows;
        render();
    };
    const handleResize = () => {
        ({ columns: lastColumns, rows: lastRows } = getTerminalSize(stream));
        render();
    };
    stream.on('resize', handleResize);
    const resizePoll = setIntervalFn(redrawIfDimensionsChanged, pollIntervalMs);
    resizePoll?.unref?.();
    return () => {
        stream.removeListener('resize', handleResize);
        clearIntervalFn(resizePoll);
    };
}

export function createCommandSelection(selected) {
    return selected ? { ...selected, args: '' } : null;
}

/**
 * CommandSelector - Interactive command picker with arrow key navigation
 *
 * Shows a filterable list of commands when activated, allowing users to
 * navigate with arrow keys and select with Enter.
 */
export class CommandSelector {
    /**
     * @param {Array} commands - Array of {name, description, usage}
     * @param {Object} options - Configuration options
     * @param {number} [options.maxVisible=8] - Maximum visible items
     * @param {Object} [options.theme] - Theme object (uses baseTheme if not provided)
     */
    constructor(commands, options = {}) {
        // Use provided theme or fall back to baseTheme
        this.theme = options.theme || baseTheme;
        this.colors = this.theme.colors;

        this.commands = commands; // Array of {name, description, usage}
        this.maxVisible = options.maxVisible || 8;
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.filter = '';
        this.filteredCommands = [...commands];
    }

    /**
     * Filter commands based on current input, prioritizing exact/prefix matches
     */
    updateFilter(input) {
        this.filter = input.toLowerCase();
        const matches = this.commands.filter(cmd =>
            cmd.name.toLowerCase().includes(this.filter) ||
            String(cmd.description || '').toLowerCase().includes(this.filter)
        );

        // Sort by match quality: exact > prefix > contains
        this.filteredCommands = matches.sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            const aExact = aName === this.filter || aName === `/${this.filter}`;
            const bExact = bName === this.filter || bName === `/${this.filter}`;
            const aPrefix = aName.startsWith(this.filter) || aName.startsWith(`/${this.filter}`);
            const bPrefix = bName.startsWith(this.filter) || bName.startsWith(`/${this.filter}`);

            if (aExact && !bExact) return -1;
            if (bExact && !aExact) return 1;
            if (aPrefix && !bPrefix) return -1;
            if (bPrefix && !aPrefix) return 1;
            return 0; // Keep original order for same priority
        });

        this.selectedIndex = 0;
        this.scrollOffset = 0;
    }

    /**
     * Move selection up
     */
    moveUp() {
        if (this.selectedIndex > 0) {
            this.selectedIndex--;
            if (this.selectedIndex < this.scrollOffset) {
                this.scrollOffset = this.selectedIndex;
            }
        }
    }

    /**
     * Move selection down
     */
    moveDown() {
        if (this.selectedIndex < this.filteredCommands.length - 1) {
            this.selectedIndex++;
            if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
                this.scrollOffset = this.selectedIndex - this.maxVisible + 1;
            }
        }
    }

    /**
     * Get the currently selected command
     */
    getSelected() {
        return this.filteredCommands[this.selectedIndex] || null;
    }

    /**
     * Render the command list to a string array (Claude Code style)
     */
    render(width = terminalWidth()) {
        const { gray, reset, cyan, magenta } = this.colors;
        const lines = [];
        const visible = this.filteredCommands.slice(
            this.scrollOffset,
            this.scrollOffset + this.maxVisible
        );

        // Show scroll indicator if needed
        if (this.scrollOffset > 0) {
            lines.push(`${gray}  ↑ ${this.scrollOffset} more${reset}`);
        }

        visible.forEach((cmd, idx) => {
            const actualIdx = this.scrollOffset + idx;
            const isSelected = actualIdx === this.selectedIndex;

            // Claude Code style: selected item has ❯ prefix and cyan highlight
            const prefix = isSelected ? `${magenta}❯${reset}` : ' ';
            const chromeWidth = 3; // leading space, selector glyph, separating space
            const availableWidth = Math.max(1, width - chromeWidth);
            const preferredNameWidth = Math.max(8, Math.floor(availableWidth * 0.4));
            const nameWidth = Math.min(32, availableWidth, preferredNameWidth);
            const descriptionWidth = Math.max(0, availableWidth - nameWidth);
            const paddedCmdName = truncateText(cmd.name, nameWidth).padEnd(nameWidth);
            const name = isSelected
                ? `${cyan}${paddedCmdName}${reset}`
                : `${reset}${paddedCmdName}`;
            const desc = `${gray}${truncateText(cmd.description, descriptionWidth)}${reset}`;

            // Two-column layout constrained to the current terminal width.
            lines.push(` ${prefix} ${name}${desc}`);
        });

        // Show scroll indicator if more below
        const remaining = this.filteredCommands.length - this.scrollOffset - this.maxVisible;
        if (remaining > 0) {
            lines.push(`${gray}  ↓ ${remaining} more${reset}`);
        }

        // Show empty state
        if (this.filteredCommands.length === 0) {
            lines.push(`${gray}  No matching commands${reset}`);
        }

        return lines;
    }

    /**
     * Get the number of lines rendered
     */
    getRenderedLineCount() {
        let count = Math.min(this.filteredCommands.length, this.maxVisible);
        if (this.scrollOffset > 0) count++; // "more above" line
        if (this.filteredCommands.length - this.scrollOffset > this.maxVisible) count++; // "more below" line
        if (this.filteredCommands.length === 0) count = 1; // "no matching" line
        return count;
    }
}

/**
 * Show an interactive command selector and return the selected command
 * Styled to match Claude Code's command picker
 *
 * @param {Array} commands - Array of {name, description, usage}
 * @param {Object} options - Options
 * @param {Object} [options.theme] - Theme object (uses baseTheme if not provided)
 * @returns {Promise<{name: string, args: string}|null>} - Selected command or null if cancelled
 */
export async function showCommandSelector(commands, options = {}) {
    if (options.signal?.aborted) return null;
    const theme = options.theme || baseTheme;
    const colors = theme.colors;
    const {
        prompt = `${colors.cyan}${colors.bold}>${colors.reset} /`,
        initialFilter = '',
        maxVisible = 10,
    } = options;

    // Calculate visible prompt length for cursor positioning
    const visiblePromptLen = visibleLength(prompt);

    return new Promise((resolve) => {
        const selector = new CommandSelector(commands, { ...options, maxVisible, theme });
        selector.updateFilter(initialFilter);

        let currentInput = initialFilter;
        let maxRenderedLines = 0; // Track max lines ever rendered for proper clearing
        const previousRawMode = process.stdin.isRaw;
        let cleaned = false;

        // Hide cursor during selection
        process.stdout.write(TERMINAL.HIDE_CURSOR);

        const clearDisplay = () => {
            if (maxRenderedLines === 0) return '';

            // Build clear sequence as single string to avoid flickering
            let output = '';
            // We're at the prompt line - move down to clear all previously rendered content
            for (let i = 0; i < maxRenderedLines; i++) {
                output += `\n${TERMINAL.CLEAR_LINE}`;
            }
            // Move back up to prompt line
            for (let i = 0; i < maxRenderedLines; i++) {
                output += TERMINAL.MOVE_UP;
            }
            // Clear prompt line
            output += `\r${TERMINAL.CLEAR_LINE}`;
            return output;
        };

        const render = () => {
            // Build entire output as single string to avoid flickering
            let output = '';

            // Clear all previously rendered content
            output += clearDisplay();

            // Render prompt with current filter (Claude Code style: "> /filter")
            output += `${prompt}${currentInput}`;

            // Horizontal separator line
            const cols = terminalWidth();
            output += `\n${colors.gray}${'─'.repeat(cols)}${colors.reset}`;

            // Render command list below
            const lines = selector.render(terminalWidth());
            lines.forEach(line => {
                output += `\n${TERMINAL.CLEAR_LINE}${line}`;
            });

            // Track max lines for future clearing (include separator line)
            const totalLines = 1 + lines.length; // 1 for separator
            if (totalLines > maxRenderedLines) {
                maxRenderedLines = totalLines;
            }

            // Move cursor back to input line
            for (let i = 0; i < totalLines; i++) {
                output += TERMINAL.MOVE_UP;
            }
            // Position cursor at end of input
            output += `\r${TERMINAL.MOVE_TO_COL(visiblePromptLen + currentInput.length + 1)}`;

            // Single write to avoid flickering
            process.stdout.write(output);
        };

        const stopResizeListener = listenForResize(render);
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            options.signal?.removeEventListener('abort', abort);
            stopResizeListener();
            // Batch the clear and cursor show in a single write
            process.stdout.write(clearDisplay() + TERMINAL.SHOW_CURSOR);
            process.stdin.setRawMode(Boolean(previousRawMode));
            process.stdin.removeListener('data', handleKey);
        };
        const abort = () => {
            cleanup();
            resolve(null);
        };

        const handleKey = (key) => {
            const keyStr = key.toString();

            // Handle special keys
            if (keyStr === '\x1b[A') {
                // Up arrow
                selector.moveUp();
                render();
                return;
            }

            if (keyStr === '\x1b[B') {
                // Down arrow
                selector.moveDown();
                render();
                return;
            }

            if (keyStr === '\r' || keyStr === '\n') {
                // Enter - select current
                const selected = selector.getSelected();
                cleanup();
                if (selected) {
                    resolve(createCommandSelection(selected));
                } else {
                    resolve(null);
                }
                return;
            }

            if (keyStr === '\x1b' || keyStr === '\x03') {
                // Escape or Ctrl+C - cancel
                cleanup();
                resolve(null);
                return;
            }

            if (keyStr === '\x7f' || keyStr === '\b') {
                // Backspace
                if (currentInput.length > 0) {
                    currentInput = currentInput.slice(0, -1);
                    selector.updateFilter(currentInput);
                    render();
                } else {
                    // Backspace with empty input - cancel
                    cleanup();
                    resolve(null);
                }
                return;
            }

            if (keyStr === '\t') {
                // Tab - complete with selected
                const selected = selector.getSelected();
                if (selected) {
                    cleanup();
                    resolve(createCommandSelection(selected));
                }
                return;
            }

            // Regular character input
            if (keyStr.length === 1 && keyStr >= ' ') {
                currentInput += keyStr;
                selector.updateFilter(currentInput);
                render();
            }
        };

        // Enable raw mode for key capture
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', handleKey);
        options.signal?.addEventListener('abort', abort, { once: true });

        // Initial render
        render();
    });
}

/**
 * Build command list from COMMAND_DEFINITIONS
 */
export function buildCommandList(commandDefs) {
    const commands = [];

    for (const [name, def] of Object.entries(commandDefs)) {
        const subOptions = [
            ...(Array.isArray(def.subOptions) ? def.subOptions : []),
            ...(Array.isArray(def.catalogSubOptions) ? def.catalogSubOptions : []),
        ];
        commands.push({
            name: `/${name}`,
            description: def.description,
            usage: def.usage || `/${name}`,
            skill: def.skill || null,
            needsSkillArg: def.needsSkillArg || false,
            needsRepoArg: def.needsRepoArg || false,
            hasSubOptions: subOptions.length > 0,
            subOptions: subOptions.length > 0 ? subOptions : null,
        });
    }

    // Sort alphabetically
    commands.sort((a, b) => a.name.localeCompare(b.name));

    return commands;
}

/**
 * Build sub-option list for a command
 */
export async function buildSubOptionList(command, subOptions) {
    if (!subOptions || subOptions.length === 0) return [];

    const { SUB_OPTIONS } = await import('../repl/SlashCommandHandler.mjs');
    const subDefs = SUB_OPTIONS[command] || {};

    return subOptions.map(opt => ({
        name: `/${command} ${opt}`,
        description: subDefs[opt]?.description || opt,
        usage: subDefs[opt]?.usage || `/${command} ${opt}`,
        skill: subDefs[opt]?.skill || null,
        args: subDefs[opt]?.args || 'optional',
        needsSkillArg: subDefs[opt]?.needsSkillArg || false,
    }));
}

/**
 * Show an interactive skill selector and return the selected skill
 *
 * @param {Array} skills - Array of {name, type, description}
 * @param {Object} options - Options
 * @param {Object} [options.theme] - Theme object (uses baseTheme if not provided)
 * @returns {Promise<{name: string}|null>} - Selected skill or null if cancelled
 */
export async function showSkillSelector(skills, options = {}) {
    const theme = options.theme || baseTheme;
    const {
        prompt = 'Select skill> ',
        initialFilter = '',
        maxVisible = 8,
    } = options;

    // Transform skills to command-like format for CommandSelector
    const skillItems = skills.map(skill => ({
        name: skill.shortName || skill.name,
        description: `[${skill.type}] ${skill.description || ''}`.trim(),
        type: skill.type,
    }));

    if (skillItems.length === 0) {
        return null;
    }

    return new Promise((resolve) => {
        const selector = new CommandSelector(skillItems, { maxVisible, theme });
        selector.updateFilter(initialFilter);

        let currentInput = initialFilter;
        let maxRenderedLines = 0;

        process.stdout.write(TERMINAL.HIDE_CURSOR);

        const clearDisplay = () => {
            if (maxRenderedLines === 0) return '';

            // Build clear sequence as single string to avoid flickering
            let output = '';
            for (let i = 0; i < maxRenderedLines; i++) {
                output += `\n${TERMINAL.CLEAR_LINE}`;
            }
            for (let i = 0; i < maxRenderedLines; i++) {
                output += TERMINAL.MOVE_UP;
            }
            output += `\r${TERMINAL.CLEAR_LINE}`;
            return output;
        };

        const render = () => {
            // Build entire output as single string to avoid flickering
            let output = clearDisplay();

            output += `${prompt}${currentInput}`;

            const lines = selector.render(terminalWidth());
            lines.forEach(line => {
                output += `\n${TERMINAL.CLEAR_LINE}${line}`;
            });

            if (lines.length > maxRenderedLines) {
                maxRenderedLines = lines.length;
            }

            for (let i = 0; i < lines.length; i++) {
                output += TERMINAL.MOVE_UP;
            }
            output += `\r${TERMINAL.MOVE_TO_COL(prompt.length + currentInput.length + 1)}`;

            // Single write to avoid flickering
            process.stdout.write(output);
        };

        const stopResizeListener = listenForResize(render);
        const cleanup = () => {
            stopResizeListener();
            // Batch the clear and cursor show in a single write
            process.stdout.write(clearDisplay() + TERMINAL.SHOW_CURSOR);
            process.stdin.setRawMode(false);
            process.stdin.removeListener('data', handleKey);
        };

        const handleKey = (key) => {
            const keyStr = key.toString();

            if (keyStr === '\x1b[A') {
                selector.moveUp();
                render();
                return;
            }

            if (keyStr === '\x1b[B') {
                selector.moveDown();
                render();
                return;
            }

            if (keyStr === '\r' || keyStr === '\n') {
                const selected = selector.getSelected();
                cleanup();
                if (selected) {
                    resolve({ name: selected.name, type: selected.type });
                } else {
                    resolve(null);
                }
                return;
            }

            if (keyStr === '\x1b' || keyStr === '\x03') {
                cleanup();
                resolve(null);
                return;
            }

            if (keyStr === '\x7f' || keyStr === '\b') {
                if (currentInput.length > 0) {
                    currentInput = currentInput.slice(0, -1);
                    selector.updateFilter(currentInput);
                    render();
                } else {
                    cleanup();
                    resolve(null);
                }
                return;
            }

            if (keyStr === '\t') {
                const selected = selector.getSelected();
                if (selected) {
                    cleanup();
                    resolve({ name: selected.name, type: selected.type });
                }
                return;
            }

            if (keyStr.length === 1 && keyStr >= ' ') {
                currentInput += keyStr;
                selector.updateFilter(currentInput);
                render();
            }
        };

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', handleKey);

        render();
    });
}


/**
 * Show an interactive help topic selector and return the selected topic
 *
 * @param {Array} topics - Array of {name, title, description}
 * @param {Object} options - Options
 * @param {Object} [options.theme] - Theme object (uses baseTheme if not provided)
 * @returns {Promise<{name: string, title: string}|null>} - Selected topic or null if cancelled
 */
export async function showHelpSelector(topics, options = {}) {
    if (!topics?.length) return null;
    if (!process.stdin.isTTY) {
        console.error('Help selector requires an interactive terminal');
        return null;
    }
    return showCommandSelector(topics.map((topic) => ({
        ...topic, description: topic.title || topic.description || '',
    })), { prompt: 'Help topic> ', ...options });
}

/**
 * Show an interactive repository selector and return the selected repo
 *
 * @param {Array} repos - Array of {name, source, enabled, editable}
 * @param {Object} options - Options
 * @param {Object} [options.theme] - Theme object (uses baseTheme if not provided)
 * @returns {Promise<{name: string}|null>} - Selected repo or null if cancelled
 */
export async function showRepoSelector(repos, options = {}) {
    const theme = options.theme || baseTheme;
    const {
        prompt = 'Select repository> ',
        initialFilter = '',
        maxVisible = 8,
    } = options;

    if (!repos || repos.length === 0) {
        return null;
    }

    // Check if stdin is a TTY
    if (!process.stdin.isTTY) {
        console.error('Repo selector requires an interactive terminal');
        return null;
    }

    // Transform repos to command-like format for CommandSelector
    const repoItems = repos.map(repo => {
        const status = repo.enabled ? '✓' : '✗';
        const editLabel = repo.editable ? 'editable' : 'read-only';
        return {
            name: repo.name,
            description: `${status} ${editLabel} - ${repo.source || repo.localPath || ''}`,
            ...repo,
        };
    });

    return new Promise((resolve) => {
        const selector = new CommandSelector(repoItems, { maxVisible, theme });
        selector.updateFilter(initialFilter);

        let currentInput = initialFilter;
        let maxRenderedLines = 0;

        process.stdout.write(TERMINAL.HIDE_CURSOR);

        const clearDisplay = () => {
            if (maxRenderedLines === 0) return '';

            // Build clear sequence as single string to avoid flickering
            let output = '';
            for (let i = 0; i < maxRenderedLines; i++) {
                output += `\n${TERMINAL.CLEAR_LINE}`;
            }
            for (let i = 0; i < maxRenderedLines; i++) {
                output += TERMINAL.MOVE_UP;
            }
            output += `\r${TERMINAL.CLEAR_LINE}`;
            return output;
        };

        const render = () => {
            // Build entire output as single string to avoid flickering
            let output = clearDisplay();

            output += `${prompt}${currentInput}`;

            const lines = selector.render(terminalWidth());
            lines.forEach(line => {
                output += `\n${TERMINAL.CLEAR_LINE}${line}`;
            });

            if (lines.length > maxRenderedLines) {
                maxRenderedLines = lines.length;
            }

            for (let i = 0; i < lines.length; i++) {
                output += TERMINAL.MOVE_UP;
            }
            output += `\r${TERMINAL.MOVE_TO_COL(prompt.length + currentInput.length + 1)}`;

            // Single write to avoid flickering
            process.stdout.write(output);
        };

        const stopResizeListener = listenForResize(render);
        const cleanup = () => {
            stopResizeListener();
            // Batch the clear and cursor show in a single write
            process.stdout.write(clearDisplay() + TERMINAL.SHOW_CURSOR);
            process.stdin.setRawMode(false);
            process.stdin.removeListener('data', handleKey);
        };

        const handleKey = (key) => {
            const keyStr = key.toString();

            if (keyStr === '\x1b[A') {
                selector.moveUp();
                render();
                return;
            }

            if (keyStr === '\x1b[B') {
                selector.moveDown();
                render();
                return;
            }

            if (keyStr === '\r' || keyStr === '\n') {
                const selected = selector.getSelected();
                cleanup();
                if (selected) {
                    resolve({ name: selected.name });
                } else {
                    resolve(null);
                }
                return;
            }

            if (keyStr === '\x1b' || keyStr === '\x03') {
                cleanup();
                resolve(null);
                return;
            }

            if (keyStr === '\x7f' || keyStr === '\b') {
                if (currentInput.length > 0) {
                    currentInput = currentInput.slice(0, -1);
                    selector.updateFilter(currentInput);
                    render();
                } else {
                    cleanup();
                    resolve(null);
                }
                return;
            }

            if (keyStr === '\t') {
                const selected = selector.getSelected();
                if (selected) {
                    cleanup();
                    resolve({ name: selected.name });
                }
                return;
            }

            if (keyStr.length === 1 && keyStr >= ' ') {
                currentInput += keyStr;
                selector.updateFilter(currentInput);
                render();
            }
        };

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', handleKey);

        render();
    });
}

/**
 * Show an interactive model selector and return the selected model
 *
 * @param {Array} catalog - Native model choices
 * @param {Object} options - Options
 * @param {Object} [options.theme] - Theme object (uses baseTheme if not provided)
 * @returns {Promise<{name: string}|null>} - Selected model or null if cancelled
 */
export async function showModelSelector(catalog, options = {}) {
    if (!Array.isArray(catalog) || catalog.length === 0) return null;
    return showCommandSelector(catalog.map((model) => typeof model === 'string'
        ? { name: model, description: '' } : model), { prompt: 'Model> ', maxVisible: 12, ...options });
}

export default CommandSelector;

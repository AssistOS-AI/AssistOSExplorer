/**
 * InteractivePrompt - Handles interactive input with command/skill selectors.
 *
 * Extracted from REPLSession to improve modularity and reduce file size.
 */

import readline from 'node:readline';
import { LineEditor } from '../ui/LineEditor.mjs';
import {
    listenForResize,
    showCommandSelector,
    showSkillSelector,
} from '../ui/CommandSelector.mjs';
import { SlashCommandHandler, SUB_OPTIONS } from './SlashCommandHandler.mjs';
import { UIContext } from '../ui/UIContext.mjs';

export function getSubOptionArgumentSource(command, subOption, subDef = {}) {
    if (command === 'task' && ['view', 'continue', 'stop', 'model', 'login'].includes(subOption)) return 'tasks';
    if (command === 'session' && subOption === 'resume') return 'sessions';
    if (subDef.needsSkillArg) return 'skills';
    if (subDef.args === 'required') return 'text';
    return 'none';
}

export function buildCompletionSelectorItems(completions = []) {
    return completions.map((completion) => ({
        name: completion.label || completion.value,
        description: completion.description || completion.value,
        usage: completion.value,
        value: completion.value,
    }));
}

export function listenForEditorResize(stream, editor, shouldSkip = () => false) {
    return listenForResize(() => {
        if (!shouldSkip()) editor.redraw();
    }, stream);
}

/**
 * InteractivePrompt class for handling user input with interactive features.
 */
export class InteractivePrompt {
    /**
     * Create a new InteractivePrompt.
     *
     * @param {Object} options - Prompt options
     * @param {HistoryManager} options.historyManager - Command history manager
     * @param {SlashCommandHandler} options.slashHandler - Slash command handler
     * @param {Array} options.commandList - List of available commands
     * @param {Function} options.getUserSkills - Callback to get user skills
     * @param {Function} [options.getAllSkills] - Callback to get all skills
     * @param {string} [options.prompt='AchillesCli> '] - Prompt string
     */
    constructor(options) {
        this.historyManager = options.historyManager;
        this.slashHandler = options.slashHandler;
        this.commandList = options.commandList;
        this.getUserSkills = options.getUserSkills;
        this.getAllSkills = options.getAllSkills || options.getUserSkills;
        this.getModelName = options.getModelName || (() => null);

        // Get colors from theme
        const theme = UIContext.getTheme();
        this.colors = theme.colors;

        // Styled prompt like Claude Code: "> " with cyan color
        this.promptString = `${this.colors.cyan}${this.colors.bold}>${this.colors.reset} `;

        // Track current hint for cleanup
        this.currentHintLines = 0;
    }

    /**
     * Get input from user with interactive selector support.
     * @returns {Promise<string>} The user's input
     */
    async prompt() {
        if (!process.stdin.isTTY) {
            return this._promptOnce();
        }
        return this._promptWithSelector();
    }

    /**
     * Prompt with interactive command selector support.
     * When user types just "/" it shows an interactive picker.
     * @returns {Promise<string>}
     * @private
     */
    async _promptWithSelector() {
        const self = this;

        return new Promise((resolve) => {
            // Set up raw mode to detect "/" key immediately
            if (!process.stdin.isTTY) {
                // Fallback for non-TTY
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout,
                });
                rl.question(self.promptString, (answer) => {
                    rl.close();
                    resolve(answer);
                });
                return;
            }

            // LineEditor handles buffer and cursor position
            const modelName = self.getModelName();
            const rightHint = modelName
                ? `${self.colors.dim}${modelName}${self.colors.reset}`
                : `${self.colors.dim}↵ send${self.colors.reset}`;
            const editor = new LineEditor({
                prompt: self.promptString,
                rightHint,
                boxed: true,
            });
            let showingSelector = false;
            let savedBuffer = ''; // Save current input when navigating history
            let historyIndex = -1; // -1 means "new input", 0+ means history index from end
            const history = self.historyManager.getAll();

            // Helper to set buffer content (for history navigation)
            const rewriteLine = (newContent) => {
                editor.setBuffer(newContent);
                editor.render();
            };

            // Initial prompt render
            editor.render();

            const stopResizeListener = listenForEditorResize(
                process.stdout,
                editor,
                () => showingSelector,
            );

            process.stdin.setRawMode(true);
            process.stdin.resume();
            LineEditor.enableBracketedPaste();

            const cleanup = () => {
                // Draw bottom border if boxed mode
                if (editor.boxed) {
                    editor.drawBottomBorder();
                }
                LineEditor.disableBracketedPaste();
                process.stdin.setRawMode(false);
                process.stdin.removeListener('data', handleKey);
                stopResizeListener();
            };

            // Track bracketed paste state
            let inBracketedPaste = false;
            let pasteBuffer = '';

            const handleKey = async (key) => {
                const keyStr = key.toString();

                // Handle bracketed paste mode
                const PASTE_START = '\x1b[200~';
                const PASTE_END = '\x1b[201~';

                // Check for paste start marker
                if (keyStr.includes(PASTE_START)) {
                    inBracketedPaste = true;
                    // Extract content after the start marker
                    const startIdx = keyStr.indexOf(PASTE_START) + PASTE_START.length;
                    const endIdx = keyStr.indexOf(PASTE_END);
                    if (endIdx !== -1) {
                        // Complete paste in one chunk
                        const pastedText = keyStr.substring(startIdx, endIdx);
                        editor.handleBracketedPaste(pastedText);
                        editor.render();
                        inBracketedPaste = false;
                    } else {
                        // Paste continues in next chunk
                        pasteBuffer = keyStr.substring(startIdx);
                    }
                    return;
                }

                // Check for paste end marker (multi-chunk paste)
                if (inBracketedPaste) {
                    const endIdx = keyStr.indexOf(PASTE_END);
                    if (endIdx !== -1) {
                        pasteBuffer += keyStr.substring(0, endIdx);
                        editor.handleBracketedPaste(pasteBuffer);
                        editor.render();
                        pasteBuffer = '';
                        inBracketedPaste = false;
                    } else {
                        pasteBuffer += keyStr;
                    }
                    return;
                }

                // Handle Ctrl+C
                if (keyStr === '\x03') {
                    cleanup();
                    process.stdout.write('\n');
                    resolve('/exit');
                    return;
                }

                // Handle Enter
                if (keyStr === '\r' || keyStr === '\n') {
                    cleanup();
                    process.stdout.write('\n');
                    resolve(editor.getBuffer());
                    return;
                }

                // Handle "/" - show interactive selector (only when buffer is empty)
                if (keyStr === '/' && editor.getBuffer() === '') {
                    if (showingSelector) return;
                    showingSelector = true;

                    if (editor.boxed) {
                        editor.clearBox();
                    }

                    process.stdin.removeListener('data', handleKey);
                    process.stdin.setRawMode(false);

                    // Show main command selector
                    const selected = await showCommandSelector(self.commandList, {
                        initialFilter: '',
                    });

                    if (selected) {
                        // Check if command has sub-options
                        if (selected.hasSubOptions && selected.subOptions) {
                            // Build sub-option list
                            const subOptionItems = selected.subOptions.map(opt => {
                                const subDefs = SUB_OPTIONS[selected.name.slice(1)] || {};
                                const subDef = subDefs[opt] || {};
                                return {
                                    name: `/${selected.name.slice(1)} ${opt}`,
                                    description: subDef.description || opt,
                                    usage: subDef.usage || `/${selected.name.slice(1)} ${opt}`,
                                    skill: subDef.skill || null,
                                    args: subDef.args || 'optional',
                                    needsSkillArg: subDef.needsSkillArg || false,
                                };
                            });

                            // Show sub-option selector
                            const selectedSub = await showCommandSelector(subOptionItems, {
                                initialFilter: '',
                            });

                            if (selectedSub) {
                                const [command, subOption] = selectedSub.name.slice(1).split(/\s+/, 2);
                                const subDef = self.slashHandler.getSubOptionDef(command, subOption) || selectedSub;
                                const argumentSource = getSubOptionArgumentSource(command, subOption, subDef);

                                if (argumentSource === 'skills') {
                                    process.stdout.write(`${selectedSub.name} `);
                                    const userSkills = command === 'remove' ? self.getUserSkills() : self.getAllSkills();
                                    if (userSkills.length === 0) {
                                        cleanup();
                                        process.stdout.write('\n');
                                        console.log(`${self.colors.yellow}No user skills found.${self.colors.reset}`);
                                        resolve('');
                                        return;
                                    }
                                    const selectedSkill = await showSkillSelector(userSkills, {
                                        prompt: `${selectedSub.name} `,
                                        initialFilter: '',
                                    });
                                    if (selectedSkill) {
                                        cleanup();
                                        const fullCommand = `${selectedSub.name} ${selectedSkill.name}`;
                                        process.stdout.write(`${selectedSkill.name}\n`);
                                        resolve(fullCommand);
                                    } else {
                                        showingSelector = false;
                                        editor.clear();
                                        editor.boxDrawn = false;
                                        editor.render();
                                        process.stdin.setRawMode(true);
                                        process.stdin.on('data', handleKey);
                                    }
                                } else if (argumentSource === 'tasks' || argumentSource === 'sessions') {
                                    const completions = argumentSource === 'tasks'
                                        ? self.slashHandler.getTaskCompletions?.(subOption) || []
                                        : self.slashHandler.getSessionCompletions?.() || [];
                                    const argumentItems = buildCompletionSelectorItems(completions);
                                    if (argumentItems.length === 0) {
                                        cleanup();
                                        process.stdout.write('\n');
                                        const noun = argumentSource === 'tasks' ? 'tasks' : 'sessions';
                                        console.log(`${self.colors.yellow}No matching ${noun} found.${self.colors.reset}`);
                                        resolve('');
                                        return;
                                    }
                                    const selectedArgument = await showCommandSelector(argumentItems, {
                                        prompt: `${selectedSub.name} `,
                                        initialFilter: '',
                                    });
                                    if (selectedArgument) {
                                        const commandWithArgument = `${selectedSub.name} ${selectedArgument.value}`;
                                        if (command === 'task' && subOption === 'continue') {
                                            await self._handleArgInputFlow(
                                                commandWithArgument,
                                                subDef,
                                                resolve,
                                                cleanup,
                                            );
                                        } else {
                                            cleanup();
                                            process.stdout.write(`${commandWithArgument}\n`);
                                            resolve(commandWithArgument);
                                        }
                                    } else {
                                        showingSelector = false;
                                        editor.clear();
                                        editor.boxDrawn = false;
                                        editor.render();
                                        process.stdin.setRawMode(true);
                                        process.stdin.on('data', handleKey);
                                    }
                                } else if (argumentSource === 'text') {
                                    await self._handleArgInputFlow(
                                        selectedSub.name,
                                        subDef,
                                        resolve,
                                        cleanup,
                                    );
                                } else {
                                    cleanup();
                                    process.stdout.write(`${selectedSub.name}\n`);
                                    resolve(selectedSub.name);
                                }
                            } else {
                                // User cancelled sub-option selection
                                showingSelector = false;
                                editor.clear();
                                editor.boxDrawn = false;
                                editor.render();
                                process.stdin.setRawMode(true);
                                process.stdin.on('data', handleKey);
                            }
                        } else if (selected.needsSkillArg) {
                            // Command needs skill argument
                            process.stdout.write(`${selected.name} `);
                            const userSkills = self.getAllSkills().filter((skill) => selected.name !== '/exec' || skill.enabled !== false);
                            if (userSkills.length === 0) {
                                cleanup();
                                process.stdout.write('\n');
                                console.log(`${self.colors.yellow}No skills found.${self.colors.reset}`);
                                resolve('');
                                return;
                            }
                            const selectedSkill = await showSkillSelector(userSkills, {
                                prompt: `${selected.name} `,
                                initialFilter: '',
                            });
                            if (selectedSkill) {
                                const commandsNeedingInput = ['/exec'];
                                if (commandsNeedingInput.includes(selected.name)) {
                                    await self._handleSkillInputFlow(selected.name, selectedSkill, userSkills, resolve, cleanup);
                                } else {
                                    cleanup();
                                    const fullCommand = `${selected.name} ${selectedSkill.name}`;
                                    process.stdout.write(`${selectedSkill.name}\n`);
                                    resolve(fullCommand);
                                }
                            } else {
                                showingSelector = false;
                                editor.clear();
                                editor.boxDrawn = false;
                                editor.render();
                                process.stdin.setRawMode(true);
                                process.stdin.on('data', handleKey);
                            }
                        } else {
                            // Command doesn't need skill arg - check if it needs text args
                            const cmdDef = SlashCommandHandler.COMMANDS[selected.name.slice(1)];
                            if (cmdDef && cmdDef.args === 'required') {
                                await self._handleArgInputFlow(selected.name, cmdDef, resolve, cleanup);
                            } else {
                                cleanup();
                                process.stdout.write(`${selected.name}\n`);
                                resolve(selected.name);
                            }
                        }
                    } else {
                        // User cancelled - return to boxed input
                        showingSelector = false;
                        editor.clear();
                        editor.boxDrawn = false;
                        editor.render();
                        process.stdin.setRawMode(true);
                        process.stdin.on('data', handleKey);
                    }
                    return;
                }

                // Handle Escape
                if (keyStr === '\x1b') {
                    // Could be escape key or start of arrow sequence
                    // For now, just ignore standalone escape
                    return;
                }

                // Handle arrow keys (history navigation)
                if (keyStr === '\x1b[A') {
                    // Up arrow - go to previous (older) command
                    if (history.length === 0) return;

                    if (historyIndex === -1) {
                        // First time pressing up - save current input
                        savedBuffer = editor.getBuffer();
                    }

                    if (historyIndex < history.length - 1) {
                        historyIndex++;
                        // History is stored oldest-first, so we read from the end
                        const historyEntry = history[history.length - 1 - historyIndex];
                        rewriteLine(historyEntry);
                    }
                    return;
                }

                if (keyStr === '\x1b[B') {
                    // Down arrow - go to next (newer) command
                    if (historyIndex === -1) return; // Already at newest

                    historyIndex--;
                    if (historyIndex === -1) {
                        // Back to current input
                        rewriteLine(savedBuffer);
                    } else {
                        const historyEntry = history[history.length - 1 - historyIndex];
                        rewriteLine(historyEntry);
                    }
                    return;
                }

                const showExecSkillSelector = async () => {
                    if (showingSelector) return;
                    showingSelector = true;

                    process.stdin.removeListener('data', handleKey);
                    process.stdin.setRawMode(false);

                    if (editor.boxed) {
                        editor.clearBox();
                    }

                    const allSkills = self.getAllSkills().filter((skill) => skill.enabled !== false);
                    if (allSkills.length === 0) {
                        showingSelector = false;
                        editor.render();
                        process.stdin.setRawMode(true);
                        process.stdin.on('data', handleKey);
                        return;
                    }

                    const sortedSkills = [...allSkills].sort((a, b) => {
                        const aName = (a.shortName || a.name || '').toLowerCase();
                        const bName = (b.shortName || b.name || '').toLowerCase();
                        return aName.localeCompare(bName);
                    });

                    const selectedSkill = await showSkillSelector(sortedSkills, {
                        prompt: '/exec ',
                        initialFilter: '',
                    });

                    if (selectedSkill) {
                        editor.setBuffer(`/exec ${selectedSkill.name}`);
                    }

                    showingSelector = false;
                    editor.render();
                    process.stdin.setRawMode(true);
                    process.stdin.on('data', handleKey);
                };

                // Helper to check if buffer is a command needing skill arg
                const getCommandNeedingSkillArg = () => {
                    const buf = editor.getBuffer();
                    if (!buf.startsWith('/')) return null;
                    const parsed = self.slashHandler.parseSlashCommand(buf);
                    if (!parsed) return null;
                    const { command, args } = parsed;
                    // Only trigger if no args yet (just the command)
                    if (args && args.trim()) return null;
                    const cmdDef = SlashCommandHandler.COMMANDS[command];
                    if (cmdDef && cmdDef.needsSkillArg) {
                        return { command, cmdDef };
                    }
                    return null;
                };

                // Helper to check if buffer is a command needing text args (not skill args)
                const getCommandNeedingTextArg = () => {
                    const buf = editor.getBuffer();
                    if (!buf.startsWith('/')) return null;
                    const parsed = self.slashHandler.parseSlashCommand(buf);
                    if (!parsed) return null;
                    const { command, args } = parsed;
                    // Only trigger if no args yet (just the command)
                    if (args && args.trim()) return null;
                    const cmdDef = SlashCommandHandler.COMMANDS[command];
                    // Command needs text args but not skill args
                    if (cmdDef && cmdDef.args === 'required' && !cmdDef.needsSkillArg) {
                        return { command, cmdDef };
                    }
                    return null;
                };

                // Helper to show skill selector for current command
                const showSkillSelectorForCommand = async (command) => {
                    if (showingSelector) return;
                    if (command === 'exec') {
                        await showExecSkillSelector();
                        return;
                    }

                    showingSelector = true;

                    process.stdin.removeListener('data', handleKey);
                    process.stdin.setRawMode(false);

                    // Clear the line and rewrite with space
                    process.stdout.write(` `);

                    // Reading and execution can select packaged as well as external skills.
                    const userSkills = self.getAllSkills();
                    if (userSkills.length === 0) {
                        cleanup();
                        process.stdout.write('\n');
                        console.log(`${self.colors.yellow}No skills found.${self.colors.reset}`);
                        resolve(''); // Return empty to re-prompt
                        return;
                    }

                    const selectedSkill = await showSkillSelector(userSkills, {
                        prompt: `/${command} `,
                        initialFilter: '',
                    });

                    if (selectedSkill) {
                        // Commands that should wait for additional input after skill selection
                        const commandsNeedingInput = ['exec'];

                        if (commandsNeedingInput.includes(command)) {
                            await self._handleSkillInputFlowForCommand(command, selectedSkill, userSkills, resolve, cleanup);
                        } else {
                            // Other commands - execute immediately
                            cleanup();
                            const fullCommand = `/${command} ${selectedSkill.name}`;
                            process.stdout.write(`${selectedSkill.name}\n`);
                            resolve(fullCommand);
                        }
                    } else {
                        // User cancelled - return to boxed input
                        showingSelector = false;
                        editor.boxDrawn = false;
                        editor.render();
                        process.stdin.setRawMode(true);
                        process.stdin.on('data', handleKey);
                    }
                };

                // Handle Tab - show skill selector if command needs skill arg, or prompt for text args
                if (keyStr === '\t') {
                    const taskMatch = editor.getBuffer().match(/^\/task\s+(view|continue|stop|model|login)(?:\s+(\S*))?$/);
                    if (taskMatch && typeof self.slashHandler.getTaskCompletions === 'function') {
                        const action = taskMatch[1];
                        const taskItems = self.slashHandler.getTaskCompletions(action).map((task) => ({
                            name: task.label,
                            description: task.description,
                            usage: task.value,
                            taskId: task.value,
                        }));
                        if (taskItems.length > 0) {
                            process.stdin.removeListener('data', handleKey);
                            process.stdin.setRawMode(false);
                            const selectedTask = await showCommandSelector(taskItems, {
                                initialFilter: taskMatch[2] || '',
                            });
                            process.stdin.setRawMode(true);
                            process.stdin.on('data', handleKey);
                            if (selectedTask) rewriteLine(`/task ${action} ${selectedTask.taskId} `);
                        }
                        return;
                    }
                    const cmdInfo = getCommandNeedingSkillArg();
                    if (cmdInfo) {
                        await showSkillSelectorForCommand(cmdInfo.command);
                        return;
                    }
                    // Check if command needs text args (not skill args)
                    const textArgInfo = getCommandNeedingTextArg();
                    if (textArgInfo) {
                        // Show argument input prompt
                        process.stdin.removeListener('data', handleKey);
                        process.stdin.setRawMode(false);
                        await self._handleArgInputFlow(`/${textArgInfo.command}`, textArgInfo.cmdDef, resolve, cleanup);
                        return;
                    }
                    // Otherwise ignore Tab
                    return;
                }

                // Handle Space after /exec to show skill selector
                if (keyStr === ' ') {
                    const buf = editor.getBuffer();
                    if (buf === '/exec') {
                        await showExecSkillSelector();
                        return;
                    }
                }

                // Disabled: space-triggered selector for slash commands.
                /*
                // Handle Space after command that needs skill arg
                if (keyStr === ' ') {
                    const cmdInfo = getCommandNeedingSkillArg();
                    if (cmdInfo) {
                        await showSkillSelectorForCommand(cmdInfo.command);
                        return;
                    }
                    // Fall through to LineEditor for regular space
                }
                */

                // Delegate to LineEditor for cursor movement, editing, and character input
                const action = editor.processKey(keyStr);
                if (action === 'modified') {
                    // Reset history navigation when user edits
                    if (historyIndex !== -1) {
                        historyIndex = -1;
                        savedBuffer = '';
                    }
                    editor.render();
                    if (editor.getBuffer() === '/exec') {
                        await showExecSkillSelector();
                        return;
                    }
                    return;
                }
                if (action === 'cursor') {
                    editor.render();
                    return;
                }
                // 'none' or 'unhandled' - ignore
            };

            process.stdin.on('data', handleKey);
        });
    }

    /**
     * Handle argument input flow when a command requires text arguments.
     * @private
     */
    async _handleArgInputFlow(commandName, cmdDef, resolve, cleanup) {
        const { gray, cyan, yellow, reset } = this.colors;

        // Show the command and usage hint
        process.stdout.write(`${commandName}\n`);
        process.stdout.write(`${gray}${'─'.repeat(50)}${reset}\n`);

        // Show usage and description
        process.stdout.write(`${cyan}  Usage:${reset} ${cmdDef.usage}\n`);
        process.stdout.write(`${cyan}  About:${reset} ${cmdDef.description}\n`);
        process.stdout.write(`${gray}  Ctrl+C to cancel${reset}\n`);
        process.stdout.write(`${gray}${'─'.repeat(50)}${reset}\n`);

        // Prompt for arguments using readline
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        let answered = false;

        // Handle Ctrl+C to cancel
        rl.on('SIGINT', () => {
            if (answered) return;
            answered = true;
            rl.close();
            process.stdout.write(`\n${yellow}Cancelled${reset}\n`);
            // Resolve with empty string to return to main loop
            resolve('');
        });

        rl.question(`${commandName} `, (input) => {
            if (answered) return;
            answered = true;
            rl.close();
            cleanup();
            const fullCommand = `${commandName} ${input}`.trim();
            resolve(fullCommand);
        });
    }

    /**
     * Handle skill input flow when command is selected with /prefix (e.g., /exec)
     * @private
     */
    async _handleSkillInputFlow(commandName, selectedSkill, userSkills, resolve, cleanup) {
        const { gray, cyan, yellow, reset } = this.colors;

        // Show hint about the skill and prompt for input
        const skillInfo = userSkills.find(s => (s.shortName || s.name) === selectedSkill.name);
        const hint = skillInfo?.description || skillInfo?.summary || '';
        const skillType = skillInfo?.type || 'skill';

        // Clear line and show skill info
        process.stdout.write(`${selectedSkill.name}\n`);
        process.stdout.write(`${gray}${'─'.repeat(50)}${reset}\n`);

        // Show skill type and description
        process.stdout.write(`${cyan}  Skill:${reset} ${selectedSkill.name} ${gray}[${skillType}]${reset}\n`);
        if (hint) {
            process.stdout.write(`${cyan}  About:${reset} ${hint}\n`);
        }

        // Show command-specific input guidance
        if (commandName === '/exec') {
            process.stdout.write(`${cyan}  Input:${reset} Type your input or press Enter to execute\n`);
        }

        process.stdout.write(`${gray}  Ctrl+C to cancel${reset}\n`);
        process.stdout.write(`${gray}${'─'.repeat(50)}${reset}\n`);

        // Prompt for input using readline
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        let answered = false;

        // Handle Ctrl+C to cancel
        rl.on('SIGINT', () => {
            if (answered) return;
            answered = true;
            rl.close();
            process.stdout.write(`\n${yellow}Cancelled${reset}\n`);
            // Resolve with empty string to return to main loop
            resolve('');
        });

        rl.question(`${commandName} ${selectedSkill.name} `, (input) => {
            if (answered) return;
            answered = true;
            rl.close();
            cleanup();
            const fullCommand = `${commandName} ${selectedSkill.name} ${input}`.trim();
            resolve(fullCommand);
        });
    }

    /**
     * Handle skill input flow when command is typed without /prefix (e.g., exec)
     * @private
     */
    async _handleSkillInputFlowForCommand(command, selectedSkill, userSkills, resolve, cleanup) {
        const { gray, cyan, yellow, reset } = this.colors;

        // Show hint about the skill and prompt for input
        const skillInfo = userSkills.find(s => (s.shortName || s.name) === selectedSkill.name);
        const hint = skillInfo?.description || skillInfo?.summary || '';
        const skillType = skillInfo?.type || 'skill';

        // Clear line and show skill info
        process.stdout.write(`${selectedSkill.name}\n`);
        process.stdout.write(`${gray}${'─'.repeat(50)}${reset}\n`);

        // Show skill type and description
        process.stdout.write(`${cyan}  Skill:${reset} ${selectedSkill.name} ${gray}[${skillType}]${reset}\n`);
        if (hint) {
            process.stdout.write(`${cyan}  About:${reset} ${hint}\n`);
        }

        // Show command-specific input guidance
        if (command === 'exec') {
            process.stdout.write(`${cyan}  Input:${reset} Type your input or press Enter to execute\n`);
        }

        process.stdout.write(`${gray}  Ctrl+C to cancel${reset}\n`);
        process.stdout.write(`${gray}${'─'.repeat(50)}${reset}\n`);

        // Prompt for input using readline
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        let answered = false;

        // Handle Ctrl+C to cancel
        rl.on('SIGINT', () => {
            if (answered) return;
            answered = true;
            rl.close();
            process.stdout.write(`\n${yellow}Cancelled${reset}\n`);
            // Resolve with empty string to return to main loop
            resolve('');
        });

        rl.question(`/${command} ${selectedSkill.name} `, (input) => {
            if (answered) return;
            answered = true;
            rl.close();
            cleanup();
            const fullCommand = `/${command} ${selectedSkill.name} ${input}`.trim();
            resolve(fullCommand);
        });
    }

    /**
     * Standard readline prompt (used for non-TTY or as fallback).
     * @returns {Promise<string>}
     * @private
     */
    async _promptOnce() {
        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                history: this.historyManager.getAll().reverse(),
                historySize: this.historyManager.maxEntries,
                terminal: Boolean(process.stdin.isTTY),
                completer: (line) => this.slashHandler.getCompletions(line),
            });

            // Clear any previous hint
            const clearHint = () => {
                if (this.currentHintLines > 0) {
                    // Move down, clear line, move back up
                    process.stdout.write('\n\x1b[K\x1b[A');
                    this.currentHintLines = 0;
                }
            };

            // Display hint below the input line
            const showHint = (line) => {
                const hint = this.slashHandler.getInputHint(line);
                if (hint) {
                    // Save cursor position, move to next line, show hint, restore cursor
                    process.stdout.write('\x1b[s'); // Save cursor
                    process.stdout.write('\n\x1b[K'); // New line, clear it
                    process.stdout.write(`${this.colors.gray}  ${hint}${this.colors.reset}`);
                    process.stdout.write('\x1b[u'); // Restore cursor
                    this.currentHintLines = 1;
                } else {
                    clearHint();
                }
            };

            // Listen for line changes to update hints
            let lastLine = '';
            const lineHandler = () => {
                const currentLine = rl.line || '';
                if (currentLine !== lastLine) {
                    lastLine = currentLine;
                    if (currentLine.startsWith('/')) {
                        showHint(currentLine);
                    } else {
                        clearHint();
                    }
                }
            };

            // Poll for line changes (readline doesn't have a direct 'input' event)
            const hintInterval = setInterval(lineHandler, 100);
            let answered = false;

            rl.question(this.promptString, (answer) => {
                answered = true;
                clearInterval(hintInterval);
                clearHint();
                rl.close();
                resolve(answer);
            });

            // Also clear hint on close
            rl.on('close', () => {
                clearInterval(hintInterval);
                clearHint();
                if (!answered) resolve('/exit');
            });
        });
    }
}

export default InteractivePrompt;

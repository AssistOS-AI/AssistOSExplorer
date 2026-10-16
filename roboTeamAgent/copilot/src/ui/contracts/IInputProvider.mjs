/**
 * IInputProvider Interface Definition
 *
 * Handles all user input collection: prompts, selectors, confirmations.
 *
 * @module contracts/IInputProvider
 */

/**
 * @typedef {Object} PromptOptions
 * @property {string} [promptString] - Custom prompt string
 * @property {string} [rightHint] - Right-side hint text
 * @property {boolean} [boxed=true] - Whether to show boxed input
 * @property {string} [initialValue] - Initial value in the input
 * @property {Object} [historyManager] - History manager for navigation
 */

/**
 * @typedef {Object} SelectorOptions
 * @property {'command'|'skill'|'repo'|'test'|'help'} [type='command'] - Selector type
 * @property {string} [prompt] - Prompt string for selector
 * @property {string} [initialFilter] - Initial filter text
 * @property {number} [maxVisible=10] - Maximum visible items
 */

/**
 * @typedef {Object} SelectorItem
 * @property {string} name - Item name/identifier
 * @property {string} [description] - Item description
 * @property {string} [type] - Item type (for skills)
 * @property {boolean} [needsSkillArg] - Whether command needs skill argument
 * @property {boolean} [needsRepoArg] - Whether command needs repo argument
 */

/**
 * @typedef {Object} ConfirmOptions
 * @property {string} [message] - Confirmation message
 * @property {boolean} [default=false] - Default value if user just presses Enter
 */

/**
 * @interface IInputProvider
 *
 * Handles all user input collection.
 *
 * @example
 * const input = ui.input;
 * const userInput = await input.prompt({ boxed: true });
 * const selected = await input.showSelector(commands, { type: 'command' });
 * const confirmed = await input.confirm({ message: 'Continue?' });
 */

/**
 * @typedef {Object} IInputProvider
 * @property {function(PromptOptions=): Promise<string>} prompt - Get single line of input
 * @property {function(SelectorItem[], SelectorOptions=): Promise<SelectorItem|null>} showSelector - Show interactive picker
 * @property {function(ConfirmOptions=): Promise<boolean>} confirm - Show yes/no confirmation
 * @property {function(string): void} setPromptString - Configure the default prompt string
 * @property {function(string): void} setRightHint - Configure default right-side hint
 * @property {function(): void} dispose - Clean up resources (e.g., raw mode listeners)
 */

export default {};

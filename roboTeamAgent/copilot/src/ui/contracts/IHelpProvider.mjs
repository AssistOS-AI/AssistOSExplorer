/**
 * IHelpProvider Interface Definition
 *
 * Handles help display and documentation.
 *
 * @module contracts/IHelpProvider
 */

/**
 * @typedef {Object} HelpTopic
 * @property {string} name - Topic identifier
 * @property {string} title - Topic display title
 * @property {string} [description] - Brief description
 * @property {string} [type] - Topic type (command, concept, etc.)
 */

/**
 * @typedef {Object} CommandHelp
 * @property {string} name - Command name (e.g., '/read')
 * @property {string} description - What the command does
 * @property {string} usage - Usage syntax
 * @property {string[]} [examples] - Example usages
 */

/**
 * @interface IHelpProvider
 *
 * Handles help display and documentation retrieval.
 *
 * @example
 * // Show help for specific topic
 * const helpText = ui.help.showHelp('slash-commands');
 * console.log(helpText);
 *
 * // Get quick reference
 * const quickRef = ui.help.getQuickReference();
 *
 * // Interactive topic selection
 * const topics = ui.help.getTopics();
 * const selected = await ui.input.showSelector(topics, { type: 'help' });
 */

/**
 * @typedef {Object} IHelpProvider
 * @property {function(string=): string} showHelp - Get help content for topic (or overview if no topic)
 * @property {function(): string} getQuickReference - Get quick reference/cheatsheet
 * @property {function(): HelpTopic[]} getTopics - Get list of available help topics
 * @property {function(): CommandHelp[]} getCommands - Get list of command help entries
 */

export default {};

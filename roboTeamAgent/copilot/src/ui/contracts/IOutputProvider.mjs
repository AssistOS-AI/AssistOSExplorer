/**
 * IOutputProvider Interface Definition
 *
 * Handles all output rendering: writing, formatting, markdown.
 *
 * @module contracts/IOutputProvider
 */

/**
 * @typedef {Object} TableOptions
 * @property {number[]} [columnWidths] - Fixed column widths
 * @property {string} [headerColor] - Color for header row
 * @property {boolean} [borders=true] - Whether to show borders
 */

/**
 * @typedef {Object} BoxOptions
 * @property {number} [width] - Box width (default: terminal width)
 * @property {string} [title] - Optional title in top border
 * @property {string} [borderColor] - Border color key
 */

/**
 * @interface IOutputProvider
 *
 * Handles all output rendering.
 *
 * @example
 * const output = ui.output;
 * output.writeLine('Hello, world!');
 * output.writeLine(output.renderMarkdown('**bold** and *italic*'));
 * output.writeLine(output.formatTable(['Name', 'Age'], [['Alice', '30']]));
 */

/**
 * @typedef {Object} IOutputProvider
 * @property {function(string): void} write - Write to output (no newline)
 * @property {function(string): void} writeLine - Write line to output
 * @property {function(): void} clear - Clear the entire output/screen
 * @property {function(): void} clearLine - Clear current line only
 * @property {function(number=): void} clearLines - Clear N lines above cursor
 * @property {function(string): string} renderMarkdown - Render markdown to terminal-styled string
 * @property {function(Object): string} formatResult - Format execution result for display
 * @property {function(Object): string} formatTestResult - Format test result for display
 * @property {function(string[], string[][], TableOptions=): string} formatTable - Format data as table
 * @property {function(string, BoxOptions=): string} formatBox - Wrap content in a box
 * @property {function(string[], Object=): string} formatList - Format items as bullet list
 * @property {function(Object, Object=): string} formatKeyValue - Format key-value pairs
 */

export default {};

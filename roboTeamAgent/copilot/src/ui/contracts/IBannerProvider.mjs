/**
 * IBannerProvider Interface Definition
 *
 * Handles startup banners and status messages.
 *
 * @module contracts/IBannerProvider
 */

/**
 * @typedef {Object} BannerOptions
 * @property {string} title - Application title
 * @property {string} workingDir - Current working directory
 * @property {Array<{name: string, type: string}>} skills - List of loaded skills
 * @property {string} [llmInfo] - LLM configuration info (model name, mode)
 * @property {number} historyCount - Number of history entries
 * @property {Object} [repositories] - External repository info
 */

/**
 * @interface IBannerProvider
 *
 * Handles startup banners and status/feedback messages.
 *
 * @example
 * ui.banner.showStartup({
 *   title: 'Achilles CLI',
 *   workingDir: '/path/to/project',
 *   skills: [{ name: 'my-skill', type: 'anthropic' }],
 *   llmInfo: 'native coding backend',
 *   historyCount: 15
 * });
 *
 * ui.banner.showSuccess('Operation completed!');
 * ui.banner.showError('Something went wrong');
 */

/**
 * @typedef {Object} IBannerProvider
 * @property {function(BannerOptions): void} showStartup - Display startup banner
 * @property {function(string): void} showStatus - Display neutral status message
 * @property {function(string): void} showSuccess - Display success message with icon
 * @property {function(string): void} showError - Display error message with icon
 * @property {function(string): void} showWarning - Display warning message with icon
 * @property {function(string): void} showInfo - Display info message with icon
 * @property {function(string, number=): void} showSeparator - Display horizontal separator line
 */

export default {};

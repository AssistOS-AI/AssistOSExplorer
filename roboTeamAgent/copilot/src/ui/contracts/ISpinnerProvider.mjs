/**
 * ISpinnerProvider Interface Definition
 *
 * Handles progress indication with spinners.
 *
 * @module contracts/ISpinnerProvider
 */

/**
 * @typedef {Object} SpinnerOptions
 * @property {string} [color] - Spinner color key
 * @property {string[]} [frames] - Custom animation frames
 * @property {number} [interval] - Animation interval in ms
 * @property {boolean} [showElapsed=true] - Show elapsed time
 * @property {boolean} [showInterruptHint=false] - Show "ESC to interrupt" hint
 * @property {NodeJS.WriteStream} [stream=process.stderr] - Output stream
 */

/**
 * @interface ISpinner
 *
 * Individual spinner instance returned by ISpinnerProvider.create().
 *
 * @example
 * const spinner = ui.spinner.create('Processing...');
 * spinner.start();
 * // ... do work ...
 * spinner.succeed('Done!');
 */

/**
 * @typedef {Object} ISpinner
 * @property {function(string=): ISpinner} start - Start with optional message
 * @property {function(string): ISpinner} update - Update message while spinning
 * @property {function(): ISpinner} pause - Pause animation (for user input)
 * @property {function(): ISpinner} resume - Resume animation after pause
 * @property {function(string=): ISpinner} stop - Stop with optional final message
 * @property {function(string=): ISpinner} succeed - Stop with success icon and message
 * @property {function(string=): ISpinner} fail - Stop with failure icon and message
 * @property {function(string=): ISpinner} warn - Stop with warning icon and message
 * @property {function(string=): ISpinner} info - Stop with info icon and message
 * @property {function(): boolean} isSpinning - Check if spinner is active
 */

/**
 * @interface ISpinnerProvider
 *
 * Factory for creating spinner instances.
 *
 * @example
 * const spinner = ui.spinner.create('Loading skills...', { showElapsed: true });
 * spinner.start();
 */

/**
 * @typedef {Object} ISpinnerProvider
 * @property {function(string, SpinnerOptions=): ISpinner} create - Create a new spinner instance
 */

export default {};

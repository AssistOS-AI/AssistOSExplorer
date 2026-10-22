/**
 * UIProvider Interface Definition
 *
 * Main composite interface that bundles all UI concerns.
 * Implementations provide different UI styles (Claude Code, Minimal, Codex, etc.)
 *
 * @module contracts/UIProvider
 */

/**
 * @typedef {Object} Theme
 * @property {string} name - Theme name identifier
 * @property {Colors} colors - Color palette
 * @property {Icons} icons - Icon set
 * @property {BoxChars} box - Box drawing characters
 * @property {Semantic} semantic - Semantic color mappings
 * @property {SpinnerConfig} spinner - Spinner configuration
 * @property {PromptConfig} prompt - Prompt styling
 * @property {SelectorConfig} selector - Selector styling
 */

/**
 * @typedef {Object} Colors
 * @property {string} reset - Reset all styles
 * @property {string} bold - Bold text
 * @property {string} dim - Dim/faded text
 * @property {string} italic - Italic text
 * @property {string} underline - Underlined text
 * @property {string} black - Black foreground
 * @property {string} red - Red foreground
 * @property {string} green - Green foreground
 * @property {string} yellow - Yellow foreground
 * @property {string} blue - Blue foreground
 * @property {string} magenta - Magenta foreground
 * @property {string} cyan - Cyan foreground
 * @property {string} white - White foreground
 * @property {string} gray - Gray foreground (bright black)
 * @property {string} [brightRed] - Bright red foreground
 * @property {string} [brightGreen] - Bright green foreground
 * @property {string} [brightYellow] - Bright yellow foreground
 * @property {string} [brightBlue] - Bright blue foreground
 * @property {string} [brightMagenta] - Bright magenta foreground
 * @property {string} [brightCyan] - Bright cyan foreground
 * @property {string} [brightWhite] - Bright white foreground
 */

/**
 * @typedef {Object} Icons
 * @property {string} bullet - Filled bullet point
 * @property {string} hollowBullet - Hollow bullet point
 * @property {string} check - Checkmark/success
 * @property {string} cross - Cross/failure
 * @property {string} arrow - Arrow indicator
 * @property {string} arrowRight - Right arrow/cursor
 * @property {string} info - Information icon
 * @property {string} warning - Warning icon
 * @property {string} error - Error icon
 * @property {string} star - Star icon
 * @property {string} dot - Small dot
 * @property {string} ellipsis - Ellipsis
 */

/**
 * @typedef {Object} BoxChars
 * @property {string} topLeft - Top-left corner
 * @property {string} topRight - Top-right corner
 * @property {string} bottomLeft - Bottom-left corner
 * @property {string} bottomRight - Bottom-right corner
 * @property {string} horizontal - Horizontal line
 * @property {string} vertical - Vertical line
 * @property {string} [tLeft] - Left T-junction
 * @property {string} [tRight] - Right T-junction
 * @property {string} [tTop] - Top T-junction
 * @property {string} [tBottom] - Bottom T-junction
 * @property {string} [cross] - Cross junction
 */

/**
 * @typedef {Object} Semantic
 * @property {string} success - Success color key
 * @property {string} error - Error color key
 * @property {string} warning - Warning color key
 * @property {string} info - Info color key
 * @property {string} muted - Muted/secondary color key
 * @property {string} highlight - Highlight color key
 * @property {string} accent - Accent color key
 */

/**
 * @typedef {Object} SpinnerConfig
 * @property {string[]} frames - Animation frames
 * @property {number} interval - Frame interval in ms
 * @property {string} color - Spinner color key
 */

/**
 * @typedef {Object} PromptConfig
 * @property {string} symbol - Prompt symbol (e.g., '>')
 * @property {string} color - Prompt color key
 * @property {string} hint - Right-side hint text
 * @property {string} hintColor - Hint color key
 */

/**
 * @typedef {Object} SelectorConfig
 * @property {string} cursorSymbol - Selection cursor (e.g., '❯')
 * @property {string} cursorColor - Cursor color key
 * @property {string} selectedColor - Selected item color key
 * @property {string} descriptionColor - Description text color key
 */

/**
 * @typedef {Object} BannerOptions
 * @property {string} title - Application title
 * @property {string} workingDir - Current working directory
 * @property {Array} skills - List of loaded skills
 * @property {string} [llmInfo] - LLM configuration info
 * @property {number} historyCount - Number of history entries
 */

/**
 * @interface UIProvider
 *
 * Main composite interface for UI implementations.
 * Bundles all UI concerns: input, output, spinner, banner, help.
 *
 * @example
 * const provider = new ClaudeCodeUIProvider({ theme: customTheme });
 * UIContext.setProvider(provider);
 *
 * // Use throughout the application
 * const ui = UIContext.getProvider();
 * await ui.input.prompt();
 * ui.banner.showStartup({ title: 'My App', ... });
 */

/**
 * @typedef {Object} UIProvider
 * @property {string} name - Provider name (e.g., 'claude-code', 'minimal', 'codex')
 * @property {Theme} theme - Theme configuration
 * @property {IInputProvider} input - Input handling
 * @property {IOutputProvider} output - Output rendering
 * @property {ISpinnerProvider} spinner - Progress indication
 * @property {IBannerProvider} banner - Banner display
 * @property {IHelpProvider} help - Help system
 * @property {function(Partial<Theme>): void} setTheme - Override theme properties
 * @property {function(): void} dispose - Clean up all resources
 */

// Re-export for convenience
export * from './IInputProvider.mjs';
export * from './IOutputProvider.mjs';
export * from './ISpinnerProvider.mjs';
export * from './IBannerProvider.mjs';
export * from './IHelpProvider.mjs';

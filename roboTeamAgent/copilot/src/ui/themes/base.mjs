/**
 * Base Theme - Core theme definition with all tokens
 *
 * This is the foundation theme that all other themes extend.
 * It defines all colors, icons, box characters, and configurations.
 *
 * @module themes/base
 */

/**
 * ANSI escape codes for colors and text styling
 */
export const colors = {
    // Reset
    reset: '\x1b[0m',

    // Text styles
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    italic: '\x1b[3m',
    underline: '\x1b[4m',
    inverse: '\x1b[7m',
    strikethrough: '\x1b[9m',

    // Foreground colors
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',

    // Bright foreground colors
    brightRed: '\x1b[91m',
    brightGreen: '\x1b[92m',
    brightYellow: '\x1b[93m',
    brightBlue: '\x1b[94m',
    brightMagenta: '\x1b[95m',
    brightCyan: '\x1b[96m',
    brightWhite: '\x1b[97m',

    // Background colors
    bgBlack: '\x1b[40m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m',
};

/**
 * Box-drawing characters for terminal UI
 */
export const box = {
    // Rounded corners (Claude Code style)
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',

    // Square corners (alternative style)
    sqTopLeft: '┌',
    sqTopRight: '┐',
    sqBottomLeft: '└',
    sqBottomRight: '┘',

    // Double line
    dTopLeft: '╔',
    dTopRight: '╗',
    dBottomLeft: '╚',
    dBottomRight: '╝',
    dHorizontal: '═',
    dVertical: '║',

    // T-junctions
    tLeft: '├',
    tRight: '┤',
    tTop: '┬',
    tBottom: '┴',
    cross: '┼',
};

/**
 * Icons and symbols for terminal UI
 */
export const icons = {
    bullet: '●',
    hollowBullet: '○',
    check: '✓',
    cross: '✗',
    arrow: '→',
    arrowRight: '❯',
    arrowLeft: '❮',
    arrowUp: '↑',
    arrowDown: '↓',
    info: 'ℹ',
    warning: '⚠',
    error: '✖',
    star: '★',
    dot: '•',
    ellipsis: '…',
    spinner: '◐',
};

/**
 * Semantic color mappings (reference color keys, not actual codes)
 */
export const semantic = {
    success: 'green',
    error: 'red',
    warning: 'yellow',
    info: 'cyan',
    muted: 'dim',
    highlight: 'cyan',
    accent: 'magenta',
    primary: 'cyan',
    secondary: 'gray',
};

/**
 * Terminal control sequences (not colors, but useful for UI)
 */
export const terminal = {
    hideCursor: '\x1b[?25l',
    showCursor: '\x1b[?25h',
    clearLine: '\x1b[K',
    clearScreen: '\x1b[2J',
    moveUp: '\x1b[A',
    moveDown: '\x1b[B',
    moveLeft: '\x1b[D',
    moveRight: '\x1b[C',
    moveToCol: (n) => `\x1b[${n}G`,
    moveToRow: (n) => `\x1b[${n}d`,
    moveTo: (row, col) => `\x1b[${row};${col}H`,
    saveCursor: '\x1b[s',
    restoreCursor: '\x1b[u',
    // Bracketed paste mode
    enableBracketedPaste: '\x1b[?2004h',
    disableBracketedPaste: '\x1b[?2004l',
    pasteStart: '\x1b[200~',
    pasteEnd: '\x1b[201~',
};

/**
 * Spinner configuration for progress indicators
 */
export const spinnerConfig = {
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    interval: 80,
    color: 'cyan',
};

/**
 * Prompt configuration for input
 */
export const promptConfig = {
    symbol: '>',
    color: 'cyan',
    hint: '[model]',
    hintColor: 'dim',
};

/**
 * Selector configuration for interactive pickers
 */
export const selectorConfig = {
    cursorSymbol: '❯',
    cursorColor: 'magenta',
    selectedColor: 'cyan',
    descriptionColor: 'gray',
};

/**
 * Complete base theme object that combines all configurations
 */
export const baseTheme = {
    name: 'base',
    colors,
    box,
    icons,
    semantic,
    terminal,
    spinner: spinnerConfig,
    prompt: promptConfig,
    selector: selectorConfig,
};

/**
 * Create a styler function bound to a specific theme
 *
 * @param {Object} theme - Theme object with colors
 * @returns {function(string, ...string): string} - Styler function
 *
 * @example
 * const style = createStyler(baseTheme);
 * console.log(style('Hello', 'cyan', 'bold')); // Cyan bold "Hello"
 */
export function createStyler(theme) {
    const { colors: themeColors } = theme;
    return (text, ...styles) => {
        const styleStr = styles
            .map(s => themeColors[s] || s)
            .join('');
        return `${styleStr}${text}${themeColors.reset}`;
    };
}

/**
 * Get a semantic color from the theme
 *
 * @param {Object} theme - Theme object
 * @param {string} semanticKey - Semantic key (e.g., 'success', 'error')
 * @returns {string} - ANSI color code
 */
export function getSemanticColor(theme, semanticKey) {
    const colorKey = theme.semantic[semanticKey];
    return theme.colors[colorKey] || theme.colors.reset;
}

/**
 * Create a horizontal line
 *
 * @param {number} width - Line width
 * @param {string} char - Character to use (default: horizontal box char)
 * @returns {string} - Line string
 */
export function line(width = 60, char = box.horizontal) {
    return char.repeat(width);
}

/**
 * Merge a custom theme with the base theme
 *
 * @param {Object} customTheme - Partial theme to merge
 * @returns {Object} - Merged theme
 */
export function mergeTheme(customTheme) {
    return {
        ...baseTheme,
        ...customTheme,
        colors: { ...baseTheme.colors, ...customTheme.colors },
        box: { ...baseTheme.box, ...customTheme.box },
        icons: { ...baseTheme.icons, ...customTheme.icons },
        semantic: { ...baseTheme.semantic, ...customTheme.semantic },
        spinner: { ...baseTheme.spinner, ...customTheme.spinner },
        prompt: { ...baseTheme.prompt, ...customTheme.prompt },
        selector: { ...baseTheme.selector, ...customTheme.selector },
    };
}

export default baseTheme;

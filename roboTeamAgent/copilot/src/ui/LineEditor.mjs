/**
 * LineEditor - Handles line editing with cursor navigation.
 *
 * Provides Unix-like terminal navigation including:
 * - Left/Right arrow cursor movement
 * - Ctrl+Left/Right, Alt+Left/Right, or Ctrl+Alt+Left/Right word navigation
 * - Ctrl+Backspace, Alt+Backspace, or Ctrl+Alt+Backspace word deletion backward
 * - Ctrl+Delete, Alt+Delete, or Ctrl+Alt+Delete word deletion forward
 * - Ctrl+A/E and Home/End for line start/end
 * - Ctrl+U to clear line
 * - Ctrl+K to kill to end of line
 * - Ctrl+Insert or Ctrl+Shift+C to copy line to clipboard
 * - Shift+Insert or Ctrl+Shift+V to paste from clipboard
 *
 * Note: Ctrl+Alt combinations behave identically to Ctrl-only combinations.
 *
 * @module ui/LineEditor
 */

import { copyToClipboard, pasteFromClipboard } from '../lib/clipboard.mjs';
import { baseTheme } from './themes/base.mjs';
import { getTerminalSize } from './terminalSize.mjs';

// ANSI escape codes for terminal control (not theme-dependent)
const ANSI = {
    MOVE_TO_COL: (n) => `\x1b[${n}G`,
    CLEAR_TO_END: '\x1b[K',
};

// Key code constants - some keys have multiple codes depending on terminal
// Modifier codes in ANSI sequences: 2=Shift, 3=Alt, 5=Ctrl, 6=Ctrl+Shift, 7=Ctrl+Alt, 8=Ctrl+Alt+Shift
const KEYS = {
    // Arrow keys
    LEFT: '\x1b[D',
    RIGHT: '\x1b[C',

    // Ctrl/Alt/Ctrl+Alt+Arrow for word navigation
    WORD_LEFT: [
        '\x1b[1;5D', '\x1b[5D',   // Ctrl+Left
        '\x1b[1;3D', '\x1bb',     // Alt+Left
        '\x1b[1;7D',              // Ctrl+Alt+Left
    ],
    WORD_RIGHT: [
        '\x1b[1;5C', '\x1b[5C',   // Ctrl+Right
        '\x1b[1;3C', '\x1bf',     // Alt+Right
        '\x1b[1;7C',              // Ctrl+Alt+Right
    ],

    // Word deletion (Ctrl/Alt/Ctrl+Alt+Backspace and Delete)
    WORD_BACKSPACE: [
        '\x08', '\x17', '\x1f',   // Ctrl+BS, Ctrl+W, Ctrl+_
        '\x1b\x7f',               // Alt+BS (ESC+DEL)
        '\x1b\x08',               // Ctrl+Alt+BS (ESC+Ctrl+BS)
    ],
    WORD_DELETE: [
        '\x1b[3;5~',              // Ctrl+Del
        '\x1b[3;3~', '\x1bd',     // Alt+Del
        '\x1b[3;7~',              // Ctrl+Alt+Del
    ],

    // Line operations
    CTRL_U: '\x15',
    CTRL_K: '\x0b',

    // Line navigation
    CTRL_A: '\x01',
    CTRL_E: '\x05',
    HOME: ['\x1b[H', '\x1b[1~', '\x1bOH'],
    END: ['\x1b[F', '\x1b[4~', '\x1bOF'],

    // Delete key
    DELETE: '\x1b[3~',

    // Standard keys
    BACKSPACE: '\x7f',  // DEL key (0x7f) - regular backspace

    // Clipboard operations
    // Ctrl+Insert (copy) - various terminal encodings
    COPY: ['\x1b[2;5~', '\x1b[2^'],
    // Shift+Insert (paste) - various terminal encodings
    PASTE: ['\x1b[2;2~', '\x1b[2$'],
    // Ctrl+Shift+C (copy) - kitty/modern terminal encoding
    COPY_ALT: ['\x1b[99;6u', '\x1b[67;6u'],
    // Ctrl+Shift+V (paste) - kitty/modern terminal encoding
    PASTE_ALT: ['\x1b[118;6u', '\x1b[86;6u'],

    // Bracketed paste mode markers
    PASTE_START: '\x1b[200~',
    PASTE_END: '\x1b[201~',
};

/**
 * LineEditor class for managing line input with cursor positioning.
 */
export class LineEditor {
    /**
     * @param {Object} options
     * @param {string} [options.prompt=''] - The prompt string displayed before input
     * @param {string} [options.rightHint=''] - Hint displayed on the right side
     * @param {boolean} [options.boxed=false] - Whether to draw a box around the input
     * @param {NodeJS.WriteStream} [options.stream=process.stdout] - Output stream
     * @param {Object} [options.theme] - Theme object (uses baseTheme if not provided)
     */
    constructor(options = {}) {
        // Use provided theme or fall back to baseTheme
        this.theme = options.theme || baseTheme;
        this.colors = this.theme.colors;
        this.box = this.theme.box;

        this.buffer = '';
        this.cursorPos = 0;
        this.prompt = options.prompt || '';
        this.rightHint = options.rightHint || '';
        this.boxed = options.boxed || false;
        this.stream = options.stream || process.stdout;
        this.boxDrawn = false; // Track if box has been drawn
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State accessors
    // ─────────────────────────────────────────────────────────────────────────

    /** Get the current buffer content */
    getBuffer() {
        return this.buffer;
    }

    /** Get the current cursor position */
    getCursorPos() {
        return this.cursorPos;
    }

    /** Set buffer content and move cursor to end */
    setBuffer(content) {
        this.buffer = content;
        this.cursorPos = content.length;
    }

    /** Clear buffer and reset cursor */
    clear() {
        this.buffer = '';
        this.cursorPos = 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Character operations
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Insert character(s) at cursor position
     * @param {string} chars - Characters to insert
     */
    insert(chars) {
        this.buffer =
            this.buffer.slice(0, this.cursorPos) +
            chars +
            this.buffer.slice(this.cursorPos);
        this.cursorPos += chars.length;
    }

    /**
     * Delete character before cursor (backspace)
     * @returns {boolean} True if a character was deleted
     */
    deleteBack() {
        if (this.cursorPos > 0) {
            this.buffer =
                this.buffer.slice(0, this.cursorPos - 1) +
                this.buffer.slice(this.cursorPos);
            this.cursorPos--;
            return true;
        }
        return false;
    }

    /**
     * Delete character at cursor (delete key)
     * @returns {boolean} True if a character was deleted
     */
    deleteForward() {
        if (this.cursorPos < this.buffer.length) {
            this.buffer =
                this.buffer.slice(0, this.cursorPos) +
                this.buffer.slice(this.cursorPos + 1);
            return true;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cursor movement
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Move cursor left one position
     * @returns {boolean} True if cursor moved
     */
    moveLeft() {
        if (this.cursorPos > 0) {
            this.cursorPos--;
            return true;
        }
        return false;
    }

    /**
     * Move cursor right one position
     * @returns {boolean} True if cursor moved
     */
    moveRight() {
        if (this.cursorPos < this.buffer.length) {
            this.cursorPos++;
            return true;
        }
        return false;
    }

    /** Move cursor to start of line */
    moveToStart() {
        this.cursorPos = 0;
    }

    /** Move cursor to end of line */
    moveToEnd() {
        this.cursorPos = this.buffer.length;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Word navigation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Find the position of the previous word boundary
     * @returns {number} Position of previous word start
     */
    findPrevWordBoundary() {
        let pos = this.cursorPos;
        // Skip whitespace first (moving backward)
        while (pos > 0 && /\s/.test(this.buffer[pos - 1])) {
            pos--;
        }
        // Then skip non-whitespace (the word itself)
        while (pos > 0 && !/\s/.test(this.buffer[pos - 1])) {
            pos--;
        }
        return pos;
    }

    /**
     * Find the position of the next word boundary
     * @returns {number} Position after next word end
     */
    findNextWordBoundary() {
        let pos = this.cursorPos;
        // Skip non-whitespace first (current word)
        while (pos < this.buffer.length && !/\s/.test(this.buffer[pos])) {
            pos++;
        }
        // Then skip whitespace
        while (pos < this.buffer.length && /\s/.test(this.buffer[pos])) {
            pos++;
        }
        return pos;
    }

    /** Move cursor to previous word boundary */
    moveToPrevWord() {
        this.cursorPos = this.findPrevWordBoundary();
    }

    /** Move cursor to next word boundary */
    moveToNextWord() {
        this.cursorPos = this.findNextWordBoundary();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Word/line deletion
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Delete word backward (Ctrl+Backspace)
     * @returns {boolean} True if text was deleted
     */
    deleteWordBack() {
        const newPos = this.findPrevWordBoundary();
        if (newPos < this.cursorPos) {
            this.buffer =
                this.buffer.slice(0, newPos) +
                this.buffer.slice(this.cursorPos);
            this.cursorPos = newPos;
            return true;
        }
        return false;
    }

    /**
     * Delete word forward (Ctrl+Delete)
     * @returns {boolean} True if text was deleted
     */
    deleteWordForward() {
        const newPos = this.findNextWordBoundary();
        if (newPos > this.cursorPos) {
            this.buffer =
                this.buffer.slice(0, this.cursorPos) +
                this.buffer.slice(newPos);
            return true;
        }
        return false;
    }

    /**
     * Clear entire line (Ctrl+U)
     */
    clearLine() {
        this.buffer = '';
        this.cursorPos = 0;
    }

    /**
     * Kill to end of line (Ctrl+K)
     * @returns {boolean} True if text was deleted
     */
    killToEnd() {
        if (this.cursorPos < this.buffer.length) {
            this.buffer = this.buffer.slice(0, this.cursorPos);
            return true;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Clipboard operations
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Enable bracketed paste mode in the terminal.
     * When enabled, pasted text is wrapped with escape sequences.
     */
    static enableBracketedPaste() {
        process.stdout.write('\x1b[?2004h');
    }

    /**
     * Disable bracketed paste mode in the terminal.
     */
    static disableBracketedPaste() {
        process.stdout.write('\x1b[?2004l');
    }

    /**
     * Copy current buffer content to system clipboard
     * @returns {boolean} True if copy was successful
     */
    copyToClipboard() {
        if (this.buffer.length === 0) {
            return false;
        }
        return copyToClipboard(this.buffer);
    }

    /**
     * Paste from system clipboard at cursor position
     * @returns {boolean} True if paste was successful and buffer was modified
     */
    pasteFromClipboard() {
        const text = pasteFromClipboard();
        if (text && text.length > 0) {
            // Filter out newlines - line editor is single-line
            const cleanText = text.replace(/[\r\n]/g, ' ');
            this.insert(cleanText);
            return true;
        }
        return false;
    }

    /**
     * Handle bracketed paste content (text pasted via terminal)
     * @param {string} text - The pasted text (without bracket markers)
     * @returns {boolean} True if text was inserted
     */
    handleBracketedPaste(text) {
        if (text && text.length > 0) {
            // Filter out newlines - line editor is single-line
            const cleanText = text.replace(/[\r\n]/g, ' ');
            this.insert(cleanText);
            return true;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Rendering
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Render the line with proper cursor positioning
     */
    render() {
        if (this.boxed) {
            this._renderBoxed();
        } else {
            this._renderSimple();
        }
    }

    /**
     * Simple render without box
     */
    _renderSimple() {
        const visiblePromptLen = this.prompt.replace(/\x1b\[[0-9;]*m/g, '').length;

        // Build output in a single string to avoid flickering
        let output = '\r' + ANSI.CLEAR_TO_END;
        output += this.prompt + this.buffer;

        // If there's a right hint, display it
        if (this.rightHint) {
            const cols = getTerminalSize(this.stream).columns;
            const contentLen = visiblePromptLen + this.buffer.length;
            const hintLen = this.rightHint.replace(/\x1b\[[0-9;]*m/g, '').length;

            if (contentLen + hintLen + 2 < cols) {
                output += ANSI.MOVE_TO_COL(cols - hintLen);
                output += this.rightHint;
            }
        }

        const cursorColumn = visiblePromptLen + this.cursorPos + 1;
        output += ANSI.MOVE_TO_COL(cursorColumn);

        // Single write to avoid flickering
        this.stream.write(output);
    }

    /**
     * Render with a box around the input
     */
    _renderBoxed() {
        const cols = getTerminalSize(this.stream).columns;
        const { gray, reset } = this.colors;
        const { topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical } = this.box;

        // Calculate visible lengths (strip ANSI codes)
        const visiblePromptLen = this.prompt.replace(/\x1b\[[0-9;]*m/g, '').length;
        const fullHintLen = this.rightHint.replace(/\x1b\[[0-9;]*m/g, '').length;
        const showHint = fullHintLen > 0 && cols - 4 - visiblePromptLen - fullHintLen >= 12;
        const displayedHint = showHint ? this.rightHint : '';
        const hintLen = showHint ? fullHintLen : 0;

        // Layout for middle line: │ {prompt}{content}{hint} │
        // = 1 (│) + 1 (space) + prompt + content + hint + 1 (space) + 1 (│)
        // = 4 + prompt + content + hint = cols
        const contentAreaWidth = Math.max(1, cols - 4 - visiblePromptLen - hintLen);
        // Horizontal line width (between corners) = cols - 2
        const horizontalWidth = cols - 2;
        const horizontalLine = horizontal.repeat(horizontalWidth);

        // Truncate buffer if too long
        let displayBuffer = this.buffer;
        let bufferOffset = 0;
        if (this.buffer.length > contentAreaWidth) {
            const start = Math.max(0, this.cursorPos - Math.floor(contentAreaWidth / 2));
            bufferOffset = start;
            displayBuffer = this.buffer.slice(start, start + contentAreaWidth);
        }

        // Build padded content - content fills remaining space before hint
        const paddedBuffer = displayBuffer.padEnd(contentAreaWidth);

        // Build output in a single string to avoid flickering
        let output = '';

        if (!this.boxDrawn) {
            // First render: draw complete box (3 lines)
            output += `\n${gray}${topLeft}${horizontalLine}${topRight}${reset}\n`;
            output += `${gray}${vertical}${reset} `;
            output += this.prompt;
            output += paddedBuffer;
            output += displayedHint;
            output += ` ${gray}${vertical}${reset}\n`;
            output += `${gray}${bottomLeft}${horizontalLine}${bottomRight}${reset}`;
            // Move cursor back up to content line
            output += '\x1b[1A'; // Move up from bottom to content line
            this.boxDrawn = true;
        } else {
            // Subsequent renders: cursor is on content line, just redraw it
            output += '\r' + ANSI.CLEAR_TO_END;
            output += `${gray}${vertical}${reset} `;
            output += this.prompt;
            output += paddedBuffer;
            output += displayedHint;
            output += ` ${gray}${vertical}${reset}`;
        }

        // Position cursor within the content line
        const cursorInBuffer = this.cursorPos - bufferOffset;
        const cursorColumn = Math.min(cols - 1, 2 + visiblePromptLen + cursorInBuffer + 1);
        output += ANSI.MOVE_TO_COL(cursorColumn);

        // Single write to avoid flickering
        this.stream.write(output);
    }

    /** Redraw the complete editor after terminal dimensions change. */
    redraw() {
        if (this.boxed && this.boxDrawn) {
            this.clearBox();
        }
        this.render();
    }

    /**
     * Finalize the box display (move cursor below the box when input is complete)
     */
    drawBottomBorder() {
        if (this.boxed && this.boxDrawn) {
            // Box is already complete with bottom border
            // Just move cursor down to below the box
            this.stream.write('\x1b[1B'); // Move down to bottom border line
            this.stream.write('\r');      // Go to start of line
            this.boxDrawn = false;
        }
    }

    /**
     * Clear the box display (move cursor up and clear lines)
     */
    clearBox() {
        if (this.boxed && this.boxDrawn) {
            // Cursor is on content line, need to clear all 3 lines
            // First move down to bottom border, then clear going up
            this.stream.write('\x1b[1B\r' + ANSI.CLEAR_TO_END); // Clear bottom border
            this.stream.write('\x1b[1A\r' + ANSI.CLEAR_TO_END); // Clear content line
            this.stream.write('\x1b[1A\r' + ANSI.CLEAR_TO_END); // Clear top border
            this.boxDrawn = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Key processing
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Helper to check if a key matches any pattern in an array or single value
     * @param {string} key - The key code to check
     * @param {string|string[]} patterns - Pattern(s) to match against
     * @returns {boolean}
     */
    static matches(key, patterns) {
        if (Array.isArray(patterns)) {
            return patterns.includes(key);
        }
        return key === patterns;
    }

    /**
     * Process a key and perform the appropriate action
     * @param {string} keyStr - The key code string
     * @returns {'modified'|'cursor'|'none'|'unhandled'} Action type
     *   - 'modified': Buffer content changed
     *   - 'cursor': Only cursor position changed
     *   - 'none': Key recognized but no change (e.g., backspace at start)
     *   - 'unhandled': Key not recognized by LineEditor
     */
    processKey(keyStr) {
        const { matches } = LineEditor;

        // Left arrow
        if (keyStr === KEYS.LEFT) {
            return this.moveLeft() ? 'cursor' : 'none';
        }

        // Right arrow
        if (keyStr === KEYS.RIGHT) {
            return this.moveRight() ? 'cursor' : 'none';
        }

        // Ctrl/Alt+Left (word left)
        if (matches(keyStr, KEYS.WORD_LEFT)) {
            this.moveToPrevWord();
            return 'cursor';
        }

        // Ctrl/Alt+Right (word right)
        if (matches(keyStr, KEYS.WORD_RIGHT)) {
            this.moveToNextWord();
            return 'cursor';
        }

        // Ctrl+A or Home
        if (keyStr === KEYS.CTRL_A || matches(keyStr, KEYS.HOME)) {
            this.moveToStart();
            return 'cursor';
        }

        // Ctrl+E or End
        if (keyStr === KEYS.CTRL_E || matches(keyStr, KEYS.END)) {
            this.moveToEnd();
            return 'cursor';
        }

        // Ctrl+U (clear line)
        if (keyStr === KEYS.CTRL_U) {
            this.clearLine();
            return 'modified';
        }

        // Ctrl+K (kill to end)
        if (keyStr === KEYS.CTRL_K) {
            return this.killToEnd() ? 'modified' : 'none';
        }

        // Ctrl/Alt+Backspace (delete word back) - check BEFORE regular backspace
        if (matches(keyStr, KEYS.WORD_BACKSPACE)) {
            return this.deleteWordBack() ? 'modified' : 'none';
        }

        // Ctrl/Alt+Delete (delete word forward) - check BEFORE regular delete
        if (matches(keyStr, KEYS.WORD_DELETE)) {
            return this.deleteWordForward() ? 'modified' : 'none';
        }

        // Backspace (single character delete)
        if (keyStr === KEYS.BACKSPACE) {
            return this.deleteBack() ? 'modified' : 'none';
        }

        // Delete key (single character delete)
        if (keyStr === KEYS.DELETE) {
            return this.deleteForward() ? 'modified' : 'none';
        }

        // Copy to clipboard (Ctrl+Insert or Ctrl+Shift+C)
        if (matches(keyStr, KEYS.COPY) || matches(keyStr, KEYS.COPY_ALT)) {
            this.copyToClipboard();
            return 'none';
        }

        // Paste from clipboard (Shift+Insert or Ctrl+Shift+V)
        if (matches(keyStr, KEYS.PASTE) || matches(keyStr, KEYS.PASTE_ALT)) {
            return this.pasteFromClipboard() ? 'modified' : 'none';
        }

        // Regular printable character
        if (keyStr.length === 1 && keyStr >= ' ' && keyStr <= '~') {
            this.insert(keyStr);
            return 'modified';
        }

        return 'unhandled';
    }
}

// Export key constants for reference/testing
export const KEYS_REFERENCE = KEYS;
export default LineEditor;

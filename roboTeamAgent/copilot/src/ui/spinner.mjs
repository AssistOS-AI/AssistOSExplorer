/**
 * CLI Spinner - Animated loading indicator for long-running operations
 *
 * @module ui/spinner
 */

import { baseTheme, colors as baseColors } from './themes/base.mjs';

/**
 * Available spinner frame styles
 */
const SPINNER_FRAMES = {
    dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    line: ['|', '/', '-', '\\'],
    arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
    circle: ['◐', '◓', '◑', '◒'],
    square: ['◰', '◳', '◲', '◱'],
    bounce: ['⠁', '⠂', '⠄', '⠂'],
    pulse: ['█', '▓', '▒', '░', '▒', '▓'],
    arrows: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
    clock: ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'],
};

export class Spinner {
    /**
     * @param {Object} options - Spinner options
     * @param {string} [options.style='dots'] - Spinner animation style
     * @param {number} [options.interval=80] - Animation interval in ms
     * @param {string} [options.color='cyan'] - Spinner color name
     * @param {Object} [options.stream=process.stderr] - Output stream
     * @param {boolean} [options.showInterruptHint=false] - Show ESC hint
     * @param {Object} [options.theme] - Theme object (uses baseTheme if not provided)
     */
    constructor(options = {}) {
        // Use provided theme or fall back to baseTheme
        this.theme = options.theme || baseTheme;
        this.colors = this.theme.colors || baseColors;

        this.frames = SPINNER_FRAMES[options.style] || SPINNER_FRAMES.dots;
        this.interval = options.interval || this.theme.spinner?.interval || 80;
        this.color = this.colors[options.color] || this.colors.cyan;
        this.stream = options.stream || process.stderr;

        this.frameIndex = 0;
        this.timer = null;
        this.message = '';
        this.startTime = null;
        this.isSpinning = false;
        this.isPaused = false;
        this.showInterruptHint = options.showInterruptHint || false;
        this.overlayInput = false;
    }

    start(message = 'Processing') {
        if (this.isSpinning) return this;

        this.isSpinning = true;
        this.message = message;
        this.startTime = Date.now();
        this.frameIndex = 0;

        // Hide cursor
        this.stream.write('\x1b[?25l');

        this.timer = setInterval(() => {
            this.render();
            this.frameIndex = (this.frameIndex + 1) % this.frames.length;
        }, this.interval);

        return this;
    }

    render() {
        const frame = this.frames[this.frameIndex];
        const elapsed = this.getElapsed();
        const line = `${this.color}${frame}${this.colors.reset} ${this.message} ${this.colors.dim}${elapsed}${this.colors.reset}`;

        if (this.overlayInput) {
            this.stream.write(`\x1b7\x1b[A\r\x1b[K${line}\x1b8`);
            return;
        }

        if (this.showInterruptHint) {
            // Clear current line and line below, then write both lines
            const hint = `${this.colors.dim}   Esc to interrupt${this.colors.reset}`;
            this.stream.write(`\r\x1b[K${line}\n\x1b[K${hint}\x1b[A\r`);
        } else {
            // Clear line and write
            this.stream.write(`\r\x1b[K${line}`);
        }
    }

    enableInputOverlay() {
        this.overlayInput = true;
        return this;
    }

    disableInputOverlay() {
        this.overlayInput = false;
        return this;
    }

    getElapsed() {
        if (!this.startTime) return '';
        const ms = Date.now() - this.startTime;
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) {
            return `(${seconds}s)`;
        }
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `(${minutes}m ${remainingSeconds}s)`;
    }

    update(message) {
        this.message = message;
        if (this.isSpinning) {
            this.render();
        }
        return this;
    }

    pause() {
        if (!this.isSpinning || this.isPaused) return this;

        clearInterval(this.timer);
        this.timer = null;

        // Clear line(s) and show cursor
        if (this.showInterruptHint) {
            // Clear both lines (current and hint below)
            this.stream.write('\r\x1b[K\n\x1b[K\x1b[A\r');
        } else {
            this.stream.write('\r\x1b[K');
        }
        this.stream.write('\x1b[?25h');

        this.isPaused = true;
        return this;
    }

    resume() {
        if (!this.isPaused || !this.isSpinning) return this;

        this.isPaused = false;

        // Hide cursor and restart animation
        this.stream.write('\x1b[?25l');

        this.timer = setInterval(() => {
            this.render();
            this.frameIndex = (this.frameIndex + 1) % this.frames.length;
        }, this.interval);

        return this;
    }

    succeed(message) {
        return this.stop(`${this.colors.green}✓${this.colors.reset} ${message || this.message}`);
    }

    fail(message) {
        return this.stop(`${this.colors.yellow}✗${this.colors.reset} ${message || this.message}`);
    }

    info(message) {
        return this.stop(`${this.colors.blue}ℹ${this.colors.reset} ${message || this.message}`);
    }

    stop(finalMessage) {
        if (!this.isSpinning) return this;

        clearInterval(this.timer);
        this.timer = null;
        this.isSpinning = false;
        this.isPaused = false;

        // Clear line(s)
        if (this.showInterruptHint) {
            // Clear both lines (current and hint below)
            this.stream.write('\r\x1b[K\n\x1b[K\x1b[A\r');
        } else {
            this.stream.write('\r\x1b[K');
        }

        // Show cursor
        this.stream.write('\x1b[?25h');

        // Write final message if provided
        if (finalMessage) {
            const elapsed = this.getElapsed();
            this.stream.write(`${finalMessage} ${this.colors.dim}${elapsed}${this.colors.reset}\n`);
        }

        return this;
    }
}

/**
 * Create and start a spinner with a single call
 *
 * @param {string} message - Initial spinner message
 * @param {Object} [options] - Spinner options (see Spinner constructor)
 * @returns {Spinner} - Started spinner instance
 */
export function createSpinner(message, options = {}) {
    return new Spinner(options).start(message);
}

/**
 * Status line that updates in place (no animation)
 */
export class StatusLine {
    constructor(stream = process.stderr) {
        this.stream = stream;
        this.active = false;
    }

    update(message) {
        if (!this.active) {
            this.active = true;
            this.stream.write('\x1b[?25l'); // Hide cursor
        }
        this.stream.write(`\r\x1b[K${message}`);
        return this;
    }

    clear() {
        if (this.active) {
            this.stream.write('\r\x1b[K');
            this.stream.write('\x1b[?25h'); // Show cursor
            this.active = false;
        }
        return this;
    }

    done(message) {
        this.stream.write(`\r\x1b[K${message}\n`);
        this.stream.write('\x1b[?25h'); // Show cursor
        this.active = false;
        return this;
    }
}

export default Spinner;

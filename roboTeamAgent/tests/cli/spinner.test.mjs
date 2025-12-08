/**
 * Tests for Spinner and StatusLine modules.
 *
 * Tests the animated progress indicator and status line utilities.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Writable } from 'node:stream';

// ============================================================================
// Mock Stream for capturing output
// ============================================================================

function createMockStream() {
    const chunks = [];
    const stream = new Writable({
        write(chunk, encoding, callback) {
            chunks.push(chunk.toString());
            callback();
        },
    });
    stream.getOutput = () => chunks.join('');
    stream.clearOutput = () => { chunks.length = 0; };
    return stream;
}

// ============================================================================
// Spinner Tests
// ============================================================================

describe('Spinner', () => {
    let Spinner, createSpinner;

    beforeEach(async () => {
        const module = await import('../src/ui/spinner.mjs');
        Spinner = module.Spinner;
        createSpinner = module.createSpinner;
    });

    describe('Constructor', () => {
        it('should create spinner with default options', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            assert.ok(spinner, 'Spinner should be created');
            assert.strictEqual(spinner.interval, 80);
            assert.strictEqual(spinner.isSpinning, false);
            assert.strictEqual(spinner.isPaused, false);
        });

        it('should accept custom interval', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream, interval: 120 });

            assert.strictEqual(spinner.interval, 120);
        });

        it('should accept custom style', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream, style: 'line' });

            assert.deepStrictEqual(spinner.frames, ['|', '/', '-', '\\']);
        });

        it('should use dots style by default', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            assert.deepStrictEqual(spinner.frames, ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
        });

        it('should accept showInterruptHint option', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream, showInterruptHint: true });

            assert.strictEqual(spinner.showInterruptHint, true);
        });
    });

    describe('start', () => {
        it('should start spinning', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Testing');

            assert.strictEqual(spinner.isSpinning, true);
            assert.strictEqual(spinner.message, 'Testing');
            assert.ok(spinner.startTime !== null);

            spinner.stop();
        });

        it('should return spinner instance for chaining', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            const result = spinner.start('Test');
            assert.strictEqual(result, spinner);

            spinner.stop();
        });

        it('should not start if already spinning', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            const startTime1 = Date.now();
            spinner.start('First');

            // Small delay
            const startTime2 = Date.now();
            spinner.start('Second');

            assert.strictEqual(spinner.message, 'First'); // Should not change
            spinner.stop();
        });

        it('should hide cursor on start', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            const output = mockStream.getOutput();

            assert.ok(output.includes('\x1b[?25l'), 'Should contain hide cursor sequence');
            spinner.stop();
        });
    });

    describe('stop', () => {
        it('should stop spinning', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            spinner.stop();

            assert.strictEqual(spinner.isSpinning, false);
            assert.strictEqual(spinner.timer, null);
        });

        it('should show cursor on stop', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            mockStream.clearOutput();
            spinner.stop();

            const output = mockStream.getOutput();
            assert.ok(output.includes('\x1b[?25h'), 'Should contain show cursor sequence');
        });

        it('should write final message if provided', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            mockStream.clearOutput();
            spinner.stop('Final message');

            const output = mockStream.getOutput();
            assert.ok(output.includes('Final message'), 'Should contain final message');
        });

        it('should return spinner instance for chaining', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            const result = spinner.stop();

            assert.strictEqual(result, spinner);
        });

        it('should do nothing if not spinning', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            const result = spinner.stop();
            assert.strictEqual(result, spinner);
        });
    });

    describe('update', () => {
        it('should update message while spinning', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Initial');
            spinner.update('Updated');

            assert.strictEqual(spinner.message, 'Updated');
            spinner.stop();
        });

        it('should return spinner instance for chaining', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            const result = spinner.update('New');

            assert.strictEqual(result, spinner);
            spinner.stop();
        });
    });

    describe('succeed', () => {
        it('should stop with success message', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            mockStream.clearOutput();
            spinner.succeed('Done!');

            const output = mockStream.getOutput();
            assert.ok(output.includes('✓'), 'Should contain checkmark');
            assert.ok(output.includes('Done!'), 'Should contain message');
            assert.strictEqual(spinner.isSpinning, false);
        });

        it('should use current message if none provided', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Processing');
            mockStream.clearOutput();
            spinner.succeed();

            const output = mockStream.getOutput();
            assert.ok(output.includes('Processing'), 'Should contain original message');
        });
    });

    describe('fail', () => {
        it('should stop with failure message', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            mockStream.clearOutput();
            spinner.fail('Error occurred');

            const output = mockStream.getOutput();
            assert.ok(output.includes('✗'), 'Should contain X mark');
            assert.ok(output.includes('Error occurred'), 'Should contain message');
            assert.strictEqual(spinner.isSpinning, false);
        });
    });

    describe('info', () => {
        it('should stop with info message', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            mockStream.clearOutput();
            spinner.info('Information');

            const output = mockStream.getOutput();
            assert.ok(output.includes('ℹ'), 'Should contain info symbol');
            assert.ok(output.includes('Information'), 'Should contain message');
            assert.strictEqual(spinner.isSpinning, false);
        });
    });

    describe('pause and resume', () => {
        it('should pause spinning', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            spinner.pause();

            assert.strictEqual(spinner.isPaused, true);
            assert.strictEqual(spinner.isSpinning, true); // Still "spinning" state
            assert.strictEqual(spinner.timer, null);

            spinner.stop();
        });

        it('should resume spinning after pause', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            spinner.pause();
            spinner.resume();

            assert.strictEqual(spinner.isPaused, false);
            assert.strictEqual(spinner.isSpinning, true);
            assert.ok(spinner.timer !== null);

            spinner.stop();
        });

        it('should do nothing if not spinning', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            const result = spinner.pause();
            assert.strictEqual(result, spinner);
            assert.strictEqual(spinner.isPaused, false);
        });

        it('should do nothing if already paused', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.start('Test');
            spinner.pause();
            const result = spinner.pause();

            assert.strictEqual(result, spinner);
            spinner.stop();
        });
    });

    describe('getElapsed', () => {
        it('should return empty string if not started', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            assert.strictEqual(spinner.getElapsed(), '');
        });

        it('should return seconds format for < 60 seconds', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.startTime = Date.now() - 5000; // 5 seconds ago
            const elapsed = spinner.getElapsed();

            assert.ok(elapsed.match(/\(\d+s\)/), 'Should be in (Xs) format');
        });

        it('should return minutes format for >= 60 seconds', () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream });

            spinner.startTime = Date.now() - 90000; // 90 seconds ago
            const elapsed = spinner.getElapsed();

            assert.ok(elapsed.match(/\(\d+m \d+s\)/), 'Should be in (Xm Xs) format');
        });
    });

    describe('createSpinner factory', () => {
        it('should create and start a spinner', () => {
            const mockStream = createMockStream();
            const spinner = createSpinner('Loading', { stream: mockStream });

            assert.ok(spinner instanceof Spinner);
            assert.strictEqual(spinner.isSpinning, true);
            assert.strictEqual(spinner.message, 'Loading');

            spinner.stop();
        });
    });
});

// ============================================================================
// StatusLine Tests
// ============================================================================

describe('StatusLine', () => {
    let StatusLine;

    beforeEach(async () => {
        const module = await import('../src/ui/spinner.mjs');
        StatusLine = module.StatusLine;
    });

    describe('Constructor', () => {
        it('should create status line with default stream', () => {
            const mockStream = createMockStream();
            const status = new StatusLine(mockStream);

            assert.ok(status);
            assert.strictEqual(status.active, false);
        });
    });

    describe('update', () => {
        it('should update message and set active', () => {
            const mockStream = createMockStream();
            const status = new StatusLine(mockStream);

            status.update('Status message');
            const output = mockStream.getOutput();

            assert.strictEqual(status.active, true);
            assert.ok(output.includes('Status message'));
        });

        it('should hide cursor on first update', () => {
            const mockStream = createMockStream();
            const status = new StatusLine(mockStream);

            status.update('Test');
            const output = mockStream.getOutput();

            assert.ok(output.includes('\x1b[?25l'), 'Should contain hide cursor sequence');
        });

        it('should return instance for chaining', () => {
            const mockStream = createMockStream();
            const status = new StatusLine(mockStream);

            const result = status.update('Test');
            assert.strictEqual(result, status);

            status.clear();
        });
    });

    describe('clear', () => {
        it('should clear line and show cursor', () => {
            const mockStream = createMockStream();
            const status = new StatusLine(mockStream);

            status.update('Test');
            mockStream.clearOutput();
            status.clear();

            const output = mockStream.getOutput();
            assert.ok(output.includes('\x1b[?25h'), 'Should contain show cursor sequence');
            assert.strictEqual(status.active, false);
        });

        it('should do nothing if not active', () => {
            const mockStream = createMockStream();
            const status = new StatusLine(mockStream);

            status.clear();
            assert.strictEqual(mockStream.getOutput(), '');
        });
    });

    describe('done', () => {
        it('should write final message and newline', () => {
            const mockStream = createMockStream();
            const status = new StatusLine(mockStream);

            status.update('Processing');
            mockStream.clearOutput();
            status.done('Complete');

            const output = mockStream.getOutput();
            assert.ok(output.includes('Complete'));
            assert.ok(output.includes('\n'));
            assert.strictEqual(status.active, false);
        });

        it('should show cursor after done', () => {
            const mockStream = createMockStream();
            const status = new StatusLine(mockStream);

            status.update('Test');
            mockStream.clearOutput();
            status.done('Done');

            const output = mockStream.getOutput();
            assert.ok(output.includes('\x1b[?25h'), 'Should contain show cursor sequence');
        });
    });
});

// ============================================================================
// Spinner Styles Tests
// ============================================================================

describe('Spinner Styles', () => {
    let Spinner;

    beforeEach(async () => {
        const module = await import('../src/ui/spinner.mjs');
        Spinner = module.Spinner;
    });

    const styles = ['dots', 'line', 'arc', 'circle', 'square', 'bounce', 'pulse', 'arrows', 'clock'];

    for (const style of styles) {
        it(`should support ${style} style`, () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream, style });

            assert.ok(spinner.frames.length > 0, `${style} style should have frames`);
        });
    }

    it('should use dots for unknown style', () => {
        const mockStream = createMockStream();
        const spinner = new Spinner({ stream: mockStream, style: 'unknown' });

        // Should fall back to dots
        assert.deepStrictEqual(spinner.frames, ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
    });
});

// ============================================================================
// Spinner Colors Tests
// ============================================================================

describe('Spinner Colors', () => {
    let Spinner;

    beforeEach(async () => {
        const module = await import('../src/ui/spinner.mjs');
        Spinner = module.Spinner;
    });

    const colors = ['cyan', 'yellow', 'green', 'blue', 'magenta'];

    for (const color of colors) {
        it(`should support ${color} color`, () => {
            const mockStream = createMockStream();
            const spinner = new Spinner({ stream: mockStream, color });

            assert.ok(spinner.color !== undefined, `${color} color should be set`);
            assert.ok(spinner.color.startsWith('\x1b['), `${color} should be ANSI escape code`);
        });
    }

    it('should use cyan for unknown color', () => {
        const mockStream = createMockStream();
        const spinner = new Spinner({ stream: mockStream, color: 'unknown' });

        // Should fall back to cyan
        assert.strictEqual(spinner.color, '\x1b[36m');
    });
});

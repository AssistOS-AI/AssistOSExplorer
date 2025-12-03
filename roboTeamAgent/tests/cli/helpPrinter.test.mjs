/**
 * Tests for HelpPrinter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('HelpPrinter', () => {
    it('should export printHelp function', async () => {
        const { printHelp } = await import('../src/ui/HelpPrinter.mjs');
        assert.strictEqual(typeof printHelp, 'function');
    });

    it('should export showHistory function', async () => {
        const { showHistory } = await import('../src/ui/HelpPrinter.mjs');
        assert.strictEqual(typeof showHistory, 'function');
    });

    it('should export searchHistory function', async () => {
        const { searchHistory } = await import('../src/ui/HelpPrinter.mjs');
        assert.strictEqual(typeof searchHistory, 'function');
    });
});

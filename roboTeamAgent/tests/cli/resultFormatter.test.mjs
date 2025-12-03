/**
 * Tests for ResultFormatter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('ResultFormatter', () => {
    it('should format string results', async () => {
        const { formatSlashResult } = await import('../src/ui/ResultFormatter.mjs');

        const result = formatSlashResult('test result');
        assert.strictEqual(result, 'test result');
    });

    it('should format object results as JSON', async () => {
        const { formatSlashResult } = await import('../src/ui/ResultFormatter.mjs');

        const result = formatSlashResult({ key: 'value' });
        assert.ok(result.includes('key'));
        assert.ok(result.includes('value'));
    });

    it('should summarize orchestrator results', async () => {
        const { summarizeResult } = await import('../src/ui/ResultFormatter.mjs');

        const orchestratorResult = {
            type: 'orchestrator',
            executions: [
                { skill: 'test-skill', status: 'success', result: 'test output' }
            ]
        };

        const summary = summarizeResult(orchestratorResult);
        assert.ok(summary, 'Should return a summary');
    });
});

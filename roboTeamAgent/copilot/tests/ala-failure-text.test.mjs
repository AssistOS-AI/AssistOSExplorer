import test from 'node:test';
import assert from 'node:assert/strict';
import { alaFailureText } from '../src/lib/execution/alaEngine.mjs';

test('an ALA failure names ALA\'s own error lines and leaves launch diagnostics to the log', () => {
    const diagnostics = '[RoboWork] preparing run\nNo interfaces with usable IPv6 routes\nUnable to set pasta-prefixed hostname\n'
        + 'ala: OpenCode session failed: Usage limit reached for 5 hour. [reason: free usage limit error, HTTP 429]\n';
    assert.equal(alaFailureText(5, diagnostics),
        'ALA execution failed (5): OpenCode session failed: Usage limit reached for 5 hour. [reason: free usage limit error, HTTP 429]');
});

test('without an ALA error line every diagnostic is kept', () => {
    assert.equal(alaFailureText(7, 'first\n\nsecond\n'), 'ALA execution failed (7).\nfirst\nsecond');
    assert.equal(alaFailureText(7, ''), 'ALA execution failed (7).');
});

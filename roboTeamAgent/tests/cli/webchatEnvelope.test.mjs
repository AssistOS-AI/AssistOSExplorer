import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeWebchatMessage,
    normalizeWebchatReferences
} from '../achilles-cli/src/lib/webchatEnvelope.mjs';

describe('webchat envelope helpers', () => {
    it('normalizes WebChat envelopes without exposing raw JSON to prompts', () => {
        const message = normalizeWebchatMessage(JSON.stringify({
            __webchatMessage: 1,
            version: 1,
            text: '@open-interpreter summarize',
            attachments: [{ filename: 'notes.md', mime: 'text/markdown', localPath: 'shared/blob-1' }],
            invocation: { token: 'caller-token' },
        }));
        assert.equal(message.rawText, '@open-interpreter summarize');
        assert.match(message.text, /Attachments:/);
        assert.equal(message.attachments.length, 1);
        assert.equal(message.invocationToken, 'caller-token');
    });

    it('preserves @open-interpreter as ordinary message text', () => {
        const message = normalizeWebchatMessage('@open-interpreter list primes');
        assert.equal(message.rawText, '@open-interpreter list primes');
        assert.equal(message.text, '@open-interpreter list primes');
        assert.deepEqual(message.references, []);
    });

    it('keeps only safe workspace-path references', () => {
        assert.deepEqual(normalizeWebchatReferences([
            { kind: 'workspace-path', path: 'docs/notes.md', type: 'file', label: 'Notes' },
            { kind: 'workspace-path', path: '../escape.md' },
            { kind: 'workspace-path', path: '/etc/passwd' },
            { kind: 'workspace-path', path: 'docs/.secrets' },
            { kind: 'workspace-path', path: 'with\0nul' },
            { kind: 'unknown', path: 'docs/other.md' },
        ]), [{
            kind: 'workspace-path',
            path: 'docs/notes.md',
            type: 'file',
            label: 'Notes',
        }]);
    });
});

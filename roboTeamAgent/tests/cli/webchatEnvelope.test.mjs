import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeWebchatMessage,
    normalizeWebchatOrigin,
    normalizeWebchatReferences
} from '../roboTeamAgent/copilot/src/lib/webchatEnvelope.mjs';

describe('webchat envelope helpers', () => {
    it('normalizes WebChat envelopes without exposing raw JSON to prompts', () => {
        const message = normalizeWebchatMessage(JSON.stringify({
            __webchatMessage: 1,
            version: 1,
            text: '@execution-worker summarize',
            attachments: [{ filename: 'notes.md', mime: 'text/markdown', localPath: 'shared/blob-1' }],
            origin: { publicBaseUrl: 'http://127.0.0.1:8080/webchat?agent=achilles-cli' },
            invocation: { token: 'caller-token' },
        }));
        assert.equal(message.rawText, '@execution-worker summarize');
        assert.match(message.text, /Attachments:/);
        assert.equal(message.attachments.length, 1);
        assert.equal(message.invocationToken, 'caller-token');
        assert.deepEqual(message.origin, { publicBaseUrl: 'http://127.0.0.1:8080' });
    });

    it('preserves @execution-worker as ordinary message text', () => {
        const message = normalizeWebchatMessage('@execution-worker list primes');
        assert.equal(message.rawText, '@execution-worker list primes');
        assert.equal(message.text, '@execution-worker list primes');
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

    it('normalizes only http or https WebChat public origins', () => {
        assert.deepEqual(normalizeWebchatOrigin({
            publicBaseUrl: 'https://workspace.example.test/webchat?agent=achilles-cli'
        }), { publicBaseUrl: 'https://workspace.example.test' });
        assert.deepEqual(normalizeWebchatOrigin({
            publicBaseUrl: 'javascript:alert(1)',
            origin: 'ftp://example.test',
        }), {});
    });
});

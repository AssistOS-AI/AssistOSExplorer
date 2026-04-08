import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BroadcastHub } from '../../observability/broadcast-hub.mjs';
import {
    redactLogEntry,
    redactPayload,
} from '../../observability/redaction.mjs';
import { deriveSessionGrouping } from '../../observability/session-grouper.mjs';

describe('BroadcastHub', () => {
    function createMockAppCtx() {
        return { log: { debug() {}, info() {}, warn() {}, error() {} } };
    }

    it('tracks subscriber count', () => {
        const hub = new BroadcastHub(createMockAppCtx());
        const mockStream = {
            onClose(fn) {
                this._cleanup = fn;
            },
            send() {},
            comment() {},
            close() {},
        };
        const id = hub.addSseSubscriber(mockStream, {});
        assert.equal(hub.subscriberCount, 1);

        // Simulate close
        mockStream._cleanup();
        assert.equal(hub.subscriberCount, 0);
    });

    it('filters by soul_id', () => {
        const hub = new BroadcastHub(createMockAppCtx());
        const received = [];
        const mockStream = {
            onClose() {},
            send(event, data) {
                received.push(JSON.parse(data));
            },
            comment() {},
            close() {},
        };

        hub.addSseSubscriber(mockStream, { soul_id: 'user-1' });

        // Matching log
        hub.publish({
            soul_id: 'user-1',
            requested_model: 'gpt-4',
            status: 'succeeded',
        });
        // Non-matching log
        hub.publish({
            soul_id: 'user-2',
            requested_model: 'gpt-4',
            status: 'succeeded',
        });

        assert.equal(received.length, 1);
        assert.equal(received[0].soul_id, 'user-1');
    });

    it('filters by model', () => {
        const hub = new BroadcastHub(createMockAppCtx());
        const received = [];
        const mockStream = {
            onClose() {},
            send(event, data) {
                received.push(JSON.parse(data));
            },
            comment() {},
            close() {},
        };

        hub.addSseSubscriber(mockStream, { model: 'gpt-4' });

        hub.publish({
            soul_id: 'u1',
            requested_model: 'gpt-4',
            status: 'succeeded',
        });
        hub.publish({
            soul_id: 'u1',
            requested_model: 'claude-3',
            status: 'succeeded',
        });

        assert.equal(received.length, 1);
    });

    it('redacts payloads in normal stream', () => {
        const hub = new BroadcastHub(createMockAppCtx());
        const received = [];
        const mockStream = {
            onClose() {},
            send(event, data) {
                received.push(JSON.parse(data));
            },
            comment() {},
            close() {},
        };

        hub.addSseSubscriber(mockStream, {}); // normal, not soul-specific

        hub.publish({
            soul_id: 'u1',
            requested_model: 'gpt-4',
            status: 'succeeded',
            request_payload: {
                messages: [{ role: 'user', content: 'secret' }],
            },
            response_payload: { content: 'answer' },
            request_headers: { authorization: 'Bearer sk-xxx' },
        });

        assert.equal(received.length, 1);
        assert.equal(
            received[0].request_payload,
            undefined,
            'should redact request_payload'
        );
        assert.equal(
            received[0].response_payload,
            undefined,
            'should redact response_payload'
        );
        assert.equal(
            received[0].request_headers,
            undefined,
            'should redact request_headers'
        );
    });

    it('sends full payload on soul-specific stream', () => {
        const hub = new BroadcastHub(createMockAppCtx());
        const received = [];
        const mockStream = {
            onClose() {},
            send(event, data) {
                received.push(JSON.parse(data));
            },
            comment() {},
            close() {},
        };

        hub.addSseSubscriber(mockStream, { soul_id: 'u1' }, true); // soul-specific

        hub.publish({
            soul_id: 'u1',
            requested_model: 'gpt-4',
            status: 'succeeded',
            request_payload: { messages: [] },
            response_payload: { content: 'answer' },
            request_headers: {},
        });

        assert.equal(received.length, 1);
        assert.ok(
            received[0].request_payload,
            'should include request_payload'
        );
        assert.ok(
            received[0].response_payload,
            'should include response_payload'
        );
    });
});

describe('redactLogEntry', () => {
    it('removes sensitive fields', () => {
        const entry = {
            log_id: '1',
            soul_id: 'u1',
            request_payload: { messages: [] },
            response_payload: { content: 'x' },
            request_headers: { auth: 'bearer' },
            response_excerpt: 'first 100 chars...',
        };

        const redacted = redactLogEntry(entry);
        assert.equal(redacted.log_id, '1');
        assert.equal(redacted.soul_id, 'u1');
        assert.equal(redacted.response_excerpt, 'first 100 chars...');
        assert.equal(redacted.request_payload, undefined);
        assert.equal(redacted.response_payload, undefined);
        assert.equal(redacted.request_headers, undefined);
    });
});

describe('redactPayload', () => {
    it('truncates long text', () => {
        const text = 'a'.repeat(3000);
        const { excerpt, full } = redactPayload(text, 100);
        assert.equal(excerpt.length, 103); // 100 + '...'
        assert.equal(full.length, 3000);
    });

    it('keeps short text as-is', () => {
        const { excerpt } = redactPayload('hello', 100);
        assert.equal(excerpt, 'hello');
    });

    it('handles null', () => {
        const { excerpt } = redactPayload(null);
        assert.equal(excerpt, null);
    });
});

describe('deriveSessionGrouping', () => {
    it('uses explicit session ID when provided', () => {
        const result = deriveSessionGrouping({
            apiKeyId: 'key-1',
            agentName: 'claude-code',
            soulId: 'user-1',
            explicitSessionId: 'sess-abc',
        });
        assert.equal(result.groupKey, 'explicit:sess-abc');
        assert.ok(result.groupDisplay.includes('sess-abc'));
    });

    it('derives implicit grouping from key + agent', () => {
        const result = deriveSessionGrouping({
            apiKeyId: 'key-12345678-abcd',
            agentName: 'cursor',
            soulId: null,
            explicitSessionId: null,
        });
        assert.ok(result.groupKey.startsWith('implicit:'));
        assert.ok(result.groupKey.includes('key-12345678-abcd'));
        assert.ok(result.groupKey.includes('cursor'));
        assert.ok(result.groupDisplay.includes('cursor'));
    });

    it('handles missing fields gracefully', () => {
        const result = deriveSessionGrouping({});
        assert.ok(result.groupKey.includes('unknown'));
    });
});

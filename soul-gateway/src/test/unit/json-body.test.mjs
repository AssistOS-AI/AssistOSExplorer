import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readJsonBody } from '../../core/json-body.mjs';
import {
    BadRequestError,
    PayloadTooLargeError,
} from '../../core/errors.mjs';

function mockReq(body) {
    const readable = new Readable({ read() {} });
    if (body !== null) {
        readable.push(typeof body === 'string' ? body : JSON.stringify(body));
    }
    readable.push(null);
    return readable;
}

describe('readJsonBody', () => {
    it('parses valid JSON', async () => {
        const body = await readJsonBody(
            mockReq({ model: 'gpt-4', messages: [] })
        );
        assert.equal(body.model, 'gpt-4');
        assert.deepEqual(body.messages, []);
    });

    it('returns null for empty body', async () => {
        const body = await readJsonBody(mockReq(null));
        assert.equal(body, null);
    });

    it('rejects invalid JSON', async () => {
        await assert.rejects(
            readJsonBody(mockReq('not json')),
            (err) =>
                err instanceof BadRequestError &&
                err.message.includes('Invalid JSON')
        );
    });

    it('rejects oversized body', async () => {
        const req = new EventEmitter();
        let destroyed = false;
        req.destroy = () => {
            destroyed = true;
        };
        const result = readJsonBody(req, 50);
        req.emit('data', Buffer.from('x'.repeat(100)));
        req.emit('data', Buffer.from('discarded after the limit'));
        req.emit('end');

        await assert.rejects(
            result,
            (err) =>
                err instanceof PayloadTooLargeError &&
                err.httpStatus === 413 &&
                err.errorType === 'payload_too_large' &&
                err.detail.limit_bytes === 50 &&
                err.message.includes('Reduce the request size')
        );
        assert.equal(destroyed, false);
    });
});

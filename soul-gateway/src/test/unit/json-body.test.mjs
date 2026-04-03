import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJsonBody } from '../../core/json-body.mjs';
import { BadRequestError } from '../../core/errors.mjs';

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
    const body = await readJsonBody(mockReq({ model: 'gpt-4', messages: [] }));
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
      (err) => err instanceof BadRequestError && err.message.includes('Invalid JSON')
    );
  });

  it('rejects oversized body', async () => {
    const huge = 'x'.repeat(100);
    await assert.rejects(
      readJsonBody(mockReq(huge), 50),
      (err) => err instanceof BadRequestError && err.message.includes('exceeds')
    );
  });
});

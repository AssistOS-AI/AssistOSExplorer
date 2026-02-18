import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSEStream, formatSSE } from '../../utils/sse-parser.mjs';

describe('sse-parser', () => {
  describe('parseSSEStream', () => {
    async function collect(chunks) {
      const frames = [];
      // Create an async iterable from string chunks
      async function* gen() {
        for (const c of chunks) yield c;
      }
      for await (const frame of parseSSEStream(gen())) {
        frames.push(frame);
      }
      return frames;
    }

    it('parses a single JSON data frame', async () => {
      const frames = await collect([
        'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n',
      ]);
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0].parsedData.id, '1');
    });

    it('parses [DONE] as done frame', async () => {
      const frames = await collect(['data: [DONE]\n\n']);
      assert.equal(frames.length, 1);
      assert.equal(frames[0].done, true);
      assert.equal(frames[0].parsedData, null);
    });

    it('parses multiple frames', async () => {
      const frames = await collect([
        'data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n',
      ]);
      assert.equal(frames.length, 3);
      assert.equal(frames[0].parsedData.n, 1);
      assert.equal(frames[1].parsedData.n, 2);
      assert.equal(frames[2].done, true);
    });

    it('handles chunked delivery (split across chunks)', async () => {
      const frames = await collect([
        'data: {"n"',
        ':1}\n\ndata: [DONE]\n\n',
      ]);
      assert.equal(frames.length, 2);
      assert.equal(frames[0].parsedData.n, 1);
    });

    it('parses event field', async () => {
      const frames = await collect([
        'event: custom\ndata: {"x":1}\n\n',
      ]);
      assert.equal(frames[0].event, 'custom');
    });

    it('parses id field', async () => {
      const frames = await collect([
        'id: msg-42\ndata: {"x":1}\n\n',
      ]);
      assert.equal(frames[0].id, 'msg-42');
    });

    it('parses retry field', async () => {
      const frames = await collect([
        'retry: 5000\ndata: {"x":1}\n\n',
      ]);
      assert.equal(frames[0].retry, 5000);
    });

    it('handles multiline data', async () => {
      const frames = await collect([
        'data: line1\ndata: line2\n\n',
      ]);
      assert.equal(frames[0].data, 'line1\nline2');
    });

    it('handles empty data field', async () => {
      const frames = await collect([
        'data:\n\n',
      ]);
      assert.equal(frames[0].data, '');
    });

    it('handles non-JSON data gracefully', async () => {
      const frames = await collect([
        'data: not json\n\n',
      ]);
      assert.equal(frames[0].data, 'not json');
      assert.equal(frames[0].parsedData, null);
    });

    it('processes remaining buffer', async () => {
      // No trailing \n\n — data is in the remaining buffer
      const frames = await collect([
        'data: {"leftover":true}',
      ]);
      assert.equal(frames.length, 1);
      assert.equal(frames[0].parsedData.leftover, true);
    });
  });

  describe('formatSSE', () => {
    it('formats string data', () => {
      const result = formatSSE('[DONE]');
      assert.equal(result, 'data: [DONE]\n\n');
    });

    it('formats object data as JSON', () => {
      const result = formatSSE({ id: 1 });
      assert.equal(result, 'data: {"id":1}\n\n');
    });

    it('includes event prefix', () => {
      const result = formatSSE('test', 'ping');
      assert.equal(result, 'event: ping\ndata: test\n\n');
    });
  });
});

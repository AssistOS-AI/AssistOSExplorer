import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { matchPath, parseUrl, readBody, sendJson, corsHeaders, handleCors } from '../../utils/http-helpers.mjs';

describe('http-helpers', () => {
  describe('matchPath', () => {
    it('matches exact static path', () => {
      const result = matchPath('/api/v1/models', '/api/v1/models');
      assert.deepEqual(result, {});
    });

    it('extracts a single param', () => {
      const result = matchPath('/api/v1/soul-families/:id', '/api/v1/soul-families/abc-123');
      assert.deepEqual(result, { id: 'abc-123' });
    });

    it('extracts multiple params', () => {
      const result = matchPath('/api/:version/:resource/:id', '/api/v1/models/xyz');
      assert.deepEqual(result, { version: 'v1', resource: 'models', id: 'xyz' });
    });

    it('returns null on segment count mismatch', () => {
      assert.equal(matchPath('/api/v1', '/api/v1/extra'), null);
    });

    it('returns null on literal mismatch', () => {
      assert.equal(matchPath('/api/v1/models', '/api/v1/keys'), null);
    });

    it('decodes URI components', () => {
      const result = matchPath('/files/:name', '/files/hello%20world');
      assert.deepEqual(result, { name: 'hello world' });
    });
  });

  describe('parseUrl', () => {
    it('extracts pathname and query', () => {
      const req = { url: '/api/v1/logs?limit=10&offset=0', headers: { host: 'localhost' } };
      const { pathname, query } = parseUrl(req);
      assert.equal(pathname, '/api/v1/logs');
      assert.equal(query.limit, '10');
      assert.equal(query.offset, '0');
    });

    it('handles paths without query', () => {
      const req = { url: '/health', headers: { host: 'localhost' } };
      const { pathname, query } = parseUrl(req);
      assert.equal(pathname, '/health');
      assert.deepEqual(query, {});
    });
  });

  describe('readBody', () => {
    it('reads full body from stream', async () => {
      const stream = Readable.from([Buffer.from('hello'), Buffer.from(' world')]);
      // Add event-emitter style compatibility
      const req = Object.assign(stream, { headers: {} });
      const body = await readBody(req);
      assert.equal(body, 'hello world');
    });
  });

  describe('corsHeaders', () => {
    it('returns CORS headers with wildcard origin', () => {
      const h = corsHeaders();
      assert.equal(h['Access-Control-Allow-Origin'], '*');
      assert.ok(h['Access-Control-Allow-Methods'].includes('GET'));
      assert.ok(h['Access-Control-Allow-Headers'].includes('Authorization'));
    });
  });

  describe('handleCors', () => {
    it('responds to OPTIONS and returns true', () => {
      let headStatus, headHeaders, ended = false;
      const req = { method: 'OPTIONS' };
      const res = {
        writeHead(s, h) { headStatus = s; headHeaders = h; },
        end() { ended = true; },
      };
      const result = handleCors(req, res);
      assert.equal(result, true);
      assert.equal(headStatus, 204);
      assert.equal(ended, true);
    });

    it('returns false for non-OPTIONS', () => {
      const req = { method: 'GET' };
      const res = {};
      assert.equal(handleCors(req, res), false);
    });
  });

  describe('sendJson', () => {
    it('sends JSON with correct headers', () => {
      let headStatus, headHeaders, body;
      const res = {
        writeHead(s, h) { headStatus = s; headHeaders = h; },
        end(b) { body = b; },
      };
      sendJson(res, { ok: true }, 201);
      assert.equal(headStatus, 201);
      assert.equal(headHeaders['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(body), { ok: true });
    });
  });
});

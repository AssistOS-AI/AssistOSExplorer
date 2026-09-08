import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { probeEgressEndpoints } from '../scripts/health/egress-semantic-health.mjs';

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function url(server) {
  return `http://127.0.0.1:${server.address().port}/`;
}

test('semantic probe distinguishes pinned Egress health and template endpoints', async () => {
  const health = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"CpuLoad":4}');
  });
  const template = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<title>LiveKit Egress</title>');
  });
  try {
    assert.deepEqual(await probeEgressEndpoints({ healthUrl: url(health), templateUrl: url(template) }), {
      health: { cpuLoad: 4 },
      template: { bytes: 29 },
    });
    await assert.rejects(
      probeEgressEndpoints({ healthUrl: url(template), templateUrl: url(health) }),
      /health endpoint returned non-JSON/,
    );
  } finally {
    await close(health);
    await close(template);
  }
});

test('semantic probe rejects invalid health JSON and an unrelated HTML server', async () => {
  const health = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const template = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>unrelated</title>');
  });
  try {
    await assert.rejects(
      probeEgressEndpoints({ healthUrl: url(health), templateUrl: url(template) }),
      /finite non-negative CpuLoad/,
    );
  } finally {
    await close(health);
    await close(template);
  }
});

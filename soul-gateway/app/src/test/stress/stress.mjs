#!/usr/bin/env node

/**
 * Stress test harness for Soul Gateway.
 *
 * Standalone CLI script. Starts a mock upstream, boots the server in test mode,
 * then fires configurable concurrent request patterns and reports latency/throughput.
 *
 * Usage:
 *   node src/test/stress/stress.mjs              # run all scenarios
 *   node src/test/stress/stress.mjs baseline      # run single scenario
 */

import { createServer } from 'node:http';

// ──────────────────────────────────────────────────────────────
// Inline mock upstream — must start BEFORE any server module load
// ──────────────────────────────────────────────────────────────

let mockLatencyMs = 0;

const NON_STREAM_RESPONSE = {
  id: 'chatcmpl-stress-001',
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Stress test response.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
};

const STREAM_CHUNKS = [
  { id: 'chatcmpl-stress-s', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  { id: 'chatcmpl-stress-s', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Stress' }, finish_reason: null }] },
  { id: 'chatcmpl-stress-s', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: ' response.' }, finish_reason: null }] },
  { id: 'chatcmpl-stress-s', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
];

function buildSSE(chunks) {
  let out = '';
  for (const chunk of chunks) out += `data: ${JSON.stringify(chunk)}\n\n`;
  out += 'data: [DONE]\n\n';
  return out;
}

const mockServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }

  if (mockLatencyMs > 0) await new Promise(r => setTimeout(r, mockLatencyMs));

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    if (body?.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.end(buildSSE(STREAM_CHUNKS));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(NON_STREAM_RESPONSE));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'not_found', message: 'Not found' } }));
});

const mockPort = await new Promise(resolve =>
  mockServer.listen(0, '127.0.0.1', () => resolve(mockServer.address().port))
);

// ──────────────────────────────────────────────────────────────
// Set env vars BEFORE any server module is imported
// ──────────────────────────────────────────────────────────────

process.env.OPENAI_MOCK_URL = `http://127.0.0.1:${mockPort}/v1/chat/completions`;
process.env.OPENAI_MOCK_KEY = 'stress-test-key';
process.env.LOG_LEVEL = 'critical';

// ──────────────────────────────────────────────────────────────
// Dynamic imports (triggers achillesAgentLib loadModelsConfiguration
// which now picks up the "mock" provider from env vars)
// ──────────────────────────────────────────────────────────────

const { config } = await import('../../config.mjs');

// Pre-seed config BEFORE test-setup runs (test-setup will overwrite some)
const TEST_SCHEMA = 'soul_gateway_stress';
const TEST_ENCRYPTION_KEY = 'a'.repeat(64);
const TEST_DASHBOARD_PASSWORD = 'stress-test-pw';

config.pgSchema = TEST_SCHEMA;
config.encryptionKey = TEST_ENCRYPTION_KEY;
config.dashboardPassword = TEST_DASHBOARD_PASSWORD;
config.defaultProxyApiKey = '';
config.maxRetries = 0;

// Import pg for DB setup (we manage DB ourselves to avoid test-setup overriding config)
const pg = (await import('pg')).default;
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');
const { createAppServer } = await import('../../server.mjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', 'db', 'schema.sql');

let pool;
let server;
let serverPort;

function getPool() {
  if (!pool) pool = new pg.Pool({ max: 5 });
  return pool;
}

async function setupDb() {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);

    let ddl = readFileSync(SCHEMA_PATH, 'utf8');
    ddl = ddl.replace(/soul_gateway/g, TEST_SCHEMA);
    await client.query(ddl);

    await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
    const now = new Date();
    for (let i = -1; i < 2; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const next = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const name = `call_logs_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
      try {
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF call_logs
           FOR VALUES FROM ('${d.toISOString().slice(0, 10)}') TO ('${next.toISOString().slice(0, 10)}')`
        );
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('overlap')) throw err;
      }
    }
  } finally {
    client.release();
  }
}

async function teardownDb() {
  const p = getPool();
  await p.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await p.end();
  pool = null;
}

async function startServer() {
  server = createAppServer();
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

async function stopServer() {
  if (!server) return;
  return new Promise(resolve => server.close(() => { server = null; resolve(); }));
}

function baseUrl() { return `http://127.0.0.1:${serverPort}`; }

// ──────────────────────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────────────────────

let sessionCookie = null;

async function login() {
  const res = await fetch(`${baseUrl()}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(TEST_DASHBOARD_PASSWORD)}`,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) sessionCookie = setCookie.split(';')[0];
}

async function apiPost(path, body) {
  return fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify(body),
  });
}

async function apiPut(path, body) {
  return fetch(`${baseUrl()}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify(body),
  });
}

async function chatCompletions(body, apiKey) {
  return fetch(`${baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
}

// ──────────────────────────────────────────────────────────────
// Scenario runner
// ──────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

async function runScenario({ name, concurrency, totalRequests, setup, buildRequest }) {
  if (setup) await setup();

  const results = [];
  let completed = 0;
  let nextIdx = 0;
  const startTime = Date.now();

  await new Promise(resolve => {
    function launch() {
      while (nextIdx < totalRequests && (nextIdx - completed) < concurrency) {
        const idx = nextIdx++;
        const reqStart = Date.now();
        const { body, apiKey } = buildRequest(idx);

        chatCompletions(body, apiKey).then(async res => {
          const latency = Date.now() - reqStart;
          // Consume body to free socket
          if (res.headers.get('content-type')?.includes('text/event-stream')) {
            await res.text();
          } else {
            try { await res.json(); } catch { await res.text().catch(() => {}); }
          }
          results.push({ status: res.status, latency });
          completed++;
          if (completed >= totalRequests) return resolve();
          launch();
        }).catch(err => {
          results.push({ status: 0, latency: Date.now() - reqStart, error: err.message });
          completed++;
          if (completed >= totalRequests) return resolve();
          launch();
        });
      }
    }
    launch();
  });

  const duration = Date.now() - startTime;
  const latencies = results.map(r => r.latency).sort((a, b) => a - b);

  // Aggregate status codes
  const statusCounts = {};
  for (const r of results) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }

  const statusStr = Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(' ');

  console.log(`\n=== ${name} (${totalRequests} req, concurrency=${concurrency}) ===`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s | Throughput: ${Math.round(totalRequests / (duration / 1000))} req/s`);
  console.log(`Latency p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms p99=${percentile(latencies, 99)}ms`);
  console.log(`Status: ${statusStr}`);

  return { name, duration, results, statusCounts };
}

// ──────────────────────────────────────────────────────────────
// Setup: create family, model, API key
// ──────────────────────────────────────────────────────────────

let defaultApiKey;
let defaultFamilyId;

async function seedDefaults() {
  await login();

  // Create a family with high RPM (no rate-limit interference)
  const famRes = await apiPost('/api/v1/soul-families', {
    name: 'stress-family',
    description: 'Stress test family',
    rpm_limit: 10000,
    tpm_limit: 10000000,
    loop_rpm_limit: 10000,
    loop_max_identical: 10000,
  });
  const family = await famRes.json();
  defaultFamilyId = family.id;

  // Raise loop detector thresholds (createFamily doesn't include these columns)
  await apiPut(`/api/v1/soul-families/${family.id}`, {
    loop_rpm_limit: 10000,
    loop_max_identical: 10000,
  });

  // Create model pointing to mock provider
  await apiPost('/api/v1/models', {
    name: 'stress-model',
    provider_key: 'mock',
    provider_model: 'mock-model',
    mode: 'deep',
    input_price: 5,
    output_price: 25,
  });

  // Create API key
  const keyRes = await apiPost('/api/v1/keys', {
    family_id: family.id,
    label: 'stress-key',
  });
  const keyBody = await keyRes.json();
  defaultApiKey = keyBody.key;
}

// ──────────────────────────────────────────────────────────────
// Scenario definitions
// ──────────────────────────────────────────────────────────────

const scenarios = {
  baseline: {
    name: 'baseline',
    concurrency: 20,
    totalRequests: 200,
    buildRequest: (idx) => ({
      body: { model: 'stress-model', messages: [{ role: 'user', content: `baseline-${idx}-${Date.now()}` }], stream: false },
      apiKey: defaultApiKey,
    }),
  },

  streaming: {
    name: 'streaming',
    concurrency: 20,
    totalRequests: 200,
    buildRequest: (idx) => ({
      body: { model: 'stress-model', messages: [{ role: 'user', content: `stream-${idx}-${Date.now()}` }], stream: true },
      apiKey: defaultApiKey,
    }),
  },

  'multi-model': {
    name: 'multi-model',
    concurrency: 20,
    totalRequests: 200,
    setup: async () => {
      for (let i = 2; i <= 3; i++) {
        await apiPost('/api/v1/models', {
          name: `stress-model-${i}`,
          provider_key: 'mock',
          provider_model: 'mock-model',
          mode: 'deep',
          input_price: 3,
          output_price: 15,
        });
      }
    },
    buildRequest: (idx) => {
      const models = ['stress-model', 'stress-model-2', 'stress-model-3'];
      return {
        body: { model: models[idx % 3], messages: [{ role: 'user', content: `multi-${idx}-${Date.now()}` }], stream: false },
        apiKey: defaultApiKey,
      };
    },
  },

  'slow-upstream': {
    name: 'slow-upstream',
    concurrency: 10,
    totalRequests: 50,
    setup: async () => { mockLatencyMs = 500; },
    buildRequest: (idx) => ({
      body: { model: 'stress-model', messages: [{ role: 'user', content: `slow-${idx}-${Date.now()}` }], stream: false },
      apiKey: defaultApiKey,
    }),
  },

  'pool-pressure': {
    name: 'pool-pressure',
    concurrency: 50,
    totalRequests: 100,
    setup: async () => { mockLatencyMs = 0; },
    buildRequest: (idx) => ({
      body: { model: 'stress-model', messages: [{ role: 'user', content: `pool-${idx}-${Date.now()}` }], stream: false },
      apiKey: defaultApiKey,
    }),
  },

  'rate-limit': (() => {
    let rlApiKey;
    return {
      name: 'rate-limit',
      concurrency: 80,
      totalRequests: 80,
      setup: async () => {
        mockLatencyMs = 0;
        // Create a family with RPM=60
        const famRes = await apiPost('/api/v1/soul-families', {
          name: 'rate-limit-family-' + Date.now(),
          description: 'Low RPM family',
          rpm_limit: 60,
          tpm_limit: 10000000,
        });
        const family = await famRes.json();
        const keyRes = await apiPost('/api/v1/keys', { family_id: family.id, label: 'rl-key' });
        rlApiKey = (await keyRes.json()).key;
      },
      buildRequest: (idx) => ({
        body: { model: 'stress-model', messages: [{ role: 'user', content: `rl-${idx}-${Date.now()}` }], stream: false },
        apiKey: rlApiKey,
      }),
    };
  })(),
};

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

const requestedScenario = process.argv[2];

if (requestedScenario && !scenarios[requestedScenario]) {
  console.error(`Unknown scenario: "${requestedScenario}". Available: ${Object.keys(scenarios).join(', ')}`);
  process.exit(1);
}

console.log('Setting up stress test environment...');

try {
  await setupDb();
  await startServer();
  await seedDefaults();

  const toRun = requestedScenario ? [scenarios[requestedScenario]] : Object.values(scenarios);

  for (const scenario of toRun) {
    // Reset mock latency between scenarios (unless scenario.setup overrides it)
    mockLatencyMs = 0;
    await runScenario(scenario);
  }

  console.log('\nAll scenarios complete.');
} catch (err) {
  console.error('Stress test failed:', err);
  process.exitCode = 1;
} finally {
  await stopServer();
  await teardownDb().catch(() => {});
  mockServer.close();
}

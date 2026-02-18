/**
 * Test environment setup: config overrides, DB schema lifecycle, server start/stop.
 */
import { config } from '../../config.mjs';
import { TEST_ENCRYPTION_KEY, TEST_DASHBOARD_PASSWORD, TEST_SCHEMA } from './fixtures.mjs';

// --- Config overrides (mutate before any server modules import config) ---
config.pgSchema = TEST_SCHEMA;
config.encryptionKey = TEST_ENCRYPTION_KEY;
config.dashboardPassword = TEST_DASHBOARD_PASSWORD;
config.defaultProxyApiKey = '';
config.maxRetries = 0;          // No retries in tests (faster)
config.slowRequestMs = 100;     // Lower threshold for testing
config.largePromptTokens = 100; // Lower threshold for testing

// Silence logs during tests
process.env.LOG_LEVEL = 'critical';

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAppServer } from '../../server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', 'db', 'schema.sql');

let pool;
let server;
let serverPort;

export function getTestPool() {
  if (!pool) {
    pool = new pg.Pool({ max: 5 });
  }
  return pool;
}

/**
 * Create test schema, run DDL, create partitions for current month.
 */
export async function setupDb() {
  const p = getTestPool();
  // Use a single client for the whole setup to keep search_path consistent
  const client = await p.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);

    // Run schema DDL
    let ddl = readFileSync(SCHEMA_PATH, 'utf8');
    // Replace the default schema name with test schema
    ddl = ddl.replace(/soul_gateway/g, TEST_SCHEMA);
    await client.query(ddl);

    // Create partitions for current month
    await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
    const now = new Date();
    for (let i = -1; i < 2; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const next = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const name = `call_logs_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
      const from = d.toISOString().slice(0, 10);
      const to = next.toISOString().slice(0, 10);
      try {
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF call_logs
           FOR VALUES FROM ('${from}') TO ('${to}')`
        );
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('overlap')) {
          throw err;
        }
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Drop test schema entirely.
 */
export async function teardownDb() {
  const p = getTestPool();
  await p.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await p.end();
  pool = null;
}

/**
 * Clear all data from test tables (faster than recreate).
 */
export async function clearDb() {
  const p = getTestPool();
  await p.query(`SET search_path TO ${TEST_SCHEMA}, public`);
  await p.query('DELETE FROM call_logs');
  await p.query('DELETE FROM api_keys');
  await p.query('DELETE FROM blacklist_rules');
  await p.query('DELETE FROM rate_limit_state');
  await p.query('DELETE FROM model_configs');
  await p.query('DELETE FROM soul_families');
}

/**
 * Start the app server on a random port.
 */
export async function startTestServer() {
  server = createAppServer();
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve({ server, port: serverPort });
    });
  });
}

/**
 * Stop the app server.
 */
export async function stopTestServer() {
  if (!server) return;
  return new Promise(resolve => {
    server.close(() => {
      server = null;
      serverPort = null;
      resolve();
    });
  });
}

export function getServerPort() {
  return serverPort;
}

export function baseUrl() {
  return `http://127.0.0.1:${serverPort}`;
}

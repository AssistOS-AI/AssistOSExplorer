import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('db');
const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {pg.Pool} */
let pool;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ max: 20 });
    pool.on('error', (err) => log.error('Pool error', { error: err.message }));
  }
  return pool;
}

/**
 * Run a query with the soul_gateway schema search path.
 */
export async function query(text, params) {
  const client = await getPool().connect();
  try {
    await client.query(`SET search_path TO ${config.pgSchema}, public`);
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

/**
 * Initialize database: create schema, run DDL, create partitions, seed data.
 */
export async function initDb() {
  const p = getPool();

  // Create schema
  await p.query(`CREATE SCHEMA IF NOT EXISTS ${config.pgSchema}`);

  // Run schema DDL
  const schemaPath = join(__dirname, 'schema.sql');
  const ddl = readFileSync(schemaPath, 'utf8');
  await p.query(ddl);

  // Migrations
  await migrate(p);

  // Create monthly partitions (current month + next 3 months)
  await ensurePartitions();

  // Seed default data if tables are empty
  await seedDefaults();

  log.info('Database initialization complete');
}

async function migrate(p) {
  const sql = `SET search_path TO ${config.pgSchema}, public`;
  await p.query(sql);
  // Add key_hint column to api_keys if missing
  await p.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hint TEXT`);
  // Add provider_key and provider_model to model_configs
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS provider_key TEXT`);
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS provider_model TEXT`);
  // Make upstream_model nullable (no longer required)
  await p.query(`ALTER TABLE model_configs ALTER COLUMN upstream_model DROP NOT NULL`);
  // Add agent_name and session_id to call_logs
  await p.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS agent_name TEXT`);
  await p.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS session_id UUID`);
}

async function ensurePartitions() {
  const now = new Date();
  for (let i = -1; i < 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const next = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
    const name = `call_logs_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
    const from = d.toISOString().slice(0, 10);
    const to = next.toISOString().slice(0, 10);
    try {
      await query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF call_logs
         FOR VALUES FROM ('${from}') TO ('${to}')`
      );
    } catch (err) {
      // Partition may already exist
      if (!err.message.includes('already exists') && !err.message.includes('overlap')) {
        log.warn(`Partition ${name} creation issue`, { error: err.message });
      }
    }
  }

  // Drop partitions older than retention period
  const cutoff = new Date(now.getFullYear(), now.getMonth() - Math.ceil(config.retentionDays / 30), 1);
  try {
    const { rows } = await query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = $1 AND tablename LIKE 'call_logs_%'
    `, [config.pgSchema]);

    for (const { tablename } of rows) {
      const match = tablename.match(/call_logs_(\d{4})_(\d{2})/);
      if (match) {
        const partDate = new Date(parseInt(match[1]), parseInt(match[2]) - 1, 1);
        if (partDate < cutoff) {
          await query(`DROP TABLE IF EXISTS ${tablename}`);
          log.info(`Dropped old partition: ${tablename}`);
        }
      }
    }
  } catch (err) {
    log.warn('Partition cleanup issue', { error: err.message });
  }
}

async function seedDefaults() {
  // Seed default soul family if none exist
  const { rows: families } = await query('SELECT id FROM soul_families LIMIT 1');
  if (families.length === 0) {
    log.info('Seeding default soul family...');
    const { rows } = await query(`
      INSERT INTO soul_families (name, description, rpm_limit, tpm_limit)
      VALUES ('default', 'Default soul family', 60, 100000)
      RETURNING id
    `);
    const familyId = rows[0].id;

  }

  // Seed model configs if none exist
  const { rows: models } = await query('SELECT id FROM model_configs LIMIT 1');
  if (models.length === 0) {
    log.info('Seeding model configs...');
    const defaultModels = [
      { name: 'axiologic-deep', providerKey: 'axiologic_proxy', providerModel: 'claude-opus-4.6', mode: 'deep', inputPrice: 5, outputPrice: 25 },
      { name: 'axiologic-fast', providerKey: 'axiologic_proxy', providerModel: 'claude-sonnet-4.5', mode: 'fast', inputPrice: 1, outputPrice: 5 },
      { name: 'axiologic-ultra', providerKey: 'axiologic_proxy', providerModel: 'gpt-5.3-codex', mode: 'deep', inputPrice: 3, outputPrice: 15 },
      { name: 'claude-opus-4.6', providerKey: 'anthropic', providerModel: 'claude-opus-4-6', mode: 'deep', inputPrice: 5, outputPrice: 25 },
      { name: 'claude-sonnet-4.5', providerKey: 'anthropic', providerModel: 'claude-sonnet-4-5', mode: 'fast', inputPrice: 3, outputPrice: 15 },
      { name: 'gpt-5.3-codex', providerKey: 'openai', providerModel: 'gpt-5.3-codex', mode: 'deep', inputPrice: 3, outputPrice: 15 },
      { name: 'gemini-2.5-pro', providerKey: 'google', providerModel: 'gemini-2.5-pro', mode: 'deep', inputPrice: 1.25, outputPrice: 10 },
    ];
    for (const m of defaultModels) {
      await query(`
        INSERT INTO model_configs (name, provider_key, provider_model, mode, input_price, output_price)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (name) DO NOTHING
      `, [m.name, m.providerKey, m.providerModel, m.mode, m.inputPrice, m.outputPrice]);
    }
    log.info('Seeded model configs');
  }
}

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
  await seedDefaultTiers();

  log.info('Database initialization complete');
}

async function migrate(p) {
  const sql = `SET search_path TO ${config.pgSchema}, public`;
  await p.query(sql);

  // Remove soul_families concept - all settings moved to per-key
  await p.query(`DROP TABLE IF EXISTS soul_families CASCADE`);
  await p.query(`ALTER TABLE api_keys DROP COLUMN IF EXISTS family_id`);
  await p.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rpm_limit INT DEFAULT 60`);
  await p.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tpm_limit INT DEFAULT 100000`);
  await p.query(`ALTER TABLE blacklist_rules DROP COLUMN IF EXISTS family_id`);
  await p.query(`ALTER TABLE call_logs DROP COLUMN IF EXISTS family_id`);
  await p.query(`ALTER TABLE call_logs DROP COLUMN IF EXISTS family_name`);
  await p.query(`DROP INDEX IF EXISTS idx_call_logs_family_started`);
  await p.query(`DROP INDEX IF EXISTS idx_api_keys_family_id`);

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
  // Add prompt_hash and cache_hit to call_logs
  await p.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS prompt_hash TEXT`);
  await p.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN DEFAULT false`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_call_logs_prompt_hash ON call_logs(prompt_hash, resolved_model) WHERE prompt_hash IS NOT NULL AND status_code = 200`);
  // Add monthly_budget to api_keys
  await p.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS monthly_budget NUMERIC`);
  // Index for per-key budget aggregation
  await p.query(`CREATE INDEX IF NOT EXISTS idx_call_logs_key_started ON call_logs(api_key_id, started_at)`);
  // Add max_concurrency to model_configs
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS max_concurrency INT DEFAULT 3`);
  // Add upstream_source to model_configs (e.g. 'google', 'openrouter', 'openai')
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS upstream_source TEXT`);

  // Add sort_order and context_window to model_configs (for /v1/models auto-discovery)
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 100`);
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS context_window TEXT`);
  // Clean up legacy axiologic alias models (replaced by tiers)
  await p.query(`DELETE FROM model_configs WHERE name IN ('axiologic-fast', 'axiologic-deep', 'axiologic-ultra')`);


  // Remove unused key_type column from api_keys (all keys are permanent)
  await p.query(`ALTER TABLE api_keys DROP COLUMN IF EXISTS key_type`);

  // Fix: remove codex/ prefix from provider_model (CLIProxyAPI doesn't support namespaced models)
  await p.query(`UPDATE model_configs SET provider_model = 'gpt-5.3-codex' WHERE provider_model = 'codex/gpt-5.3-codex'`);
  await p.query(`UPDATE model_configs SET upstream_source = 'openai' WHERE upstream_source = 'codex'`);

  // Create model_tiers table (migration for existing deployments)
  await p.query(`CREATE TABLE IF NOT EXISTS ${config.pgSchema}.model_tiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    display_name TEXT,
    models TEXT[] NOT NULL DEFAULT '{}',
    fallback_tier TEXT,
    sort_order INT DEFAULT 100,
    is_enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  // Create provider_configs table (migration for existing deployments)
  await p.query(`CREATE TABLE IF NOT EXISTS ${config.pgSchema}.provider_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    display_name TEXT,
    protocol TEXT NOT NULL DEFAULT 'openai',
    base_url TEXT NOT NULL,
    encrypted_api_key BYTEA NOT NULL,
    key_hint TEXT,
    is_enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  // Add provider_config_id FK to model_configs
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS provider_config_id UUID REFERENCES ${config.pgSchema}.provider_configs(id) ON DELETE SET NULL`);

  // Populate upstream_source for existing models that don't have it
  const sourceByProvider = [
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['google', 'google'],
  ];
  for (const [providerKey, source] of sourceByProvider) {
    await p.query(`
      UPDATE model_configs SET upstream_source = $1
      WHERE provider_key = $2 AND upstream_source IS NULL
    `, [source, providerKey]);
  }
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
  // Seed model configs if none exist
  const { rows: models } = await query('SELECT id FROM model_configs LIMIT 1');
  if (models.length === 0) {
    log.info('Seeding model configs...');
    const defaultModels = [
      { name: 'claude-opus-4.6', providerKey: 'anthropic', providerModel: 'claude-opus-4-6', upstreamSource: 'anthropic', mode: 'deep', inputPrice: 5, outputPrice: 25 },
      { name: 'claude-sonnet-4.5', providerKey: 'anthropic', providerModel: 'claude-sonnet-4-5', upstreamSource: 'anthropic', mode: 'fast', inputPrice: 3, outputPrice: 15 },
      { name: 'gpt-5.3-codex', providerKey: 'openai', providerModel: 'gpt-5.3-codex', upstreamSource: 'openai', mode: 'deep', inputPrice: 3, outputPrice: 15 },
      { name: 'gemini-2.5-pro', providerKey: 'google', providerModel: 'gemini-2.5-pro', upstreamSource: 'google', mode: 'deep', inputPrice: 1.25, outputPrice: 10 },
    ];
    for (const m of defaultModels) {
      await query(`
        INSERT INTO model_configs (name, provider_key, provider_model, upstream_source, mode, input_price, output_price)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (name) DO NOTHING
      `, [m.name, m.providerKey, m.providerModel, m.upstreamSource, m.mode, m.inputPrice, m.outputPrice]);
    }
    log.info('Seeded model configs');
  }
}

async function seedDefaultTiers() {
  const { rows: tiers } = await query('SELECT id FROM model_tiers LIMIT 1');
  if (tiers.length === 0) {
    log.info('Seeding default model tiers...');
    const defaults = [
      { name: 'fast', display_name: 'Fast', models: ['copilot-gpt-4o', 'copilot-gpt-4.1', 'copilot-gpt-5-mini', 'kiro-claude-haiku-4.5'], fallback: null, sort_order: 10 },
      { name: 'plan', display_name: 'Plan', models: ['copilot-gpt-4o', 'copilot-gpt-4.1', 'copilot-gemini-3-flash'], fallback: 'fast', sort_order: 20 },
      { name: 'write', display_name: 'Write', models: ['copilot-gemini-3-flash'], fallback: 'fast', sort_order: 30 },
      { name: 'code', display_name: 'Code', models: ['kiro-claude-sonnet-4.5', 'kiro-claude-sonnet-4'], fallback: 'code-paid', sort_order: 40 },
      { name: 'code-paid', display_name: 'Code (Paid)', models: [], fallback: 'deep', sort_order: 50 },
      { name: 'deep', display_name: 'Deep', models: ['copilot-opus-4.6', 'gpt-5.3-codex'], fallback: null, sort_order: 60 },
      { name: 'ultra', display_name: 'Ultra', models: ['copilot-opus-4.6', 'gpt-5.3-codex'], fallback: null, sort_order: 70 },
    ];
    for (const t of defaults) {
      await query(`
        INSERT INTO model_tiers (name, display_name, models, fallback_tier, sort_order)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (name) DO NOTHING
      `, [t.name, t.display_name, t.models, t.fallback, t.sort_order]);
    }
    log.info('Seeded default model tiers');
  }
}

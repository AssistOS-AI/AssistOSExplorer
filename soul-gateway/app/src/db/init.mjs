import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.mjs';
import { createLogger } from '../utils/logger.mjs';
import { seedProviders } from './seed-providers.mjs';
import { buildModelName, stripLegacyPrefix } from '../utils/model-naming.mjs';

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

  // Seed providers from environment variables
  await seedProviders();

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

  // Add is_free flag to model_configs (free models don't count against API key budget)
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT false`);

  // Add is_free to call_logs (denormalized for budget spend queries)
  await p.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT false`);

  // Add budget_reset_at to api_keys (allows mid-month budget reset)
  await p.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS budget_reset_at TIMESTAMPTZ`);

  // Set default budget of $10 for keys that have no budget set
  await p.query(`UPDATE api_keys SET monthly_budget = 10 WHERE monthly_budget IS NULL`);

  // Add daily_budget to api_keys (replaces monthly_budget for enforcement)
  await p.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS daily_budget NUMERIC DEFAULT 2`);
  await p.query(`UPDATE api_keys SET daily_budget = 2 WHERE daily_budget IS NULL`);

  // Add pricing_type and request_cost to model_configs (per-request pricing for copilot/kiro)
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS pricing_type TEXT DEFAULT 'token'`);
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS request_cost NUMERIC DEFAULT 0`);

  // Set per-request pricing for copilot models (base: $0.04/premium request)
  // Handles both legacy names (copilot-*) and new names (axl/copilot/*)
  await p.query(`
    UPDATE model_configs SET pricing_type = 'request', request_cost = CASE
      WHEN name IN ('copilot-gpt-4o', 'copilot-gpt-4.1', 'copilot-gpt-5-mini', 'copilot-raptor-mini',
                    'axl/copilot/gpt-4o', 'axl/copilot/gpt-4.1', 'axl/copilot/gpt-5-mini', 'axl/copilot/raptor-mini') THEN 0
      WHEN name LIKE 'copilot-grok%' OR name LIKE 'axl/copilot/grok%' THEN 0.01
      WHEN name LIKE 'copilot-%-haiku%' OR name LIKE 'copilot-gemini-%-flash%' OR name LIKE 'copilot-gpt-5.4-mini%'
        OR name LIKE 'axl/copilot/%-haiku%' OR name LIKE 'axl/copilot/gemini-%-flash%' OR name LIKE 'axl/copilot/gpt-5.4-mini%' THEN 0.0132
      WHEN name LIKE 'copilot-opus-4%' OR name LIKE 'axl/copilot/opus-4%' THEN 0.12
      ELSE 0.04
    END
    WHERE (name LIKE 'copilot-%' OR name LIKE 'axl/copilot/%') AND pricing_type = 'token'
  `);

  // Set per-request pricing for kiro models (base: $0.04/credit)
  // Handles both legacy names (kiro-*) and new names (axl/kiro/*)
  await p.query(`
    UPDATE model_configs SET pricing_type = 'request', request_cost = CASE
      WHEN name IN ('kiro-qwen3-coder-next', 'axl/kiro/qwen3-coder-next') THEN 0.002
      WHEN name IN ('kiro-minimax-m2.1', 'axl/kiro/minimax-m2.1') THEN 0.006
      WHEN name IN ('kiro-deepseek-3.2', 'kiro-minimax-m2.5', 'axl/kiro/deepseek-3.2', 'axl/kiro/minimax-m2.5') THEN 0.01
      WHEN name IN ('kiro-claude-haiku-4.5', 'axl/kiro/claude-haiku-4.5') THEN 0.016
      WHEN name LIKE 'kiro-claude-sonnet%' OR name LIKE 'axl/kiro/claude-sonnet%' THEN 0.052
      WHEN name LIKE 'kiro-claude-opus%' OR name LIKE 'axl/kiro/claude-opus%' THEN 0.088
      ELSE 0.04
    END
    WHERE (name LIKE 'kiro-%' OR name = 'auto-kiro' OR name LIKE 'axl/kiro/%') AND pricing_type = 'token'
  `);

  // Add billing_type to provider_configs (subscription vs api_key)
  await p.query(`ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS billing_type TEXT DEFAULT 'api_key'`);
  await p.query(`UPDATE provider_configs SET billing_type = 'subscription' WHERE name IN ('copilot', 'axiologic_kiro') AND billing_type = 'api_key'`);

  // Add tags array to model_configs
  await p.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`);

  // Rename models to axl/<provider>/<model> convention
  await migrateModelNames(p);

  // Seed initial tags for known models
  await seedModelTags(p);
}

/**
 * Rename existing models to the axl/<provider-slug>/<model> convention.
 * Idempotent: skips models already prefixed with 'axl/'.
 * Also updates model_tiers.models arrays.
 */
async function migrateModelNames(p) {
  // Use a single client to keep the search_path set across queries
  const client = await p.connect();
  try {
    await client.query(`SET search_path TO ${config.pgSchema}, public`);

    const { rows: models } = await client.query(
      `SELECT id, name, provider_key FROM model_configs WHERE name NOT LIKE 'axl/%' AND provider_key IS NOT NULL`
    );
    if (models.length === 0) return;

    const renames = []; // { oldName, newName }
    for (const m of models) {
      const modelPart = stripLegacyPrefix(m.name, m.provider_key);
      const newName = buildModelName(m.provider_key, modelPart);
      if (newName === m.name) continue;

      try {
        await client.query(
          `UPDATE model_configs SET name = $1, display_name = CASE WHEN display_name = $2 THEN $1 ELSE display_name END WHERE id = $3`,
          [newName, m.name, m.id]
        );
        renames.push({ oldName: m.name, newName });
      } catch (err) {
        // Name conflict — skip (model might already exist with new name)
        if (err.code !== '23505') throw err;
        log.warn(`Skipping rename ${m.name} → ${newName}: name already exists`);
      }
    }

    if (renames.length === 0) return;

    // Update model_tiers.models arrays
    const { rows: tiers } = await client.query('SELECT id, models FROM model_tiers');
    for (const tier of tiers) {
      let changed = false;
      const updatedModels = (tier.models || []).map(name => {
        const rename = renames.find(r => r.oldName === name);
        if (rename) { changed = true; return rename.newName; }
        return name;
      });
      if (changed) {
        await client.query('UPDATE model_tiers SET models = $1 WHERE id = $2', [updatedModels, tier.id]);
      }
    }

    log.info(`Renamed ${renames.length} models to axl/ convention`);
  } finally {
    client.release();
  }
}

/**
 * Seed initial tags for known model patterns.
 * Only sets tags on models that have an empty tags array.
 */
async function seedModelTags(p) {
  const client = await p.connect();
  try {
    await client.query(`SET search_path TO ${config.pgSchema}, public`);
    // Keyword-based rules: match model names across ALL providers.
    // More specific patterns first; broader catch-alls at the end.
    const tagRules = [
      // Search models
      { pattern: 'axl/search/%', tags: ['search'], like: true },
      // Code-specialized models (specific first)
      { pattern: '%codex%', tags: ['coding', 'reasoning', 'agentic'], like: true },
      { pattern: '%codestral%', tags: ['coding', 'fast'], like: true },
      { pattern: '%codegemma%', tags: ['coding'], like: true },
      { pattern: '%codelion%', tags: ['coding'], like: true },
      { pattern: '%starcoder%', tags: ['coding'], like: true },
      { pattern: '%code-%', tags: ['coding'], like: true },
      { pattern: '%/code%', tags: ['coding'], like: true },
      { pattern: '%-coder%', tags: ['coding', 'agentic'], like: true },
      // Opus-class (large reasoning models)
      { pattern: '%opus%', tags: ['reasoning', 'coding', 'agentic', 'long-context'], like: true },
      // Sonnet-class
      { pattern: '%sonnet%', tags: ['coding', 'agentic', 'fast'], like: true },
      // Haiku-class (fast/cheap)
      { pattern: '%haiku%', tags: ['fast', 'chat'], like: true },
      // GPT models (specific first, then broad catch-all)
      { pattern: '%gpt-5%codex%', tags: ['coding', 'reasoning', 'agentic'], like: true },
      { pattern: '%gpt-5%mini%', tags: ['fast', 'chat', 'function-calling'], like: true },
      { pattern: '%gpt-5.3%', tags: ['reasoning', 'coding', 'agentic'], like: true },
      { pattern: '%gpt-5.4%', tags: ['reasoning', 'coding'], like: true },
      { pattern: '%gpt-5.2%', tags: ['reasoning', 'coding'], like: true },
      { pattern: '%gpt-5.1%', tags: ['reasoning', 'coding'], like: true },
      { pattern: '%gpt-5%', tags: ['reasoning', 'chat'], like: true },
      { pattern: '%gpt-4o%', tags: ['fast', 'chat', 'function-calling'], like: true },
      { pattern: '%gpt-4.1%', tags: ['fast', 'chat', 'function-calling'], like: true },
      { pattern: '%gpt-%', tags: ['chat'], like: true },
      // Gemini
      { pattern: '%gemini%pro%', tags: ['reasoning', 'long-context', 'multimodal'], like: true },
      { pattern: '%gemini%flash%', tags: ['fast', 'chat'], like: true },
      { pattern: '%gemma%', tags: ['chat', 'fast'], like: true },
      // Grok
      { pattern: '%grok%', tags: ['chat', 'reasoning'], like: true },
      // DeepSeek
      { pattern: '%deepseek%', tags: ['coding', 'reasoning'], like: true },
      // Qwen
      { pattern: '%qwen%', tags: ['coding', 'multilingual'], like: true },
      // Llama
      { pattern: '%llama%', tags: ['chat', 'reasoning'], like: true },
      // Mixtral / Mistral
      { pattern: '%mixtral%', tags: ['fast', 'multilingual'], like: true },
      { pattern: '%mistral%', tags: ['chat', 'multilingual'], like: true },
      // Vision / multimodal models
      { pattern: '%vlm%', tags: ['vision', 'multimodal'], like: true },
      { pattern: '%vision%', tags: ['vision', 'multimodal'], like: true },
      { pattern: '%fuyu%', tags: ['vision', 'multimodal'], like: true },
      { pattern: '%kosmos%', tags: ['vision', 'multimodal'], like: true },
      { pattern: '%llava%', tags: ['vision', 'multimodal'], like: true },
      { pattern: '%paligemma%', tags: ['vision', 'multimodal'], like: true },
      { pattern: '%neva%', tags: ['vision', 'multimodal'], like: true },
      { pattern: '%vila%', tags: ['vision', 'multimodal'], like: true },
      { pattern: '%cogvlm%', tags: ['vision', 'multimodal'], like: true },
      // Embedding / retrieval models
      { pattern: '%embed%', tags: ['embeddings'], like: true },
      { pattern: '%e5-%', tags: ['embeddings'], like: true },
      { pattern: '%bge-%', tags: ['embeddings'], like: true },
      { pattern: '%rerank%', tags: ['retrieval'], like: true },
      // MiniMax
      { pattern: '%minimax%', tags: ['chat', 'multilingual'], like: true },
      // Phi (small efficient models)
      { pattern: '%phi-%', tags: ['fast', 'reasoning'], like: true },
      // Yi
      { pattern: '%yi-%', tags: ['chat', 'multilingual'], like: true },
      // Nemotron
      { pattern: '%nemotron%', tags: ['reasoning', 'chat'], like: true },
      // Raptor
      { pattern: '%raptor%', tags: ['fast', 'chat'], like: true },
      // Known model families
      { pattern: '%jamba%', tags: ['chat', 'long-context'], like: true },
      { pattern: '%dbrx%', tags: ['chat', 'reasoning'], like: true },
      { pattern: '%arctic%', tags: ['chat'], like: true },
      { pattern: '%falcon%', tags: ['chat'], like: true },
      { pattern: '%mpt-%', tags: ['chat'], like: true },
      { pattern: '%baichuan%', tags: ['chat', 'multilingual'], like: true },
      { pattern: '%internlm%', tags: ['chat', 'multilingual'], like: true },
      { pattern: '%chatglm%', tags: ['chat', 'multilingual'], like: true },
      { pattern: '%sea-lion%', tags: ['chat', 'multilingual'], like: true },
      { pattern: '%solar%', tags: ['chat'], like: true },
      { pattern: '%zephyr%', tags: ['chat'], like: true },
      { pattern: '%command-%', tags: ['chat', 'function-calling'], like: true },
      { pattern: '%seed-%', tags: ['chat'], like: true },
      { pattern: '%kimi%', tags: ['coding', 'agentic'], like: true },
      { pattern: '%glm-%', tags: ['chat', 'reasoning'], like: true },
      // Writer / Palmyra models
      { pattern: '%palmyra-creative%', tags: ['creative', 'writing'], like: true },
      { pattern: '%palmyra-fin%', tags: ['finance', 'reasoning'], like: true },
      { pattern: '%palmyra-med%', tags: ['medical', 'research'], like: true },
      { pattern: '%palmyra%', tags: ['writing', 'chat'], like: true },
      { pattern: '%writer%', tags: ['writing'], like: true },
      // Euro / regional LLMs
      { pattern: '%eurollm%', tags: ['multilingual', 'chat'], like: true },
      { pattern: '%swallow%', tags: ['multilingual', 'chat'], like: true },
      { pattern: '%taiwan%', tags: ['multilingual', 'chat'], like: true },
      // Zamba
      { pattern: '%zamba%', tags: ['chat', 'fast'], like: true },
      // GLM (zhipu)
      { pattern: '%glm%', tags: ['chat', 'reasoning'], like: true },
      // Thinker / thinking models
      { pattern: '%Thinker%', tags: ['reasoning', 'thinking'], like: true },
      { pattern: '%thinker%', tags: ['reasoning', 'thinking'], like: true },
      // Kimi
      { pattern: '%klmi%', tags: ['coding', 'agentic'], like: true },
      // Apriel / ServiceNow
      { pattern: '%apriel%', tags: ['chat', 'reasoning'], like: true },
      // Kiro auto-router
      { pattern: 'axl/kiro/auto', tags: ['agentic'] },
      // Catch-all: any remaining instruct/chat-tuned model
      { pattern: '%instruct%', tags: ['chat', 'instruction-following'], like: true },
      { pattern: '%-chat%', tags: ['chat'], like: true },
      { pattern: '%/chat%', tags: ['chat'], like: true },
      // Final catch-all: anything with a size indicator (e.g. 7b, 13b, 70b) is likely a general LLM
      { pattern: '%-7b%', tags: ['chat'], like: true },
      { pattern: '%-8b%', tags: ['chat'], like: true },
      { pattern: '%-13b%', tags: ['chat'], like: true },
      { pattern: '%-14b%', tags: ['chat'], like: true },
      { pattern: '%-32b%', tags: ['chat'], like: true },
      { pattern: '%-32k%', tags: ['long-context'], like: true },
      { pattern: '%-70b%', tags: ['chat', 'reasoning'], like: true },
      { pattern: '%-122b%', tags: ['chat', 'reasoning'], like: true },
    ];

    for (const rule of tagRules) {
      if (rule.like) {
        await client.query(
          `UPDATE model_configs SET tags = $1 WHERE name LIKE $2 AND (tags IS NULL OR tags = '{}')`,
          [rule.tags, rule.pattern]
        );
      } else {
        await client.query(
          `UPDATE model_configs SET tags = $1 WHERE name = $2 AND (tags IS NULL OR tags = '{}')`,
          [rule.tags, rule.pattern]
        );
      }
    }

    // Append 'tool-calling' tag to models from providers that support it.
    // Uses array_append to add to existing tags without overwriting.
    // Only adds if tag not already present.
    const toolCallingProviders = [
      'copilot', 'axiologic_kiro', 'anthropic', 'openai', 'google',
      'openrouter', 'axiologic_proxy', 'mistral', 'xai',
      'opencode', 'opencode_anthropic', 'opencode_responses',
    ];
    // Exclude specific models known NOT to support tool calling
    const noToolCalling = [
      'axl/copilot/gpt-4o', 'axl/copilot/gpt-4.1',
    ];

    await client.query(`
      UPDATE model_configs
      SET tags = array_append(tags, 'tool-calling')
      WHERE provider_key = ANY($1)
        AND NOT (name = ANY($2))
        AND NOT ('tool-calling' = ANY(tags))
    `, [toolCallingProviders, noToolCalling]);

  } finally {
    client.release();
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
      { name: 'axl/anthropic/claude-opus-4.6', providerKey: 'anthropic', providerModel: 'claude-opus-4-6', upstreamSource: 'anthropic', mode: 'deep', inputPrice: 5, outputPrice: 25 },
      { name: 'axl/anthropic/claude-sonnet-4.5', providerKey: 'anthropic', providerModel: 'claude-sonnet-4-5', upstreamSource: 'anthropic', mode: 'fast', inputPrice: 3, outputPrice: 15 },
      { name: 'axl/openai/gpt-5.3-codex', providerKey: 'openai', providerModel: 'gpt-5.3-codex', upstreamSource: 'openai', mode: 'deep', inputPrice: 3, outputPrice: 15 },
      { name: 'axl/google/gemini-2.5-pro', providerKey: 'google', providerModel: 'gemini-2.5-pro', upstreamSource: 'google', mode: 'deep', inputPrice: 1.25, outputPrice: 10 },
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
      { name: 'fast', display_name: 'Fast', models: ['axl/copilot/gpt-4o', 'axl/copilot/gpt-4.1', 'axl/copilot/gpt-5-mini', 'axl/kiro/claude-haiku-4.5'], fallback: null, sort_order: 10 },
      { name: 'plan', display_name: 'Plan', models: ['axl/copilot/gpt-4o', 'axl/copilot/gpt-4.1', 'axl/copilot/gemini-3-flash'], fallback: 'fast', sort_order: 20 },
      { name: 'write', display_name: 'Write', models: ['axl/copilot/gemini-3-flash'], fallback: 'fast', sort_order: 30 },
      { name: 'code', display_name: 'Code', models: ['axl/kiro/claude-sonnet-4.5', 'axl/kiro/claude-sonnet-4'], fallback: 'code-paid', sort_order: 40 },
      { name: 'code-paid', display_name: 'Code (Paid)', models: [], fallback: 'deep', sort_order: 50 },
      { name: 'deep', display_name: 'Deep', models: ['axl/copilot/opus-4.6', 'axl/openai/gpt-5.3-codex'], fallback: null, sort_order: 60 },
      { name: 'ultra', display_name: 'Ultra', models: ['axl/copilot/opus-4.6', 'axl/openai/gpt-5.3-codex'], fallback: null, sort_order: 70 },
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

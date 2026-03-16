import { query } from './init.mjs';
import { createProvider, getProviderByName } from './providers-dao.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('seed-providers');

const SEED_PROVIDERS = [
  { name: 'openrouter',         display_name: 'OpenRouter',            protocol: 'openai',    base_url: 'https://openrouter.ai/api/v1/chat/completions',                envVar: 'OPENROUTER_API_KEY' },
  { name: 'axiologic_proxy',    display_name: 'CLIProxyAPI',           protocol: 'openai',    base_url: 'http://10.0.2.2:8317/v1/chat/completions',                     envVar: 'AXIOLOGIC_PROXY_API_KEY' },
  { name: 'axiologic_kiro',     display_name: 'Kiro Gateway',         protocol: 'openai',    base_url: 'http://10.0.2.2:8000/v1/chat/completions',                     envVar: 'KIRO_PROXY_API_KEY' },
  { name: 'copilot',            display_name: 'Copilot Gateway',      protocol: 'openai',    base_url: 'http://10.0.2.2:4141/v1/chat/completions',                     envVar: 'COPILOT_API_KEY' },
  { name: 'opencode',           display_name: 'OpenCode',             protocol: 'openai',    base_url: 'https://opencode.ai/zen/v1/chat/completions',                  envVar: 'OPENCODE_API_KEY' },
  { name: 'opencode_anthropic', display_name: 'OpenCode (Anthropic)', protocol: 'anthropic', base_url: 'https://opencode.ai/zen/v1/messages',                          envVar: 'OPENCODE_API_KEY' },
  { name: 'opencode_responses', display_name: 'OpenCode (Responses)', protocol: 'openai',    base_url: 'https://opencode.ai/zen/v1/responses',                        envVar: 'OPENCODE_API_KEY' },
  { name: 'openai',             display_name: 'OpenAI',               protocol: 'openai',    base_url: 'https://api.openai.com/v1/chat/completions',                   envVar: 'OPENAI_API_KEY' },
  { name: 'anthropic',          display_name: 'Anthropic',            protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1/messages',                         envVar: 'ANTHROPIC_API_KEY' },
  { name: 'google',             display_name: 'Google AI',            protocol: 'google',    base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',      envVar: 'GEMINI_API_KEY' },
  { name: 'xai',                display_name: 'xAI',                  protocol: 'openai',    base_url: 'https://api.x.ai/v1/chat/completions',                         envVar: 'XAI_API_KEY' },
  { name: 'mistral',            display_name: 'Mistral',              protocol: 'openai',    base_url: 'https://api.mistral.ai/v1/chat/completions',                   envVar: 'MISTRAL_API_KEY' },
];

/**
 * Auto-seed provider_configs from environment variables.
 * Idempotent: only creates providers that don't already exist in the DB.
 * After seeding, links existing models to their DB providers.
 */
export async function seedProviders() {
  let seededCount = 0;
  const seededNames = [];

  for (const seed of SEED_PROVIDERS) {
    const apiKey = process.env[seed.envVar];
    if (!apiKey) continue;

    const existing = await getProviderByName(seed.name);
    if (existing) continue;

    try {
      await createProvider({
        name: seed.name,
        display_name: seed.display_name,
        protocol: seed.protocol,
        base_url: seed.base_url,
        api_key: apiKey,
      });
      seededCount++;
      seededNames.push(seed.name);
      log.info(`Seeded provider: ${seed.name}`);
    } catch (err) {
      log.warn(`Failed to seed provider ${seed.name}: ${err.message}`);
    }
  }

  if (seededCount > 0) {
    log.info(`Seeded ${seededCount} providers: ${seededNames.join(', ')}`);
  }

  // Link existing models to DB providers
  await linkModelsToProviders();
}

/**
 * For models that have provider_config_id IS NULL, try to link them
 * to a DB provider matching their provider_key.
 */
async function linkModelsToProviders() {
  const { rows: unlinkedModels } = await query(`
    SELECT mc.id, mc.provider_key
    FROM model_configs mc
    WHERE mc.provider_config_id IS NULL
      AND mc.provider_key IS NOT NULL
  `);

  if (unlinkedModels.length === 0) return;

  // Build a map of provider name → provider id
  const { rows: providers } = await query('SELECT id, name FROM provider_configs');
  const providerMap = new Map(providers.map(p => [p.name, p.id]));

  let linkedCount = 0;
  for (const model of unlinkedModels) {
    const providerId = providerMap.get(model.provider_key);
    if (!providerId) continue;

    await query(
      'UPDATE model_configs SET provider_config_id = $1 WHERE id = $2',
      [providerId, model.id]
    );
    linkedCount++;
  }

  if (linkedCount > 0) {
    log.info(`Linked ${linkedCount} models to DB providers`);
  }
}

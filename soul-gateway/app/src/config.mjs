export const config = {
  port: parseInt(process.env.PORT || '8042', 10),

  // Dashboard auth
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  // PostgreSQL (uses pg defaults: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE)
  pgSchema: 'soul_gateway',

  // Encryption
  encryptionKey: process.env.ENCRYPTION_KEY || '',

  // achillesAgentLib LLMConfig.json path override (optional)
  llmConfigPath: process.env.LLM_CONFIG_PATH || '',

  // Rate limiting defaults
  defaultRpmLimit: 60,
  defaultTpmLimit: 100000,

  // Retry defaults
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30000,
  jitterPercent: 20,

  // Alert thresholds
  slowRequestMs: 30000,
  largePromptTokens: 50000,

  // Log retention
  retentionDays: 90,

  // Session timeout (ms) — requests from the same key+agent
  // beyond this gap start a new session
  sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
};

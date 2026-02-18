export const config = {
  port: parseInt(process.env.PORT || '8042', 10),
  upstreamUrl: process.env.UPSTREAM_URL || 'https://proxy.axiologic.dev',

  // Dashboard auth
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  // PostgreSQL (uses pg defaults: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE)
  pgSchema: 'soul_gateway',

  // Encryption
  encryptionKey: process.env.ENCRYPTION_KEY || '',

  // Default proxy API key (from /shared/proxy_api_key)
  defaultProxyApiKey: process.env.DEFAULT_PROXY_API_KEY || '',

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
};

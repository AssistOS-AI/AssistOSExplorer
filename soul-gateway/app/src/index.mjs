import { createAppServer, startServer } from './server.mjs';
import { initDb } from './db/init.mjs';
import { scanMiddlewares } from './pipeline/middleware-loader.mjs';
import { createLogger } from './utils/logger.mjs';
import { registerAdapter, startRefreshLoop, stopRefreshLoop } from './providers/auth-manager.mjs';
import copilotAdapter from './providers/adapters/copilot.mjs';
import kiroAdapter from './providers/adapters/kiro.mjs';
import codexAdapter from './providers/adapters/codex.mjs';
import geminiAdapter from './providers/adapters/gemini.mjs';
import anthropicAdapter from './providers/adapters/anthropic.mjs';

const log = createLogger('main');

async function main() {
  log.info('Soul Gateway starting...');

  // Initialize database (create schema, run migrations, seed data)
  await initDb();
  log.info('Database initialized');

  // Discover and register middleware plugins
  await scanMiddlewares();

  registerAdapter(copilotAdapter);
  registerAdapter(kiroAdapter);
  registerAdapter(codexAdapter);
  registerAdapter(geminiAdapter);
  registerAdapter(anthropicAdapter);
  startRefreshLoop();
  log.info('Provider auth system initialized');

  // Create and start HTTP server
  const server = createAppServer();
  await startServer(server);

  // Graceful shutdown
  const shutdown = async (signal) => {
    log.info(`Received ${signal}, shutting down...`);
    stopRefreshLoop();
    server.close(() => {
      log.info('Server closed');
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  log.critical('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});

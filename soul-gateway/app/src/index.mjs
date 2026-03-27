import { createAppServer, startServer } from './server.mjs';
import { initDb } from './db/init.mjs';
import { scanMiddlewares } from './pipeline/middleware-loader.mjs';
import { createLogger } from './utils/logger.mjs';

const log = createLogger('main');

async function main() {
  log.info('Soul Gateway starting...');

  // Initialize database (create schema, run migrations, seed data)
  await initDb();
  log.info('Database initialized');

  // Discover and register middleware plugins
  await scanMiddlewares();

  // Create and start HTTP server
  const server = createAppServer();
  await startServer(server);

  // Graceful shutdown
  const shutdown = async (signal) => {
    log.info(`Received ${signal}, shutting down...`);
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

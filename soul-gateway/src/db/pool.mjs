import pg from 'pg';

/**
 * Create and return a single pg.Pool instance.
 * The pool is configured but NOT connected — first query triggers connection.
 */
export function createPgPool(config) {
  const env = config.env;

  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.PG_POOL_MAX,
    min: env.PG_POOL_MIN,
    idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.PG_CONNECT_TIMEOUT_MS,
    maxUses: env.PG_MAX_USES,
    application_name: 'soul-gateway',
  });

  pool.on('error', (err) => {
    console.error('[db] idle client error', err.message);
  });

  return pool;
}

/**
 * Set the default search_path so all queries operate in the soul_gateway schema.
 */
export async function ensureSchema(pool) {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS soul_gateway`);
  await pool.query(`SET search_path TO soul_gateway, public`);
}

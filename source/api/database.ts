import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { applicationMetadata } from '../../database/schema';

/**
 * Sixty-four-bit results are read as numbers.
 *
 * PostgreSQL sums a `bigint` column into a `bigint`, so every total over a whole office is a
 * 64-bit value, and node-postgres returns those as strings to avoid silently rounding anything
 * beyond 2^53. Every figure this system publishes is either money in centavos or a count of
 * rows: 9,007,199,254,740,992 centavos is PHP 90 trillion, so the conversion cannot lose a
 * peso at any size an ISP could reach. Doing it once here keeps the SQL honest about its own
 * width - a sum cast to `int` overflows at PHP 21,474,836.47, which twenty thousand accounts
 * pass without any single figure looking unusual - and keeps forty read sites from having to
 * remember it.
 */
export function readWideNumbersAsNumbers() {
  pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
}

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 2_000, statement_timeout: 2_000 });
  // Pool idle errors must not terminate the API; readiness exposes the outage.
  pool.on('error', () => { console.error('PostgreSQL connection interrupted.'); });
  const db = drizzle(pool);
  return {
    db,
    pool,
    async check() {
      const rows = await db.select({ value: applicationMetadata.value }).from(applicationMetadata)
        .where(eq(applicationMetadata.key, 'schema_version'));
      if (rows[0]?.value !== '3') throw new Error('Required database migrations are missing.');
    },
    close: () => pool.end(),
  };
}

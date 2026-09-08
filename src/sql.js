/**
 * Postgres access layer.
 *
 * Two drivers behind one interface:
 *   - production: Neon over HTTP (`DATABASE_URL=postgres://…`), which survives
 *     serverless cold starts without holding a TCP pool open
 *   - local: PGlite, a real Postgres compiled to WASM that keeps its data in
 *     `data/pg`, so the shop runs on a laptop with nothing to install
 *
 * Both speak the same SQL, so there is exactly one set of queries to maintain.
 *
 * Queries are written with `?` placeholders and rewritten to Postgres `$1, $2…`
 * here. That keeps the query text readable and means a parameter is never
 * pasted into SQL by hand.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const URL_ = process.env.DATABASE_URL || '';
export const isRemote = /^postgres(ql)?:\/\//.test(URL_);

/** `SELECT … WHERE id = ?` → `SELECT … WHERE id = $1` */
function toPgPlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

let driver = null;

async function getDriver() {
  if (driver) return driver;

  if (isRemote) {
    const { neon, neonConfig, Pool } = await import('@neondatabase/serverless');
    neonConfig.fetchConnectionCache = true;
    const sql = neon(URL_);
    driver = {
      kind: 'neon',
      query: async (text, params) => ({ rows: await sql.query(text, params) }),
      // Multi-statement SQL (the schema) needs the simple query protocol, which
      // only a real session offers.
      execMany: async (text) => {
        const pool = new Pool({ connectionString: URL_ });
        const client = await pool.connect();
        try { await client.query(text); }
        finally { client.release(); await pool.end(); }
      },
      close: async () => {},
      // Transactions need a real session, so they take a pooled connection.
      transaction: async (fn) => {
        const pool = new Pool({ connectionString: URL_ });
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({
            query: async (text, params) => client.query(text, params)
          });
          await client.query('COMMIT');
          return out;
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
          throw err;
        } finally {
          client.release();
          await pool.end();
        }
      }
    };
  } else {
    // PGlite is a 25 MB WebAssembly build of Postgres and is only ever used
    // for local development, so it lives in devDependencies and is not
    // installed in production. Importing it through a variable also keeps the
    // serverless bundler from tracing it into the deployed function.
    const local = '@electric-sql/pglite';
    let PGlite;
    try {
      ({ PGlite } = await import(local));
    } catch {
      throw new Error(
        'No DATABASE_URL is set and the local database is not installed. ' +
        'Set DATABASE_URL to your Postgres connection string.'
      );
    }
    // Configurable so a throwaway instance can run alongside the real one.
    const pg = await PGlite.create(process.env.PGLITE_DIR || join(ROOT, 'data', 'pg'));
    driver = {
      kind: 'pglite',
      query: (text, params) => pg.query(text, params),
      execMany: (text) => pg.exec(text),
      // PGlite keeps an in-memory filesystem that must be flushed to disk, so a
      // hard kill can corrupt the data directory. Always close it cleanly.
      close: () => pg.close(),
      transaction: async (fn) => {
        await pg.query('BEGIN');
        try {
          const out = await fn({ query: (text, params) => pg.query(text, params) });
          await pg.query('COMMIT');
          return out;
        } catch (err) {
          try { await pg.query('ROLLBACK'); } catch { /* already unwound */ }
          throw err;
        }
      }
    };
  }

  return driver;
}

/**
 * Run raw SQL with no parameters. Handles scripts containing several
 * statements, which the prepared-statement path cannot.
 */
export async function exec(sql) {
  const d = await getDriver();
  await d.execMany(sql);
}

/** All matching rows. */
export async function all(sql, params = []) {
  const d = await getDriver();
  const r = await d.query(toPgPlaceholders(sql), params);
  return r.rows;
}

/** The first row, or undefined. */
export async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

/** For INSERT/UPDATE/DELETE — returns `{ rowCount, rows }`. */
export async function run(sql, params = []) {
  const d = await getDriver();
  const r = await d.query(toPgPlaceholders(sql), params);
  return { rowCount: r.rowCount ?? r.rows?.length ?? 0, rows: r.rows || [] };
}

/** Insert and hand back the new id — Postgres has no `lastInsertRowid`. */
export async function insertReturningId(sql, params = []) {
  const r = await run(sql, params);
  return r.rows[0]?.id;
}

/**
 * Run `fn` inside a transaction. `fn` receives the same {all,get,run} helpers,
 * bound to the transaction's connection.
 */
export async function transaction(fn) {
  const d = await getDriver();
  return d.transaction(async (tx) => {
    const txAll = async (sql, params = []) => (await tx.query(toPgPlaceholders(sql), params)).rows;
    return fn({
      all: txAll,
      get: async (sql, params = []) => (await txAll(sql, params))[0],
      run: async (sql, params = []) => {
        const r = await tx.query(toPgPlaceholders(sql), params);
        return { rowCount: r.rowCount ?? 0, rows: r.rows || [] };
      },
      insertReturningId: async (sql, params = []) => {
        const r = await tx.query(toPgPlaceholders(sql), params);
        return r.rows[0]?.id;
      },
      exec: async (sql) => { await tx.query(sql, []); }
    });
  });
}

export async function driverName() {
  return (await getDriver()).kind;
}

/** Flush and release the database. Call before the process exits. */
export async function closeDatabase() {
  if (!driver) return;
  try { await driver.close(); } catch { /* nothing useful to do while exiting */ }
  driver = null;
}

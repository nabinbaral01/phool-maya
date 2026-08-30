/**
 * Load a JSON dump produced from the old SQLite database into Postgres.
 *
 *   node scripts/import-sqlite.js data/sqlite-export.json
 *
 * Safe to run against an empty or seeded database: rows keep their original ids,
 * conflicts are skipped, and each table's id sequence is moved past the highest
 * id afterwards so new inserts do not collide.
 */
import { readFileSync } from 'node:fs';
import { ready, all, run, exec, invalidateSettings } from '../src/db.js';

const file = process.argv[2] || 'data/sqlite-export.json';

// Parents before children.
const ORDER = [
  'settings', 'admins', 'categories', 'products', 'customers',
  'orders', 'order_items', 'order_events', 'coupons', 'reviews',
  'subscribers', 'messages', 'faqs', 'activity_log', 'events'
];

const CONFLICT_KEY = {
  settings: 'key', admins: 'email', categories: 'slug',
  products: 'slug', customers: 'email', orders: 'order_no',
  coupons: 'code', subscribers: 'email'
};

async function main() {
  await ready();

  const dump = JSON.parse(readFileSync(file, 'utf8'));
  const tables = dump.tables || dump;
  let total = 0;

  for (const table of ORDER) {
    const rows = tables[table];
    if (!Array.isArray(rows) || !rows.length) continue;

    const columns = Object.keys(rows[0]);

    // Imported rows are the real ones — for tables the seed also writes, the
    // import must win, or a customised setting or changed password would be
    // silently replaced by the default.
    const OVERWRITE = { settings: ['value'], admins: ['name', 'password_hash', 'last_login_at'] };
    const conflict = OVERWRITE[table]
      ? `ON CONFLICT (${CONFLICT_KEY[table]}) DO UPDATE SET ${
        OVERWRITE[table].map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}`
      : CONFLICT_KEY[table]
        ? `ON CONFLICT (${CONFLICT_KEY[table]}) DO NOTHING`
        : 'ON CONFLICT (id) DO NOTHING';

    let written = 0;
    const chunk = 200;
    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk);
      const values = slice
        .map(() => `(${columns.map(() => '?').join(',')})`)
        .join(',');
      const params = slice.flatMap((r) => columns.map((c) => r[c]));
      const r = await run(
        `INSERT INTO ${table}(${columns.map((c) => `"${c}"`).join(',')}) VALUES ${values} ${conflict}`,
        params
      );
      written += r.rowCount;
    }

    // Keep SERIAL sequences ahead of the imported ids.
    if (columns.includes('id')) {
      await exec(`SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                   GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`);
    }

    console.log(`  ${table.padEnd(14)} ${String(written).padStart(6)} imported`);
    total += written;
  }

  invalidateSettings();
  console.log(`\nDone — ${total} rows.`);

  const counts = await all(`
    SELECT 'products' AS t, COUNT(*)::int AS n FROM products
    UNION ALL SELECT 'customers', COUNT(*)::int FROM customers
    UNION ALL SELECT 'orders', COUNT(*)::int FROM orders
    UNION ALL SELECT 'events', COUNT(*)::int FROM events`);
  console.log('Now in Postgres:', counts.map((c) => `${c.t}=${c.n}`).join('  '));
  process.exit(0);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});

/**
 * Snapshots.
 *
 * Taken automatically right before anything destructive, so a mis-click is
 * recoverable. On a serverless host there is no disk to copy a database file
 * to, so a snapshot is a gzipped JSON dump of every table, stored in the
 * database itself and downloadable from Settings.
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { all, get, run } from './sql.js';
import { nowISO } from './db.js';

const KEEP = 8;
const MAX_BYTES = 8_000_000; // a snapshot far bigger than this is not worth storing inline

/** Tables captured, in an order that can be restored without breaking keys. */
const TABLES = [
  'settings', 'admins', 'categories', 'products', 'customers',
  'orders', 'order_items', 'order_events', 'coupons', 'reviews',
  'subscribers', 'messages', 'faqs', 'activity_log'
];

/**
 * @param {string} reason short slug describing what triggered it
 * @returns {Promise<{id:number, bytes:number}|null>}
 */
export async function takeSnapshot(reason = 'manual') {
  try {
    const dump = { app: 'phool-maya', version: 1, created_at: nowISO(), reason, tables: {} };

    for (const t of TABLES) {
      // `events` is deliberately excluded — it is by far the largest table and
      // analytics history is not what anyone is trying to rescue.
      dump.tables[t] = await all(`SELECT * FROM ${t}`);
    }

    const json = JSON.stringify(dump);
    if (Buffer.byteLength(json) > MAX_BYTES) {
      console.warn('[snapshot] skipped — dump exceeds', MAX_BYTES, 'bytes');
      return null;
    }

    const payload = gzipSync(Buffer.from(json)).toString('base64');
    const r = await run(
      'INSERT INTO snapshots(reason, bytes, payload, created_at) VALUES(?,?,?,?) RETURNING id',
      [reason, Buffer.byteLength(json), payload, nowISO()]
    );

    await prune();
    return { id: r.rows[0]?.id, bytes: Buffer.byteLength(json) };
  } catch (err) {
    // A failed snapshot must never block the operator's actual request; it is a
    // safety net, not a gate.
    console.error('[snapshot] failed:', err.message);
    return null;
  }
}

async function prune() {
  const old = await all(
    `SELECT id FROM snapshots ORDER BY id DESC OFFSET ${KEEP}`
  );
  for (const s of old) await run('DELETE FROM snapshots WHERE id = ?', [s.id]);
}

/** Newest first, without the payload. */
export function listSnapshots() {
  return all('SELECT id, reason, bytes, created_at FROM snapshots ORDER BY id DESC');
}

/** The decompressed JSON for one snapshot. */
export async function readSnapshot(id) {
  const row = await get('SELECT * FROM snapshots WHERE id = ?', [id]);
  if (!row) return null;
  return {
    created_at: row.created_at,
    reason: row.reason,
    json: gunzipSync(Buffer.from(row.payload, 'base64')).toString('utf8')
  };
}

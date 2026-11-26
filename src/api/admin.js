/**
 * Admin API — authentication, catalogue/order management, and the analytics
 * aggregations that feed the dashboard charts.
 *
 * Everything under /api/admin (except /login) is gated in server.js, which
 * resolves the session cookie and attaches `req.admin`.
 */
import {
  all, get, run, exec, transaction,
  getSettings, setSetting, nowISO, logActivity, slugify, DEFAULT_SETTINGS, productImages
} from '../db.js';
import { ok, fail, readBody, readRawBody, str, numOr, intOr, bool01 } from '../lib/http.js';
import { saveUpload, deleteUpload, isOwnUpload } from '../storage.js';
import { takeSnapshot, listSnapshots, readSnapshot } from '../backup.js';
import {
  hashPassword, verifyPassword, newSessionId, sessionExpiry,
  serializeCookie, SESSION_COOKIE, SESSION_MAX_AGE
} from '../auth.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (now, prev) => (prev > 0 ? round2(((now - prev) / prev) * 100) : now > 0 ? 100 : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ */
/* Product photo uploads                                               */
/* ------------------------------------------------------------------ */

const MAX_UPLOAD = 6_000_000; // 6 MB

/**
 * Identify an image from its leading bytes. The browser's Content-Type is a
 * claim, not a fact, so the file signature decides what we are willing to store.
 */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { ext: 'png', mime: 'image/png' };
  if (['GIF89a', 'GIF87a'].includes(buf.subarray(0, 6).toString('latin1')))
    return { ext: 'gif', mime: 'image/gif' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')
    return { ext: 'webp', mime: 'image/webp' };
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return { ext: 'avif', mime: 'image/avif' };
    if (brand.startsWith('hei')) return { ext: 'heic', mime: 'image/heic' };
  }
  // SVG can carry script and is served back to shoppers — never accepted.
  return null;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

function daysAgoISO(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days + 1);
  return d.toISOString();
}

function dayKeys(days) {
  const keys = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days + 1);
  for (let i = 0; i < days; i++) {
    keys.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return keys;
}

const REVENUE_STATUSES = `('pending','confirmed','packing','shipped','delivered')`;
const ORDER_STATUSES = ['pending', 'confirmed', 'packing', 'shipped', 'delivered', 'cancelled', 'refunded'];
const PAYMENT_STATUSES = ['unpaid', 'paid', 'refunded'];
const DEAD = (s) => s === 'cancelled' || s === 'refunded';

/**
 * Move one order to a new status, keeping stock honest: cancelling or refunding
 * returns items to the shelf, and reviving an order takes them off again.
 * Shared by the single-order editor and the bulk action so the two cannot drift.
 *
 * @param {object} q  {get,all,run} bound to a transaction, or the module helpers
 */
async function applyOrderStatus(q, order, status, adminName, eventNote = '') {
  const t = nowISO();
  const items = () => q.all('SELECT product_id, qty FROM order_items WHERE order_id = ?', [order.id]);

  if (!DEAD(order.status) && DEAD(status)) {
    for (const it of await items()) {
      if (it.product_id)
        await q.run('UPDATE products SET stock = stock + ?, sold = GREATEST(0, sold - ?) WHERE id = ?',
          [it.qty, it.qty, it.product_id]);
    }
  } else if (DEAD(order.status) && !DEAD(status)) {
    for (const it of await items()) {
      if (it.product_id)
        await q.run('UPDATE products SET stock = GREATEST(0, stock - ?), sold = sold + ? WHERE id = ?',
          [it.qty, it.qty, it.product_id]);
    }
  }

  await q.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [status, t, order.id]);

  if (status !== order.status || eventNote) {
    await q.run('INSERT INTO order_events(order_id, status, note, created_at) VALUES(?,?,?,?)',
      [order.id, status, eventNote || `Status set to ${status} by ${adminName}`, t]);
  }
}

/** Restore stock for an order about to be deleted outright. */
async function restoreStockForDeletedOrder(q, order) {
  if (DEAD(order.status)) return;
  for (const it of await q.all('SELECT product_id, qty FROM order_items WHERE order_id = ?', [order.id])) {
    if (it.product_id)
      await q.run('UPDATE products SET stock = stock + ?, sold = GREATEST(0, sold - ?) WHERE id = ?',
        [it.qty, it.qty, it.product_id]);
  }
}

/* ================================================================== */
/* Analytics                                                           */
/* ================================================================== */

export async function buildAnalytics(days = 30) {
  const from = daysAgoISO(days);
  const prevFrom = daysAgoISO(days * 2);
  const keys = dayKeys(days);
  const settings = await getSettings();

  const agg = (since, until) => get(
    `SELECT COALESCE(SUM(total),0)::float8 AS revenue, COALESCE(SUM(cost_total),0)::float8 AS cost,
            COUNT(*)::int AS orders, COALESCE(SUM(discount),0)::float8 AS discount
     FROM orders WHERE created_at >= ? ${until ? 'AND created_at < ?' : ''}
       AND status IN ${REVENUE_STATUSES}`,
    until ? [since, until] : [since]
  );

  const [cur, prev, unitsRow, dailyRows, trafficRows] = await Promise.all([
    agg(from, null),
    agg(prevFrom, from),
    get(`SELECT COALESCE(SUM(i.qty),0)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id
         WHERE o.created_at >= ? AND o.status IN ${REVENUE_STATUSES}`, [from]),
    all(`SELECT substr(created_at,1,10) AS d, SUM(total)::float8 AS revenue,
                SUM(cost_total)::float8 AS cost, COUNT(*)::int AS orders
         FROM orders WHERE created_at >= ? AND status IN ${REVENUE_STATUSES} GROUP BY d`, [from]),
    all(`SELECT substr(created_at,1,10) AS d, COUNT(*)::int AS views,
                COUNT(DISTINCT visitor_key)::int AS visitors
         FROM events WHERE created_at >= ? AND type = 'pageview' GROUP BY d`, [from])
  ]);

  const dailyMap = Object.fromEntries(dailyRows.map((r) => [r.d, r]));
  const daily = keys.map((d) => ({
    date: d,
    revenue: round2(dailyMap[d]?.revenue || 0),
    profit: round2((dailyMap[d]?.revenue || 0) - (dailyMap[d]?.cost || 0)),
    orders: dailyMap[d]?.orders || 0
  }));

  const trafficMap = Object.fromEntries(trafficRows.map((r) => [r.d, r]));
  const traffic = keys.map((d) => ({
    date: d,
    views: trafficMap[d]?.views || 0,
    visitors: trafficMap[d]?.visitors || 0
  }));

  const countEvents = async (type) =>
    (await get('SELECT COUNT(DISTINCT visitor_key)::int AS n FROM events WHERE created_at >= ? AND type = ?',
      [from, type])).n;

  const [visitedN, viewedN, cartN, checkoutN] = await Promise.all([
    countEvents('pageview'), countEvents('product_view'),
    countEvents('add_to_cart'), countEvents('begin_checkout')
  ]);

  const funnel = [
    { step: 'Visited shop', value: visitedN },
    { step: 'Viewed a bouquet', value: viewedN },
    { step: 'Added to basket', value: cartN },
    { step: 'Started checkout', value: checkoutN },
    { step: 'Ordered', value: cur.orders }
  ];

  const threshold = Number(settings.low_stock_threshold || 5);

  const [byStatus, byPayment, topProducts, byCategory, heat,
    newCustomersRow, repeatRow, totalCustomersRow, topCustomers,
    lowStock, inventoryValue, belowCost] = await Promise.all([
    all('SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total),0)::float8 AS revenue FROM orders WHERE created_at >= ? GROUP BY status', [from]),
    all(`SELECT payment_method, COUNT(*)::int AS n, COALESCE(SUM(total),0)::float8 AS revenue FROM orders
         WHERE created_at >= ? AND status IN ${REVENUE_STATUSES} GROUP BY payment_method`, [from]),
    all(`SELECT i.name, SUM(i.qty)::int AS units,
                ROUND(SUM(i.line_total)::numeric,2)::float8 AS revenue,
                ROUND(SUM(i.line_total - i.unit_cost * i.qty)::numeric,2)::float8 AS profit
         FROM order_items i JOIN orders o ON o.id = i.order_id
         WHERE o.created_at >= ? AND o.status IN ${REVENUE_STATUSES}
         GROUP BY i.name ORDER BY revenue DESC LIMIT 8`, [from]),
    all(`SELECT COALESCE(c.name,'Uncategorised') AS name, SUM(i.qty)::int AS units,
                ROUND(SUM(i.line_total)::numeric,2)::float8 AS revenue
         FROM order_items i
         JOIN orders o ON o.id = i.order_id
         LEFT JOIN products p ON p.id = i.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE o.created_at >= ? AND o.status IN ${REVENUE_STATUSES}
         GROUP BY c.name ORDER BY revenue DESC`, [from]),
    all(`SELECT EXTRACT(DOW FROM created_at::timestamptz)::int AS dow,
                EXTRACT(HOUR FROM created_at::timestamptz)::int AS hour,
                COUNT(*)::int AS n
         FROM orders WHERE created_at >= ? AND status IN ${REVENUE_STATUSES}
         GROUP BY dow, hour`, [daysAgoISO(Math.max(days, 90))]),
    get('SELECT COUNT(*)::int AS n FROM customers WHERE created_at >= ?', [from]),
    get(`SELECT COUNT(*)::int AS n FROM (
           SELECT customer_id FROM orders WHERE customer_id IS NOT NULL
           GROUP BY customer_id HAVING COUNT(*) > 1) AS repeats`),
    get('SELECT COUNT(*)::int AS n FROM customers'),
    all(`SELECT c.name, c.email, COUNT(o.id)::int AS orders,
                ROUND(SUM(o.total)::numeric,2)::float8 AS spent
         FROM orders o JOIN customers c ON c.id = o.customer_id
         WHERE o.status IN ${REVENUE_STATUSES}
         GROUP BY c.id, c.name, c.email ORDER BY spent DESC LIMIT 6`),
    all('SELECT id, name, stock, price FROM products WHERE active = 1 AND stock <= ? ORDER BY stock ASC LIMIT 10', [threshold]),
    get('SELECT ROUND(COALESCE(SUM(stock * price),0)::numeric,2)::float8 AS v, COALESCE(SUM(stock),0)::int AS units FROM products WHERE active = 1'),
    all(`SELECT id, name, price, cost, ROUND((cost - price)::numeric, 2)::float8 AS loss
         FROM products WHERE active = 1 AND cost > price ORDER BY loss DESC LIMIT 10`)
  ]);

  const [pendingOrders, unpaidOrders, pendingReviews, newMessages] = await Promise.all([
    get(`SELECT COUNT(*)::int AS n FROM orders WHERE status='pending'`),
    get(`SELECT COUNT(*)::int AS n FROM orders WHERE payment_status='unpaid' AND status IN ${REVENUE_STATUSES}`),
    get(`SELECT COUNT(*)::int AS n FROM reviews WHERE status='pending'`),
    get(`SELECT COUNT(*)::int AS n FROM messages WHERE status='new'`)
  ]);

  const revenue = round2(cur.revenue);
  const profit = round2(cur.revenue - cur.cost);
  const visitors = visitedN;

  return {
    range_days: days,
    currency: settings.currency_symbol,
    kpis: {
      revenue,
      revenue_change: pct(cur.revenue, prev.revenue),
      orders: cur.orders,
      orders_change: pct(cur.orders, prev.orders),
      aov: cur.orders ? round2(cur.revenue / cur.orders) : 0,
      aov_change: pct(cur.orders ? cur.revenue / cur.orders : 0, prev.orders ? prev.revenue / prev.orders : 0),
      profit,
      margin: cur.revenue ? round2((profit / cur.revenue) * 100) : 0,
      units: unitsRow.n,
      discount_given: round2(cur.discount),
      visitors,
      conversion: visitors ? round2((cur.orders / visitors) * 100) : 0,
      new_customers: newCustomersRow.n,
      total_customers: totalCustomersRow.n,
      repeat_customers: repeatRow.n,
      inventory_value: inventoryValue.v,
      inventory_units: inventoryValue.units
    },
    daily,
    traffic,
    funnel,
    by_status: byStatus,
    by_payment: byPayment,
    top_products: topProducts,
    by_category: byCategory,
    heatmap: heat,
    top_customers: topCustomers,
    low_stock: lowStock,
    below_cost: belowCost,
    alerts: {
      pending_orders: pendingOrders.n,
      unpaid_orders: unpaidOrders.n,
      pending_reviews: pendingReviews.n,
      new_messages: newMessages.n,
      low_stock: lowStock.length,
      below_cost: belowCost.length
    }
  };
}

/* ================================================================== */
/* CSV                                                                 */
/* ================================================================== */

function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

function sendCSV(res, filename, rows) {
  const body = toCSV(rows);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */

export function registerAdminRoutes(router) {
  /* ---------------- auth ---------------- */

  router.post('/api/admin/login', async (req, res) => {
    const b = await readBody(req);
    const email = str(b.email, 160).toLowerCase();
    const admin = await get('SELECT * FROM admins WHERE LOWER(email) = ?', [email]);

    if (!admin || !verifyPassword(String(b.password || ''), admin.password_hash))
      return fail(res, 401, 'Email or password is not correct.');

    const sid = newSessionId();
    await run(
      'INSERT INTO sessions(id, admin_id, created_at, expires_at, ip, user_agent) VALUES(?,?,?,?,?,?)',
      [sid, admin.id, nowISO(), sessionExpiry(),
        req.socket?.remoteAddress || '', str(req.headers['user-agent'], 300)]
    );
    await run('UPDATE admins SET last_login_at = ? WHERE id = ?', [nowISO(), admin.id]);
    await logActivity(admin, 'login', 'Signed in');

    ok(res, { admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } }, {
      'Set-Cookie': serializeCookie(SESSION_COOKIE, sid, { maxAge: SESSION_MAX_AGE })
    });
  });

  router.post('/api/admin/logout', async (req, res) => {
    if (req.sessionId) await run('DELETE FROM sessions WHERE id = ?', [req.sessionId]);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': serializeCookie(SESSION_COOKIE, '', { maxAge: 0 })
    });
    res.end(JSON.stringify({ ok: true }));
  });

  router.get('/api/admin/me', async (req, res) => {
    ok(res, { admin: req.admin, settings: await getSettings() });
  });

  router.post('/api/admin/password', async (req, res) => {
    const b = await readBody(req);
    const admin = await get('SELECT * FROM admins WHERE id = ?', [req.admin.id]);
    if (!verifyPassword(String(b.current || ''), admin.password_hash))
      return fail(res, 400, 'Your current password is not correct.');
    const next = String(b.password || '');
    if (next.length < 8) return fail(res, 400, 'Use at least 8 characters.');
    await run('UPDATE admins SET password_hash = ? WHERE id = ?', [hashPassword(next).hash, admin.id]);
    await run('DELETE FROM sessions WHERE admin_id = ? AND id <> ?', [admin.id, req.sessionId || '']);
    await logActivity(req.admin, 'password_change', 'Password updated');
    ok(res, { message: 'Password updated. Other devices have been signed out.' });
  });

  /* ---------------- dashboard ---------------- */

  router.get('/api/admin/analytics', async (req, res) => {
    const days = Math.min(365, Math.max(1, intOr(req.url_parsed.searchParams.get('days'), 30)));
    ok(res, await buildAnalytics(days));
  });

  router.get('/api/admin/overview', async (req, res) => {
    ok(res, {
      recent_orders: await all(
        `SELECT id, order_no, ship_name, total, status, payment_status, created_at
         FROM orders ORDER BY id DESC LIMIT 8`),
      activity: await all(
        'SELECT admin_name, action, detail, created_at FROM activity_log ORDER BY id DESC LIMIT 12')
    });
  });

  /* ---------------- products ---------------- */

  router.get('/api/admin/products', async (req, res) => {
    const u = req.url_parsed.searchParams;
    const q = str(u.get('q'), 80);
    const where = [];
    const args = [];
    if (q) { where.push('(p.name ILIKE ? OR p.sku ILIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    if (u.get('status') === 'active') where.push('p.active = 1');
    if (u.get('status') === 'hidden') where.push('p.active = 0');
    if (u.get('status') === 'low') {
      where.push('p.stock <= ?');
      args.push(Number((await getSettings()).low_stock_threshold || 5));
    }

    ok(res, {
      products: await all(
        `SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC`, args),
      categories: await all('SELECT * FROM categories ORDER BY sort_order, name')
    });
  });

  const MAX_PRODUCT_PHOTOS = 12;

  /** Accept `images` as an array or JSON string; fall back to a lone `image_url`. */
  const imagesFrom = (b) => {
    let list = b.images;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
    if (!Array.isArray(list)) list = [];
    list = [...new Set(list.map((u) => str(u, 500)).filter(Boolean))].slice(0, MAX_PRODUCT_PHOTOS);
    if (!list.length && str(b.image_url, 500)) list = [str(b.image_url, 500)];
    return list;
  };

  /** Delete uploaded files no product or slide refers to any more. */
  const dropUnusedUploads = async (urls) => {
    for (const url of urls) {
      if (!isOwnUpload(url)) continue;
      const used = await get(
        `SELECT (SELECT COUNT(*)::int FROM products WHERE image_url = ? OR images LIKE ?)
              + (SELECT COUNT(*)::int FROM hero_slides WHERE image_url = ?) AS c`,
        [url, `%${JSON.stringify(url)}%`, url]);
      if (used.c === 0) await deleteUpload(url);
    }
  };

  const productPayload = (b, existing = {}) => ({
    ...(() => {
      const images = imagesFrom(b);
      return { images: JSON.stringify(images), image_url: images[0] || null };
    })(),
    name: str(b.name, 140) || existing.name,
    description: str(b.description, 4000),
    category_id: intOr(b.category_id, 0) || null,
    price: round2(numOr(b.price, 0)),
    old_price: b.old_price === '' || b.old_price === null || b.old_price === undefined
      ? null : round2(numOr(b.old_price, 0)),
    cost: round2(numOr(b.cost, 0)),
    stock: Math.max(0, intOr(b.stock, 0)),
    sku: str(b.sku, 40),
    palette: str(b.palette, 20) || 'rose',
    seed: intOr(b.seed, Math.floor(Math.random() * 9999)),
    bloom_count: Math.max(1, Math.min(9, intOr(b.bloom_count, 4))),
    badge: str(b.badge, 40) || null,
    featured: bool01(b.featured),
    active: bool01(b.active)
  });

  router.post('/api/admin/products', async (req, res) => {
    const b = await readBody(req);
    if (!str(b.name)) return fail(res, 400, 'A product needs a name.');
    const p = productPayload(b);
    let slug = slugify(p.name);
    if (await get('SELECT 1 FROM products WHERE slug = ?', [slug])) slug += '-' + Date.now().toString(36);
    const t = nowISO();

    const r = await run(
      `INSERT INTO products
       (name, slug, description, category_id, price, old_price, cost, stock, sku, palette, seed,
        bloom_count, image_url, images, badge, featured, active, sold, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?) RETURNING id`,
      [p.name, slug, p.description, p.category_id, p.price, p.old_price, p.cost, p.stock, p.sku,
        p.palette, p.seed, p.bloom_count, p.image_url, p.images, p.badge, p.featured, p.active, t, t]);

    await logActivity(req.admin, 'product_create', p.name);
    ok(res, { id: r.rows[0]?.id, message: `"${p.name}" added.` });
  });

  router.put('/api/admin/products/:id', async (req, res, { params }) => {
    const existing = await get('SELECT * FROM products WHERE id = ?', [intOr(params.id)]);
    if (!existing) return fail(res, 404, 'Product not found');
    const b = await readBody(req);
    const p = productPayload(b, existing);

    await run(
      `UPDATE products SET name=?, description=?, category_id=?, price=?, old_price=?,
       cost=?, stock=?, sku=?, palette=?, seed=?, bloom_count=?, image_url=?, images=?, badge=?,
       featured=?, active=?, updated_at=? WHERE id=?`,
      [p.name, p.description, p.category_id, p.price, p.old_price, p.cost, p.stock, p.sku,
        p.palette, p.seed, p.bloom_count, p.image_url, p.images, p.badge, p.featured, p.active,
        nowISO(), existing.id]);

    // Photos that were removed and are no longer referenced anywhere can go.
    const kept = new Set(JSON.parse(p.images));
    await dropUnusedUploads(productImages(existing).filter((u) => !kept.has(u)));

    await logActivity(req.admin, 'product_update', p.name);
    ok(res, { message: `"${p.name}" saved.` });
  });

  router.delete('/api/admin/products/:id', async (req, res, { params }) => {
    const p = await get('SELECT * FROM products WHERE id = ?', [intOr(params.id)]);
    if (!p) return fail(res, 404, 'Product not found');
    const ordered = await get('SELECT COUNT(*)::int AS c FROM order_items WHERE product_id = ?', [p.id]);
    if (ordered.c > 0) {
      // Keep the sales history intact — hide it from the shop instead.
      await run('UPDATE products SET active = 0, updated_at = ? WHERE id = ?', [nowISO(), p.id]);
      await logActivity(req.admin, 'product_hide', p.name);
      return ok(res, { message: `"${p.name}" has past orders, so it was hidden rather than deleted.` });
    }
    await run('DELETE FROM products WHERE id = ?', [p.id]);
    await logActivity(req.admin, 'product_delete', p.name);
    ok(res, { message: `"${p.name}" deleted.` });
  });

  /* ---------------- photo upload ---------------- */

  router.post('/api/admin/upload', async (req, res) => {
    let buf;
    try {
      buf = await readRawBody(req, MAX_UPLOAD);
    } catch {
      return fail(res, 413, 'That image is larger than 6 MB. Please pick a smaller one.');
    }
    if (!buf.length) return fail(res, 400, 'No image was received.');

    const kind = sniffImage(buf);
    if (!kind) return fail(res, 415, 'That file is not an image we can use. Try a JPG, PNG or WebP.');

    const saved = await saveUpload(buf, kind.ext, kind.mime);
    await logActivity(req.admin, 'photo_upload', `${Math.round(saved.bytes / 1024)} KB`);
    ok(res, { url: saved.url, bytes: saved.bytes, type: kind.mime });
  });

  router.post('/api/admin/upload/delete', async (req, res) => {
    const b = await readBody(req);
    const url = str(b.url, 500);
    if (!isOwnUpload(url)) return fail(res, 400, 'That is not an uploaded photo.');

    const stillUsed = await get('SELECT COUNT(*)::int AS c FROM products WHERE image_url = ? OR images LIKE ?',
      [url, `%${JSON.stringify(url)}%`]);
    if (stillUsed.c > 0) return ok(res, { message: 'Photo is still used by a product; kept.' });

    await deleteUpload(url);
    await logActivity(req.admin, 'photo_delete', url.slice(-30));
    ok(res, { message: 'Photo deleted.' });
  });

  /* ---------------- bulk actions ---------------- */

  /**
   * One request, one transaction, for an action applied to many rows. Doing this
   * client-side as N calls would be slower and could half-apply if the
   * connection dropped part way through.
   */
  router.post('/api/admin/bulk', async (req, res) => {
    const b = await readBody(req);
    const entity = str(b.entity, 20);
    const action = str(b.action, 30);
    const value = str(b.value, 30);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map((i) => intOr(i, 0)).filter(Boolean);

    if (!ids.length) return fail(res, 400, 'Nothing was selected.');
    if (ids.length > 500) return fail(res, 400, 'Too many rows at once — select up to 500.');

    // Reject unknown targets before doing any work — otherwise a bad request
    // still costs a snapshot.
    const BULK_ENTITIES = new Set(['orders', 'products', 'reviews', 'messages', 'coupons']);
    if (!BULK_ENTITIES.has(entity)) return fail(res, 400, 'That bulk action is not available.');

    const slots = ids.map(() => '?').join(',');

    // Anything that removes rows gets a snapshot first, so a mis-click is
    // always recoverable.
    let snapshot = null;
    if (action === 'delete') snapshot = await takeSnapshot(`bulk-${entity}-delete`);

    let affected = 0;
    let message = '';

    try {
      await transaction(async (tx) => {
        switch (`${entity}:${action}`) {
          case 'orders:status': {
            if (!ORDER_STATUSES.includes(value)) throw new Error('Unknown order status.');
            for (const o of await tx.all(`SELECT * FROM orders WHERE id IN (${slots})`, ids)) {
              await applyOrderStatus(tx, o, value, req.admin.name, `Bulk update by ${req.admin.name}`);
              affected++;
            }
            message = `${plural(affected, 'order', 'orders')} marked ${value}.`;
            break;
          }
          case 'orders:payment': {
            if (!PAYMENT_STATUSES.includes(value)) throw new Error('Unknown payment status.');
            const r = await tx.run(
              `UPDATE orders SET payment_status = ?, updated_at = ? WHERE id IN (${slots})`,
              [value, nowISO(), ...ids]);
            affected = r.rowCount;
            message = `${plural(affected, 'order', 'orders')} marked ${value}.`;
            break;
          }
          case 'orders:delete': {
            for (const o of await tx.all(`SELECT * FROM orders WHERE id IN (${slots})`, ids)) {
              await restoreStockForDeletedOrder(tx, o);
              affected++;
            }
            await tx.run(`DELETE FROM orders WHERE id IN (${slots})`, ids);
            message = `${plural(affected, 'order', 'orders')} deleted and their stock returned.`;
            break;
          }

          case 'products:visibility': {
            const active = value === 'show' ? 1 : 0;
            const r = await tx.run(
              `UPDATE products SET active = ?, updated_at = ? WHERE id IN (${slots})`,
              [active, nowISO(), ...ids]);
            affected = r.rowCount;
            message = `${plural(affected, 'product', 'products')} ${active ? 'now visible in the shop' : 'hidden from the shop'}.`;
            break;
          }
          case 'products:featured': {
            const featured = value === 'on' ? 1 : 0;
            const r = await tx.run(
              `UPDATE products SET featured = ?, updated_at = ? WHERE id IN (${slots})`,
              [featured, nowISO(), ...ids]);
            affected = r.rowCount;
            message = `${plural(affected, 'product', 'products')} ${featured ? 'featured on the home page' : 'removed from the home page'}.`;
            break;
          }
          case 'products:delete': {
            // Anything with sales history is hidden instead, so past orders stay readable.
            let hidden = 0;
            for (const id of ids) {
              const used = await tx.get('SELECT COUNT(*)::int AS c FROM order_items WHERE product_id = ?', [id]);
              if (used.c > 0) {
                await tx.run('UPDATE products SET active = 0, updated_at = ? WHERE id = ?', [nowISO(), id]);
                hidden++;
              } else {
                affected += (await tx.run('DELETE FROM products WHERE id = ?', [id])).rowCount;
              }
            }
            message = hidden
              ? `${plural(hidden, 'product is', 'products are')} on past orders, so ${hidden === 1 ? 'it was' : 'they were'} hidden from the shop instead of deleted — that keeps your sales figures correct.${affected ? ` ${plural(affected, 'other was', 'others were')} deleted.` : ''}`
              : `${plural(affected, 'product', 'products')} deleted.`;
            break;
          }

          case 'reviews:status': {
            if (!['approved', 'rejected', 'pending'].includes(value)) throw new Error('Unknown review status.');
            affected = (await tx.run(`UPDATE reviews SET status = ? WHERE id IN (${slots})`, [value, ...ids])).rowCount;
            message = `${plural(affected, 'review', 'reviews')} ${value}.`;
            break;
          }
          case 'reviews:delete': {
            affected = (await tx.run(`DELETE FROM reviews WHERE id IN (${slots})`, ids)).rowCount;
            message = `${plural(affected, 'review', 'reviews')} deleted.`;
            break;
          }

          case 'messages:status': {
            if (!['new', 'read', 'replied', 'archived'].includes(value)) throw new Error('Unknown status.');
            affected = (await tx.run(`UPDATE messages SET status = ? WHERE id IN (${slots})`, [value, ...ids])).rowCount;
            message = `${plural(affected, 'message', 'messages')} marked ${value}.`;
            break;
          }
          case 'messages:delete': {
            affected = (await tx.run(`DELETE FROM messages WHERE id IN (${slots})`, ids)).rowCount;
            message = `${plural(affected, 'message', 'messages')} deleted.`;
            break;
          }

          case 'coupons:active': {
            const active = value === 'on' ? 1 : 0;
            affected = (await tx.run(`UPDATE coupons SET active = ? WHERE id IN (${slots})`, [active, ...ids])).rowCount;
            message = `${plural(affected, 'code', 'codes')} ${active ? 'switched on' : 'switched off'}.`;
            break;
          }
          case 'coupons:delete': {
            affected = (await tx.run(`DELETE FROM coupons WHERE id IN (${slots})`, ids)).rowCount;
            message = `${plural(affected, 'code', 'codes')} deleted.`;
            break;
          }

          default:
            throw new Error('That bulk action is not available.');
        }
      });
    } catch (err) {
      return fail(res, 400, err.message || 'Bulk action failed — nothing was changed.');
    }

    await logActivity(req.admin, `bulk_${entity}_${action}`, `${ids.length} selected · ${value || '—'}`);
    ok(res, { affected, message, snapshot: snapshot?.id ?? null });
  });

  router.post('/api/admin/customers/emails', async (req, res) => {
    const b = await readBody(req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map((i) => intOr(i, 0)).filter(Boolean);
    if (!ids.length) return fail(res, 400, 'Nothing was selected.');
    const rows = await all(`SELECT email FROM customers WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    ok(res, { emails: rows.map((r) => r.email) });
  });

  /* ---------------- categories ---------------- */

  router.get('/api/admin/categories', async (req, res) => {
    ok(res, {
      categories: await all(
        `SELECT c.*, (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id) AS product_count
         FROM categories c ORDER BY sort_order, name`)
    });
  });

  router.post('/api/admin/categories', async (req, res) => {
    const b = await readBody(req);
    const name = str(b.name, 60);
    if (!name) return fail(res, 400, 'A category needs a name.');
    let slug = slugify(name);
    if (await get('SELECT 1 FROM categories WHERE slug = ?', [slug])) slug += '-' + Date.now().toString(36);
    await run('INSERT INTO categories(name, slug, icon, color, sort_order, active) VALUES(?,?,?,?,?,?)',
      [name, slug, str(b.icon, 20) || 'flower', str(b.color, 20) || '#F2C9D9',
        intOr(b.sort_order, 0), bool01(b.active ?? 1)]);
    await logActivity(req.admin, 'category_create', name);
    ok(res, { message: `Category "${name}" added.` });
  });

  router.put('/api/admin/categories/:id', async (req, res, { params }) => {
    const b = await readBody(req);
    const c = await get('SELECT * FROM categories WHERE id = ?', [intOr(params.id)]);
    if (!c) return fail(res, 404, 'Category not found');
    await run('UPDATE categories SET name=?, icon=?, color=?, sort_order=?, active=? WHERE id=?',
      [str(b.name, 60) || c.name, str(b.icon, 20) || c.icon, str(b.color, 20) || c.color,
        intOr(b.sort_order, c.sort_order), bool01(b.active), c.id]);
    await logActivity(req.admin, 'category_update', c.name);
    ok(res, { message: 'Category saved.' });
  });

  router.delete('/api/admin/categories/:id', async (req, res, { params }) => {
    const c = await get('SELECT * FROM categories WHERE id = ?', [intOr(params.id)]);
    if (!c) return fail(res, 404, 'Category not found');
    await run('DELETE FROM categories WHERE id = ?', [c.id]);
    await logActivity(req.admin, 'category_delete', c.name);
    ok(res, { message: `Category "${c.name}" deleted. Its products are now uncategorised.` });
  });

  /* ---------------- orders ---------------- */

  router.get('/api/admin/orders', async (req, res) => {
    const u = req.url_parsed.searchParams;
    const where = [];
    const args = [];
    const status = str(u.get('status'), 20);
    if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
    const q = str(u.get('q'), 80);
    if (q) {
      where.push('(order_no ILIKE ? OR ship_name ILIKE ? OR ship_email ILIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const limit = Math.min(200, intOr(u.get('limit'), 50));
    const offset = Math.max(0, intOr(u.get('offset'), 0));
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [orders, total, counts] = await Promise.all([
      all(`SELECT id, order_no, ship_name, ship_email, total, status, payment_status, payment_method,
                  created_at,
                  (SELECT COALESCE(SUM(qty),0)::int FROM order_items WHERE order_id = orders.id) AS items
           FROM orders ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]),
      get(`SELECT COUNT(*)::int AS c FROM orders ${clause}`, args),
      all('SELECT status, COUNT(*)::int AS n FROM orders GROUP BY status')
    ]);

    ok(res, {
      orders,
      total: total.c,
      counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
      statuses: ORDER_STATUSES
    });
  });

  router.get('/api/admin/orders/:id', async (req, res, { params }) => {
    const o = await get('SELECT * FROM orders WHERE id = ?', [intOr(params.id)]);
    if (!o) return fail(res, 404, 'Order not found');
    ok(res, {
      order: o,
      items: await all('SELECT * FROM order_items WHERE order_id = ?', [o.id]),
      timeline: await all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', [o.id]),
      customer: o.customer_id ? await get('SELECT * FROM customers WHERE id = ?', [o.customer_id]) : null,
      customer_orders: o.customer_id
        ? await get('SELECT COUNT(*)::int AS n, ROUND(COALESCE(SUM(total),0)::numeric,2)::float8 AS spent FROM orders WHERE customer_id = ?', [o.customer_id])
        : { n: 0, spent: 0 },
      statuses: ORDER_STATUSES,
      currency: (await getSettings()).currency_symbol
    });
  });

  router.put('/api/admin/orders/:id', async (req, res, { params }) => {
    const o = await get('SELECT * FROM orders WHERE id = ?', [intOr(params.id)]);
    if (!o) return fail(res, 404, 'Order not found');
    const b = await readBody(req);

    const status = ORDER_STATUSES.includes(b.status) ? b.status : o.status;
    const paymentStatus = PAYMENT_STATUSES.includes(b.payment_status) ? b.payment_status : o.payment_status;

    await transaction(async (tx) => {
      await applyOrderStatus(tx, o, status, req.admin.name, str(b.event_note, 300));
      await tx.run('UPDATE orders SET payment_status = ?, note = ?, updated_at = ? WHERE id = ?',
        [paymentStatus, str(b.note, 1000), nowISO(), o.id]);
    });

    await logActivity(req.admin, 'order_update', `${o.order_no} → ${status}`);
    ok(res, { message: `Order ${o.order_no} updated.` });
  });

  router.delete('/api/admin/orders/:id', async (req, res, { params }) => {
    const o = await get('SELECT * FROM orders WHERE id = ?', [intOr(params.id)]);
    if (!o) return fail(res, 404, 'Order not found');
    await takeSnapshot('order-delete');
    await transaction(async (tx) => {
      await restoreStockForDeletedOrder(tx, o);
      await tx.run('DELETE FROM orders WHERE id = ?', [o.id]);
    });
    await logActivity(req.admin, 'order_delete', o.order_no);
    ok(res, { message: `Order ${o.order_no} deleted.` });
  });

  /* ---------------- customers ---------------- */

  router.get('/api/admin/customers', async (req, res) => {
    const q = str(req.url_parsed.searchParams.get('q'), 80);
    const clause = q ? 'WHERE c.name ILIKE ? OR c.email ILIKE ?' : '';
    const args = q ? [`%${q}%`, `%${q}%`] : [];
    ok(res, {
      customers: await all(
        `SELECT c.*,
          (SELECT COUNT(*)::int FROM orders o WHERE o.customer_id = c.id) AS orders,
          (SELECT ROUND(COALESCE(SUM(o.total),0)::numeric,2)::float8 FROM orders o
             WHERE o.customer_id = c.id AND o.status IN ${REVENUE_STATUSES}) AS spent,
          (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = c.id) AS last_order
         FROM customers c ${clause} ORDER BY spent DESC NULLS LAST, c.id DESC LIMIT 300`, args)
    });
  });

  router.get('/api/admin/customers/:id', async (req, res, { params }) => {
    const c = await get('SELECT * FROM customers WHERE id = ?', [intOr(params.id)]);
    if (!c) return fail(res, 404, 'Customer not found');
    ok(res, {
      customer: c,
      orders: await all('SELECT id, order_no, total, status, created_at FROM orders WHERE customer_id = ? ORDER BY id DESC', [c.id])
    });
  });

  router.put('/api/admin/customers/:id', async (req, res, { params }) => {
    const c = await get('SELECT * FROM customers WHERE id = ?', [intOr(params.id)]);
    if (!c) return fail(res, 404, 'Customer not found');
    const b = await readBody(req);
    await run('UPDATE customers SET name=?, phone=?, address=?, city=?, postcode=?, country=?, notes=? WHERE id=?',
      [str(b.name, 120) || c.name, str(b.phone, 40), str(b.address, 300), str(b.city, 80),
        str(b.postcode, 20), str(b.country, 80), str(b.notes, 1000), c.id]);
    await logActivity(req.admin, 'customer_update', c.email);
    ok(res, { message: 'Customer saved.' });
  });

  /* ---------------- coupons ---------------- */

  router.get('/api/admin/coupons', async (req, res) => {
    ok(res, { coupons: await all('SELECT * FROM coupons ORDER BY id DESC') });
  });

  router.post('/api/admin/coupons', async (req, res) => {
    const b = await readBody(req);
    const code = str(b.code, 30).toUpperCase().replace(/\s+/g, '');
    if (!code) return fail(res, 400, 'A coupon needs a code.');
    if (await get('SELECT 1 FROM coupons WHERE UPPER(code) = ?', [code]))
      return fail(res, 409, 'That code already exists.');
    await run(
      `INSERT INTO coupons(code, type, value, min_subtotal, max_uses, used_count, expires_at, active, created_at)
       VALUES(?,?,?,?,?,0,?,?,?)`,
      [code, b.type === 'fixed' ? 'fixed' : 'percent', numOr(b.value, 0), numOr(b.min_subtotal, 0),
        intOr(b.max_uses, 0), str(b.expires_at, 40) || null, bool01(b.active ?? 1), nowISO()]);
    await logActivity(req.admin, 'coupon_create', code);
    ok(res, { message: `Coupon ${code} created.` });
  });

  router.put('/api/admin/coupons/:id', async (req, res, { params }) => {
    const c = await get('SELECT * FROM coupons WHERE id = ?', [intOr(params.id)]);
    if (!c) return fail(res, 404, 'Coupon not found');
    const b = await readBody(req);
    await run('UPDATE coupons SET type=?, value=?, min_subtotal=?, max_uses=?, expires_at=?, active=? WHERE id=?',
      [b.type === 'fixed' ? 'fixed' : 'percent', numOr(b.value, c.value), numOr(b.min_subtotal, c.min_subtotal),
        intOr(b.max_uses, c.max_uses), str(b.expires_at, 40) || null, bool01(b.active), c.id]);
    await logActivity(req.admin, 'coupon_update', c.code);
    ok(res, { message: `Coupon ${c.code} saved.` });
  });

  router.delete('/api/admin/coupons/:id', async (req, res, { params }) => {
    const c = await get('SELECT * FROM coupons WHERE id = ?', [intOr(params.id)]);
    if (!c) return fail(res, 404, 'Coupon not found');
    await run('DELETE FROM coupons WHERE id = ?', [c.id]);
    await logActivity(req.admin, 'coupon_delete', c.code);
    ok(res, { message: `Coupon ${c.code} deleted.` });
  });

  /* ---------------- reviews ---------------- */

  router.get('/api/admin/reviews', async (req, res) => {
    const status = str(req.url_parsed.searchParams.get('status'), 20);
    const clause = status && status !== 'all' ? 'WHERE r.status = ?' : '';
    ok(res, {
      reviews: await all(
        `SELECT r.*, p.name AS product FROM reviews r LEFT JOIN products p ON p.id = r.product_id
         ${clause} ORDER BY r.id DESC LIMIT 200`, clause ? [status] : []),
      counts: Object.fromEntries(
        (await all('SELECT status, COUNT(*)::int AS n FROM reviews GROUP BY status')).map((r) => [r.status, r.n]))
    });
  });

  router.put('/api/admin/reviews/:id', async (req, res, { params }) => {
    const b = await readBody(req);
    const status = ['pending', 'approved', 'rejected'].includes(b.status) ? b.status : 'pending';
    const r = await get('SELECT * FROM reviews WHERE id = ?', [intOr(params.id)]);
    if (!r) return fail(res, 404, 'Review not found');
    await run('UPDATE reviews SET status = ? WHERE id = ?', [status, r.id]);
    await logActivity(req.admin, 'review_' + status, r.name);
    ok(res, { message: `Review ${status}.` });
  });

  router.delete('/api/admin/reviews/:id', async (req, res, { params }) => {
    await run('DELETE FROM reviews WHERE id = ?', [intOr(params.id)]);
    await logActivity(req.admin, 'review_delete', params.id);
    ok(res, { message: 'Review deleted.' });
  });

  /* ---------------- messages & subscribers ---------------- */

  router.get('/api/admin/messages', async (req, res) => {
    const [messages, subscribers, newCount] = await Promise.all([
      all('SELECT * FROM messages ORDER BY id DESC LIMIT 200'),
      all('SELECT * FROM subscribers ORDER BY id DESC LIMIT 500'),
      get(`SELECT COUNT(*)::int AS n FROM messages WHERE status='new'`)
    ]);
    ok(res, { messages, subscribers, new_count: newCount.n });
  });

  router.put('/api/admin/messages/:id', async (req, res, { params }) => {
    const b = await readBody(req);
    const status = ['new', 'read', 'replied', 'archived'].includes(b.status) ? b.status : 'read';
    await run('UPDATE messages SET status = ? WHERE id = ?', [status, intOr(params.id)]);
    ok(res, { message: `Marked ${status}.` });
  });

  router.delete('/api/admin/messages/:id', async (req, res, { params }) => {
    await run('DELETE FROM messages WHERE id = ?', [intOr(params.id)]);
    ok(res, { message: 'Message deleted.' });
  });

  /* ---------------- home page slideshow ---------------- */

  router.get('/api/admin/hero-slides', async (req, res) => {
    const settings = await getSettings();
    ok(res, {
      slides: await all('SELECT * FROM hero_slides ORDER BY sort_order, id'),
      interval: Number(settings.hero_interval) || 10
    });
  });

  router.post('/api/admin/hero-slides', async (req, res) => {
    const b = await readBody(req);
    const url = str(b.image_url, 500);
    if (!url) return fail(res, 400, 'Upload a photo first.');

    // New slides go on the end.
    const last = await get('SELECT COALESCE(MAX(sort_order), -1)::int AS n FROM hero_slides');
    await run(
      'INSERT INTO hero_slides(image_url, caption, sort_order, active, created_at) VALUES(?,?,?,1,?)',
      [url, str(b.caption, 160), last.n + 1, nowISO()]
    );
    await logActivity(req.admin, 'hero_slide_add', url.slice(-30));
    ok(res, { message: 'Photo added to the slideshow.' });
  });

  router.put('/api/admin/hero-slides/:id', async (req, res, { params }) => {
    const slide = await get('SELECT * FROM hero_slides WHERE id = ?', [intOr(params.id)]);
    if (!slide) return fail(res, 404, 'Slide not found');
    const b = await readBody(req);
    await run('UPDATE hero_slides SET caption = ?, active = ? WHERE id = ?',
      [str(b.caption, 160), bool01(b.active), slide.id]);
    ok(res, { message: 'Slide saved.' });
  });

  /** Accepts the ids in their new order. */
  router.post('/api/admin/hero-slides/reorder', async (req, res) => {
    const b = await readBody(req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map((i) => intOr(i, 0)).filter(Boolean);
    if (!ids.length) return fail(res, 400, 'No order was given.');
    await transaction(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx.run('UPDATE hero_slides SET sort_order = ? WHERE id = ?', [i, id]);
      }
    });
    ok(res, { message: 'Order saved.' });
  });

  router.delete('/api/admin/hero-slides/:id', async (req, res, { params }) => {
    const slide = await get('SELECT * FROM hero_slides WHERE id = ?', [intOr(params.id)]);
    if (!slide) return fail(res, 404, 'Slide not found');
    await run('DELETE FROM hero_slides WHERE id = ?', [slide.id]);

    // Drop the file too, unless a product is also using it.
    if (isOwnUpload(slide.image_url)) {
      const used = await get(
        `SELECT (SELECT COUNT(*)::int FROM products WHERE image_url = ? OR images LIKE ?)
              + (SELECT COUNT(*)::int FROM hero_slides WHERE image_url = ?) AS c`,
        [slide.image_url, `%${JSON.stringify(slide.image_url)}%`, slide.image_url]
      );
      if (used.c === 0) await deleteUpload(slide.image_url);
    }

    await logActivity(req.admin, 'hero_slide_delete', slide.image_url.slice(-30));
    ok(res, { message: 'Photo removed from the slideshow.' });
  });

  /* ---------------- FAQs ---------------- */

  router.get('/api/admin/faqs', async (req, res) => {
    ok(res, { faqs: await all('SELECT * FROM faqs ORDER BY sort_order, id') });
  });

  router.post('/api/admin/faqs', async (req, res) => {
    const b = await readBody(req);
    if (!str(b.question) || !str(b.answer)) return fail(res, 400, 'Both a question and an answer are needed.');
    await run('INSERT INTO faqs(question, answer, sort_order, active) VALUES(?,?,?,?)',
      [str(b.question, 300), str(b.answer, 2000), intOr(b.sort_order, 99), bool01(b.active ?? 1)]);
    await logActivity(req.admin, 'faq_create', str(b.question, 60));
    ok(res, { message: 'Question added.' });
  });

  router.put('/api/admin/faqs/:id', async (req, res, { params }) => {
    const b = await readBody(req);
    const f = await get('SELECT * FROM faqs WHERE id = ?', [intOr(params.id)]);
    if (!f) return fail(res, 404, 'FAQ not found');
    await run('UPDATE faqs SET question=?, answer=?, sort_order=?, active=? WHERE id=?',
      [str(b.question, 300) || f.question, str(b.answer, 2000) || f.answer,
        intOr(b.sort_order, f.sort_order), bool01(b.active), f.id]);
    ok(res, { message: 'Question saved.' });
  });

  router.delete('/api/admin/faqs/:id', async (req, res, { params }) => {
    await run('DELETE FROM faqs WHERE id = ?', [intOr(params.id)]);
    ok(res, { message: 'Question deleted.' });
  });

  /* ---------------- settings ---------------- */

  router.get('/api/admin/settings', async (req, res) => {
    ok(res, { settings: await getSettings(), defaults: DEFAULT_SETTINGS });
  });

  router.put('/api/admin/settings', async (req, res) => {
    const b = await readBody(req);
    let n = 0;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in b) { await setSetting(key, str(b[key], 2000)); n++; }
    }
    await logActivity(req.admin, 'settings_update', `${n} settings`);
    ok(res, { message: 'Shop settings saved.', settings: await getSettings() });
  });

  /* ---------------- snapshots ---------------- */

  router.get('/api/admin/backups', async (req, res) => {
    ok(res, { backups: await listSnapshots() });
  });

  router.post('/api/admin/backups', async (req, res) => {
    const snap = await takeSnapshot('manual');
    if (!snap) return fail(res, 500, 'Could not write a snapshot.');
    await logActivity(req.admin, 'backup_create', String(snap.id));
    ok(res, { message: `Snapshot saved (${Math.round(snap.bytes / 1024)} KB).`, ...snap });
  });

  router.get('/api/admin/backups/:id', async (req, res, { params }) => {
    const snap = await readSnapshot(intOr(params.id));
    if (!snap) return fail(res, 404, 'That snapshot no longer exists.');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="maya-flora-${snap.created_at.slice(0, 19).replace(/[:]/g, '-')}.json"`,
      'Content-Length': Buffer.byteLength(snap.json)
    });
    res.end(snap.json);
  });

  /* ---------------- exports ---------------- */

  router.get('/api/admin/export/:what', async (req, res, { params }) => {
    const stamp = new Date().toISOString().slice(0, 10);
    switch (params.what) {
      case 'orders':
        return sendCSV(res, `orders-${stamp}.csv`, await all(
          `SELECT order_no, created_at, ship_name, ship_email, ship_phone, ship_address, ship_city,
                  ship_postcode, ship_country, subtotal, discount, shipping, total, coupon_code,
                  status, payment_method, payment_status FROM orders ORDER BY id DESC`));
      case 'order-items':
        return sendCSV(res, `order-items-${stamp}.csv`, await all(
          `SELECT o.order_no, o.created_at, i.name, i.qty, i.unit_price, i.line_total, o.status
           FROM order_items i JOIN orders o ON o.id = i.order_id ORDER BY o.id DESC`));
      case 'products':
        return sendCSV(res, `products-${stamp}.csv`, await all(
          `SELECT p.sku, p.name, c.name AS category, p.price, p.old_price, p.cost, p.stock, p.sold,
                  p.active, p.featured FROM products p LEFT JOIN categories c ON c.id = p.category_id
           ORDER BY p.id`));
      case 'customers':
        return sendCSV(res, `customers-${stamp}.csv`, await all(
          `SELECT c.name, c.email, c.phone, c.city, c.country, c.created_at,
                  (SELECT COUNT(*)::int FROM orders o WHERE o.customer_id = c.id) AS orders,
                  (SELECT ROUND(COALESCE(SUM(o.total),0)::numeric,2)::float8 FROM orders o WHERE o.customer_id = c.id) AS spent
           FROM customers c ORDER BY spent DESC NULLS LAST`));
      case 'subscribers':
        return sendCSV(res, `subscribers-${stamp}.csv`,
          await all('SELECT email, active, created_at FROM subscribers ORDER BY id DESC'));
      default:
        return fail(res, 404, 'Nothing to export by that name.');
    }
  });

  /* ---------------- demo data ---------------- */

  router.post('/api/admin/demo-data', async (req, res) => {
    const b = await readBody(req);
    if (b.action === 'clear') {
      if (req.admin.role !== 'owner') return fail(res, 403, 'Only the shop owner can reset the shop.');
      // The snapshot is the only way back, so refuse to go on without one.
      if (!await takeSnapshot('before-reset'))
        return fail(res, 500, 'Could not take a safety snapshot first, so nothing was deleted.');

      await transaction(async (tx) => {
        // Orders still holding stock give it back before they disappear.
        const held = await tx.all(
          `SELECT oi.product_id, SUM(oi.qty)::int AS qty FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE o.status NOT IN ('cancelled','refunded') AND oi.product_id IS NOT NULL
           GROUP BY oi.product_id`);
        for (const h of held)
          await tx.run('UPDATE products SET stock = stock + ? WHERE id = ?', [h.qty, h.product_id]);
        await tx.run('UPDATE products SET sold = 0');
        await tx.run('UPDATE coupons SET used_count = 0');
      });
      // RESTART IDENTITY so order numbers begin again from the first one.
      await exec('TRUNCATE order_items, order_events, orders, customers, events, activity_log RESTART IDENTITY');
      await logActivity(req.admin, 'shop_reset', 'Orders, customers and analytics reset');
      return ok(res, { message: 'Shop reset — orders, customers and analytics cleared. A snapshot was saved first.' });
    }
    const made = await generateDemoData(Math.min(180, intOr(b.days, 60)));
    await logActivity(req.admin, 'demo_seed', `${made.orders} sample orders`);
    ok(res, { message: `Generated ${made.orders} sample orders across ${made.days} days.` });
  });
}

/* ================================================================== */
/* Demo data — batched, because every round trip costs on a remote DB  */
/* ================================================================== */

/** Insert `rows` (arrays of values) with one multi-row INSERT per chunk. */
async function bulkInsert(q, table, columns, rows, { chunk = 250, conflict = '' } = {}) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values = slice.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    await q.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${values} ${conflict}`, slice.flat());
  }
}

export async function generateDemoData(days = 60) {
  const products = await all('SELECT * FROM products WHERE active = 1');
  if (!products.length) return { orders: 0, days };

  const settings = await getSettings();
  const firstNames = ['Marie', 'Owen', 'Priya', 'Jonas', 'Amelia', 'Luca', 'Sofie', 'Noah', 'Ingrid', 'Mateo',
    'Freya', 'Elias', 'Nadia', 'Tomas', 'Clara', 'Hugo', 'Lena', 'Oscar', 'Aisha', 'Viktor'];
  const lastNames = ['Kristensen', 'Thomas', 'Sharma', 'Berg', 'Reid', 'Rossi', 'Holm', 'Weber', 'Lund',
    'Garcia', 'Nyman', 'Falk', 'Haddad', 'Novak', 'Bauer', 'Moreau', 'Sato', 'Dahl', 'Okafor', 'Petrov'];
  const cities = [['Copenhagen', 'DK'], ['Aarhus', 'DK'], ['London', 'UK'], ['Manchester', 'UK'],
    ['Berlin', 'DE'], ['Toronto', 'CA'], ['Dublin', 'IE'], ['Amsterdam', 'NL'], ['Oslo', 'NO'], ['Paris', 'FR']];
  const statuses = ['delivered', 'delivered', 'delivered', 'shipped', 'packing', 'confirmed', 'pending', 'cancelled'];
  const payments = String(settings.payment_methods).split(',').filter(Boolean);
  const prefix = settings.order_prefix || 'FB';
  const freeOver = Number(settings.free_shipping_over || 120);
  const flatShip = Number(settings.shipping_flat || 9);

  let rnd = 20240515;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rand() * a.length)];

  /* --- build everything in memory first --- */
  const customerRows = new Map();   // email -> row
  const eventRows = [];
  const plannedOrders = [];

  for (let d = days - 1; d >= 0; d--) {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - d);

    const trend = 1 + (days - d) / days;
    const weekendLift = [0, 6].includes(day.getUTCDay()) ? 1.45 : 1;
    const perDay = Math.max(0, Math.round((0.8 + rand() * 2.4) * trend * weekendLift));

    const views = Math.round(perDay * (18 + rand() * 26));
    const dayStr = day.toISOString().slice(0, 10);
    for (let v = 0; v < views; v++) {
      const at = new Date(Math.min(day.getTime() + Math.floor(rand() * 864e5), Date.now())).toISOString();
      const key = `v${dayStr}-${Math.floor(rand() * views)}`;
      eventRows.push(['pageview', '/', null, key, pick(['', 'instagram.com', 'google.com', 'facebook.com']), 0, at]);
      if (rand() < 0.55) eventRows.push(['product_view', '/product', pick(products).id, key, '', 0, at]);
      if (rand() < 0.22) eventRows.push(['add_to_cart', '/product', pick(products).id, key, '', 0, at]);
      if (rand() < 0.11) eventRows.push(['begin_checkout', '/checkout', null, key, '', 0, at]);
    }

    for (let i = 0; i < perDay; i++) {
      const hour = 8 + Math.floor(rand() * 14);
      const at = new Date(Math.min(day.getTime() + hour * 36e5 + Math.floor(rand() * 36e5), Date.now())).toISOString();
      const fn = pick(firstNames);
      const ln = pick(lastNames);
      const name = `${fn} ${ln}`;
      const email = `${fn}.${ln}`.toLowerCase() + '@example.com';
      const [city, country] = pick(cities);

      if (!customerRows.has(email)) {
        customerRows.set(email, [email, name, '+45 ' + Math.floor(10000000 + rand() * 89999999),
          `${Math.ceil(rand() * 90)} Blomstervej`, city, String(1000 + Math.floor(rand() * 8999)), country, '', at]);
      }

      const lineCount = 1 + (rand() < 0.35 ? 1 : 0) + (rand() < 0.12 ? 1 : 0);
      const chosen = [];
      for (let l = 0; l < lineCount; l++) {
        const p = pick(products);
        if (!chosen.find((c) => c.id === p.id)) chosen.push(p);
      }

      let subtotal = 0;
      let costTotal = 0;
      const lines = chosen.map((p) => {
        const qty = 1 + (rand() < 0.2 ? 1 : 0);
        const lineTotal = round2(p.price * qty);
        subtotal += lineTotal;
        costTotal += p.cost * qty;
        return { p, qty, lineTotal };
      });
      subtotal = round2(subtotal);

      const useCoupon = rand() < 0.18;
      const discount = useCoupon ? round2(subtotal * 0.1) : 0;
      const shipping = subtotal >= freeOver ? 0 : flatShip;

      plannedOrders.push({
        email, name, city, country, at, lines,
        subtotal, discount, shipping,
        total: round2(subtotal - discount + shipping),
        costTotal: round2(costTotal),
        coupon: useCoupon ? 'WELCOME10' : null,
        status: pick(statuses),
        payment: pick(payments)
      });
    }
  }

  /* --- write it --- */
  await transaction(async (tx) => {
    // Demo names are drawn from a fixed pool, so a shop that already has
    // customers will collide — keep the existing rows.
    await bulkInsert(tx, 'customers',
      ['email', 'name', 'phone', 'address', 'city', 'postcode', 'country', 'notes', 'created_at'],
      [...customerRows.values()], { conflict: 'ON CONFLICT (email) DO NOTHING' });

    const customerIds = new Map(
      (await tx.all('SELECT id, email FROM customers')).map((c) => [c.email, c.id]));

    for (const o of plannedOrders) {
      const oid = await tx.insertReturningId(
        `INSERT INTO orders
         (order_no, customer_id, ship_name, ship_email, ship_phone, ship_address, ship_city,
          ship_postcode, ship_country, subtotal, discount, shipping, total, cost_total,
          coupon_code, status, payment_method, payment_status, note, created_at, updated_at)
         VALUES(?,?,?,?,'','',?,'',?,?,?,?,?,?,?,?,?,?,'',?,?) RETURNING id`,
        ['TMP' + Math.random().toString(36).slice(2, 12), customerIds.get(o.email) ?? null,
          o.name, o.email, o.city, o.country,
          o.subtotal, o.discount, o.shipping, o.total, o.costTotal,
          o.coupon, o.status, o.payment,
          ['delivered', 'shipped'].includes(o.status) ? 'paid' : 'unpaid', o.at, o.at]);

      await tx.run('UPDATE orders SET order_no = ? WHERE id = ?', [`${prefix}-${10000 + oid}`, oid]);

      await bulkInsert(tx, 'order_items',
        ['order_id', 'product_id', 'name', 'unit_price', 'unit_cost', 'qty', 'line_total'],
        o.lines.map((l) => [oid, l.p.id, l.p.name, l.p.price, l.p.cost, l.qty, l.lineTotal]));

      if (!DEAD(o.status)) {
        for (const l of o.lines) {
          await tx.run('UPDATE products SET sold = sold + ? WHERE id = ?', [l.qty, l.p.id]);
        }
      }

      await bulkInsert(tx, 'order_events', ['order_id', 'status', 'note', 'created_at'],
        o.status === 'pending'
          ? [[oid, 'pending', 'Order placed by customer', o.at]]
          : [[oid, 'pending', 'Order placed by customer', o.at],
            [oid, o.status, `Status set to ${o.status}`, o.at]]);

      eventRows.push(['purchase', '/checkout', null, 'demo-buyer-' + oid, '', o.total, o.at]);
    }

    await bulkInsert(tx, 'events',
      ['type', 'path', 'product_id', 'visitor_key', 'referrer', 'value', 'created_at'], eventRows);
  });

  return { orders: plannedOrders.length, days };
}

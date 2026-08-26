/**
 * The request handler, independent of how it is being served.
 *
 * `server.js` wraps this in a node:http server for local use; `api/index.js`
 * hands it straight to Vercel. Keeping it in one place means local and
 * production run identical code.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ready, get as dbGet, run as dbRun } from './db.js';
import { Router, serveStatic, json, fail, send } from './lib/http.js';
import { parseCookies, SESSION_COOKIE } from './auth.js';
import { registerShopRoutes } from './api/shop.js';
import { registerAdminRoutes } from './api/admin.js';
import { bouquetDocument, PALETTES } from '../public/js/bouquet.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PUBLIC_DIR = join(ROOT, 'public');

const router = new Router();
registerShopRoutes(router);
registerAdminRoutes(router);

/* ---- generated product artwork ---------------------------------- */
router.get('/img/bouquet.svg', (req, res) => {
  const u = req.url_parsed.searchParams;
  const svg = bouquetDocument(
    Number(u.get('seed')) || 7,
    u.get('palette') || 'rose',
    Number(u.get('count')) || 4,
    Math.min(1200, Math.max(120, Number(u.get('size')) || 480))
  );
  send(res, 200, svg, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400'
  });
});

router.get('/api/palettes', (req, res) => {
  json(res, 200, {
    palettes: Object.entries(PALETTES).map(([key, v]) => ({ key, label: v.label, colors: v.colors }))
  });
});

router.get('/api/health', async (req, res) => {
  const [products, orders] = await Promise.all([
    dbGet('SELECT COUNT(*)::int AS c FROM products'),
    dbGet('SELECT COUNT(*)::int AS c FROM orders')
  ]);
  json(res, 200, { ok: true, time: new Date().toISOString(), products: products.c, orders: orders.c });
});

/* ---- session resolution ----------------------------------------- */

const PUBLIC_ADMIN_ROUTES = new Set(['/api/admin/login', '/api/admin/logout']);

async function resolveAdmin(req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid) return null;
  const row = await dbGet(
    `SELECT s.id AS sid, s.expires_at, a.id, a.name, a.email, a.role
     FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id = ?`,
    [sid]
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await dbRun('DELETE FROM sessions WHERE id = ?', [sid]);
    return null;
  }
  req.sessionId = row.sid;
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

/* ---- request pipeline -------------------------------------------- */

export async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return fail(res, 400, 'Bad request');
  }
  req.url_parsed = url;
  const pathname = url.pathname;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  try {
    // Schema creation and seeding happen once per process, before anything else.
    await ready();

    const match = router.match(req.method, pathname);

    if (match && match.handler) {
      if (pathname.startsWith('/api/admin') && !PUBLIC_ADMIN_ROUTES.has(pathname)) {
        const admin = await resolveAdmin(req);
        if (!admin) return fail(res, 401, 'Please sign in.');
        req.admin = admin;
      } else if (pathname === '/api/admin/logout') {
        await resolveAdmin(req);
      }
      await match.handler(req, res, { params: match.params });
      return;
    }
    if (match && match.methodMismatch) return fail(res, 405, 'Method not allowed');

    /* --- static & page routes --- */
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/admin' || pathname === '/admin/') {
        if (serveStatic(req, res, PUBLIC_DIR, '/admin/index.html')) return;
      }
      if (serveStatic(req, res, PUBLIC_DIR, pathname)) return;

      // Client-side routed pages fall back to their shell.
      if (!pathname.startsWith('/api/') && !/\.[a-z0-9]{2,5}$/i.test(pathname)) {
        if (pathname.startsWith('/admin')) {
          if (serveStatic(req, res, PUBLIC_DIR, '/admin/index.html')) return;
        }
        if (serveStatic(req, res, PUBLIC_DIR, '/index.html')) return;
      }
    }

    fail(res, 404, 'Not found');
  } catch (err) {
    console.error(`[${req.method} ${pathname}]`, err);
    if (!res.headersSent) fail(res, 500, err.message || 'Something went wrong on our side.');
    else res.end();
  }
}

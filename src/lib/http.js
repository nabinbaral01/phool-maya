/**
 * A very small HTTP toolkit: pattern router, body parsing, JSON + static replies.
 */
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Markup, scripts and styles revalidate on every load. The ETag turns that
 * into a cheap 304, and it means a fix is never left sitting invisible in
 * someone's browser cache.
 */
const CODE_TYPES = new Set(['.html', '.js', '.mjs', '.css', '.json']);

export function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

export function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
}

export const ok = (res, data, headers = {}) => json(res, 200, data, headers);
export const fail = (res, status, message, extra = {}) =>
  json(res, status, { error: message, ...extra });

export async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON body'); }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try { return JSON.parse(raw); } catch { return { raw }; }
}

/** Collect the raw request body as a Buffer — used for binary file uploads. */
export async function readRawBody(req, limit = 6_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Router with `/api/orders/:id` style params. */
export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp(
      '^' +
      pattern
        .replace(/\/+$/, '')
        // Escape regex metacharacters. `/` is not one of them, so the `:param`
        // substitution below still sees plain `/:name` segments.
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\/:([A-Za-z_]\w*)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) +
      '/?$'
    );
    this.routes.push({ method, rx, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathExists = false;
    for (const r of this.routes) {
      const m = r.rx.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return pathExists ? { methodMismatch: true } : null;
  }
}

/** Serve a file from `root`, refusing any path that escapes it. */
export function serveStatic(req, res, root, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const target = normalize(join(root, rel));
  if (!target.startsWith(normalize(root) + sep) && target !== normalize(root)) return false;
  if (!existsSync(target)) return false;

  let stat;
  try { stat = statSync(target); } catch { return false; }
  if (stat.isDirectory()) return serveStatic(req, res, root, rel + '/index.html');

  const ext = extname(target).toLowerCase();
  const isCode = CODE_TYPES.has(ext);
  // Uploads are named by a hash of their contents, so a given URL can never
  // change — those are safe to cache hard.
  const contentAddressed = rel.startsWith('/uploads/');
  const etag = `W/"${stat.size}-${stat.mtimeMs.toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': contentAddressed
      ? 'public, max-age=31536000, immutable'
      : isCode ? 'no-cache' : 'public, max-age=86400'
  });
  createReadStream(target).pipe(res);
  return true;
}

/* ---------- validation helpers ---------- */

export const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
export const numOr = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
export const intOr = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
export const bool01 = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());

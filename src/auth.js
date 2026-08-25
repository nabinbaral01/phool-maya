/**
 * Authentication — scrypt password hashing and server-side sessions.
 * Deliberately dependency-free: everything here comes from node:crypto.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'fb_admin';
const SESSION_DAYS = 14;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { hash: `scrypt$${salt}$${key}` };
}

export function verifyPassword(password, stored) {
  try {
    const [algo, salt, key] = String(stored).split('$');
    if (algo !== 'scrypt' || !salt || !key) return false;
    const candidate = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
    const expected = Buffer.from(key, 'hex');
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export const newSessionId = () => randomBytes(32).toString('hex');

export function sessionExpiry() {
  return new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (typeof maxAge === 'number') c += `; Max-Age=${maxAge}`;
  if (process.env.SECURE_COOKIES === '1') c += '; Secure';
  return c;
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86400;

/** Stable, non-identifying visitor key for storefront analytics. */
export function visitorKey(ip, userAgent) {
  return createHash('sha256')
    .update(`${ip || ''}|${userAgent || ''}|flowerbutik`)
    .digest('hex')
    .slice(0, 24);
}

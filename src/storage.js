/**
 * Product photo storage.
 *
 * Vercel's filesystem is read-only apart from a scratch /tmp that is wiped
 * between invocations, so uploads cannot live next to the code in production.
 *
 *   - with BLOB_READ_WRITE_TOKEN set  → Vercel Blob (a real CDN-backed store)
 *   - without it                      → public/uploads on local disk
 *
 * Both return a URL the browser can use, so nothing above this file cares which
 * one is in play.
 */
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const LOCAL_UPLOAD_DIR = join(ROOT, 'public', 'uploads');

export const usingBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

/**
 * @param {Buffer} buffer  raw file bytes, already validated as an image
 * @param {string} ext     file extension without the dot
 * @param {string} mime    content type
 * @returns {Promise<{url: string, bytes: number}>}
 */
export async function saveUpload(buffer, ext, mime) {
  // Content-addressed: the same photo uploaded twice reuses one object.
  const name = createHash('sha256').update(buffer).digest('hex').slice(0, 20) + '.' + ext;

  if (usingBlob) {
    const { put } = await import('@vercel/blob');
    const blob = await put(`products/${name}`, buffer, {
      access: 'public',
      contentType: mime,
      addRandomSuffix: false,
      cacheControlMaxAge: 31536000
    });
    return { url: blob.url, bytes: buffer.length };
  }

  mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  const target = join(LOCAL_UPLOAD_DIR, name);
  if (!existsSync(target)) writeFileSync(target, buffer);
  return { url: '/uploads/' + name, bytes: buffer.length };
}

/** Remove a previously stored photo. Never throws — deletion is best effort. */
export async function deleteUpload(url) {
  try {
    if (usingBlob && /^https?:\/\//.test(url)) {
      const { del } = await import('@vercel/blob');
      await del(url);
      return true;
    }
    const name = url.startsWith('/uploads/') ? url.slice('/uploads/'.length) : '';
    if (!/^[0-9a-f]{20}\.(jpg|png|gif|webp|avif|heic)$/.test(name)) return false;
    const target = join(LOCAL_UPLOAD_DIR, name);
    if (existsSync(target)) unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

/** True if the URL looks like something this app stored, not an external link. */
export const isOwnUpload = (url) =>
  url.startsWith('/uploads/') || /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//.test(url);

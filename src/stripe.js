/**
 * Stripe Checkout, spoken to over its REST API so there is no SDK to install.
 *
 * Configure with environment variables (never in code or the database):
 *   STRIPE_SECRET_KEY      sk_test_… or sk_live_…   — switches card payment on
 *   STRIPE_WEBHOOK_SECRET  whsec_…                  — lets Stripe confirm payments
 *                                                    even if the shopper closes
 *                                                    the tab before returning
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.stripe.com/v1';

export const stripeEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY);

// Currencies Stripe expects in whole units rather than cents.
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
]);

export function toMinorUnits(amount, currency) {
  const n = Number(amount) || 0;
  return ZERO_DECIMAL.has(currency) ? Math.round(n) : Math.round(n * 100);
}

/** Stripe takes form-encoded bodies with bracketed keys for nested values. */
function encode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body ? encode(body).toString() : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Stripe request failed (${res.status})`);
    err.stripe = data?.error;
    throw err;
  }
  return data;
}

/**
 * One line for the whole order, so shipping and coupon discounts are already
 * baked into the amount the server calculated — Stripe charges exactly that.
 */
export function createCheckoutSession({ order, items, currency, shopName, origin }) {
  const cur = String(currency || 'usd').toLowerCase();
  const summary = items.map((i) => `${i.qty} × ${i.name}`).join(', ').slice(0, 480);
  const back = `${origin}/order/${encodeURIComponent(order.order_no)}`;

  return stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    client_reference_id: order.order_no,
    customer_email: order.ship_email,
    metadata: { order_no: order.order_no },
    payment_intent_data: { metadata: { order_no: order.order_no } },
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: cur,
          unit_amount: toMinorUnits(order.total, cur),
          product_data: { name: `${shopName} order ${order.order_no}`, description: summary || undefined }
        }
      }
    },
    // Unpaid orders hold stock, so release them quickly; 30 min is Stripe's minimum.
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    success_url: `${back}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${back}?cancelled=1`
  });
}

export const retrieveSession = (id) =>
  stripe('GET', `/checkout/sessions/${encodeURIComponent(id)}`);

/**
 * Check a webhook's Stripe-Signature header against the raw body.
 * @returns {object|null} the parsed event, or null when the signature is wrong
 */
export function verifyWebhook(rawBody, header, toleranceSec = 300) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return null;

  const parts = Object.create(null);
  for (const kv of String(header).split(',')) {
    const [k, v] = kv.split('=');
    (parts[k] ||= []).push(v);
  }
  const ts = Number(parts.t?.[0]);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return null;

  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
  const match = (parts.v1 || []).some((sig) => {
    const given = Buffer.from(sig || '', 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!match) return null;

  try { return JSON.parse(rawBody); } catch { return null; }
}

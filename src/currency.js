/**
 * Visitor currency support.
 *
 * Prices are stored and charged in the shop's own currency (Settings →
 * currency code). Shoppers abroad see an estimate in their local currency,
 * converted with daily rates from open.er-api.com (free, no key needed).
 */

const RATES_TTL = 12 * 60 * 60 * 1000; // rates change daily; refresh twice a day
const cache = new Map(); // base → { at, rates }

/**
 * @param {string} base ISO currency code the prices are stored in, e.g. "USD"
 * @returns {Promise<Record<string, number> | null>} units of each currency per 1 base unit
 */
export async function getRates(base) {
  base = String(base || 'USD').toUpperCase();
  const hit = cache.get(base);
  if (hit && Date.now() - hit.at < RATES_TTL) return hit.rates;

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, {
      signal: AbortSignal.timeout(4000)
    });
    const data = await res.json();
    if (data?.result !== 'success' || !data.rates) throw new Error('bad rates response');
    cache.set(base, { at: Date.now(), rates: data.rates });
    return data.rates;
  } catch {
    // Keep serving yesterday's rates rather than none at all.
    return hit?.rates || null;
  }
}

/** Two-letter country code from the hosting platform's geo headers, if any. */
export function visitorCountry(req) {
  const h = req.headers;
  const c = String(h['x-vercel-ip-country'] || h['cf-ipcountry'] || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : '';
}

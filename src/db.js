/**
 * Schema, settings and first-run seed.
 *
 * Postgres dialect throughout — see src/sql.js for the two drivers behind it.
 */
import { all, get, run, exec } from './sql.js';
import { hashPassword } from './auth.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner',
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  icon       TEXT DEFAULT 'flower',
  color      TEXT DEFAULT '#F2C9D9',
  sort_order INTEGER DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  price       DOUBLE PRECISION NOT NULL DEFAULT 0,
  old_price   DOUBLE PRECISION,
  cost        DOUBLE PRECISION NOT NULL DEFAULT 0,
  stock       INTEGER NOT NULL DEFAULT 0,
  sku         TEXT,
  palette     TEXT NOT NULL DEFAULT 'rose',
  seed        INTEGER NOT NULL DEFAULT 7,
  bloom_count INTEGER NOT NULL DEFAULT 4,
  image_url   TEXT,
  badge       TEXT,
  featured    INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  sold        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

CREATE TABLE IF NOT EXISTS customers (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  phone      TEXT DEFAULT '',
  address    TEXT DEFAULT '',
  city       TEXT DEFAULT '',
  postcode   TEXT DEFAULT '',
  country    TEXT DEFAULT '',
  notes      TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id             SERIAL PRIMARY KEY,
  order_no       TEXT NOT NULL UNIQUE,
  customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  ship_name      TEXT NOT NULL,
  ship_email     TEXT NOT NULL,
  ship_phone     TEXT DEFAULT '',
  ship_address   TEXT DEFAULT '',
  ship_city      TEXT DEFAULT '',
  ship_postcode  TEXT DEFAULT '',
  ship_country   TEXT DEFAULT '',
  subtotal       DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount       DOUBLE PRECISION NOT NULL DEFAULT 0,
  shipping       DOUBLE PRECISION NOT NULL DEFAULT 0,
  total          DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_total     DOUBLE PRECISION NOT NULL DEFAULT 0,
  coupon_code    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  payment_method TEXT NOT NULL DEFAULT 'cod',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  note           TEXT DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  unit_price DOUBLE PRECISION NOT NULL,
  unit_cost  DOUBLE PRECISION NOT NULL DEFAULT 0,
  qty        INTEGER NOT NULL,
  line_total DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coupons (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL DEFAULT 'percent',
  value        DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_subtotal DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_uses     INTEGER NOT NULL DEFAULT 0,
  used_count   INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT DEFAULT '',
  location   TEXT DEFAULT '',
  rating     INTEGER NOT NULL DEFAULT 5,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscribers (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  subject    TEXT DEFAULT '',
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS faqs (
  id         SERIAL PRIMARY KEY,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS events (
  id          SERIAL PRIMARY KEY,
  type        TEXT NOT NULL,
  path        TEXT DEFAULT '',
  product_id  INTEGER,
  visitor_key TEXT DEFAULT '',
  referrer    TEXT DEFAULT '',
  value       DOUBLE PRECISION DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type);

CREATE TABLE IF NOT EXISTS activity_log (
  id         SERIAL PRIMARY KEY,
  admin_id   INTEGER,
  admin_name TEXT DEFAULT '',
  action     TEXT NOT NULL,
  detail     TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hero_slides (
  id         SERIAL PRIMARY KEY,
  image_url  TEXT NOT NULL,
  caption    TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id         SERIAL PRIMARY KEY,
  reason     TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  shop_name: 'Maya Flora',
  tagline: 'Handmade Pipe Cleaner Flowers That Never Fade',
  announcement: '',
  currency_symbol: '$',
  currency_code: 'USD',
  email: 'hello@mayaflora.com',
  phone: '+45 00 00 00 00',
  address: 'Sønderborg, Denmark',
  hours: 'Mon–Fri, 9–17 CET',
  instagram: '#',
  facebook: '#',
  tiktok: '#',
  pinterest: '#',
  shipping_flat: '9',
  free_shipping_over: '120',
  low_stock_threshold: '5',
  order_prefix: 'FB',
  payment_methods: 'stripe',
  hero_title: 'Flowers that stay as long as the feeling does.',
  hero_body: 'Hand-twisted pipe cleaner bouquets — no water, no wilting, no pollen. Just soft, fuzzy colour that sits on the shelf for years.',
  hero_interval: '10',
  logo_url: '',
  // Product page: one item per line; leave empty to hide the row.
  product_badges: 'No water needed\nPet safe\nShips in 2–4 days',
  product_trust: 'Hand-twisted in small batches\n{shipping}\n14-day returns',
  about: 'Handmade pipe cleaner flowers, twisted with patience in small batches. Designed in Denmark, gifted everywhere.'
};

/**
 * Settings are read on nearly every request, so they are cached per process and
 * dropped on write. On serverless a save only reaches the instance that handled
 * it, so the cache also expires after a few seconds; otherwise other warm
 * instances would keep serving old prices and shipping until they restart.
 */
const SETTINGS_TTL_MS = 5000;
let settingsCache = null;
let settingsAt = 0;

export async function getSettings() {
  if (settingsCache && Date.now() - settingsAt < SETTINGS_TTL_MS) return settingsCache;
  const out = { ...DEFAULT_SETTINGS };
  for (const r of await all('SELECT key, value FROM settings')) out[r.key] = r.value;
  settingsCache = out;
  settingsAt = Date.now();
  return out;
}

export async function getSetting(key, fallback = null) {
  const s = await getSettings();
  return key in s ? s[key] : fallback;
}

export async function setSetting(key, value) {
  await run(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value ?? '')]
  );
  settingsCache = null;
}

export const invalidateSettings = () => { settingsCache = null; };

export const nowISO = () => new Date().toISOString();

export async function logActivity(admin, action, detail = '') {
  await run(
    'INSERT INTO activity_log(admin_id, admin_name, action, detail, created_at) VALUES(?,?,?,?,?)',
    [admin?.id ?? null, admin?.name ?? 'system', action, detail, nowISO()]
  );
}

export const slugify = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

let readyPromise = null;

/** Create the schema and seed, once per process. Every request awaits this. */
export function ready() {
  if (!readyPromise) readyPromise = setup();
  return readyPromise;
}

async function setup() {
  await exec(SCHEMA);
  await seed();
  await migrateCategoryIcons();
  await migrateProductImages();
}

/**
 * Products can carry several photos. `images` holds them all as a JSON array,
 * in display order; `image_url` stays as the first one (the cover) so lists,
 * baskets and older code keep working unchanged.
 */
async function migrateProductImages() {
  await exec("ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT NOT NULL DEFAULT '[]'");
  await run(
    `UPDATE products SET images = json_build_array(image_url)::text
     WHERE image_url IS NOT NULL AND image_url <> '' AND (images IS NULL OR images = '[]')`
  );
}

/** Parse a product's stored `images` into a clean array of URLs. */
export function productImages(p) {
  let list = [];
  try { list = JSON.parse(p?.images || '[]'); } catch { /* bad JSON: treat as none */ }
  if (!Array.isArray(list)) list = [];
  list = list.filter((u) => typeof u === 'string' && u);
  if (!list.length && p?.image_url) list = [p.image_url];
  return list;
}

/**
 * First-run seed.
 *
 * The admin account, shop settings, categories and FAQs are always created —
 * without them the shop cannot be signed into or configured. The twelve sample
 * bouquets are only for trying the thing out, so a real shop can skip them with
 * SEED_SAMPLE_DATA=0 and start with an empty catalogue.
 */
async function seed() {
  const alreadySetUp = await get('SELECT COUNT(*)::int AS c FROM admins');
  if (alreadySetUp.c > 0) return;

  const withSamples = process.env.SEED_SAMPLE_DATA !== '0';
  const t = nowISO();
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await setSetting(k, v);

  const cats = [
    ['Birthday', 'cake', '#F6E3C0'],
    ['Anniversary', 'heart', '#F2C9D9'],
    ['Get Well', 'sun', '#DCEAD8'],
    ['Congrats', 'handmade', '#E9D6E8'],
    ['Thank You', 'gift', '#DCEAD8'],
    ['Home Decor', 'home', '#F6E3C0'],
    ['DIY Kits', 'scissors', '#E9D6E8']
  ];
  for (const [i, [name, icon, color]] of cats.entries()) {
    await run(
      `INSERT INTO categories(name, slug, icon, color, sort_order, active) VALUES(?,?,?,?,?,1)
       ON CONFLICT (slug) DO NOTHING`,
      [name, slugify(name), icon, color, i]
    );
  }

  const catId = async (name) =>
    (await get('SELECT id FROM categories WHERE slug = ?', [slugify(name)]))?.id ?? null;

  //  name, palette, price, oldPrice, stock, category, blooms, description, badge, featured, cost
  const products = [
    ['Cherish Peonies', 'rose', 129, 139, 48, 'Anniversary', 3, 'Our signature blush peony bouquet — nine hand-twisted blooms wrapped in soft matte paper. The one people buy twice.', 'On Sale', 1, 58],
    ['Dreamelle Bouquet', 'lilac', 135, null, 32, 'Birthday', 4, 'Lilac and lavender petals with a butter-gold centre. A quiet, grown-up bouquet that suits any shelf.', null, 1, 61],
    ['Sunrise Petals', 'sunset', 119, 132, 24, 'Congrats', 5, 'Warm apricot and coral blooms that catch the morning light. Cheerful without being loud.', 'On Sale', 1, 54],
    ['Moonlit Blush', 'cream', 125, null, 18, 'Home Decor', 4, 'Cream and champagne tones for neutral interiors. Sits beautifully on a mantel or hallway table.', null, 0, 56],
    ['Midnight Romance', 'berry', 159, null, 12, 'Anniversary', 5, 'Deep berry and wine petals — our most dramatic arrangement, and the one most often gifted for anniversaries.', 'Bestseller', 1, 71],
    ['Meadow Whisper', 'sage', 99, 112, 40, 'Get Well', 4, 'Soft sage greens with pale gold centres. Calm, fresh, and the kindest thing to send someone recovering.', 'On Sale', 0, 45],
    ['Pure Affection', 'rose', 179, null, 9, 'Anniversary', 6, 'Our largest bouquet — fifteen blooms, double-wrapped, and finished with a hand-tied ribbon.', 'Premium', 1, 80],
    ['Ocean Mist Basket', 'lilac', 149, null, 21, 'Home Decor', 5, 'A woven basket arrangement in cool lilac and dusk blue. Ready to place, no vase needed.', null, 0, 67],
    ['Little Sunshine', 'sunset', 69, null, 60, 'Thank You', 2, 'A three-stem posy in warm yellows — small, sweet, and the perfect desk-side thank you.', null, 0, 31],
    ['Starter DIY Kit', 'rose', 45, 55, 85, 'DIY Kits', 3, 'Pre-cut pipe cleaners, a printed pattern card, floral tape and a wrap sheet. Everything but the scissors.', 'On Sale', 1, 20],
    ['Deluxe DIY Kit', 'berry', 79, null, 45, 'DIY Kits', 5, 'Twice the stems, four palettes to mix, and an illustrated 12-page booklet covering six petal shapes.', null, 0, 36],
    ['Forever Frame', 'cream', 189, null, 6, 'Home Decor', 4, 'A pressed-style bouquet mounted in a deep oak shadow box. Made to order in three to five days.', 'Premium', 0, 85]
  ];

  if (withSamples) for (const [i, p] of products.entries()) {
    const [name, palette, price, oldPrice, stock, cat, blooms, desc, badge, featured, cost] = p;
    await run(
      `INSERT INTO products
       (name, slug, description, category_id, price, old_price, cost, stock, sku, palette, seed,
        bloom_count, badge, featured, active, sold, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)
       ON CONFLICT (slug) DO NOTHING`,
      [name, slugify(name), desc, await catId(cat), price, oldPrice, cost, stock,
        'FB-' + String(1001 + i), palette, i * 97 + 13, blooms, badge, featured, t, t]
    );
  }

  const faqs = [
    ['What are your bouquets made from?', 'Every flower starts as a bundle of fuzzy craft pipe cleaners, hand-twisted into petals, leaves, and stems — no plastic moulds, no wire mesh, just colour and patience.'],
    ['Do you ship internationally?', 'Yes — we ship across the EU, UK, and North America. Delivery is 3–7 business days within Europe and 6–12 business days internationally.'],
    ['Will my bouquet really last forever?', 'With no water and no sunlight sensitivity, most bouquets stay vivid for years. We recommend keeping them out of direct sun to preserve colour longest.'],
    ['Can I customise the colours?', 'Absolutely. Choose a palette on any bouquet page, and for larger custom orders message us directly with your colours or occasion.'],
    ['What comes in a DIY kit?', 'Pre-cut pipe cleaners in your chosen palette, a printed step-by-step pattern card, floral tape, and a wrap sheet — everything except scissors.'],
    ['How do I track my order?', 'Every order gets a number like FB-10021. Enter it with your email on the Track Order page and you will see exactly where it is.']
  ];
  for (const [i, [q, a]] of faqs.entries()) {
    await run('INSERT INTO faqs(question, answer, sort_order, active) VALUES(?,?,?,1)', [q, a, i]);
  }

  for (const c of [
    ['WELCOME10', 'percent', 10, 0, 0],
    ['BLOOM25', 'fixed', 25, 150, 100]
  ]) {
    await run(
      `INSERT INTO coupons(code, type, value, min_subtotal, max_uses, used_count, expires_at, active, created_at)
       VALUES(?,?,?,?,?,0,NULL,1,?) ON CONFLICT (code) DO NOTHING`,
      [...c, t]
    );
  }

  const reviews = [
    [1, 'Marie K.', 'Aarhus, DK', 5, 'I bought the Cherish Peonies for my mum and she still has them on her kitchen table eight months later. Genuinely beautiful craftsmanship.'],
    [10, 'Owen T.', 'Manchester, UK', 5, 'Ordered a DIY kit as a rainy-day project with my daughter — the instructions were clear and the finished bouquet looked shockingly good.'],
    [5, 'Priya S.', 'Toronto, CA', 5, 'My partner is allergic to real flowers so this was the perfect workaround. The packaging alone felt like a gift.'],
    [2, 'Jonas B.', 'Odense, DK', 5, 'Arrived faster than promised and the lilac is even prettier in person. Already planning the next one.'],
    [7, 'Amelia R.', 'Dublin, IE', 5, 'Bought Pure Affection for our tenth anniversary. It is enormous and it is staying on the piano forever.']
  ];
  if (withSamples) for (const [pid, name, loc, rating, body] of reviews) {
    await run(
      'INSERT INTO reviews(product_id, name, email, location, rating, body, status, created_at) VALUES(?,?,?,?,?,?,?,?)',
      [pid, name, '', loc, rating, body, 'approved', t]
    );
  }

  const { hash } = hashPassword(process.env.ADMIN_PASSWORD || 'admin1234');
  await run(
    `INSERT INTO admins(email, name, password_hash, role, created_at) VALUES(?,?,?,?,?)
     ON CONFLICT (email) DO NOTHING`,
    [(process.env.ADMIN_EMAIL || 'admin@phoolmaya.com').toLowerCase(), 'Shop Owner', hash, 'owner', t]
  );

  console.log(withSamples
    ? '  Database seeded with sample products. Set SEED_SAMPLE_DATA=0 for an empty catalogue.'
    : '  Database ready — empty catalogue, admin account created.');
}

/** Categories once stored an emoji; map the originals onto icon names. */
async function migrateCategoryIcons() {
  const map = {
    '\u{1F382}': 'cake', '\u{1F497}': 'heart', '\u{1F33C}': 'sun', '\u{1F389}': 'handmade',
    '\u{1F64F}': 'gift', '\u{1F3E1}': 'home', '✂️': 'scissors', '\u{1F338}': 'flower',
    '*': 'flower'
  };
  for (const c of await all('SELECT id, icon FROM categories')) {
    const next = map[c.icon];
    if (next) await run('UPDATE categories SET icon = ? WHERE id = ?', [next, c.id]);
  }
}

export { all, get, run, exec, insertReturningId, transaction } from './sql.js';

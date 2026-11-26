/**
 * Public storefront API — catalogue, cart pricing, checkout, tracking, forms.
 *
 * Rule of the house: the browser may propose product ids and quantities, but
 * every price, discount and total is recalculated here from the database.
 */
import { all, get, run, transaction, getSettings, nowISO, productImages } from '../db.js';
import { ok, fail, readBody, readRawBody, str, intOr, isEmail } from '../lib/http.js';
import { visitorKey } from '../auth.js';
import { getRates, visitorCountry } from '../currency.js';
import { stripeEnabled, createCheckoutSession, retrieveSession, verifyWebhook } from '../stripe.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** A one-item-per-line setting as a list, blank lines dropped. */
const lines = (v) => String(v ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 8);

/* ------------------------------------------------------------------ */
/* Card payments (Stripe)                                              */
/* ------------------------------------------------------------------ */

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

/** Record a confirmed Stripe payment once, however many times it is reported. */
async function markOrderPaid(orderNo, note) {
  return transaction(async (tx) => {
    const o = await tx.get('SELECT id, status, payment_status FROM orders WHERE order_no = ? FOR UPDATE', [orderNo]);
    if (!o || o.payment_status === 'paid') return Boolean(o);
    const t = nowISO();
    await tx.run("UPDATE orders SET payment_status = 'paid', updated_at = ? WHERE id = ?", [t, o.id]);
    await tx.run('INSERT INTO order_events(order_id, status, note, created_at) VALUES(?,?,?,?)',
      [o.id, o.status, note, t]);
    return true;
  });
}

/**
 * An unpaid card order whose payment was abandoned: cancel it and put the
 * stock and coupon use back, so it does not block other shoppers.
 */
async function releaseUnpaidOrder(orderNo, note) {
  return transaction(async (tx) => {
    const o = await tx.get('SELECT * FROM orders WHERE order_no = ? FOR UPDATE', [orderNo]);
    if (!o || o.payment_status !== 'unpaid' || o.status !== 'pending') return false;
    for (const it of await tx.all('SELECT product_id, qty FROM order_items WHERE order_id = ?', [o.id])) {
      if (it.product_id)
        await tx.run('UPDATE products SET stock = stock + ?, sold = GREATEST(0, sold - ?) WHERE id = ?',
          [it.qty, it.qty, it.product_id]);
    }
    if (o.coupon_code)
      await tx.run('UPDATE coupons SET used_count = GREATEST(0, used_count - 1) WHERE UPPER(code) = UPPER(?)',
        [o.coupon_code]);
    const t = nowISO();
    await tx.run("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?", [t, o.id]);
    await tx.run('INSERT INTO order_events(order_id, status, note, created_at) VALUES(?,?,?,?)',
      [o.id, 'cancelled', note, t]);
    return true;
  });
}

const PRODUCT_FIELDS = `p.id, p.name, p.slug, p.description, p.price, p.old_price, p.stock,
  p.palette, p.seed, p.bloom_count, p.image_url, p.images, p.badge, p.featured, p.sold, p.sku,
  p.category_id, c.name AS category, c.slug AS category_slug`;

async function ratingFor(productId) {
  const r = await get(
    `SELECT ROUND(AVG(rating)::numeric, 1)::float8 AS avg, COUNT(*)::int AS n
     FROM reviews WHERE product_id = ? AND status = 'approved'`,
    [productId]
  );
  return { rating: r?.avg ?? 5, review_count: r?.n ?? 0 };
}

async function decorate(p) {
  return { ...p, images: productImages(p), ...(await ratingFor(p.id)), in_stock: p.stock > 0 };
}

const decorateAll = (rows) => Promise.all(rows.map(decorate));

/* ------------------------------------------------------------------ */
/* Pricing                                                             */
/* ------------------------------------------------------------------ */

export async function findCoupon(code, subtotal) {
  if (!code) return { coupon: null, discount: 0 };
  const c = await get('SELECT * FROM coupons WHERE UPPER(code) = UPPER(?)', [String(code).trim()]);
  if (!c) return { coupon: null, discount: 0, reason: 'That code does not exist.' };
  if (!c.active) return { coupon: null, discount: 0, reason: 'That code is no longer active.' };
  if (c.expires_at && new Date(c.expires_at) < new Date())
    return { coupon: null, discount: 0, reason: 'That code has expired.' };
  if (c.max_uses > 0 && c.used_count >= c.max_uses)
    return { coupon: null, discount: 0, reason: 'That code has been fully redeemed.' };
  if (subtotal < c.min_subtotal)
    return { coupon: null, discount: 0, reason: `Spend at least ${c.min_subtotal} to use this code.` };

  const discount = c.type === 'percent'
    ? round2(subtotal * (c.value / 100))
    : round2(Math.min(c.value, subtotal));
  return { coupon: c, discount };
}

/** Cart lines as shoppers may see them: no cost price or stock level. */
const publicLines = (lines) => lines.map(({ unit_cost, stock, ...l }) => l);

/** Rebuild a cart from the database. Never trusts client-side prices. */
export async function priceCart(items, couponCode) {
  const settings = await getSettings();
  const lines = [];
  const problems = [];

  for (const raw of Array.isArray(items) ? items : []) {
    const id = intOr(raw.id ?? raw.product_id, 0);
    const qty = Math.max(1, Math.min(99, intOr(raw.qty, 1)));
    if (!id) continue;
    const p = await get('SELECT * FROM products WHERE id = ? AND active = 1', [id]);
    if (!p) { problems.push('One item is no longer available and was removed.'); continue; }
    if (p.stock <= 0) { problems.push(`${p.name} just sold out.`); continue; }
    const capped = Math.min(qty, p.stock);
    if (capped < qty) problems.push(`Only ${p.stock} left of ${p.name}.`);
    lines.push({
      product_id: p.id,
      name: p.name,
      slug: p.slug,
      palette: p.palette,
      seed: p.seed,
      bloom_count: p.bloom_count,
      unit_price: p.price,
      unit_cost: p.cost,
      qty: capped,
      line_total: round2(p.price * capped),
      stock: p.stock
    });
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));
  const { coupon, discount, reason } = await findCoupon(couponCode, subtotal);

  const freeOver = Number(settings.free_shipping_over || 0);
  const flat = Number(settings.shipping_flat || 0);
  const shipping = lines.length === 0 || (freeOver > 0 && subtotal >= freeOver) ? 0 : flat;

  const total = round2(Math.max(0, subtotal - discount) + shipping);
  const cost_total = round2(lines.reduce((s, l) => s + l.unit_cost * l.qty, 0));

  return {
    lines, subtotal, discount, shipping, total, cost_total,
    coupon: coupon ? { code: coupon.code, type: coupon.type, value: coupon.value } : null,
    coupon_error: couponCode && !coupon ? reason : null,
    problems,
    free_shipping_over: freeOver,
    currency: settings.currency_symbol
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerShopRoutes(router) {
  /* --- bootstrap: everything the storefront needs in one round trip --- */
  router.get('/api/shop/bootstrap', async (req, res) => {
    const s = await getSettings();
    const [categories, faqs, testimonials, productCount, soldCount, avgRating, heroSlides] = await Promise.all([
      all('SELECT id, name, slug, icon, color FROM categories WHERE active = 1 ORDER BY sort_order, name'),
      all('SELECT question, answer FROM faqs WHERE active = 1 ORDER BY sort_order, id'),
      all(`SELECT r.name, r.location, r.rating, r.body, p.name AS product
           FROM reviews r LEFT JOIN products p ON p.id = r.product_id
           WHERE r.status = 'approved' ORDER BY r.created_at DESC LIMIT 9`),
      get('SELECT COUNT(*)::int AS c FROM products WHERE active = 1'),
      get('SELECT COALESCE(SUM(sold),0)::int AS c FROM products'),
      get(`SELECT ROUND(AVG(rating)::numeric,1)::float8 AS a FROM reviews WHERE status='approved'`),
      all('SELECT image_url, caption FROM hero_slides WHERE active = 1 ORDER BY sort_order, id')
    ]);

    ok(res, {
      settings: {
        shop_name: s.shop_name, tagline: s.tagline, announcement: s.announcement,
        currency: s.currency_symbol, email: s.email, phone: s.phone, address: s.address,
        hours: s.hours, about: s.about, hero_title: s.hero_title, hero_body: s.hero_body,
        instagram: s.instagram, facebook: s.facebook, tiktok: s.tiktok, pinterest: s.pinterest,
        shipping_flat: Number(s.shipping_flat), free_shipping_over: Number(s.free_shipping_over),
        payment_methods: String(s.payment_methods).split(',').filter(Boolean),
        stripe_ready: stripeEnabled(),
        hero_interval: Math.min(120, Math.max(2, Number(s.hero_interval) || 10)),
        logo_url: s.logo_url || '',
        product_badges: lines(s.product_badges),
        product_trust: lines(s.product_trust),
        currency_code: String(s.currency_code || 'USD').toUpperCase()
      },
      visitor_country: visitorCountry(req),
      hero_slides: heroSlides,
      categories,
      faqs,
      testimonials,
      stats: {
        products: productCount.c,
        sold: soldCount.c,
        rating: avgRating?.a || 5
      }
    });
  });

  /* --- catalogue --- */
  /* --- exchange rates for showing prices in the visitor's currency --- */
  router.get('/api/shop/rates', async (req, res) => {
    const s = await getSettings();
    const base = String(s.currency_code || 'USD').toUpperCase();
    ok(res, { base, rates: await getRates(base) });
  });

  router.get('/api/products', async (req, res) => {
    const u = req.url_parsed.searchParams;
    const where = ['p.active = 1'];
    const args = [];

    const cat = str(u.get('category'), 60);
    if (cat && cat !== 'all') { where.push('c.slug = ?'); args.push(cat); }

    const q = str(u.get('q'), 80);
    if (q) { where.push('(p.name ILIKE ? OR p.description ILIKE ?)'); args.push(`%${q}%`, `%${q}%`); }

    if (u.get('featured') === '1') where.push('p.featured = 1');

    const sorts = {
      popular: 'p.sold DESC, p.id DESC',
      newest: 'p.created_at DESC',
      price_asc: 'p.price ASC',
      price_desc: 'p.price DESC',
      name: 'p.name ASC'
    };
    const order = sorts[u.get('sort')] || sorts.popular;
    const limit = Math.min(60, intOr(u.get('limit'), 24));
    const offset = Math.max(0, intOr(u.get('offset'), 0));

    const rows = await all(
      `SELECT ${PRODUCT_FIELDS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...args, limit, offset]
    );

    const total = await get(
      `SELECT COUNT(*)::int AS c FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where.join(' AND ')}`,
      args
    );

    ok(res, { products: await decorateAll(rows), total: total.c, limit, offset });
  });

  router.get('/api/products/:slug', async (req, res, { params }) => {
    const p = await get(
      `SELECT ${PRODUCT_FIELDS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.slug = ? AND p.active = 1`,
      [params.slug]
    );
    if (!p) return fail(res, 404, 'Product not found');

    const reviews = await all(
      `SELECT name, location, rating, body, created_at FROM reviews
       WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 20`,
      [p.id]
    );

    const related = await all(
      `SELECT ${PRODUCT_FIELDS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.active = 1 AND p.id <> ? AND (p.category_id = ? OR ?::int IS NULL)
       ORDER BY p.sold DESC LIMIT 4`,
      [p.id, p.category_id, p.category_id]
    );

    ok(res, {
      product: await decorate(p),
      reviews,
      related: await decorateAll(related)
    });
  });

  /* --- cart + coupon --- */
  router.post('/api/cart/price', async (req, res) => {
    const body = await readBody(req);
    const { cost_total, ...priced } = await priceCart(body.items, str(body.coupon, 40));
    ok(res, { ...priced, lines: publicLines(priced.lines) });
  });

  /* --- checkout --- */
  router.post('/api/orders', async (req, res) => {
    const body = await readBody(req);
    const name = str(body.name, 120);
    const email = str(body.email, 160).toLowerCase();

    if (!name) return fail(res, 400, 'Please enter your name.');
    if (!isEmail(email)) return fail(res, 400, 'Please enter a valid email address.');

    const priced = await priceCart(body.items, str(body.coupon, 40));
    if (!priced.lines.length) return fail(res, 400, 'Your basket is empty.');

    const settings = await getSettings();
    const allowedPay = String(settings.payment_methods).split(',');
    const payment = allowedPay.includes(body.payment_method) ? body.payment_method : allowedPay[0];
    if (payment === 'stripe' && !stripeEnabled())
      return fail(res, 503, 'Card payments are not available yet. Please try again soon.');
    const t = nowISO();

    let result;
    try {
      result = await transaction(async (tx) => {
        // Re-check stock inside the transaction so two shoppers cannot oversell.
        for (const l of priced.lines) {
          const cur = await tx.get('SELECT stock, name FROM products WHERE id = ? FOR UPDATE', [l.product_id]);
          if (!cur || cur.stock < l.qty) {
            const err = new Error(`Sorry — ${cur?.name || 'an item'} sold out while you were checking out.`);
            err.status = 409;
            throw err;
          }
        }

        let customer = await tx.get('SELECT * FROM customers WHERE email = ?', [email]);
        if (!customer) {
          await tx.run(
            `INSERT INTO customers(email, name, phone, address, city, postcode, country, created_at)
             VALUES(?,?,?,?,?,?,?,?) ON CONFLICT (email) DO NOTHING`,
            [email, name, str(body.phone, 40), str(body.address, 300), str(body.city, 80),
              str(body.postcode, 20), str(body.country, 80), t]
          );
          customer = await tx.get('SELECT * FROM customers WHERE email = ?', [email]);
        } else {
          await tx.run(
            'UPDATE customers SET name=?, phone=?, address=?, city=?, postcode=?, country=? WHERE id=?',
            [name, str(body.phone, 40), str(body.address, 300), str(body.city, 80),
              str(body.postcode, 20), str(body.country, 80), customer.id]
          );
        }

        const temp = 'TMP-' + Math.random().toString(36).slice(2, 12);
        const orderId = await tx.insertReturningId(
          `INSERT INTO orders
           (order_no, customer_id, ship_name, ship_email, ship_phone, ship_address, ship_city,
            ship_postcode, ship_country, subtotal, discount, shipping, total, cost_total,
            coupon_code, status, payment_method, payment_status, note, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,'unpaid',?,?,?) RETURNING id`,
          [temp, customer.id, name, email, str(body.phone, 40), str(body.address, 300),
            str(body.city, 80), str(body.postcode, 20), str(body.country, 80),
            priced.subtotal, priced.discount, priced.shipping, priced.total, priced.cost_total,
            priced.coupon?.code ?? null, payment, str(body.note, 500), t, t]
        );

        const orderNo = `${settings.order_prefix || 'FB'}-${10000 + orderId}`;
        await tx.run('UPDATE orders SET order_no = ? WHERE id = ?', [orderNo, orderId]);

        for (const l of priced.lines) {
          await tx.run(
            `INSERT INTO order_items(order_id, product_id, name, unit_price, unit_cost, qty, line_total)
             VALUES(?,?,?,?,?,?,?)`,
            [orderId, l.product_id, l.name, l.unit_price, l.unit_cost, l.qty, l.line_total]
          );
          await tx.run(
            'UPDATE products SET stock = stock - ?, sold = sold + ? WHERE id = ?',
            [l.qty, l.qty, l.product_id]
          );
        }

        await tx.run(
          'INSERT INTO order_events(order_id, status, note, created_at) VALUES(?,?,?,?)',
          [orderId, 'pending', 'Order placed by customer', t]
        );

        if (priced.coupon) {
          await tx.run('UPDATE coupons SET used_count = used_count + 1 WHERE UPPER(code) = UPPER(?)',
            [priced.coupon.code]);
        }

        await tx.run(
          'INSERT INTO events(type, path, product_id, visitor_key, referrer, value, created_at) VALUES(?,?,?,?,?,?,?)',
          ['purchase', '/checkout', null,
            visitorKey(req.socket?.remoteAddress, req.headers['user-agent']), '', priced.total, t]
        );

        return { orderNo };
      });
    } catch (err) {
      if (err.status === 409) return fail(res, 409, err.message);
      throw err;
    }

    let checkoutUrl = null;
    if (payment === 'stripe') {
      try {
        const session = await createCheckoutSession({
          order: { order_no: result.orderNo, total: priced.total, ship_email: email },
          items: priced.lines,
          currency: settings.currency_code,
          shopName: settings.shop_name,
          origin: requestOrigin(req)
        });
        checkoutUrl = session.url;
      } catch (err) {
        console.error('[stripe] could not start checkout:', err.message);
        await releaseUnpaidOrder(result.orderNo, 'Card payment could not be started');
        return fail(res, 502, 'We could not start the card payment. Please try again.');
      }
    }

    ok(res, {
      order_no: result.orderNo,
      checkout_url: checkoutUrl,
      total: priced.total,
      subtotal: priced.subtotal,
      discount: priced.discount,
      shipping: priced.shipping,
      lines: publicLines(priced.lines),
      coupon: priced.coupon,
      currency: settings.currency_symbol,
      email,
      payment_method: payment,
      message: 'Order placed'
    });
  });

  /* --- card payment: shopper returns from Stripe --- */
  router.post('/api/orders/confirm-payment', async (req, res) => {
    const body = await readBody(req);
    const orderNo = str(body.order_no, 40);
    const sessionId = str(body.session_id, 200);
    if (!orderNo || !sessionId.startsWith('cs_')) return fail(res, 400, 'Missing payment details.');
    if (!stripeEnabled()) return fail(res, 503, 'Card payments are not available.');

    let session;
    try { session = await retrieveSession(sessionId); }
    catch { return fail(res, 404, 'We could not find that payment.'); }

    // The session must belong to this order, or any paid session could unlock any order.
    if (session.metadata?.order_no !== orderNo) return fail(res, 400, 'That payment is for a different order.');

    if (session.payment_status === 'paid') {
      await markOrderPaid(orderNo, `Paid by card via Stripe (${session.payment_intent || session.id})`);
      return ok(res, { paid: true });
    }
    ok(res, { paid: false, status: session.status });
  });

  /* --- card payment: shopper pressed "back" on the Stripe page --- */
  router.post('/api/orders/cancel-payment', async (req, res) => {
    const body = await readBody(req);
    const orderNo = str(body.order_no, 40);
    const email = str(body.email, 160).toLowerCase();
    const o = await get('SELECT payment_method FROM orders WHERE order_no = ? AND LOWER(ship_email) = ?',
      [orderNo, email]);
    if (!o || o.payment_method !== 'stripe') return fail(res, 404, 'Order not found.');
    ok(res, { released: await releaseUnpaidOrder(orderNo, 'Card payment cancelled by customer') });
  });

  /* --- card payment: Stripe's server-to-server confirmation --- */
  router.post('/api/stripe/webhook', async (req, res) => {
    const raw = (await readRawBody(req, 1_000_000)).toString('utf8');
    const event = verifyWebhook(raw, req.headers['stripe-signature']);
    if (!event) return fail(res, 400, 'Invalid signature');

    const session = event.data?.object || {};
    const orderNo = session.metadata?.order_no;
    if (orderNo) {
      if ((event.type === 'checkout.session.completed' && session.payment_status === 'paid') ||
          event.type === 'checkout.session.async_payment_succeeded') {
        await markOrderPaid(orderNo, `Paid by card via Stripe (${session.payment_intent || session.id})`);
      } else if (event.type === 'checkout.session.expired' ||
                 event.type === 'checkout.session.async_payment_failed') {
        await releaseUnpaidOrder(orderNo, 'Card payment not completed — order released');
      }
    }
    ok(res, { received: true });
  });

  /* --- order tracking --- */
  router.get('/api/track-order', async (req, res) => {
    const u = req.url_parsed.searchParams;
    const orderNo = str(u.get('order_no'), 40).toUpperCase();
    const email = str(u.get('email'), 160).toLowerCase();
    if (!orderNo || !email) return fail(res, 400, 'Enter both your order number and email.');

    const o = await get(
      'SELECT * FROM orders WHERE UPPER(order_no) = ? AND LOWER(ship_email) = ?',
      [orderNo, email]
    );
    if (!o) return fail(res, 404, 'No order matches that number and email.');

    const settings = await getSettings();
    ok(res, {
      order: {
        order_no: o.order_no, status: o.status, payment_status: o.payment_status,
        payment_method: o.payment_method, total: o.total, subtotal: o.subtotal,
        discount: o.discount, shipping: o.shipping, created_at: o.created_at,
        ship_name: o.ship_name, ship_address: o.ship_address, ship_city: o.ship_city,
        ship_postcode: o.ship_postcode, ship_country: o.ship_country
      },
      items: await all('SELECT name, unit_price, qty, line_total FROM order_items WHERE order_id = ?', [o.id]),
      timeline: await all('SELECT status, note, created_at FROM order_events WHERE order_id = ? ORDER BY id', [o.id]),
      currency: settings.currency_symbol
    });
  });

  /* --- reviews --- */
  router.post('/api/reviews', async (req, res) => {
    const b = await readBody(req);
    const name = str(b.name, 80);
    const body = str(b.body, 1200);
    const productId = intOr(b.product_id, 0);
    if (!name || !body) return fail(res, 400, 'Please add your name and a few words.');
    if (!await get('SELECT 1 FROM products WHERE id = ?', [productId]))
      return fail(res, 400, 'Unknown product.');

    await run(
      'INSERT INTO reviews(product_id, name, email, location, rating, body, status, created_at) VALUES(?,?,?,?,?,?,?,?)',
      [productId, name, str(b.email, 160), str(b.location, 80),
        Math.max(1, Math.min(5, intOr(b.rating, 5))), body, 'pending', nowISO()]
    );

    ok(res, { message: 'Thank you! Your review will appear once we have read it.' });
  });

  /* --- newsletter --- */
  router.post('/api/subscribe', async (req, res) => {
    const b = await readBody(req);
    const email = str(b.email, 160).toLowerCase();
    if (!isEmail(email)) return fail(res, 400, 'That email does not look right.');
    await run(
      `INSERT INTO subscribers(email, active, created_at) VALUES(?,1,?)
       ON CONFLICT (email) DO UPDATE SET active = 1`,
      [email, nowISO()]
    );
    ok(res, { message: "You're on the list! Watch your inbox for new blooms." });
  });

  /* --- contact --- */
  router.post('/api/contact', async (req, res) => {
    const b = await readBody(req);
    const name = str(b.name, 120);
    const email = str(b.email, 160);
    const message = str(b.message ?? b.body, 2000);
    if (!name || !isEmail(email) || !message)
      return fail(res, 400, 'Please fill in your name, a valid email, and a message.');
    await run('INSERT INTO messages(name, email, subject, body, status, created_at) VALUES(?,?,?,?,?,?)',
      [name, email, str(b.subject, 160), message, 'new', nowISO()]);
    ok(res, { message: 'Message sent — we reply within one working day.' });
  });

  /* --- lightweight first-party analytics --- */
  router.post('/api/track', async (req, res) => {
    const b = await readBody(req, 20_000);
    const allowed = new Set(['pageview', 'product_view', 'add_to_cart', 'begin_checkout', 'search']);
    const type = str(b.type, 32);
    if (!allowed.has(type)) return ok(res, { ignored: true });

    await run(
      'INSERT INTO events(type, path, product_id, visitor_key, referrer, value, created_at) VALUES(?,?,?,?,?,?,?)',
      [type, str(b.path, 200), intOr(b.product_id, 0) || null,
        visitorKey(req.socket?.remoteAddress, req.headers['user-agent']),
        str(b.referrer, 200), Number(b.value) || 0, nowISO()]
    );

    res.writeHead(204).end();
  });
}

/**
 * Phool Maya storefront.
 *
 * A small hand-rolled SPA: history routing, a localStorage basket that is
 * always re-priced by the server, and progressive first-party analytics.
 */
import { bouquetSVG } from './bouquet.js';
import { icon, iconOrText } from './icons.js';

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  settings: {},
  categories: [],
  faqs: [],
  testimonials: [],
  stats: {},
  cart: [],
  coupon: '',
  pricing: null
};

const money = (n) =>
  `${state.settings.currency || '$'}${Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  })}`;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options
  });
  const isJSON = (res.headers.get('content-type') || '').includes('json');
  const data = isJSON ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function track(type, extra = {}) {
  navigator.sendBeacon?.('/api/track', new Blob(
    [JSON.stringify({ type, path: location.pathname, referrer: document.referrer, ...extra })],
    { type: 'application/json' }
  ));
}

// The bouquet is always drawn on a 240pt canvas; the viewBox scales it to
// whatever the slot needs, so a 68px cart thumb keeps its petals.
const ART = 240;

const bouquet = (p) =>
  `<svg viewBox="0 0 ${ART} ${ART}" role="img" aria-label="${esc(p.name)}">${
    bouquetSVG(p.seed, p.palette, p.bloom_count, ART, ART)}</svg>`;

const productArt = (p) =>
  p.image_url
    ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy">`
    : bouquet(p);

const stars = (n) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));

/* ------------------------------------------------------------------ */
/* Basket                                                              */
/* ------------------------------------------------------------------ */

const CART_KEY = 'fb_cart_v1';

function loadCart() {
  try { state.cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; }
  catch { state.cart = []; }
  try { state.coupon = localStorage.getItem('fb_coupon') || ''; } catch { state.coupon = ''; }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
    localStorage.setItem('fb_coupon', state.coupon);
  } catch { /* private mode — basket simply won't persist */ }
  const count = state.cart.reduce((s, i) => s + i.qty, 0);
  const badge = $('#cartCount');
  badge.textContent = count;
  badge.hidden = count === 0;
}

function addToCart(product, qty = 1) {
  const line = state.cart.find((i) => i.id === product.id);
  if (line) line.qty = Math.min(99, line.qty + qty);
  else state.cart.push({ id: product.id, qty, name: product.name, price: product.price,
    palette: product.palette, seed: product.seed, bloom_count: product.bloom_count,
    slug: product.slug, image_url: product.image_url });
  saveCart();
  track('add_to_cart', { product_id: product.id });
  toast(`Added "${product.name}" to your basket`);
  refreshCart();
}

function setQty(id, qty) {
  const line = state.cart.find((i) => i.id === id);
  if (!line) return;
  if (qty <= 0) state.cart = state.cart.filter((i) => i.id !== id);
  else line.qty = Math.min(99, qty);
  saveCart();
  refreshCart();
}

async function priceCart() {
  if (!state.cart.length) { state.pricing = null; return null; }
  try {
    state.pricing = await api('/api/cart/price', {
      method: 'POST',
      body: JSON.stringify({ items: state.cart.map((i) => ({ id: i.id, qty: i.qty })), coupon: state.coupon })
    });
    // Reconcile anything the server rejected (sold out, price changed).
    for (const line of state.pricing.lines) {
      const local = state.cart.find((i) => i.id === line.product_id);
      if (local) { local.qty = line.qty; local.price = line.unit_price; }
    }
    const keep = new Set(state.pricing.lines.map((l) => l.product_id));
    state.cart = state.cart.filter((i) => keep.has(i.id));
    saveCart();
    if (state.pricing.problems?.length) toast(state.pricing.problems[0], 'error');
    return state.pricing;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

async function refreshCart() {
  const body = $('#cartBody');
  const foot = $('#cartFoot');

  if (!state.cart.length) {
    body.innerHTML = `<div class="empty-state">
      <div class="e-ico">${icon('basket', { size: 42, stroke: 1.4 })}</div>
      <p>Your basket is empty.</p>
      <p style="margin-top:14px"><a href="/shop" data-link class="btn btn-primary btn-sm">Browse bouquets</a></p>
    </div>`;
    foot.hidden = true;
    return;
  }

  body.innerHTML = state.cart.map((i) => `
    <div class="cart-item">
      <div class="thumb">${productArt(i)}</div>
      <div class="ci-body">
        <div class="ci-name">${esc(i.name)}</div>
        <div class="ci-price">${money(i.price)} each</div>
        <div class="ci-actions">
          <div class="mini-qty">
            <button data-qty="${i.id}" data-delta="-1" aria-label="Decrease">−</button>
            <span>${i.qty}</span>
            <button data-qty="${i.id}" data-delta="1" aria-label="Increase">+</button>
          </div>
          <button class="link-danger" data-remove="${i.id}">Remove</button>
        </div>
      </div>
      <div style="font-weight:800">${money(i.price * i.qty)}</div>
    </div>`).join('');

  const p = await priceCart();
  if (!p) { foot.hidden = true; return; }

  foot.hidden = false;
  foot.innerHTML = `
    <div class="coupon-row">
      <input id="couponInput" placeholder="Discount code" value="${esc(state.coupon)}">
      <button class="btn btn-outline btn-sm" id="couponApply">Apply</button>
    </div>
    ${p.coupon_error ? `<div class="form-err" style="margin-bottom:10px">${esc(p.coupon_error)}</div>` : ''}
    <div class="line-row"><span>Subtotal</span><span>${money(p.subtotal)}</span></div>
    ${p.discount > 0 ? `<div class="line-row" style="color:var(--sage-deep)"><span>Discount ${esc(p.coupon?.code || '')}</span><span>−${money(p.discount)}</span></div>` : ''}
    <div class="line-row"><span>Shipping</span><span>${p.shipping === 0 ? 'Free' : money(p.shipping)}</span></div>
    ${p.shipping > 0 && p.free_shipping_over > 0
      ? `<div class="line-row muted" style="font-size:12.5px"><span>Spend ${money(p.free_shipping_over - p.subtotal)} more for free shipping</span><span></span></div>` : ''}
    <div class="line-row total"><span>Total</span><span>${money(p.total)}</span></div>
    <a href="/checkout" data-link class="btn btn-primary btn-block">Checkout</a>`;
}

const openCart = () => { $('#cartDrawer').classList.add('open'); $('#scrim').classList.add('show'); refreshCart(); };
const closeCart = () => { $('#cartDrawer').classList.remove('open'); $('#scrim').classList.remove('show'); };

/* ------------------------------------------------------------------ */
/* Page: home                                                          */
/* ------------------------------------------------------------------ */

function skeletonGrid(n = 4) {
  return `<div class="grid">${Array.from({ length: n }, () =>
    `<div class="skel"><div class="skel-box"></div><div class="skel-line"></div><div class="skel-line short"></div></div>`
  ).join('')}</div>`;
}

async function pageHome() {
  const s = state.settings;
  const heroArt = bouquetSVG(7, 'rose', 5, 400, 400);

  $('#app').innerHTML = `
    <section class="hero">
      <div>
        <span class="eyebrow">Handmade · Never wilts</span>
        <h1>${esc(s.hero_title)}</h1>
        <p class="lead">${esc(s.hero_body)}</p>
        <div class="btn-row">
          <a href="/shop" data-link class="btn btn-primary">Shop bouquets</a>
          <a href="/shop?category=diy-kits" data-link class="btn btn-outline">Try a DIY kit</a>
        </div>
        <div class="stat-row">
          <div class="stat"><span class="num">${state.stats.sold || 0}+</span><span class="label">Bouquets gifted</span></div>
          <div class="stat"><span class="num">${state.stats.rating || 5}★</span><span class="label">Average rating</span></div>
          <div class="stat"><span class="num">${state.stats.products || 0}</span><span class="label">Designs in store</span></div>
        </div>
      </div>
      <div class="hero-art">
        <div class="hero-blob"></div>
        <svg viewBox="0 0 400 400" aria-hidden="true">${heroArt}</svg>
      </div>
    </section>

    <section class="occasions">
      <div class="chip-scroll">
        ${state.categories.map((c) => `
          <a href="/shop?category=${encodeURIComponent(c.slug)}" data-link class="chip">
            <span class="chip-ico" style="background:${esc(c.color)}">${
              iconOrText(c.icon, { size: 16 })}</span>${esc(c.name)}
          </a>`).join('')}
      </div>
    </section>

    <section class="gallery-section">
      <div class="section-head gallery-head">
        <div>
          <h2>Straight from the worktable</h2>
          <p>Every bouquet we have made lately. Tap one to buy it.</p>
        </div>
        <div class="gallery-controls">
          <button class="icon-btn" id="galleryPrev" aria-label="Scroll left">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6"/></svg>
          </button>
          <button class="icon-btn" id="galleryNext" aria-label="Scroll right">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>
      </div>
      <div class="gallery-strip" id="galleryStrip" tabindex="0"
           aria-label="Bouquet photos — scroll or drag to browse"></div>
    </section>

    <section class="section" id="shop">
      <div class="section-head">
        <div>
          <h2>Best-loved bouquets</h2>
          <p>Our most-gifted arrangements, twisted and shaped entirely by hand.</p>
        </div>
        <a href="/shop" data-link class="see-all">Shop all bouquets →</a>
      </div>
      <div id="featuredGrid">${skeletonGrid(4)}</div>
    </section>

    <section class="section">
      <div class="why">
        <div class="why-item">
          <div class="why-ico" style="background:#F2C9D9;color:#9C4E6C">${icon('handmade', { size: 24 })}</div>
          <h3>Twisted with care</h3>
          <p>No factories, no moulds — every petal is looped by hand by our small team, so no two bouquets are ever quite the same.</p>
        </div>
        <div class="why-item">
          <div class="why-ico" style="background:#DCEAD8;color:#4E7343">${icon('leaf', { size: 24 })}</div>
          <h3>Allergy-free &amp; pet-safe</h3>
          <p>No pollen, no water, no wilting leaves on the floor. Just soft, fuzzy colour that's safe around kids and curious pets.</p>
        </div>
        <div class="why-item">
          <div class="why-ico" style="background:#F6E3C0;color:#8A6320">${icon('infinity', { size: 24 })}</div>
          <h3>Built to outlast the moment</h3>
          <p>A real bouquet fades in a week. Yours will still be on the shelf next year — and the one after that.</p>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="promo">
        <div>
          <h2>Prefer to twist your own?</h2>
          <p>Our DIY kits come with pre-cut pipe cleaners, a printed pattern card, and everything you need to shape your first bouquet in an evening — no experience needed.</p>
          <a href="/shop?category=diy-kits" data-link class="btn btn-primary">Shop DIY kits</a>
        </div>
        <svg viewBox="0 0 400 280" style="width:100%;max-width:420px;justify-self:center" aria-hidden="true">${
          bouquetSVG(21, 'sage', 4, 400, 280)}</svg>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div><h2>What our flower-people say</h2><p>Real words from real inboxes.</p></div>
      </div>
      <div class="testi-grid">
        ${state.testimonials.slice(0, 3).map((t) => {
          const initials = t.name.split(' ').map((w) => w[0]).join('').slice(0, 2);
          const colors = ['#E39AB6', '#A8C3A0', '#EFC98A', '#C9B7DE'];
          return `<div class="testi-card">
            <div class="stars">${stars(t.rating)}</div>
            <p>"${esc(t.body)}"</p>
            <div class="testi-who">
              <div class="avatar" style="background:${colors[t.name.length % colors.length]}">${esc(initials)}</div>
              <div><div class="name">${esc(t.name)}</div><div class="loc">${esc(t.location || '')}</div></div>
            </div>
          </div>`;
        }).join('') || '<p class="muted">No reviews yet — yours could be the first.</p>'}
      </div>
    </section>

    <section class="section" id="faq">
      <div class="section-head" style="justify-content:center;text-align:center;flex-direction:column;align-items:center">
        <h2>Questions, answered</h2>
        <p>Can't find what you need? <a href="/contact" data-link style="color:var(--rose-deep);font-weight:700;text-decoration:underline">Message us</a> — we reply within a day.</p>
      </div>
      <div class="faq-wrap">
        ${state.faqs.map((f) => `
          <div class="faq-item">
            <button class="faq-q" aria-expanded="false"><span>${esc(f.question)}</span><span class="plus">+</span></button>
            <div class="faq-a"><div class="faq-a-inner">${esc(f.answer)}</div></div>
          </div>`).join('')}
      </div>
    </section>

    <section class="section">
      <div class="newsletter">
        <h2>Get first look at new blooms</h2>
        <p>Occasional emails about new colours, restocks, and gift-day reminders. No spam, ever.</p>
        <form class="nl-form" id="nlForm">
          <input type="email" placeholder="you@example.com" required aria-label="Email address">
          <button type="submit" class="btn btn-primary">Subscribe</button>
        </form>
        <div class="nl-msg" id="nlMsg"></div>
      </div>
    </section>`;

  wireFAQ();
  wireNewsletter();

  // One request feeds both the strip and the featured grid.
  const { products: everything } = await api('/api/products?limit=40&sort=newest');
  mountGallery(everything);

  const featured = everything.filter((p) => p.featured);
  const list = (featured.length ? featured : everything).slice(0, 8);
  $('#featuredGrid').innerHTML = list.length
    ? `<div class="grid">${list.map(productCard).join('')}</div>`
    : `<div class="empty-state"><div class="e-ico">${icon('flower', { size: 42, stroke: 1.4 })}</div>
       <p>No bouquets yet — add your first one in the admin panel.</p></div>`;
}

/* ------------------------------------------------------------------ */
/* Home gallery — a slow, continuous photo strip                       */
/* ------------------------------------------------------------------ */

/** Stops the running animation frame when the home page is torn down. */
let galleryStop = null;

/**
 * Fill the strip and drift it sideways forever.
 *
 * The list is rendered twice so the scroll position can wrap without a visible
 * jump. It drifts by nudging `scrollLeft` rather than animating a transform,
 * which keeps the strip a genuinely scrollable element — swipe, trackpad and
 * drag all still work, and the drift simply steps aside while they do.
 */
function mountGallery(products) {
  const strip = $('#galleryStrip');
  if (!strip) return;



  const tile = (p, i) => `
    <button class="gtile" data-quick="${esc(p.slug)}" aria-label="${esc(p.name)}, ${money(p.price)}"
            ${i >= products.length ? 'tabindex="-1" aria-hidden="true"' : ''}>
      <span class="gtile-art">${productArt(p)}</span>
      <span class="gtile-info">
        <span class="gtile-name">${esc(p.name)}</span>
        <span class="gtile-price">${money(p.price)}</span>
      </span>
      ${p.in_stock ? '' : '<span class="gtile-out">Sold out</span>'}
    </button>`;

  // Two passes of the same products: the second is the runway the first wraps
  // into. With only a handful of bouquets the strip does not overflow, so a
  // second pass would just show every photo twice side by side — render once
  // and leave it still.
  const TILE = 250;   // tile width plus gap, near enough for this decision
  const SHELL = 1180; // the page's content column

  // A showcase of one or two photos is just the grid below it repeated, so the
  // whole section waits until there is enough to actually show off.
  const section = strip.closest('.gallery-section');
  if (products.length < 3) {
    if (section) section.hidden = true;
    return;
  }
  if (section) section.hidden = false;

  // When the strip does not overflow it sits in the content column, so the
  // decision has to be measured against that width, not the whole window.
  const contentWidth = Math.min(strip.clientWidth, SHELL - 48);
  const loops = products.length * TILE > contentWidth;

  strip.innerHTML = (loops ? [...products, ...products] : products).map(tile).join('');
  // A strip that does not scroll should line up with the heading above it
  // instead of running to the window edges, so the section is flagged too.
  strip.classList.toggle('is-static', !loops);
  section?.classList.toggle('is-static', !loops);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || !loops;
  let paused = reduced;
  let raf = null;
  let last = 0;
  const SPEED = 22; // px per second — slow enough to read a label in passing

  const half = () => (loops ? strip.scrollWidth / 2 : 0);

  // The drift is tracked as a float here rather than read back from
  // `scrollLeft`: at this speed each frame moves well under a pixel, and the
  // browser rounds `scrollLeft`, so accumulating in the DOM loses every step
  // and the strip never moves.
  let pos = strip.scrollLeft;

  const step = (now) => {
    if (!last) last = now;
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1; // a backgrounded tab must not lurch on return

    const h = half();
    if (h > 0) {
      // While paused the reader owns the scroll position, so follow it; that
      // keeps the wrap working for swipes, drags and the arrow buttons too.
      if (paused) pos = strip.scrollLeft;
      else pos += SPEED * dt;

      if (pos >= h) pos -= h;
      else if (pos < 0) pos += h;

      // Only write when it actually differs, so a smooth arrow scroll is not
      // cancelled by an assignment every frame.
      if (Math.abs(pos - strip.scrollLeft) > 0.5) strip.scrollLeft = pos;
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);

  const hold = () => { paused = true; };
  const release = () => {
    if (reduced) return;
    last = 0;              // drop the stale frame timestamp
    pos = strip.scrollLeft; // pick up wherever the reader left it
    paused = false;
  };
  strip.addEventListener('pointerenter', hold);
  strip.addEventListener('pointerleave', release);
  strip.addEventListener('focusin', hold);
  strip.addEventListener('focusout', release);
  strip.addEventListener('touchstart', hold, { passive: true });
  strip.addEventListener('touchend', () => setTimeout(release, 2500), { passive: true });

  /* --- drag to scrub --- */
  let dragging = false;
  let startX = 0;
  let startScroll = 0;
  let moved = 0;

  strip.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return; // native touch scrolling is better
    dragging = true;
    moved = 0;
    startX = e.clientX;
    startScroll = strip.scrollLeft;
    strip.classList.add('dragging');
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    strip.scrollLeft = startScroll - dx;
  });
  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    strip.classList.remove('dragging');
    // A drag must not also register as a click on the tile underneath.
    if (moved > 6) strip.dataset.suppressClick = '1';
    setTimeout(() => { delete strip.dataset.suppressClick; }, 0);
  });

  const nudge = (dir) => {
    paused = true;
    strip.scrollBy({ left: dir * Math.min(520, strip.clientWidth * 0.8), behavior: 'smooth' });
    setTimeout(release, 2500);
  };
  const controls = $('.gallery-controls');
  if (controls) controls.hidden = !loops;
  $('#galleryPrev')?.addEventListener('click', () => nudge(-1));
  $('#galleryNext')?.addEventListener('click', () => nudge(1));

  galleryStop = () => { if (raf) cancelAnimationFrame(raf); raf = null; };
}

/* ------------------------------------------------------------------ */
/* Quick buy                                                           */
/* ------------------------------------------------------------------ */

const closeQuickView = () => {
  $('#qvScrim').classList.remove('show');
  document.body.style.overflow = '';
};

async function openQuickView(slug) {
  const scrim = $('#qvScrim');
  const box = $('#qv');
  box.innerHTML = '<div class="qv-loading">Loading…</div>';
  scrim.classList.add('show');
  document.body.style.overflow = 'hidden';

  let p;
  try {
    p = (await api('/api/products/' + encodeURIComponent(slug))).product;
  } catch (err) {
    box.innerHTML = `<div class="qv-loading">${esc(err.message)}</div>`;
    return;
  }

  track('product_view', { product_id: p.id });
  let qty = 1;

  box.innerHTML = `
    <button class="qv-close" id="qvClose" aria-label="Close">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
    <div class="qv-media">${productArt(p)}</div>
    <div class="qv-body">
      ${p.badge ? `<span class="eyebrow">${esc(p.badge)}</span>` : ''}
      <h3 id="qvName">${esc(p.name)}</h3>
      <div class="qv-meta">
        <span>${stars(p.rating)} ${Number(p.rating).toFixed(1)}</span>
        <span>${p.sold} sold</span>
        <span>${p.in_stock ? `${p.stock} in stock` : 'Out of stock'}</span>
      </div>
      <div class="qv-price">
        <span class="price">${money(p.price)}</span>
        ${p.old_price ? `<span class="price-old">${money(p.old_price)}</span>` : ''}
      </div>
      <p class="qv-desc">${esc(p.description)}</p>
      <div class="qv-actions">
        <div class="qty">
          <button id="qvMinus" aria-label="Decrease quantity">−</button>
          <span id="qvQty">1</span>
          <button id="qvPlus" aria-label="Increase quantity">+</button>
        </div>
        <button class="btn btn-outline" id="qvAdd" ${p.in_stock ? '' : 'disabled'}>Add to basket</button>
        <button class="btn btn-primary" id="qvBuy" ${p.in_stock ? '' : 'disabled'}>
          ${p.in_stock ? 'Buy now' : 'Sold out'}</button>
      </div>
      <a href="/product/${esc(p.slug)}" data-link class="qv-more">See full details →</a>
    </div>`;

  const setQ = (v) => { qty = Math.max(1, Math.min(p.stock || 1, v)); $('#qvQty').textContent = qty; };
  $('#qvMinus').onclick = () => setQ(qty - 1);
  $('#qvPlus').onclick = () => setQ(qty + 1);
  $('#qvClose').onclick = closeQuickView;

  $('#qvAdd').onclick = () => {
    addToCart(p, qty);
    closeQuickView();
    openCart();
  };
  $('#qvBuy').onclick = () => {
    addToCart(p, qty);
    closeQuickView();
    navigate('/checkout');
  };
}

/* ------------------------------------------------------------------ */
/* Page: shop                                                          */
/* ------------------------------------------------------------------ */

function productCard(p) {
  const out = !p.in_stock;
  return `<article class="card">
    <a href="/product/${esc(p.slug)}" data-link class="card-media">
      ${out ? '<span class="badge stock-out">Sold out</span>'
        : p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ''}
      ${productArt(p)}
      <button class="quick-add" data-add="${p.id}" data-slug="${esc(p.slug)}" ${out ? 'disabled' : ''}>
        ${out ? 'Out of stock' : '+ Add to basket'}
      </button>
    </a>
    <div class="card-body">
      <a href="/product/${esc(p.slug)}" data-link class="name">${esc(p.name)}</a>
      <div class="meta-row">★ ${Number(p.rating).toFixed(1)} · ${p.sold} sold${
        p.stock > 0 && p.stock <= 5 ? ` · only ${p.stock} left` : ''}</div>
      <div class="price-row">
        <span class="price">${money(p.price)}</span>
        ${p.old_price ? `<span class="price-old">${money(p.old_price)}</span>` : ''}
      </div>
    </div>
  </article>`;
}

async function pageShop(params) {
  const category = params.get('category') || 'all';
  const sort = params.get('sort') || 'popular';
  const q = params.get('q') || '';

  $('#app').innerHTML = `
    <section class="section">
      <div class="crumbs"><a href="/" data-link>Home</a> / Shop</div>
      <div class="section-head">
        <div>
          <h2>${category === 'all' ? 'Every bouquet' :
            esc(state.categories.find((c) => c.slug === category)?.name || 'Shop')}</h2>
          <p>Hand-twisted, made to order, and shipped in protective boxes.</p>
        </div>
      </div>

      <div class="chip-scroll" style="margin-bottom:20px">
        <a href="/shop" data-link class="chip ${category === 'all' ? 'active' : ''}">
          <span class="chip-ico" style="background:var(--cream-deep)">${icon('flower', { size: 16 })}</span>All</a>
        ${state.categories.map((c) => `
          <a href="/shop?category=${encodeURIComponent(c.slug)}" data-link class="chip ${category === c.slug ? 'active' : ''}">
            <span class="chip-ico" style="background:${esc(c.color)}">${
              iconOrText(c.icon, { size: 16 })}</span>${esc(c.name)}</a>`).join('')}
      </div>

      <div class="filters">
        <div class="field">${icon('search', { size: 16 })}<input id="searchInput" placeholder="Search bouquets…" value="${esc(q)}"></div>
        <div class="field">
          <select id="sortSelect">
            <option value="popular"${sort === 'popular' ? ' selected' : ''}>Most popular</option>
            <option value="newest"${sort === 'newest' ? ' selected' : ''}>Newest first</option>
            <option value="price_asc"${sort === 'price_asc' ? ' selected' : ''}>Price: low to high</option>
            <option value="price_desc"${sort === 'price_desc' ? ' selected' : ''}>Price: high to low</option>
            <option value="name"${sort === 'name' ? ' selected' : ''}>Name A–Z</option>
          </select>
        </div>
        <span class="result-count" id="resultCount"></span>
      </div>

      <div id="shopGrid">${skeletonGrid(8)}</div>
    </section>`;

  const query = new URLSearchParams({ category, sort, limit: '60' });
  if (q) query.set('q', q);
  const { products, total } = await api('/api/products?' + query);

  $('#resultCount').textContent = `${total} ${total === 1 ? 'bouquet' : 'bouquets'}`;
  $('#shopGrid').innerHTML = products.length
    ? `<div class="grid">${products.map(productCard).join('')}</div>`
    : `<div class="empty-state"><div class="e-ico">${icon('emptySearch', { size: 42, stroke: 1.4 })}</div><p>Nothing matches that yet.</p>
       <p style="margin-top:14px"><a href="/shop" data-link class="btn btn-outline btn-sm">Clear filters</a></p></div>`;

  const applyFilters = () => {
    const next = new URLSearchParams();
    if (category !== 'all') next.set('category', category);
    const term = $('#searchInput').value.trim();
    if (term) { next.set('q', term); track('search', { path: '/shop' }); }
    const s = $('#sortSelect').value;
    if (s !== 'popular') next.set('sort', s);
    navigate('/shop' + (next.toString() ? '?' + next : ''));
  };

  let debounce;
  $('#searchInput').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(applyFilters, 420);
  });
  $('#sortSelect').addEventListener('change', applyFilters);
}

/* ------------------------------------------------------------------ */
/* Page: product                                                       */
/* ------------------------------------------------------------------ */

async function pageProduct(slug) {
  $('#app').innerHTML = `<section class="section">${skeletonGrid(2)}</section>`;

  let data;
  try { data = await api('/api/products/' + encodeURIComponent(slug)); }
  catch { return pageNotFound(); }

  const p = data.product;
  track('product_view', { product_id: p.id });
  document.title = `${p.name} | ${state.settings.shop_name}`;

  $('#app').innerHTML = `
    <section class="section">
      <div class="crumbs">
        <a href="/" data-link>Home</a> / <a href="/shop" data-link>Shop</a>
        ${p.category ? ` / <a href="/shop?category=${esc(p.category_slug)}" data-link>${esc(p.category)}</a>` : ''}
      </div>

      <div class="pdp">
        <div class="pdp-media">${productArt(p)}</div>
        <div>
          ${p.badge ? `<span class="eyebrow">${esc(p.badge)}</span>` : ''}
          <h1>${esc(p.name)}</h1>
          <div class="pdp-meta">
            <span>${stars(p.rating)} ${Number(p.rating).toFixed(1)} (${p.review_count})</span>
            <span>${p.sold} sold</span>
            <span>${p.in_stock ? `${p.stock} in stock` : 'Out of stock'}</span>
          </div>
          <div class="pdp-price">
            <span class="price">${money(p.price)}</span>
            ${p.old_price ? `<span class="price-old">${money(p.old_price)}</span>` : ''}
            ${p.old_price ? `<span class="pill" style="background:var(--rose-light)">Save ${money(p.old_price - p.price)}</span>` : ''}
          </div>
          <p class="desc">${esc(p.description)}</p>

          <div class="pill-row">
            <span class="pill">${icon('leaf', { size: 15 })} No water needed</span>
            <span class="pill">${icon('heart', { size: 15 })} Pet safe</span>
            <span class="pill">${icon('products', { size: 15 })} Ships in 2–4 days</span>
          </div>

          <div class="btn-row" style="align-items:center">
            <div class="qty">
              <button id="qtyMinus" aria-label="Decrease quantity">−</button>
              <span id="qtyVal">1</span>
              <button id="qtyPlus" aria-label="Increase quantity">+</button>
            </div>
            <button class="btn btn-primary" id="addBtn" ${p.in_stock ? '' : 'disabled'}>
              ${p.in_stock ? 'Add to basket' : 'Sold out'}
            </button>
          </div>

          <div class="trust-row">
            <div class="trust"><div class="t-ico">${icon('handmade', { size: 20 })}</div><div class="t-txt">Hand-twisted<br>in small batches</div></div>
            <div class="trust"><div class="t-ico">${icon('truck', { size: 20 })}</div><div class="t-txt">Free shipping<br>over ${money(state.settings.free_shipping_over)}</div></div>
            <div class="trust"><div class="t-ico">${icon('returns', { size: 20 })}</div><div class="t-txt">14-day<br>returns</div></div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><div><h2>Reviews</h2><p>${p.review_count} verified ${p.review_count === 1 ? 'review' : 'reviews'}.</p></div></div>
      <div class="testi-grid">
        ${data.reviews.map((r) => `
          <div class="testi-card">
            <div class="stars">${stars(r.rating)}</div>
            <p>"${esc(r.body)}"</p>
            <div class="testi-who">
              <div class="avatar" style="background:var(--rose)">${esc(r.name.slice(0, 2))}</div>
              <div><div class="name">${esc(r.name)}</div><div class="loc">${esc(r.location || '')}</div></div>
            </div>
          </div>`).join('') || '<p class="muted">No reviews yet — be the first to write one.</p>'}
      </div>

      <div class="panel" style="max-width:640px;margin-top:28px">
        <h3>Write a review</h3>
        <form id="reviewForm" class="form-grid">
          <div class="form-row"><label for="rvName">Your name</label><input id="rvName" required maxlength="80"></div>
          <div class="form-row"><label for="rvLoc">Where from</label><input id="rvLoc" placeholder="Aarhus, DK" maxlength="80"></div>
          <div class="form-row"><label for="rvRating">Rating</label>
            <select id="rvRating">
              <option value="5">★★★★★ Loved it</option><option value="4">★★★★☆ Really good</option>
              <option value="3">★★★☆☆ Fine</option><option value="2">★★☆☆☆ Not for me</option>
              <option value="1">★☆☆☆☆ Disappointed</option>
            </select></div>
          <div class="form-row"><label for="rvEmail">Email (kept private)</label><input id="rvEmail" type="email"></div>
          <div class="form-row full"><label for="rvBody">Your review</label><textarea id="rvBody" required maxlength="1200"></textarea></div>
          <div class="form-row full"><button class="btn btn-primary" type="submit">Submit review</button></div>
        </form>
      </div>
    </section>

    ${data.related.length ? `<section class="section">
      <div class="section-head"><div><h2>You might also like</h2></div></div>
      <div class="grid">${data.related.map(productCard).join('')}</div>
    </section>` : ''}`;

  let qty = 1;
  const setQ = (v) => { qty = Math.max(1, Math.min(p.stock || 1, v)); $('#qtyVal').textContent = qty; };
  $('#qtyMinus').onclick = () => setQ(qty - 1);
  $('#qtyPlus').onclick = () => setQ(qty + 1);
  $('#addBtn').onclick = () => { addToCart(p, qty); openCart(); };

  $('#reviewForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/reviews', {
        method: 'POST',
        body: JSON.stringify({
          product_id: p.id, name: $('#rvName').value, location: $('#rvLoc').value,
          email: $('#rvEmail').value, rating: $('#rvRating').value, body: $('#rvBody').value
        })
      });
      toast(r.message);
      e.target.reset();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ------------------------------------------------------------------ */
/* Page: checkout                                                      */
/* ------------------------------------------------------------------ */

const PAYMENT_LABELS = {
  cod: ['Cash on delivery', 'Pay the courier when your bouquet arrives'],
  bank: ['Bank transfer', 'We email you the account details right away'],
  card: ['Card on delivery', 'Card machine brought to your door']
};

async function pageCheckout() {
  if (!state.cart.length) {
    $('#app').innerHTML = `<section class="section"><div class="empty-state">
      <div class="e-ico">${icon('basket', { size: 42, stroke: 1.4 })}</div><p>Your basket is empty.</p>
      <p style="margin-top:14px"><a href="/shop" data-link class="btn btn-primary btn-sm">Browse bouquets</a></p>
    </div></section>`;
    return;
  }

  track('begin_checkout');
  const p = (await priceCart()) || {};
  const methods = state.settings.payment_methods || ['cod'];

  $('#app').innerHTML = `
    <section class="section">
      <div class="crumbs"><a href="/" data-link>Home</a> / Checkout</div>
      <div class="section-head"><div><h2>Checkout</h2><p>We hand-make every order — expect 2–4 days before it ships.</p></div></div>

      <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:30px;align-items:start" class="checkout-grid">
        <form class="panel" id="checkoutForm">
          <h3>Delivery details</h3>
          <div class="form-grid">
            <div class="form-row"><label for="coName">Full name *</label><input id="coName" required maxlength="120"></div>
            <div class="form-row"><label for="coEmail">Email *</label><input id="coEmail" type="email" required maxlength="160"></div>
            <div class="form-row"><label for="coPhone">Phone</label><input id="coPhone" maxlength="40"></div>
            <div class="form-row"><label for="coCity">City</label><input id="coCity" maxlength="80"></div>
            <div class="form-row full"><label for="coAddress">Street address</label><input id="coAddress" maxlength="300"></div>
            <div class="form-row"><label for="coPost">Postcode</label><input id="coPost" maxlength="20"></div>
            <div class="form-row"><label for="coCountry">Country</label><input id="coCountry" maxlength="80"></div>
            <div class="form-row full"><label for="coNote">Gift note or delivery instructions</label>
              <textarea id="coNote" maxlength="500" placeholder="Anything we should know?"></textarea></div>
          </div>

          <h3 style="margin-top:28px">How would you like to pay?</h3>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${methods.map((m, i) => `
              <label class="choice ${i === 0 ? 'selected' : ''}">
                <input type="radio" name="pay" value="${esc(m)}" ${i === 0 ? 'checked' : ''}>
                <span>
                  <span class="c-title">${esc(PAYMENT_LABELS[m]?.[0] || m)}</span><br>
                  <span class="c-sub">${esc(PAYMENT_LABELS[m]?.[1] || '')}</span>
                </span>
              </label>`).join('')}
          </div>

          <div class="form-err" id="coError" style="margin-top:16px"></div>
          <button class="btn btn-primary btn-block" type="submit" id="placeBtn" style="margin-top:18px">
            Place order · ${money(p.total)}
          </button>
          <p class="muted" style="font-size:12.5px;text-align:center;margin-top:12px">
            No card details are stored on this site.</p>
        </form>

        <div class="panel">
          <h3>Your order</h3>
          ${(p.lines || []).map((l) => `
            <div class="cart-item">
              <div class="thumb">${bouquet(l)}</div>
              <div class="ci-body">
                <div class="ci-name">${esc(l.name)}</div>
                <div class="ci-price">${l.qty} × ${money(l.unit_price)}</div>
              </div>
              <div style="font-weight:800">${money(l.line_total)}</div>
            </div>`).join('')}
          <div style="margin-top:18px">
            <div class="line-row"><span>Subtotal</span><span>${money(p.subtotal)}</span></div>
            ${p.discount > 0 ? `<div class="line-row" style="color:var(--sage-deep)"><span>Discount ${esc(p.coupon?.code || '')}</span><span>−${money(p.discount)}</span></div>` : ''}
            <div class="line-row"><span>Shipping</span><span>${p.shipping === 0 ? 'Free' : money(p.shipping)}</span></div>
            <div class="line-row total"><span>Total</span><span>${money(p.total)}</span></div>
          </div>
        </div>
      </div>
    </section>`;

  $$('.choice').forEach((c) => c.addEventListener('click', () => {
    $$('.choice').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
  }));

  $('#checkoutForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#placeBtn');
    btn.disabled = true;
    btn.textContent = 'Placing your order…';
    $('#coError').textContent = '';

    try {
      const result = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#coName').value, email: $('#coEmail').value, phone: $('#coPhone').value,
          address: $('#coAddress').value, city: $('#coCity').value, postcode: $('#coPost').value,
          country: $('#coCountry').value, note: $('#coNote').value,
          payment_method: $('input[name=pay]:checked')?.value,
          coupon: state.coupon,
          items: state.cart.map((i) => ({ id: i.id, qty: i.qty }))
        })
      });
      state.cart = [];
      state.coupon = '';
      saveCart();
      sessionStorage.setItem('fb_last_order', JSON.stringify(result));
      navigate('/order/' + result.order_no);
    } catch (err) {
      $('#coError').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Place order';
    }
  });
}

function pageOrderConfirmed(orderNo) {
  let info = {};
  try { info = JSON.parse(sessionStorage.getItem('fb_last_order')) || {}; } catch { /* ignore */ }

  $('#app').innerHTML = `
    <section class="section" style="max-width:680px">
      <div class="success-hero">
        <div class="tick">${icon('check', { size: 38, stroke: 2.6 })}</div>
        <h1 style="font-size:34px">Thank you — your bouquet is on its way</h1>
        <p class="muted" style="margin-top:12px">
          We've sent a confirmation to ${esc(info.email || 'your email')}. Keep this number safe:</p>
        <div class="order-no-box">${esc(orderNo)}</div>
        ${info.total ? `<p class="muted">Total ${money(info.total)} · ${esc(PAYMENT_LABELS[info.payment_method]?.[0] || info.payment_method || '')}</p>` : ''}
      </div>
      <div class="panel" style="margin-top:30px">
        <h3>What happens next</h3>
        <div class="timeline">
          <div class="tl-item"><div class="tl-dot"></div><div>
            <div class="tl-title">Order received</div>
            <div class="tl-meta">We've got it. Nothing for you to do.</div></div></div>
          <div class="tl-item"><div class="tl-dot" style="background:var(--cream-deep);box-shadow:none"></div><div>
            <div class="tl-title">Hand-twisted</div>
            <div class="tl-meta">Your bouquet is made to order — usually 2–4 days.</div></div></div>
          <div class="tl-item"><div class="tl-dot" style="background:var(--cream-deep);box-shadow:none"></div><div>
            <div class="tl-title">On its way</div>
            <div class="tl-meta">You'll get a note the moment it ships.</div></div></div>
        </div>
        <div class="btn-row" style="margin-top:24px">
          <a href="/track?order_no=${encodeURIComponent(orderNo)}" data-link class="btn btn-primary">Track this order</a>
          <a href="/shop" data-link class="btn btn-outline">Keep shopping</a>
        </div>
      </div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* Page: track order                                                   */
/* ------------------------------------------------------------------ */

const STEPS = ['pending', 'confirmed', 'packing', 'shipped', 'delivered'];

function pageTrack(params) {
  const prefill = params.get('order_no') || '';

  $('#app').innerHTML = `
    <section class="section" style="max-width:720px">
      <div class="crumbs"><a href="/" data-link>Home</a> / Track order</div>
      <div class="section-head"><div><h2>Where is my bouquet?</h2>
        <p>Enter the order number from your confirmation, plus the email you used.</p></div></div>
      <form class="panel" id="trackForm">
        <div class="form-grid">
          <div class="form-row"><label for="tkNo">Order number</label>
            <input id="tkNo" placeholder="FB-10021" required value="${esc(prefill)}"></div>
          <div class="form-row"><label for="tkEmail">Email</label>
            <input id="tkEmail" type="email" placeholder="you@example.com" required></div>
        </div>
        <div class="form-err" id="tkError" style="margin-top:12px"></div>
        <button class="btn btn-primary" type="submit" style="margin-top:16px">Find my order</button>
      </form>
      <div id="trackResult"></div>
    </section>`;

  $('#trackForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#tkError').textContent = '';
    $('#trackResult').innerHTML = '';
    try {
      const d = await api(`/api/track-order?order_no=${encodeURIComponent($('#tkNo').value)}&email=${encodeURIComponent($('#tkEmail').value)}`);
      const o = d.order;
      const reached = STEPS.indexOf(o.status);

      $('#trackResult').innerHTML = `
        <div class="panel" style="margin-top:24px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
            <div><h3 style="margin:0">${esc(o.order_no)}</h3>
              <div class="muted" style="font-size:13.5px;margin-top:4px">
                Placed ${new Date(o.created_at).toLocaleDateString()}</div></div>
            <span class="status-tag st-${esc(o.status)}">${esc(o.status)}</span>
          </div>

          <div class="timeline" style="margin-top:24px">
            ${['cancelled', 'refunded'].includes(o.status)
              ? `<div class="tl-item"><div class="tl-dot" style="background:#96393C"></div><div>
                   <div class="tl-title">${esc(o.status)}</div>
                   <div class="tl-meta">Get in touch if this looks wrong.</div></div></div>`
              : STEPS.map((s, i) => `
                <div class="tl-item">
                  <div class="tl-dot" style="${i > reached ? 'background:var(--cream-deep);box-shadow:none' : ''}"></div>
                  <div><div class="tl-title">${s}</div>
                    <div class="tl-meta">${esc(d.timeline.find((t) => t.status === s)?.created_at
                      ? new Date(d.timeline.find((t) => t.status === s).created_at).toLocaleString()
                      : i > reached ? 'Not yet' : '')}</div></div>
                </div>`).join('')}
          </div>

          <div style="margin-top:24px;border-top:1px solid var(--line);padding-top:20px">
            ${d.items.map((i) => `<div class="line-row"><span>${i.qty} × ${esc(i.name)}</span><span>${money(i.line_total)}</span></div>`).join('')}
            <div class="line-row"><span>Shipping</span><span>${o.shipping === 0 ? 'Free' : money(o.shipping)}</span></div>
            ${o.discount > 0 ? `<div class="line-row"><span>Discount</span><span>−${money(o.discount)}</span></div>` : ''}
            <div class="line-row total"><span>Total</span><span>${money(o.total)}</span></div>
            <div class="muted" style="font-size:13px">Payment: ${esc(o.payment_method)} ·
              <span class="status-tag st-${esc(o.payment_status)}">${esc(o.payment_status)}</span></div>
          </div>

          <div style="margin-top:20px;font-size:14px;line-height:1.7" class="muted">
            <strong style="color:var(--mocha)">Shipping to</strong><br>
            ${esc(o.ship_name)}<br>${esc(o.ship_address)}<br>
            ${esc(o.ship_postcode)} ${esc(o.ship_city)} ${esc(o.ship_country)}
          </div>
        </div>`;
    } catch (err) {
      $('#tkError').textContent = err.message;
    }
  });

  if (prefill) $('#tkEmail').focus();
}

/* ------------------------------------------------------------------ */
/* Page: contact                                                       */
/* ------------------------------------------------------------------ */

function pageContact() {
  const s = state.settings;
  $('#app').innerHTML = `
    <section class="section" style="max-width:900px">
      <div class="crumbs"><a href="/" data-link>Home</a> / Contact</div>
      <div class="section-head"><div><h2>Say hello</h2>
        <p>Custom colours, bulk orders, or a question about an order — we read everything.</p></div></div>

      <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:26px;align-items:start" class="checkout-grid">
        <form class="panel" id="contactForm">
          <div class="form-grid">
            <div class="form-row"><label for="cName">Your name *</label><input id="cName" required maxlength="120"></div>
            <div class="form-row"><label for="cEmail">Email *</label><input id="cEmail" type="email" required maxlength="160"></div>
            <div class="form-row full"><label for="cSubject">Subject</label><input id="cSubject" maxlength="160"></div>
            <div class="form-row full"><label for="cBody">Message *</label><textarea id="cBody" required maxlength="2000"></textarea></div>
          </div>
          <div class="form-err" id="cError" style="margin-top:12px"></div>
          <button class="btn btn-primary" type="submit" style="margin-top:16px">Send message</button>
        </form>

        <div class="panel">
          <h3>Other ways</h3>
          <div class="contact-line">${icon('mail', { size: 16 })} ${esc(s.email)}</div>
          <div class="contact-line">${icon('phone', { size: 16 })} ${esc(s.phone)}</div>
          <div class="contact-line">${icon('pin', { size: 16 })} ${esc(s.address)}</div>
          <div class="contact-line">${icon('clock', { size: 16 })} ${esc(s.hours)}</div>
          <p class="muted" style="font-size:14px;line-height:1.7;margin-top:18px">
            We answer messages within one working day. For order questions, include your
            order number so we can look it up straight away.</p>
        </div>
      </div>
    </section>`;

  $('#contactForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#cError').textContent = '';
    try {
      const r = await api('/api/contact', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#cName').value, email: $('#cEmail').value,
          subject: $('#cSubject').value, message: $('#cBody').value
        })
      });
      toast(r.message);
      e.target.reset();
    } catch (err) { $('#cError').textContent = err.message; }
  });
}

function pageNotFound() {
  $('#app').innerHTML = `<section class="section"><div class="empty-state">
    <div class="e-ico">${icon('flower', { size: 42, stroke: 1.4 })}</div><h2>We couldn't find that page</h2>
    <p style="margin-top:14px"><a href="/" data-link class="btn btn-primary btn-sm">Back to the shop</a></p>
  </div></section>`;
}

/* ------------------------------------------------------------------ */
/* Shared wiring                                                       */
/* ------------------------------------------------------------------ */

function wireFAQ() {
  $$('.faq-item').forEach((item) => {
    const btn = $('.faq-q', item);
    const ans = $('.faq-a', item);
    btn.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      $$('.faq-item.open').forEach((o) => {
        o.classList.remove('open');
        $('.faq-a', o).style.maxHeight = null;
        $('.faq-q', o).setAttribute('aria-expanded', 'false');
      });
      if (!isOpen) {
        item.classList.add('open');
        ans.style.maxHeight = ans.scrollHeight + 'px';
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
}

function wireNewsletter() {
  const form = $('#nlForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ email: form.querySelector('input').value })
      });
      $('#nlMsg').textContent = r.message;
      form.reset();
    } catch (err) { $('#nlMsg').textContent = err.message; }
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function navigate(url, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  render();
}

async function render() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  closeCart();
  closeQuickView();
  // The gallery's animation frame belongs to the page that created it.
  if (galleryStop) { galleryStop(); galleryStop = null; }
  $('#navLinks').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'instant' });

  $$('#navLinks a[data-route]').forEach((a) =>
    a.classList.toggle('active', a.dataset.route === path));

  document.title = `${state.settings.shop_name} | ${state.settings.tagline}`;
  track('pageview');

  try {
    if (path === '/') await pageHome();
    else if (path === '/shop') await pageShop(params);
    else if (path.startsWith('/product/')) await pageProduct(path.slice(9));
    else if (path === '/checkout') await pageCheckout();
    else if (path.startsWith('/order/')) pageOrderConfirmed(decodeURIComponent(path.slice(7)));
    else if (path === '/track') pageTrack(params);
    else if (path === '/contact') pageContact();
    else pageNotFound();
  } catch (err) {
    console.error(err);
    $('#app').innerHTML = `<section class="section"><div class="empty-state">
      <div class="e-ico">${icon('offline', { size: 42, stroke: 1.4 })}</div><h2>Something went wrong</h2>
      <p class="muted" style="margin-top:8px">${esc(err.message)}</p>
      <p style="margin-top:14px"><button class="btn btn-outline btn-sm" onclick="location.reload()">Try again</button></p>
    </div></section>`;
  }

  if (location.hash) {
    const target = document.querySelector(location.hash);
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth' }), 60);
  }
}

/* ------------------------------------------------------------------ */
/* Chrome (header/footer) + global listeners                           */
/* ------------------------------------------------------------------ */

function paintChrome() {
  const s = state.settings;
  $('#announce').textContent = s.announcement || '';
  $('#announce').hidden = !s.announcement;
  $('#brandName').textContent = s.shop_name;
  $('#footBrand').textContent = s.shop_name;
  $('#footAbout').textContent = s.about;
  $('#footEmail').innerHTML = icon('mail', { size: 15 }) + ' ' + esc(s.email);
  $('#footAddr').innerHTML = icon('pin', { size: 15 }) + ' ' + esc(s.address);
  $('#footHours').innerHTML = icon('clock', { size: 15 }) + ' ' + esc(s.hours);
  $('#footCopy').textContent = `© ${new Date().getFullYear()} ${s.shop_name}. All bouquets handmade to order.`;

  const socials = ['instagram', 'facebook', 'tiktok', 'pinterest'];
  const configured = socials.filter((k) => s[k] && s[k] !== '#');
  $('#socialRow').innerHTML = (configured.length ? configured : socials)
    .map((k) => `<a href="${configured.length ? esc(s[k]) : '#'}"
      ${configured.length ? 'target="_blank" rel="noopener"' : ''}
      aria-label="${k}">${icon(k, { size: 17 })}</a>`).join('');
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#qvScrim') && !e.target.closest('#qv')) { closeQuickView(); return; }

  const tile = e.target.closest('[data-quick]');
  if (tile) {
    // A drag across the strip must not count as a tap on a tile.
    if ($('#galleryStrip')?.dataset.suppressClick) return;
    e.preventDefault();
    openQuickView(tile.dataset.quick);
    return;
  }

  // Quick-add sits inside the product link, so it has to be matched first —
  // otherwise the card's anchor swallows the click and navigates instead.
  const add = e.target.closest('[data-add]');
  if (add) {
    e.preventDefault();
    if (add.disabled) return;
    add.disabled = true;
    api('/api/products/' + encodeURIComponent(add.dataset.slug))
      .then((d) => addToCart(d.product, 1))
      .catch((err) => toast(err.message, 'error'))
      .finally(() => { add.disabled = false; });
    return;
  }

  const link = e.target.closest('a[data-link]');
  if (link && link.origin === location.origin) {
    e.preventDefault();
    navigate(link.getAttribute('href'));
    return;
  }

  const qtyBtn = e.target.closest('[data-qty]');
  if (qtyBtn) {
    const line = state.cart.find((i) => i.id === Number(qtyBtn.dataset.qty));
    if (line) setQty(line.id, line.qty + Number(qtyBtn.dataset.delta));
    return;
  }

  const rm = e.target.closest('[data-remove]');
  if (rm) { setQty(Number(rm.dataset.remove), 0); return; }

  if (e.target.closest('#couponApply')) {
    state.coupon = $('#couponInput').value.trim().toUpperCase();
    saveCart();
    refreshCart();
  }
});

$('#cartBtn').addEventListener('click', openCart);
$('#cartClose').addEventListener('click', closeCart);
$('#scrim').addEventListener('click', closeCart);
$('#menuToggle').addEventListener('click', () => {
  const nav = $('#navLinks');
  nav.classList.toggle('open');
  $('#menuToggle').setAttribute('aria-expanded', nav.classList.contains('open'));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeCart(); closeQuickView(); } });
window.addEventListener('popstate', render);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(async function boot() {
  loadCart();
  saveCart();
  try {
    const data = await api('/api/shop/bootstrap');
    Object.assign(state, data);
  } catch {
    $('#app').innerHTML = `<section class="section"><div class="empty-state">
      <div class="e-ico">${icon('offline', { size: 42, stroke: 1.4 })}</div><h2>The shop is offline</h2>
      <p class="muted">Start the server with <code>npm start</code> and refresh.</p></div></section>`;
    return;
  }
  paintChrome();
  await render();
  refreshCart();
})();

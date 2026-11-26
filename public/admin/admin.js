/**
 * Maya Flora — admin panel.
 *
 * Hash-routed views over the /api/admin endpoints. The session lives in an
 * HttpOnly cookie, so there is no token handling here: a 401 simply drops the
 * operator back to the login screen.
 */
import {
  areaChart, columnChart, donutChart, barChart, funnelChart, heatmap,
  sparkline, meter, compact, PALETTE
} from './charts.js';
import { bouquetSVG, PALETTES } from '/js/bouquet.js';
import { icon, iconOrText, PICKABLE } from '/js/icons.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const app = { admin: null, settings: {}, alerts: {}, range: 30 };

const money = (n) => `${app.settings.currency_symbol || '$'}${Number(n || 0)
  .toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// A minus sign belongs before the currency symbol, not after it.
const moneyShort = (n) => {
  const sym = app.settings.currency_symbol || '$';
  return Number(n) < 0 ? `-${sym}${compact(Math.abs(n))}` : `${sym}${compact(n)}`;
};

const dateTime = (iso) => new Date(iso).toLocaleString(undefined,
  { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateOnly = (iso) => new Date(iso).toLocaleDateString(undefined,
  { day: 'numeric', month: 'short', year: 'numeric' });

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options
  });
  if (res.status === 401) { app.admin = null; renderLogin(); throw new Error('Session expired'); }
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

const tag = (value) => `<span class="tag t-${esc(value)}">${esc(value)}</span>`;

function delta(value, label = 'vs prev.') {
  const v = Number(value) || 0;
  const dir = v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—';
  return `<span class="delta ${dir}">${arrow} ${Math.abs(v).toFixed(1)}%
    <span class="vs">${esc(label)}</span></span>`;
}

// Always draw the bouquet on a 240pt canvas and let the viewBox scale it down —
// drawing directly at 40px turns the petals into an unreadable blob.
const ART = 240;

const productArt = (p) => p.image_url
  ? `<img src="${esc(p.image_url)}" alt="" style="width:100%;height:100%;object-fit:cover">`
  : `<svg viewBox="0 0 ${ART} ${ART}" style="width:100%;height:100%" aria-hidden="true">${
      bouquetSVG(p.seed, p.palette, p.bloom_count, ART, ART)}</svg>`;

/* ------------------------------------------------------------------ */
/* Bulk selection                                                      */
/* ------------------------------------------------------------------ */

/** A checkbox for one selectable row. `stopPropagation` keeps row clicks from opening the editor. */
const rowCheck = (id) =>
  `<label class="pick" onclick="event.stopPropagation()">
     <input type="checkbox" class="row-check" value="${id}"></label>`;

const headCheck = () =>
  `<th class="pick-col"><label class="pick"><input type="checkbox" id="checkAll"
     aria-label="Select all"></label></th>`;

/**
 * Wire selection + a bulk action bar into whatever was just rendered.
 *
 * @param {object} cfg
 * @param {string} cfg.entity     server-side entity name for /api/admin/bulk
 * @param {string} cfg.noun       "order" / "product" — used in the bar's label
 * @param {Array}  cfg.actions    [{ label, action, value, tone, confirm }]
 * @param {Function} cfg.reload   called after a successful action
 */
function initBulk(cfg) {
  const boxes = $$('.row-check');
  const bar = $('#bulkBar');
  if (!bar) return;
  if (!boxes.length) { bar.hidden = true; return; }

  const selected = () => boxes.filter((b) => b.checked).map((b) => Number(b.value));
  let lastIndex = null;

  const paint = () => {
    const n = selected().length;
    bar.hidden = n === 0;
    $('#bulkCount').textContent = `${n} ${cfg.noun}${n === 1 ? '' : 's'} selected`;
    const all = $('#checkAll');
    if (all) {
      all.checked = n === boxes.length && n > 0;
      all.indeterminate = n > 0 && n < boxes.length;
    }
    boxes.forEach((b) => b.closest('tr, .card')?.classList.toggle('picked', b.checked));
  };

  boxes.forEach((box, i) => {
    box.addEventListener('click', (e) => {
      // Shift-click selects the whole range, the way a file manager does.
      if (e.shiftKey && lastIndex !== null) {
        const [from, to] = [Math.min(lastIndex, i), Math.max(lastIndex, i)];
        for (let j = from; j <= to; j++) boxes[j].checked = box.checked;
      }
      lastIndex = i;
      paint();
    });
  });

  $('#checkAll')?.addEventListener('change', (e) => {
    boxes.forEach((b) => { b.checked = e.target.checked; });
    lastIndex = null;
    paint();
  });

  bar.querySelector('.bulk-actions').innerHTML = cfg.actions.map((a, i) =>
    `<button class="btn btn-sm ${a.tone === 'danger' ? 'btn-danger' : 'btn-ghost'}"
       data-bulk="${i}">${a.icon ? icon(a.icon, { size: 14 }) : ''} ${esc(a.label)}</button>`).join('');

  bar.querySelector('.bulk-actions').onclick = async (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn) return;
    const a = cfg.actions[Number(btn.dataset.bulk)];
    const ids = selected();
    if (!ids.length) return;

    // Past a handful of rows a single click is too cheap for something
    // irreversible, so the operator has to type the word out.
    const needsTyping = a.tone === 'danger' && ids.length > 10;
    if (a.confirm && !await confirmAction(
      a.confirm.title,
      a.confirm.body.replace('{n}', `${ids.length} ${cfg.noun}${ids.length === 1 ? '' : 's'}`),
      a.confirm.label || 'Confirm',
      needsTyping ? 'DELETE' : '')) return;

    try {
      if (a.run) { await a.run(ids); return; }
      const r = await api('/api/admin/bulk', {
        method: 'POST',
        body: JSON.stringify({ entity: cfg.entity, action: a.action, value: a.value, ids })
      });
      toast(r.message);
      cfg.reload();
    } catch (err) { toast(err.message, 'error'); }
  };

  $('#bulkClear').onclick = () => {
    boxes.forEach((b) => { b.checked = false; });
    lastIndex = null;
    paint();
  };

  paint();
}

/** Markup for the action bar; sits directly above the list it controls. */
const bulkBar = () => `
  <div class="bulk-bar" id="bulkBar" hidden>
    <strong id="bulkCount"></strong>
    <div class="bulk-actions"></div>
    <button class="btn btn-sm btn-ghost" id="bulkClear">Clear</button>
  </div>`;

/* ---- modal ---- */

function openModal(title, bodyHTML, footHTML = '', wide = false) {
  const modal = $('#modal');
  modal.className = 'modal' + (wide ? ' wide' : '');
  modal.innerHTML = `
    <div class="modal-head"><h3>${esc(title)}</h3>
      <button class="icon-x" data-close aria-label="Close">${icon('close', { size: 18 })}</button></div>
    <div class="modal-body">${bodyHTML}</div>
    ${footHTML ? `<div class="modal-foot">${footHTML}</div>` : ''}`;
  $('#modalScrim').classList.add('show');
  modal.querySelector('input, select, textarea, button:not([data-close])')?.focus();
  return modal;
}
const closeModal = () => $('#modalScrim').classList.remove('show');

$('#modalScrim').addEventListener('click', (e) => {
  if (e.target.id === 'modalScrim' || e.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/** Reads every [name] input inside a container into a plain object. */
function formValues(root) {
  const out = {};
  for (const f of $$('[name]', root)) {
    out[f.name] = f.type === 'checkbox' ? (f.checked ? 1 : 0) : f.value;
  }
  return out;
}

/**
 * @param {string} [typeToConfirm] when set, the operator must type this word
 *   before the button unlocks — reserved for large, irreversible deletions.
 */
async function confirmAction(title, message, confirmLabel = 'Delete', typeToConfirm = '') {
  return new Promise((resolve) => {
    openModal(title,
      `<p style="line-height:1.7;color:var(--ink-2)">${esc(message)}</p>
       ${typeToConfirm ? `
         <div class="field-row" style="margin-top:16px">
           <label for="confirmText">Type <strong>${esc(typeToConfirm)}</strong> to confirm</label>
           <input type="text" id="confirmText" autocomplete="off" spellcheck="false">
         </div>` : ''}
       <p class="help" style="margin-top:12px">
         A snapshot of your data is saved automatically before anything is deleted,
         so this can be undone from Settings.</p>`,
      `<button class="btn btn-ghost" data-close>Cancel</button>
       <button class="btn btn-danger" id="confirmYes" ${typeToConfirm ? 'disabled' : ''}>${esc(confirmLabel)}</button>`);

    if (typeToConfirm) {
      $('#confirmText').addEventListener('input', (e) => {
        $('#confirmYes').disabled = e.target.value.trim().toUpperCase() !== typeToConfirm.toUpperCase();
      });
    }
    $('#confirmYes').onclick = () => { closeModal(); resolve(true); };
    $('#modalScrim').addEventListener('click', function once(e) {
      if (e.target.id === 'modalScrim' || e.target.closest('[data-close]')) {
        $('#modalScrim').removeEventListener('click', once);
        resolve(false);
      }
    });
  });
}

/* ================================================================== */
/* Login                                                               */
/* ================================================================== */

function renderLogin(message = '') {
  $('#root').innerHTML = `
    <div class="login-shell">
      <form class="login-card" id="loginForm">
        <div class="brand"><i></i><span id="loginBrand">Shop admin</span></div>
        <div class="sub">Sign in to manage orders and see how the shop is doing.</div>
        <div class="field-row">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autocomplete="username">
        </div>
        <div class="field-row">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <div id="loginError" style="color:var(--critical);font-weight:700;font-size:13px;min-height:20px">${esc(message)}</div>
        <button class="btn btn-primary" style="width:100%;margin-top:8px" type="submit" id="loginBtn">Sign in</button>
      </form>
    </div>`;

  // The name lives in the shop's settings, so even the signed-out screen asks
  // for it rather than hardcoding a brand that can be renamed at any time.
  fetch('/api/shop/bootstrap')
    .then((r) => r.json())
    .then((d) => {
      const name = d?.settings?.shop_name;
      if (name) {
        $('#loginBrand').textContent = name;
        document.title = `Shop Admin | ${name}`;
      }
    })
    .catch(() => { /* the placeholder is fine */ });

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const data = await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: $('#email').value, password: $('#password').value })
      });
      app.admin = data.admin;
      await boot();
    } catch (err) {
      $('#loginError').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}

/* ================================================================== */
/* Shell                                                               */
/* ================================================================== */

const NAV = [
  ['dashboard', 'dashboard', 'Dashboard'],
  ['analytics', 'analytics', 'Analytics'],
  ['orders', 'orders', 'Orders', 'pending_orders'],
  ['products', 'products', 'Products'],
  ['customers', 'customers', 'Customers'],
  ['coupons', 'discount', 'Discounts'],
  ['reviews', 'star', 'Reviews', 'pending_reviews'],
  ['messages', 'inbox', 'Inbox', 'new_messages'],
  ['content', 'content', 'Shop content'],
  ['settings', 'settings', 'Settings']
];

function renderShell() {
  $('#root').innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><i></i>${esc(app.settings.shop_name || 'Shop admin')}</div>
        ${NAV.map(([key, ico, label, alertKey]) => `
          <a class="nav-item" href="#/${key}" data-nav="${key}">
            <span class="ico">${icon(ico)}</span>${label}
            <span class="tally" data-alert="${alertKey || ''}" hidden></span>
          </a>`).join('')}
        <div class="nav-sep"></div>
        <a class="nav-item" href="/" target="_blank"><span class="ico">${icon('external')}</span>View shop</a>
        <button class="nav-item" id="logoutBtn"><span class="ico">${icon('logout')}</span>Sign out</button>
        <div class="sidebar-foot">
          Signed in as<br><strong>${esc(app.admin.name)}</strong>
        </div>
      </aside>
      <main class="main" id="view"></main>
    </div>`;

  $('#logoutBtn').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    app.admin = null;
    location.hash = '';
    renderLogin('You have been signed out.');
  });
}

function paintAlerts() {
  for (const el of $$('[data-alert]')) {
    const key = el.dataset.alert;
    const n = key ? Number(app.alerts[key] || 0) : 0;
    el.textContent = n;
    el.hidden = !n;
  }
}

function setActiveNav(route) {
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route));
}

/** Standard page header. `actions` is trusted markup built by the caller. */
function pageHead(title, sub, actions = '') {
  return `<div class="topbar">
    <div>
      <button class="btn btn-ghost btn-sm mobile-menu" id="menuBtn" style="margin-bottom:8px">${icon('menu', { size: 16 })} Menu</button>
      <h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div>
    </div>
    <div class="topbar-actions">${actions}</div>
  </div>`;
}

function wireHead() {
  $('#menuBtn')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
}

const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '12 months']];
const rangeControl = () => `<div class="segmented" id="rangeControl">
  ${RANGES.map(([d, label]) =>
    `<button data-range="${d}" class="${app.range === d ? 'active' : ''}">${label}</button>`).join('')}
</div>`;

function wireRange(onChange) {
  $('#rangeControl')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    app.range = Number(btn.dataset.range);
    onChange();
  });
}

/* ================================================================== */
/* View: dashboard                                                     */
/* ================================================================== */

async function viewDashboard() {
  const view = $('#view');
  view.innerHTML = pageHead('Dashboard',
    `How ${app.settings.shop_name} is doing right now.`,
    rangeControl() + `<button class="btn btn-ghost btn-sm" id="printBtn">${icon('print', { size: 15 })} Print</button>
      <button class="btn btn-danger btn-sm" id="resetShopBtn">${icon('refresh', { size: 15 })} Reset</button>`) +
    `<div id="dashBody"><p class="chart-empty">Loading…</p></div>`;
  wireHead();
  wireRange(viewDashboard);
  $('#printBtn').onclick = () => window.print();
  $('#resetShopBtn').onclick = resetShop;

  const [a, o] = await Promise.all([
    api(`/api/admin/analytics?days=${app.range}`),
    api('/api/admin/overview')
  ]);
  app.alerts = a.alerts;
  paintAlerts();

  const k = a.kpis;
  const revSeries = a.daily.map((d) => d.revenue);
  const rangeLabel = RANGES.find(([d]) => d === app.range)?.[1] || `${app.range} days`;

  const alerts = [
    k.orders === 0 ? null : null,
    a.alerts.pending_orders ? `<a class="alert warn" href="#/orders?status=pending">${icon('clock', { size: 16 })} ${a.alerts.pending_orders} orders waiting to be confirmed</a>` : '',
    a.alerts.below_cost ? `<a class="alert critical" href="#/products">${icon('warning', { size: 16 })} ${
      a.alerts.below_cost === 1
        ? `"${esc(a.below_cost[0].name)}" sells for less than it costs to make`
        : `${a.alerts.below_cost} products sell for less than they cost to make`}</a>` : '',
    a.alerts.low_stock ? `<a class="alert serious" href="#/products?status=low">${icon('boxAlert', { size: 16 })} ${a.alerts.low_stock} products low on stock</a>` : '',
    a.alerts.pending_reviews ? `<a class="alert info" href="#/reviews">${icon('star', { size: 16 })} ${a.alerts.pending_reviews} reviews awaiting approval</a>` : '',
    a.alerts.new_messages ? `<a class="alert info" href="#/messages">${icon('inbox', { size: 16 })} ${a.alerts.new_messages} unread messages</a>` : ''
  ].filter(Boolean).join('');

  $('#dashBody').innerHTML = `
    ${alerts ? `<div class="alert-row">${alerts}</div>` : ''}

    <div class="grid-wide" style="margin-bottom:18px">
      <div class="card card-pad">
        <div class="s-label" style="font-size:12.5px;color:var(--ink-2);font-weight:700">
          Paid revenue · last ${esc(rangeLabel)}</div>
        <div class="hero-figure">${money(k.revenue)}</div>
        <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-top:8px">
          ${delta(k.revenue_change)}
          <span style="color:var(--ink-2);font-size:13px">
            ${k.orders} paid orders · ${k.units} bouquets · ${money(k.profit)} profit (${k.margin}% margin)
          </span>
        </div>
      </div>
      <div class="card card-pad">
        <div class="s-label">Waiting on you</div>
        <div style="display:flex;flex-direction:column;gap:11px;margin-top:12px">
          <div style="display:flex;justify-content:space-between"><span>Orders to confirm</span>
            <strong>${a.alerts.pending_orders}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>Unpaid orders</span>
            <strong>${a.alerts.unpaid_orders}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>Reviews to approve</span>
            <strong>${a.alerts.pending_reviews}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>Unread messages</span>
            <strong>${a.alerts.new_messages}</strong></div>
        </div>
      </div>
    </div>

    <div class="stat-row">
      ${statTile('Paid orders', compact(k.orders), delta(k.orders_change), a.daily.map((d) => d.orders))}
      ${statTile('Average paid order', money(k.aov), delta(k.aov_change), null)}
      ${statTile('Visitors', compact(k.visitors), `<span class="delta flat">${k.conversion}% ordered</span>`, a.traffic.map((d) => d.visitors))}
      ${statTile('Stock on hand', money(k.inventory_value), `<span class="delta flat">${k.inventory_units} items</span>`, null)}
      ${statTile('Customers', compact(k.total_customers), `<span class="delta flat">${k.new_customers} new · ${k.repeat_customers} repeat</span>`, null)}
    </div>

    <!-- Revenue and profit sit on very different scales, so they get a chart
         each rather than one squashed pair sharing an axis. -->
    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <div><h3>Revenue</h3>
            <div class="cap">Paid takings each day across the last ${esc(rangeLabel)}.</div></div>
        </div>
        <div class="card-body"><div id="chartRevenue"></div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div><h3>Profit</h3>
            <div class="cap">Paid takings minus what the bouquets cost to make.</div></div>
        </div>
        <div class="card-body"><div id="chartProfit"></div></div>
      </div>
    </div>

    <div class="grid-wide mt">
      <div class="card">
        <div class="card-head"><div><h3>Orders per day</h3>
          <div class="cap">Count of orders, however large.</div></div></div>
        <div class="card-body"><div id="chartOrders"></div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div><h3>Where orders stand</h3><div class="cap">Every order placed in this period.</div></div>
        </div>
        <div class="card-body"><div id="chartStatus"></div></div>
      </div>
    </div>

    <div class="grid-wide mt">
      <div class="card">
        <div class="card-head"><div><h3>Best sellers</h3>
          <div class="cap">By revenue in this period.</div></div></div>
        <div class="card-body"><div id="chartTop"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Running low</h3>
          <div class="cap">At or below ${esc(app.settings.low_stock_threshold)} left.</div></div></div>
        <div class="card-body">
          ${a.low_stock.length ? a.low_stock.map((p) => `
            <div style="margin-bottom:14px">
              <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;margin-bottom:5px">
                <span>${esc(p.name)}</span><span>${p.stock} left</span>
              </div>
              ${meter(p.stock, Math.max(10, Number(app.settings.low_stock_threshold) * 2),
                { color: p.stock === 0 ? '#A93338' : p.stock <= 2 ? '#B4551F' : '#C3728F' })}
            </div>`).join('')
            : '<p class="chart-empty">Every product is comfortably in stock.</p>'}
        </div>
      </div>
    </div>

    <div class="card mt">
      <div class="card-head">
        <div><h3>Latest orders</h3><div class="cap">Newest first.</div></div>
        <a class="btn btn-ghost btn-sm" href="#/orders">All orders</a>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th class="num">Total</th></tr></thead>
          <tbody>${o.recent_orders.map((r) => `
            <tr class="row-link" data-order="${r.id}">
              <td class="strong">${esc(r.order_no)}<div class="cell-sub">${esc(dateOnly(r.created_at))}</div></td>
              <td>${esc(r.ship_name)}</td>
              <td>${tag(r.status)}</td>
              <td class="num strong">${money(r.total)}</td>
            </tr>`).join('') || '<tr><td colspan="4" class="empty">No orders yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  areaChart('#chartRevenue', a.daily, [{ key: 'revenue', label: 'Revenue', color: PALETTE[0] }],
    { x: 'date', id: 'rev', format: moneyShort, height: 230, ariaLabel: 'Revenue per day' });

  areaChart('#chartProfit', a.daily, [{ key: 'profit', label: 'Profit', color: PALETTE[1] }],
    { x: 'date', id: 'prof', format: moneyShort, height: 230, ariaLabel: 'Profit per day' });

  // Order status is an ordered lifecycle, not a set of unrelated categories, so
  // it wears the ordinal ramp (light early → dark delivered) with the two
  // terminal states pulled out in reserved status colours.
  const STATUS_ORDER = ['pending', 'confirmed', 'packing', 'shipped', 'delivered', 'cancelled', 'refunded'];
  const STATUS_COLOR = {
    pending: '#E294B0', confirmed: '#D07494', packing: '#B85778',
    shipped: '#99405D', delivered: '#7A2C45',
    cancelled: '#A93338', refunded: '#93817B'
  };
  donutChart('#chartStatus',
    [...a.by_status]
      .sort((x, y) => STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status))
      .map((s) => ({ label: s.status, value: s.n, color: STATUS_COLOR[s.status] })),
    { centreLabel: 'orders', format: (n) => String(Math.round(n)), nameLabel: 'Status', valueLabel: 'Orders' });

  columnChart('#chartOrders', a.daily, {
    x: 'date', key: 'orders', label: 'Orders', height: 230,
    format: (n) => String(Math.round(n)), ariaLabel: 'Orders per day'
  });

  barChart('#chartTop', a.top_products.slice(0, 6).map((p) => ({
    label: p.name, value: p.revenue, sub: `${p.units}`, subLabel: 'units'
  })), { format: moneyShort, nameLabel: 'Product', valueLabel: 'Revenue' });

  $$('[data-order]').forEach((row) =>
    row.addEventListener('click', () => openOrder(row.dataset.order)));
}

function statTile(label, value, footHTML, series) {
  return `<div class="stat">
    <span class="s-label">${esc(label)}</span>
    <span class="s-value">${value}</span>
    <span class="s-foot">${footHTML || ''}${series ? sparkline(series) : ''}</span>
  </div>`;
}

/* ================================================================== */
/* View: analytics                                                     */
/* ================================================================== */

async function viewAnalytics() {
  const view = $('#view');
  view.innerHTML = pageHead('Analytics',
    'Where the traffic comes from, what it does, and what it buys.',
    rangeControl() + `<button class="btn btn-ghost btn-sm" id="exportBtn">${icon('download', { size: 15 })} Export CSV</button>`) +
    `<div id="anBody"><p class="chart-empty">Loading…</p></div>`;
  wireHead();
  wireRange(viewAnalytics);
  $('#exportBtn').onclick = () => { location.href = '/api/admin/export/orders'; };

  const a = await api(`/api/admin/analytics?days=${app.range}`);
  app.alerts = a.alerts;
  paintAlerts();

  const k = a.kpis;
  const rangeLabel = RANGES.find(([d]) => d === app.range)?.[1] || `${app.range} days`;

  $('#anBody').innerHTML = `
    <div class="card card-pad" style="margin-bottom:18px">
      <div class="s-label">Profit · last ${esc(rangeLabel)}</div>
      <div class="hero-figure">${money(k.profit)}</div>
      <div style="color:var(--ink-2);font-size:13px;margin-top:8px">
        ${k.margin}% margin on ${money(k.revenue)} of revenue · ${money(k.discount_given)} given away in discounts
      </div>
    </div>

    <div class="grid-wide">
      <div class="card">
        <div class="card-head"><div><h3>Visitors and page views</h3>
          <div class="cap">First-party counts — no third-party trackers on the shop.</div></div></div>
        <div class="card-body"><div id="chartTraffic"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>From visit to order</h3>
          <div class="cap">Unique people reaching each step.</div></div></div>
        <div class="card-body"><div id="chartFunnel"></div></div>
      </div>
    </div>

    <div class="grid-wide mt">
      <div class="card">
        <div class="card-head"><div><h3>When people order</h3>
          <div class="cap">Orders by day and time of day — useful for planning making days.</div></div></div>
        <div class="card-body"><div id="chartHeat"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Sales by occasion</h3>
          <div class="cap">Revenue split across categories.</div></div></div>
        <div class="card-body"><div id="chartCategory"></div></div>
      </div>
    </div>

    <div class="grid-wide mt">
      <div class="card">
        <div class="card-head"><div><h3>Product performance</h3>
          <div class="cap">Revenue, units and profit per bouquet.</div></div></div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>Product</th><th class="num">Units</th><th class="num">Revenue</th>
              <th class="num">Profit</th><th class="num">Margin</th></tr></thead>
            <tbody>${a.top_products.map((p) => `
              <tr>
                <td class="strong">${esc(p.name)}</td>
                <td class="num">${p.units}</td>
                <td class="num">${money(p.revenue)}</td>
                <td class="num">${money(p.profit)}</td>
                <td class="num">${p.revenue ? Math.round((p.profit / p.revenue) * 100) : 0}%</td>
              </tr>`).join('') || '<tr><td colspan="5" class="empty">No sales in this period.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>How people pay</h3>
          <div class="cap">Orders by payment method.</div></div></div>
        <div class="card-body"><div id="chartPayment"></div></div>
      </div>
    </div>

    <div class="card mt">
      <div class="card-head"><div><h3>Best customers</h3>
        <div class="cap">Lifetime spend across all time.</div></div></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Customer</th><th>Email</th><th class="num">Orders</th><th class="num">Spent</th></tr></thead>
          <tbody>${a.top_customers.map((c) => `
            <tr><td class="strong">${esc(c.name)}</td><td>${esc(c.email)}</td>
              <td class="num">${c.orders}</td><td class="num strong">${money(c.spent)}</td></tr>`).join('')
            || '<tr><td colspan="4" class="empty">No customers yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  areaChart('#chartTraffic', a.traffic, [
    { key: 'visitors', label: 'Visitors', color: PALETTE[0] },
    { key: 'views', label: 'Page views', color: PALETTE[2] }
  ], { x: 'date', id: 'traffic', format: (n) => compact(n), height: 240 });

  funnelChart('#chartFunnel', a.funnel);
  heatmap('#chartHeat', a.heatmap);

  donutChart('#chartCategory', a.by_category.slice(0, 6).map((c, i) => ({
    label: c.name, value: c.revenue, color: PALETTE[i]
  })), { format: moneyShort, centreLabel: 'revenue', nameLabel: 'Category', valueLabel: 'Revenue' });

  const payLabels = { stripe: 'Card (Stripe)', cod: 'Cash on delivery', bank: 'Bank transfer', card: 'Card on delivery' };
  donutChart('#chartPayment', a.by_payment.map((p, i) => ({
    label: payLabels[p.payment_method] || p.payment_method, value: p.n, color: PALETTE[i]
  })), { centreLabel: 'orders', format: (n) => String(Math.round(n)), nameLabel: 'Method', valueLabel: 'Orders' });
}

/* ================================================================== */
/* View: orders                                                        */
/* ================================================================== */

let orderFilter = { status: 'all', q: '' };

async function viewOrders(params) {
  if (params?.get('status')) orderFilter.status = params.get('status');

  $('#view').innerHTML = pageHead('Orders', 'Everything customers have bought.',
    `<button class="btn btn-ghost btn-sm" id="exportOrders">${icon('download', { size: 15 })} Export CSV</button>`) +
    `<div class="toolbar">
      <div class="search-field">${icon('search', { size: 16 })}<input id="orderSearch" placeholder="Order number, name or email"
        value="${esc(orderFilter.q)}"></div>
      <select id="statusFilter" style="width:auto">
        <option value="all">All statuses</option>
        ${['pending', 'confirmed', 'packing', 'shipped', 'delivered', 'cancelled', 'refunded']
          .map((s) => `<option value="${s}"${orderFilter.status === s ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
      <span class="spacer"></span>
      <span id="orderCount" style="font-size:13px;color:var(--ink-2);font-weight:700"></span>
    </div>
    ${bulkBar()}
    <div class="card"><div class="table-wrap" id="ordersTable"><p class="chart-empty">Loading…</p></div></div>`;
  wireHead();
  $('#exportOrders').onclick = () => { location.href = '/api/admin/export/orders'; };

  const load = async () => {
    const q = new URLSearchParams({ status: orderFilter.status, limit: '200' });
    if (orderFilter.q) q.set('q', orderFilter.q);
    const d = await api('/api/admin/orders?' + q);
    $('#orderCount').textContent = `${d.total} ${d.total === 1 ? 'order' : 'orders'}`;
    $('#ordersTable').innerHTML = d.orders.length ? `
      <table class="data">
        <thead><tr>${headCheck()}<th>Order</th><th>Customer</th><th class="num">Items</th>
          <th>Status</th><th>Payment</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${d.orders.map((o) => `
          <tr class="row-link" data-order="${o.id}">
            <td class="pick-col">${rowCheck(o.id)}</td>
            <td class="strong">${esc(o.order_no)}<div class="cell-sub">${esc(dateTime(o.created_at))}</div></td>
            <td>${esc(o.ship_name)}<div class="cell-sub">${esc(o.ship_email)}</div></td>
            <td class="num">${o.items || 0}</td>
            <td>${tag(o.status)}</td>
            <td>${tag(o.payment_status)}<div class="cell-sub">${esc(o.payment_method)}</div></td>
            <td class="num strong">${money(o.total)}</td>
            <td><button class="btn btn-ghost btn-sm">Open</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`
      : `<div class="empty"><div class="e-ico">${icon('orders', { size: 34, stroke: 1.5 })}</div><p>No orders match that filter.</p></div>`;

    $$('[data-order]').forEach((row) =>
      row.addEventListener('click', () => openOrder(row.dataset.order)));

    initBulk({
      entity: 'orders', noun: 'order', reload: load,
      actions: [
        { label: 'Confirm', action: 'status', value: 'confirmed', icon: 'check' },
        { label: 'Packing', action: 'status', value: 'packing', icon: 'products' },
        { label: 'Shipped', action: 'status', value: 'shipped', icon: 'truck' },
        { label: 'Delivered', action: 'status', value: 'delivered', icon: 'check' },
        { label: 'Mark paid', action: 'payment', value: 'paid', icon: 'cash' },
        { label: 'Cancel', action: 'status', value: 'cancelled', icon: 'close',
          confirm: { title: 'Cancel these orders?',
            body: 'Cancelling {n} returns their items to your stock. You can move them back afterwards.',
            label: 'Cancel orders' } },
        { label: 'Delete', action: 'delete', tone: 'danger', icon: 'trash',
          confirm: { title: 'Delete these orders?',
            body: 'This permanently removes {n} and returns their stock. There is no undo.',
            label: 'Delete' } }
      ]
    });
  };

  let debounce;
  $('#orderSearch').addEventListener('input', (e) => {
    orderFilter.q = e.target.value.trim();
    clearTimeout(debounce);
    debounce = setTimeout(load, 350);
  });
  $('#statusFilter').addEventListener('change', (e) => {
    orderFilter.status = e.target.value;
    load();
  });

  await load();
}

async function openOrder(id) {
  const d = await api('/api/admin/orders/' + id);
  const o = d.order;

  openModal(`Order ${o.order_no}`, `
    <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:24px" class="field-grid">
      <div>
        <table class="data" style="margin-bottom:18px">
          <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
          <tbody>${d.items.map((i) => `
            <tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td>
              <td class="num">${money(i.unit_price)}</td>
              <td class="num strong">${money(i.line_total)}</td></tr>`).join('')}
          </tbody>
        </table>
        <div style="display:flex;flex-direction:column;gap:7px;font-size:13.5px">
          <div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
          ${o.discount > 0 ? `<div style="display:flex;justify-content:space-between;color:var(--good)">
            <span>Discount ${esc(o.coupon_code || '')}</span><span>−${money(o.discount)}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between"><span>Shipping</span><span>${money(o.shipping)}</span></div>
          <div style="display:flex;justify-content:space-between;font-weight:800;font-size:16px;
            border-top:1px solid var(--line);padding-top:9px;margin-top:4px">
            <span>Total</span><span>${money(o.total)}</span></div>
          <div style="display:flex;justify-content:space-between;color:var(--ink-2)">
            <span>Estimated profit</span><span>${money(o.total - o.shipping - o.cost_total)}</span></div>
        </div>

        <h4 style="margin:22px 0 12px;font-size:14px">History</h4>
        <div class="timeline">
          ${d.timeline.map((t) => `
            <div class="tl-item"><div class="tl-dot"></div>
              <div><div class="tl-title">${esc(t.status)}</div>
                <div class="tl-meta">${esc(t.note)} · ${esc(dateTime(t.created_at))}</div></div>
            </div>`).join('')}
        </div>
      </div>

      <div>
        <div class="field-row">
          <label for="oStatus">Order status</label>
          <select id="oStatus" name="status">
            ${d.statuses.map((s) => `<option value="${s}"${o.status === s ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="field-row">
          <label for="oPayment">Payment</label>
          <select id="oPayment" name="payment_status">
            ${['unpaid', 'paid', 'refunded'].map((s) =>
              `<option value="${s}"${o.payment_status === s ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="field-row">
          <label for="oEventNote">Note for the history</label>
          <input type="text" id="oEventNote" name="event_note" placeholder="e.g. Posted with GLS, tracking 123">
        </div>
        <div class="field-row">
          <label for="oNote">Internal note</label>
          <textarea id="oNote" name="note" style="min-height:70px">${esc(o.note)}</textarea>
        </div>

        <div style="background:var(--surface-2);border-radius:12px;padding:15px;font-size:13px;line-height:1.75">
          <strong style="display:block;margin-bottom:7px">Shipping to</strong>
          ${esc(o.ship_name)}<br>${esc(o.ship_email)}<br>${esc(o.ship_phone || '')}<br>
          ${esc(o.ship_address || '')}<br>${esc(o.ship_postcode || '')} ${esc(o.ship_city || '')}<br>
          ${esc(o.ship_country || '')}
          <div style="margin-top:11px;padding-top:11px;border-top:1px solid var(--line)">
            ${d.customer_orders.n} order${d.customer_orders.n === 1 ? '' : 's'} ·
            ${money(d.customer_orders.spent)} lifetime
          </div>
        </div>
      </div>
    </div>`,
    `<button class="btn btn-danger btn-sm" id="deleteOrder">Delete order</button>
     <span style="flex:1"></span>
     <button class="btn btn-ghost" data-close>Close</button>
     <button class="btn btn-primary" id="saveOrder">Save changes</button>`, true);

  $('#saveOrder').onclick = async () => {
    try {
      const body = {
        status: $('#oStatus').value,
        payment_status: $('#oPayment').value,
        event_note: $('#oEventNote').value,
        note: $('#oNote').value
      };
      const r = await api('/api/admin/orders/' + id, { method: 'PUT', body: JSON.stringify(body) });
      closeModal();
      toast(r.message);
      route();
    } catch (err) { toast(err.message, 'error'); }
  };

  $('#deleteOrder').onclick = async () => {
    closeModal();
    if (!await confirmAction('Delete this order?',
      `Order ${o.order_no} will be removed permanently and its stock returned to the shelf. This cannot be undone.`)) return;
    try {
      const r = await api('/api/admin/orders/' + id, { method: 'DELETE' });
      toast(r.message);
      route();
    } catch (err) { toast(err.message, 'error'); }
  };
}

/* ================================================================== */
/* View: products                                                      */
/* ================================================================== */

let productFilter = { status: 'all', q: '' };

async function viewProducts(params) {
  if (params?.get('status')) productFilter.status = params.get('status');

  $('#view').innerHTML = pageHead('Products', 'Your catalogue — prices, stock and photos.',
    `<button class="btn btn-ghost btn-sm" id="exportProducts">${icon('download', { size: 15 })} Export CSV</button>
     <button class="btn btn-primary btn-sm" id="newProduct">${icon('plus', { size: 15 })} New product</button>`) +
    `<div class="toolbar">
      <div class="search-field">${icon('search', { size: 16 })}<input id="prodSearch" placeholder="Name or SKU" value="${esc(productFilter.q)}"></div>
      <select id="prodStatus" style="width:auto">
        <option value="all">All products</option>
        <option value="active"${productFilter.status === 'active' ? ' selected' : ''}>Visible in shop</option>
        <option value="hidden"${productFilter.status === 'hidden' ? ' selected' : ''}>Hidden</option>
        <option value="low"${productFilter.status === 'low' ? ' selected' : ''}>Low stock</option>
      </select>
      <span class="spacer"></span>
      <span id="prodCount" style="font-size:13px;color:var(--ink-2);font-weight:700"></span>
    </div>
    ${bulkBar()}
    <div class="card"><div class="table-wrap" id="prodTable"><p class="chart-empty">Loading…</p></div></div>`;
  wireHead();
  $('#exportProducts').onclick = () => { location.href = '/api/admin/export/products'; };

  let categories = [];

  const load = async () => {
    const q = new URLSearchParams({ status: productFilter.status });
    if (productFilter.q) q.set('q', productFilter.q);
    const d = await api('/api/admin/products?' + q);
    categories = d.categories;
    const threshold = Number(app.settings.low_stock_threshold || 5);

    $('#prodCount').textContent = `${d.products.length} product${d.products.length === 1 ? '' : 's'}`;
    $('#prodTable').innerHTML = d.products.length ? `
      <table class="data">
        <thead><tr>${headCheck()}<th>Product</th><th>Category</th><th class="num">Price</th>
          <th class="num">Cost</th><th class="num">Stock</th><th class="num">Sold</th>
          <th>Visible</th><th></th></tr></thead>
        <tbody>${d.products.map((p) => `
          <tr class="row-link" data-product="${p.id}">
            <td class="pick-col">${rowCheck(p.id)}</td>
            <td>
              <div class="cell-flex">
                <span class="thumb-sm">${productArt(p)}</span>
                <span><span class="strong">${esc(p.name)}</span>
                  <div class="cell-sub">${esc(p.sku || '—')}</div></span>
              </div>
            </td>
            <td>${esc(p.category || '—')}</td>
            <td class="num">${money(p.price)}${p.old_price ? `<div class="cell-sub">was ${money(p.old_price)}</div>` : ''}</td>
            <td class="num">${money(p.cost)}</td>
            <td class="num">${p.stock <= threshold ? `<span class="tag t-low">${p.stock}</span>` : p.stock}</td>
            <td class="num">${p.sold}</td>
            <td>${p.active ? tag('active') : tag('hidden')}</td>
            <td><button class="btn btn-ghost btn-sm">Edit</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`
      : `<div class="empty"><div class="e-ico">${icon('emptySearch', { size: 34, stroke: 1.5 })}</div><p>No products match that filter.</p></div>`;

    $$('[data-product]').forEach((row) => row.addEventListener('click', () => {
      const p = d.products.find((x) => x.id === Number(row.dataset.product));
      editProduct(p, categories);
    }));

    initBulk({
      entity: 'products', noun: 'product', reload: load,
      actions: [
        { label: 'Show in shop', action: 'visibility', value: 'show', icon: 'eye' },
        { label: 'Hide', action: 'visibility', value: 'hide', icon: 'close' },
        { label: 'Feature', action: 'featured', value: 'on', icon: 'star' },
        { label: 'Unfeature', action: 'featured', value: 'off', icon: 'star' },
        { label: 'Delete', action: 'delete', tone: 'danger', icon: 'trash',
          confirm: { title: 'Delete these products?',
            body: 'Removes {n}. Any that appear on past orders are hidden instead, so your sales history stays correct.',
            label: 'Delete' } }
      ]
    });
  };

  let debounce;
  $('#prodSearch').addEventListener('input', (e) => {
    productFilter.q = e.target.value.trim();
    clearTimeout(debounce);
    debounce = setTimeout(load, 350);
  });
  $('#prodStatus').addEventListener('change', (e) => { productFilter.status = e.target.value; load(); });
  $('#newProduct').onclick = () => editProduct(null, categories);

  await load();
}

const MAX_PHOTOS = 12;

/** A product's photos in order; older rows only have `image_url`. */
function productPhotos(p) {
  let list = p?.images;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  if (!Array.isArray(list)) list = [];
  list = list.filter((u) => typeof u === 'string' && u);
  if (!list.length && p?.image_url) list = [p.image_url];
  return list;
}

function editProduct(p, categories) {
  const isNew = !p;
  const d = p || {
    name: '', description: '', category_id: '', price: '', old_price: '', cost: '',
    stock: 0, sku: '', palette: 'rose', seed: Math.floor(Math.random() * 9999),
    bloom_count: 4, image_url: '', badge: '', featured: 0, active: 1
  };

  openModal(isNew ? 'New product' : `Edit ${d.name}`, `
    <div style="display:grid;grid-template-columns:210px 1fr;gap:24px" class="field-grid">
      <div>
        <label style="font-size:12.5px;font-weight:800;color:var(--ink-2);display:block;margin-bottom:6px">
          Product photos</label>

        <div class="dropzone" id="dropzone" tabindex="0" role="button"
             aria-label="Upload product photos from your device">
          <div class="dz-preview" id="artPreview">${productArt(d)}</div>
          <div class="dz-overlay"><span>${icon('camera', { size: 26, stroke: 1.6 })}</span>Drop photos here</div>
        </div>
        <input type="file" id="pFile" accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
               multiple hidden>

        <div class="photo-strip" id="photoStrip"></div>

        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-primary btn-sm" type="button" id="pickPhoto" style="flex:1">
            Upload photos</button>
        </div>
        <div class="help" id="photoHelp" style="margin-top:7px"></div>

        <details class="drawn-fallback" ${productPhotos(d).length ? '' : 'open'}>
          <summary>No photo yet? Use a drawn bouquet</summary>
          <div class="field-row" style="margin-top:12px">
            <label>Colour palette</label>
            <div class="swatches" id="paletteSwatches">
              ${Object.entries(PALETTES).map(([key, v]) => `
                <button type="button" class="swatch ${d.palette === key ? 'on' : ''}" data-palette="${key}"
                  title="${esc(v.label)}" aria-label="${esc(v.label)}">
                  ${v.colors.map((c) => `<i style="background:${c}"></i>`).join('')}
                </button>`).join('')}
            </div>
          </div>
          <div class="field-row">
            <label for="pBlooms">Flowers in the bouquet</label>
            <input type="number" id="pBlooms" name="bloom_count" min="1" max="9" value="${d.bloom_count}">
          </div>
          <button class="btn btn-ghost btn-sm" type="button" id="reshuffle" style="width:100%">
            ${icon('refresh', { size: 15 })} Reshuffle arrangement</button>
        </details>

      </div>

      <div>
        <div class="field-row">
          <label for="pName">Product name</label>
          <input type="text" id="pName" name="name" value="${esc(d.name)}" required maxlength="140">
        </div>
        <div class="field-row">
          <label for="pDesc">Description</label>
          <textarea id="pDesc" name="description" maxlength="4000">${esc(d.description)}</textarea>
        </div>
        <div class="field-grid">
          <div class="field-row">
            <label for="pPrice">Price</label>
            <input type="number" id="pPrice" name="price" step="0.01" min="0" value="${d.price}">
          </div>
          <div class="field-row">
            <label for="pOld">Compare-at price</label>
            <input type="number" id="pOld" name="old_price" step="0.01" min="0" value="${d.old_price ?? ''}">
            <span class="help">Shown struck through.</span>
          </div>
          <div class="field-row">
            <label for="pCost">Cost to make</label>
            <input type="number" id="pCost" name="cost" step="0.01" min="0" value="${d.cost}">
            <span class="help" id="costHelp">Used for profit reporting only.</span>
          </div>
          <div class="field-row">
            <label for="pStock">Stock</label>
            <input type="number" id="pStock" name="stock" min="0" value="${d.stock}">
          </div>
          <div class="field-row">
            <label for="pSku">SKU</label>
            <input type="text" id="pSku" name="sku" value="${esc(d.sku || '')}" maxlength="40">
          </div>
          <div class="field-row">
            <label for="pCat">Category</label>
            <select id="pCat" name="category_id">
              <option value="">No category</option>
              ${categories.map((c) => `<option value="${c.id}"${d.category_id === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field-row">
            <label for="pBadge">Badge</label>
            <input type="text" id="pBadge" name="badge" value="${esc(d.badge || '')}" maxlength="40" placeholder="On Sale">
          </div>
          <div class="field-row" style="justify-content:flex-end;gap:14px">
            <label class="check"><input type="checkbox" name="featured" ${d.featured ? 'checked' : ''}> Featured on home page</label>
            <label class="check"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}> Visible in shop</label>
          </div>
        </div>
      </div>
    </div>
    <input type="hidden" name="palette" id="pPalette" value="${esc(d.palette)}">
    <input type="hidden" name="seed" id="pSeed" value="${d.seed}">`,
    `${isNew ? '' : '<button class="btn btn-danger btn-sm" id="deleteProduct">Delete</button>'}
     <span style="flex:1"></span>
     <button class="btn btn-ghost" data-close>Cancel</button>
     <button class="btn btn-primary" id="saveProduct">${isNew ? 'Create product' : 'Save changes'}</button>`, true);

  /* --- photos: the first one is the cover; none means the drawn bouquet --- */
  const photos = productPhotos(d);
  let shown = 0; // which photo the big preview shows

  const repaint = () => {
    if (shown >= photos.length) shown = Math.max(0, photos.length - 1);
    const photo = photos[shown];
    $('#artPreview').innerHTML = photo
      ? `<img src="${esc(photo)}" alt="">`
      : `<svg viewBox="0 0 ${ART} ${ART}" style="width:100%;height:100%">${
          bouquetSVG($('#pSeed').value, $('#pPalette').value, $('#pBlooms').value, ART, ART)}</svg>`;

    $('#photoStrip').innerHTML = photos.map((url, i) => `
      <div class="ps-item ${i === shown ? 'on' : ''}" data-i="${i}">
        <button type="button" class="ps-thumb" data-act="show" title="Preview">
          <img src="${esc(url)}" alt="Photo ${i + 1}"></button>
        ${i === 0 ? '<span class="ps-cover">Cover</span>' : ''}
        <div class="ps-tools">
          ${i > 0 ? `<button type="button" data-act="left" title="Move earlier" aria-label="Move photo ${i + 1} earlier">‹</button>` : ''}
          ${i > 0 ? `<button type="button" data-act="cover" title="Make cover" aria-label="Make photo ${i + 1} the cover">★</button>` : ''}
          ${i < photos.length - 1 ? `<button type="button" data-act="right" title="Move later" aria-label="Move photo ${i + 1} later">›</button>` : ''}
          <button type="button" data-act="remove" title="Remove" aria-label="Remove photo ${i + 1}">✕</button>
        </div>
      </div>`).join('');

    const full = photos.length >= MAX_PHOTOS;
    $('#pickPhoto').disabled = full;
    $('#pickPhoto').textContent = photos.length ? 'Add more photos' : 'Upload photos';
    $('#photoHelp').textContent = full
      ? `That's the maximum of ${MAX_PHOTOS} photos.`
      : photos.length
        ? `${photos.length} of ${MAX_PHOTOS} photos. The first is the cover — use ★ to change it.`
        : 'JPG, PNG or WebP, up to 6 MB each. You can pick several at once. Square photos look best.';
  };

  /* --- upload: one request per file, in the order they were picked --- */
  async function uploadPhotos(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) return toast(`A product can have up to ${MAX_PHOTOS} photos.`, 'error');
    if (files.length > room) toast(`Only the first ${room} will be added (max ${MAX_PHOTOS}).`, 'error');

    const zone = $('#dropzone');
    zone.classList.add('busy');
    $('#pickPhoto').disabled = true;
    let added = 0;
    for (const [n, file] of files.slice(0, room).entries()) {
      if (!file.type.startsWith('image/')) { toast(`${file.name} is not an image.`, 'error'); continue; }
      if (file.size > 6_000_000) { toast(`${file.name} is larger than 6 MB.`, 'error'); continue; }
      $('#photoHelp').textContent = `Uploading ${n + 1} of ${Math.min(files.length, room)}…`;
      try {
        // The raw file is the body — no multipart wrapper needed.
        const res = await fetch('/api/admin/upload', {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        photos.push(data.url);
        added++;
        repaint();
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    zone.classList.remove('busy');
    $('#pFile').value = '';
    repaint();
    if (added) toast(`${added} photo${added === 1 ? '' : 's'} added. Remember to save.`);
  }

  $('#photoStrip').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const i = Number(btn.closest('[data-i]').dataset.i);
    const move = (from, to) => photos.splice(to, 0, photos.splice(from, 1)[0]);
    switch (btn.dataset.act) {
      case 'show': shown = i; break;
      case 'left': move(i, i - 1); shown = i - 1; break;
      case 'right': move(i, i + 1); shown = i + 1; break;
      case 'cover': move(i, 0); shown = 0; break;
      case 'remove':
        photos.splice(i, 1);
        if (shown > i) shown--;
        if (!photos.length) $('.drawn-fallback').open = true;
        break;
    }
    repaint();
  });

  /* --- margin check: a cost above the price loses money on every sale --- */
  const checkMargin = () => {
    const price = Number($('#pPrice').value) || 0;
    const cost = Number($('#pCost').value) || 0;
    const help = $('#costHelp');
    if (cost > price && price > 0) {
      help.textContent = `This loses ${money(cost - price)} on every sale — check the cost.`;
      help.style.color = 'var(--critical)';
      help.style.fontWeight = '800';
    } else if (price > 0 && cost > 0) {
      help.textContent = `Margin ${Math.round(((price - cost) / price) * 100)}% · ${money(price - cost)} profit per sale.`;
      help.style.color = '';
      help.style.fontWeight = '';
    } else {
      help.textContent = 'Used for profit reporting only.';
      help.style.color = '';
      help.style.fontWeight = '';
    }
  };
  $('#pCost').addEventListener('input', checkMargin);
  $('#pPrice').addEventListener('input', checkMargin);
  checkMargin();

  $('#pickPhoto').onclick = () => $('#pFile').click();
  $('#dropzone').addEventListener('click', () => $('#pFile').click());
  $('#dropzone').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#pFile').click(); }
  });
  $('#pFile').addEventListener('change', (e) => uploadPhotos(e.target.files));

  for (const type of ['dragenter', 'dragover']) {
    $('#dropzone').addEventListener(type, (e) => {
      e.preventDefault();
      $('#dropzone').classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    $('#dropzone').addEventListener(type, (e) => {
      e.preventDefault();
      $('#dropzone').classList.remove('over');
    });
  }
  $('#dropzone').addEventListener('drop', (e) => uploadPhotos(e.dataTransfer?.files));
  repaint();

  $('#paletteSwatches').addEventListener('click', (e) => {
    const sw = e.target.closest('[data-palette]');
    if (!sw) return;
    $$('.swatch').forEach((s) => s.classList.remove('on'));
    sw.classList.add('on');
    $('#pPalette').value = sw.dataset.palette;
    repaint();
  });
  $('#pBlooms').addEventListener('input', repaint);
  $('#reshuffle').onclick = () => { $('#pSeed').value = Math.floor(Math.random() * 9999); repaint(); };

  $('#saveProduct').onclick = async () => {
    const body = formValues($('#modal'));
    if (!body.name.trim()) return toast('Give the product a name first.', 'error');
    body.images = photos;
    body.image_url = photos[0] || '';
    try {
      const r = isNew
        ? await api('/api/admin/products', { method: 'POST', body: JSON.stringify(body) })
        : await api('/api/admin/products/' + p.id, { method: 'PUT', body: JSON.stringify(body) });
      closeModal();
      toast(r.message);
      route();
    } catch (err) { toast(err.message, 'error'); }
  };

  if (!isNew) {
    $('#deleteProduct').onclick = async () => {
      closeModal();
      if (!await confirmAction('Delete this product?',
        `"${p.name}" will be removed. If it appears on past orders it is hidden from the shop instead, so your sales history stays correct.`)) return;
      try {
        const r = await api('/api/admin/products/' + p.id, { method: 'DELETE' });
        toast(r.message);
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
  }
}

/* ================================================================== */
/* View: customers                                                     */
/* ================================================================== */

async function viewCustomers() {
  $('#view').innerHTML = pageHead('Customers', 'Everyone who has ordered from you.',
    `<button class="btn btn-ghost btn-sm" id="exportCustomers">${icon('download', { size: 15 })} Export CSV</button>`) +
    `<div class="toolbar">
      <div class="search-field">${icon('search', { size: 16 })}<input id="custSearch" placeholder="Name or email"></div>
      <span class="spacer"></span>
      <span id="custCount" style="font-size:13px;color:var(--ink-2);font-weight:700"></span>
    </div>
    ${bulkBar()}
    <div class="card"><div class="table-wrap" id="custTable"><p class="chart-empty">Loading…</p></div></div>`;
  wireHead();
  $('#exportCustomers').onclick = () => { location.href = '/api/admin/export/customers'; };

  const load = async (q = '') => {
    const d = await api('/api/admin/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    $('#custCount').textContent = `${d.customers.length} customer${d.customers.length === 1 ? '' : 's'}`;
    $('#custTable').innerHTML = d.customers.length ? `
      <table class="data">
        <thead><tr>${headCheck()}<th>Customer</th><th>Location</th><th class="num">Orders</th>
          <th class="num">Lifetime spend</th><th>Last order</th><th></th></tr></thead>
        <tbody>${d.customers.map((c) => `
          <tr class="row-link" data-customer="${c.id}">
            <td class="pick-col">${rowCheck(c.id)}</td>
            <td class="strong">${esc(c.name || '—')}<div class="cell-sub">${esc(c.email)}</div></td>
            <td>${esc([c.city, c.country].filter(Boolean).join(', ') || '—')}</td>
            <td class="num">${c.orders}</td>
            <td class="num strong">${money(c.spent)}</td>
            <td>${c.last_order ? esc(dateOnly(c.last_order)) : '—'}</td>
            <td><button class="btn btn-ghost btn-sm">Open</button></td>
          </tr>`).join('')}
      </tbody></table>`
      : `<div class="empty"><div class="e-ico">${icon('customers', { size: 34, stroke: 1.5 })}</div><p>No customers yet.</p></div>`;

    $$('[data-customer]').forEach((row) =>
      row.addEventListener('click', () => openCustomer(row.dataset.customer)));

    initBulk({
      entity: 'customers', noun: 'customer', reload: () => load(),
      actions: [{
        label: 'Copy email addresses', icon: 'inbox',
        run: async (ids) => {
          const r = await api('/api/admin/customers/emails', {
            method: 'POST', body: JSON.stringify({ ids })
          });
          const text = r.emails.join(', ');
          try {
            await navigator.clipboard.writeText(text);
            toast(`${r.emails.length} addresses copied to your clipboard.`);
          } catch {
            openModal('Email addresses',
              `<p class="help" style="margin-bottom:10px">Copy these into your mail app.</p>
               <textarea readonly style="min-height:160px">${esc(text)}</textarea>`,
              '<button class="btn btn-primary" data-close>Done</button>');
          }
        }
      }]
    });
  };

  let debounce;
  $('#custSearch').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => load(e.target.value.trim()), 350);
  });

  await load();
}

async function openCustomer(id) {
  const d = await api('/api/admin/customers/' + id);
  const c = d.customer;
  const spent = d.orders.reduce((s, o) => s + (['cancelled', 'refunded'].includes(o.status) ? 0 : o.total), 0);

  openModal(c.name || c.email, `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px" class="field-grid">
      <div>
        <div class="field-row"><label for="cName">Name</label>
          <input type="text" id="cName" name="name" value="${esc(c.name)}"></div>
        <div class="field-row"><label for="cPhone">Phone</label>
          <input type="text" id="cPhone" name="phone" value="${esc(c.phone)}"></div>
        <div class="field-row"><label for="cAddr">Address</label>
          <input type="text" id="cAddr" name="address" value="${esc(c.address)}"></div>
        <div class="field-grid">
          <div class="field-row"><label for="cCity">City</label>
            <input type="text" id="cCity" name="city" value="${esc(c.city)}"></div>
          <div class="field-row"><label for="cPost">Postcode</label>
            <input type="text" id="cPost" name="postcode" value="${esc(c.postcode)}"></div>
        </div>
        <div class="field-row"><label for="cCountry">Country</label>
          <input type="text" id="cCountry" name="country" value="${esc(c.country)}"></div>
        <div class="field-row"><label for="cNotes">Private notes</label>
          <textarea id="cNotes" name="notes" style="min-height:70px">${esc(c.notes)}</textarea></div>
      </div>
      <div>
        <div class="stat" style="margin-bottom:14px">
          <span class="s-label">Lifetime spend</span>
          <span class="s-value">${money(spent)}</span>
          <span class="s-foot"><span class="delta flat">${d.orders.length} orders ·
            joined ${esc(dateOnly(c.created_at))}</span></span>
        </div>
        <div style="font-size:12.5px;font-weight:800;color:var(--ink-2);margin-bottom:8px">ORDER HISTORY</div>
        <div style="max-height:300px;overflow-y:auto">
          <table class="data">
            <tbody>${d.orders.map((o) => `
              <tr><td class="strong">${esc(o.order_no)}<div class="cell-sub">${esc(dateOnly(o.created_at))}</div></td>
                <td>${tag(o.status)}</td>
                <td class="num strong">${money(o.total)}</td></tr>`).join('')
              || '<tr><td class="empty">No orders yet.</td></tr>'}
            </tbody>
          </table>
        </div>
        <p style="font-size:12.5px;color:var(--ink-3);margin-top:12px;line-height:1.6">
          Email: <strong>${esc(c.email)}</strong> — this is how the customer signs in to track orders,
          so it cannot be edited here.</p>
      </div>
    </div>`,
    `<span style="flex:1"></span>
     <button class="btn btn-ghost" data-close>Close</button>
     <button class="btn btn-primary" id="saveCustomer">Save changes</button>`, true);

  $('#saveCustomer').onclick = async () => {
    try {
      const r = await api('/api/admin/customers/' + id, {
        method: 'PUT', body: JSON.stringify(formValues($('#modal')))
      });
      closeModal();
      toast(r.message);
      route();
    } catch (err) { toast(err.message, 'error'); }
  };
}

/* ================================================================== */
/* View: coupons                                                       */
/* ================================================================== */

async function viewCoupons() {
  $('#view').innerHTML = pageHead('Discount codes', 'Codes customers can type at checkout.',
    `<button class="btn btn-primary btn-sm" id="newCoupon">${icon('plus', { size: 15 })} New code</button>`) +
    bulkBar() +
    `<div class="card"><div class="table-wrap" id="couponTable"><p class="chart-empty">Loading…</p></div></div>`;
  wireHead();

  const load = async () => {
    const d = await api('/api/admin/coupons');
    $('#couponTable').innerHTML = d.coupons.length ? `
      <table class="data">
        <thead><tr>${headCheck()}<th>Code</th><th>Discount</th><th class="num">Minimum spend</th>
          <th class="num">Used</th><th>Expires</th><th>Status</th><th></th></tr></thead>
        <tbody>${d.coupons.map((c) => `
          <tr class="row-link" data-coupon="${c.id}">
            <td class="pick-col">${rowCheck(c.id)}</td>
            <td class="strong" style="font-family:ui-monospace,monospace">${esc(c.code)}</td>
            <td>${c.type === 'percent' ? `${c.value}% off` : `${money(c.value)} off`}</td>
            <td class="num">${c.min_subtotal ? money(c.min_subtotal) : '—'}</td>
            <td class="num">${c.used_count}${c.max_uses ? ` / ${c.max_uses}` : ''}</td>
            <td>${c.expires_at ? esc(dateOnly(c.expires_at)) : 'Never'}</td>
            <td>${c.active ? tag('active') : tag('hidden')}</td>
            <td><button class="btn btn-ghost btn-sm">Edit</button></td>
          </tr>`).join('')}
      </tbody></table>`
      : `<div class="empty"><div class="e-ico">${icon('discount', { size: 34, stroke: 1.5 })}</div><p>No discount codes yet.</p></div>`;

    $$('[data-coupon]').forEach((row) => row.addEventListener('click', () =>
      editCoupon(d.coupons.find((c) => c.id === Number(row.dataset.coupon)))));

    initBulk({
      entity: 'coupons', noun: 'code', reload: load,
      actions: [
        { label: 'Switch on', action: 'active', value: 'on', icon: 'check' },
        { label: 'Switch off', action: 'active', value: 'off', icon: 'close' },
        { label: 'Delete', action: 'delete', tone: 'danger', icon: 'trash',
          confirm: { title: 'Delete these codes?', body: 'Removes {n}. They stop working immediately.',
            label: 'Delete' } }
      ]
    });
  };

  $('#newCoupon').onclick = () => editCoupon(null);
  await load();
}

function editCoupon(c) {
  const isNew = !c;
  const d = c || { code: '', type: 'percent', value: 10, min_subtotal: 0, max_uses: 0, expires_at: '', active: 1 };

  openModal(isNew ? 'New discount code' : `Edit ${d.code}`, `
    <div class="field-grid">
      <div class="field-row">
        <label for="cuCode">Code</label>
        <input type="text" id="cuCode" name="code" value="${esc(d.code)}"
          ${isNew ? '' : 'disabled'} maxlength="30" placeholder="SPRING20"
          style="text-transform:uppercase;font-family:ui-monospace,monospace">
        ${isNew ? '<span class="help">Customers type this at checkout.</span>'
          : '<span class="help">Codes cannot be renamed — create a new one instead.</span>'}
      </div>
      <div class="field-row">
        <label for="cuType">Type</label>
        <select id="cuType" name="type">
          <option value="percent"${d.type === 'percent' ? ' selected' : ''}>Percentage off</option>
          <option value="fixed"${d.type === 'fixed' ? ' selected' : ''}>Fixed amount off</option>
        </select>
      </div>
      <div class="field-row">
        <label for="cuValue">Amount</label>
        <input type="number" id="cuValue" name="value" step="0.01" min="0" value="${d.value}">
        <span class="help">Percent, or an amount in ${esc(app.settings.currency_symbol)}.</span>
      </div>
      <div class="field-row">
        <label for="cuMin">Minimum spend</label>
        <input type="number" id="cuMin" name="min_subtotal" step="0.01" min="0" value="${d.min_subtotal}">
        <span class="help">0 for no minimum.</span>
      </div>
      <div class="field-row">
        <label for="cuMax">Maximum uses</label>
        <input type="number" id="cuMax" name="max_uses" min="0" value="${d.max_uses}">
        <span class="help">0 for unlimited.</span>
      </div>
      <div class="field-row">
        <label for="cuExp">Expires on</label>
        <input type="date" id="cuExp" name="expires_at" value="${esc((d.expires_at || '').slice(0, 10))}">
      </div>
      <div class="field-row full">
        <label class="check"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}> Code is live</label>
      </div>
    </div>`,
    `${isNew ? '' : '<button class="btn btn-danger btn-sm" id="deleteCoupon">Delete</button>'}
     <span style="flex:1"></span>
     <button class="btn btn-ghost" data-close>Cancel</button>
     <button class="btn btn-primary" id="saveCoupon">${isNew ? 'Create code' : 'Save changes'}</button>`);

  $('#saveCoupon').onclick = async () => {
    const body = formValues($('#modal'));
    if (isNew) body.code = $('#cuCode').value;
    try {
      const r = isNew
        ? await api('/api/admin/coupons', { method: 'POST', body: JSON.stringify(body) })
        : await api('/api/admin/coupons/' + c.id, { method: 'PUT', body: JSON.stringify(body) });
      closeModal();
      toast(r.message);
      route();
    } catch (err) { toast(err.message, 'error'); }
  };

  if (!isNew) {
    $('#deleteCoupon').onclick = async () => {
      closeModal();
      if (!await confirmAction('Delete this code?', `${c.code} will stop working immediately.`)) return;
      const r = await api('/api/admin/coupons/' + c.id, { method: 'DELETE' });
      toast(r.message);
      route();
    };
  }
}

/* ================================================================== */
/* View: reviews                                                       */
/* ================================================================== */

let reviewFilter = 'pending';

async function viewReviews() {
  $('#view').innerHTML = pageHead('Reviews', 'Nothing appears on the shop until you approve it.') +
    `<div class="toolbar">
      <div class="segmented" id="reviewTabs">
        ${['pending', 'approved', 'rejected', 'all'].map((s) =>
          `<button data-rev="${s}" class="${reviewFilter === s ? 'active' : ''}">${s}</button>`).join('')}
      </div>
    </div>
    ${bulkBar()}
    <div id="reviewList"><p class="chart-empty">Loading…</p></div>`;
  wireHead();

  const load = async () => {
    const d = await api('/api/admin/reviews?status=' + reviewFilter);
    app.alerts.pending_reviews = d.counts.pending || 0;
    paintAlerts();

    $('#reviewList').innerHTML = d.reviews.length
      ? `<div class="stack">${d.reviews.map((r) => `
        <div class="card card-pad">
          <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:10px">
            <div style="display:flex;gap:12px;align-items:flex-start">
              ${rowCheck(r.id)}
              <div>
              <strong>${esc(r.name)}</strong>
              <span style="color:var(--ink-3)"> · ${esc(r.location || 'somewhere')}</span>
              <div class="cell-sub">on ${esc(r.product || 'a deleted product')} · ${esc(dateTime(r.created_at))}</div>
              </div>
            </div>
            <div style="display:flex;gap:9px;align-items:center">
              <span style="color:#EDA100;letter-spacing:2px">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
              ${tag(r.status)}
            </div>
          </div>
          <p style="line-height:1.7;color:var(--ink-2)">${esc(r.body)}</p>
          <div style="display:flex;gap:9px;margin-top:14px;flex-wrap:wrap">
            ${r.status !== 'approved' ? `<button class="btn btn-primary btn-sm" data-approve="${r.id}">Approve</button>` : ''}
            ${r.status !== 'rejected' ? `<button class="btn btn-ghost btn-sm" data-reject="${r.id}">Reject</button>` : ''}
            <button class="btn btn-danger btn-sm" data-delrev="${r.id}">Delete</button>
          </div>
        </div>`).join('')}</div>`
      : `<div class="card"><div class="empty"><div class="e-ico">${icon('star', { size: 34, stroke: 1.5 })}</div><p>Nothing here.</p></div></div>`;

    const setStatus = async (id, status) => {
      const r = await api('/api/admin/reviews/' + id, { method: 'PUT', body: JSON.stringify({ status }) });
      toast(r.message);
      load();
    };
    $$('[data-approve]').forEach((b) => b.onclick = () => setStatus(b.dataset.approve, 'approved'));
    $$('[data-reject]').forEach((b) => b.onclick = () => setStatus(b.dataset.reject, 'rejected'));
    $$('[data-delrev]').forEach((b) => b.onclick = async () => {
      if (!await confirmAction('Delete this review?', 'It will be removed permanently.')) return;
      await api('/api/admin/reviews/' + b.dataset.delrev, { method: 'DELETE' });
      toast('Review deleted.');
      load();
    });

    initBulk({
      entity: 'reviews', noun: 'review', reload: load,
      actions: [
        { label: 'Approve', action: 'status', value: 'approved', icon: 'check' },
        { label: 'Reject', action: 'status', value: 'rejected', icon: 'close' },
        { label: 'Delete', action: 'delete', tone: 'danger', icon: 'trash',
          confirm: { title: 'Delete these reviews?', body: 'Removes {n} permanently.', label: 'Delete' } }
      ]
    });
  };

  $('#reviewTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rev]');
    if (!btn) return;
    reviewFilter = btn.dataset.rev;
    $$('[data-rev]').forEach((b) => b.classList.toggle('active', b === btn));
    load();
  });

  await load();
}

/* ================================================================== */
/* View: messages & subscribers                                        */
/* ================================================================== */

async function viewMessages() {
  $('#view').innerHTML = pageHead('Inbox', 'Contact form messages and newsletter sign-ups.',
    `<button class="btn btn-ghost btn-sm" id="exportSubs">${icon('download', { size: 15 })} Export subscribers</button>`) +
    bulkBar() +
    `<div id="msgBody"><p class="chart-empty">Loading…</p></div>`;
  wireHead();
  $('#exportSubs').onclick = () => { location.href = '/api/admin/export/subscribers'; };

  const load = async () => {
    const d = await api('/api/admin/messages');
    app.alerts.new_messages = d.new_count;
    paintAlerts();

    $('#msgBody').innerHTML = `
      <div class="grid-wide">
        <div class="stack">
          ${d.messages.length ? d.messages.map((m) => `
            <div class="card card-pad">
              <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:8px">
                <div style="display:flex;gap:12px;align-items:flex-start">${rowCheck(m.id)}
                  <div><strong>${esc(m.name)}</strong>
                  <div class="cell-sub">${esc(m.email)} · ${esc(dateTime(m.created_at))}</div></div></div>
                ${tag(m.status)}
              </div>
              ${m.subject ? `<div style="font-weight:800;margin-bottom:6px">${esc(m.subject)}</div>` : ''}
              <p style="line-height:1.7;color:var(--ink-2);white-space:pre-wrap">${esc(m.body)}</p>
              <div style="display:flex;gap:9px;margin-top:14px;flex-wrap:wrap">
                <a class="btn btn-primary btn-sm" href="mailto:${esc(m.email)}?subject=${encodeURIComponent('Re: ' + (m.subject || 'your message'))}">Reply by email</a>
                <button class="btn btn-ghost btn-sm" data-msg="${m.id}" data-status="replied">Mark replied</button>
                <button class="btn btn-ghost btn-sm" data-msg="${m.id}" data-status="archived">Archive</button>
                <button class="btn btn-danger btn-sm" data-delmsg="${m.id}">Delete</button>
              </div>
            </div>`).join('')
            : `<div class="card"><div class="empty"><div class="e-ico">${icon('inbox', { size: 34, stroke: 1.5 })}</div><p>No messages yet.</p></div></div>`}
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Newsletter list</h3>
            <div class="cap">${d.subscribers.length} subscriber${d.subscribers.length === 1 ? '' : 's'}.</div></div></div>
          <div class="card-body" style="max-height:560px;overflow-y:auto">
            ${d.subscribers.map((s) => `
              <div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;
                border-bottom:1px solid var(--line);font-size:13px">
                <span>${esc(s.email)}</span>
                <span style="color:var(--ink-3)">${esc(dateOnly(s.created_at))}</span>
              </div>`).join('') || '<p class="chart-empty">Nobody has signed up yet.</p>'}
          </div>
        </div>
      </div>`;

    $$('[data-msg]').forEach((b) => b.onclick = async () => {
      await api('/api/admin/messages/' + b.dataset.msg, {
        method: 'PUT', body: JSON.stringify({ status: b.dataset.status })
      });
      load();
    });
    $$('[data-delmsg]').forEach((b) => b.onclick = async () => {
      if (!await confirmAction('Delete this message?', 'It will be removed permanently.')) return;
      await api('/api/admin/messages/' + b.dataset.delmsg, { method: 'DELETE' });
      toast('Message deleted.');
      load();
    });

    initBulk({
      entity: 'messages', noun: 'message', reload: load,
      actions: [
        { label: 'Mark read', action: 'status', value: 'read', icon: 'eye' },
        { label: 'Mark replied', action: 'status', value: 'replied', icon: 'reply' },
        { label: 'Archive', action: 'status', value: 'archived', icon: 'archive' },
        { label: 'Delete', action: 'delete', tone: 'danger', icon: 'trash',
          confirm: { title: 'Delete these messages?', body: 'Removes {n} permanently.', label: 'Delete' } }
      ]
    });
  };

  await load();
}

/* ================================================================== */
/* View: shop content (categories + FAQ)                               */
/* ================================================================== */

async function viewContent() {
  $('#view').innerHTML = pageHead('Shop content',
    'The home page slideshow, your categories, and the questions shown on the shop.') +
    `<div id="contentBody"><p class="chart-empty">Loading…</p></div>`;
  wireHead();

  const load = async () => {
    const [cats, faqs, hero] = await Promise.all([
      api('/api/admin/categories'),
      api('/api/admin/faqs'),
      api('/api/admin/hero-slides')
    ]);

    $('#contentBody').innerHTML = `
      <div class="card" style="margin-bottom:18px">
        <div class="card-head">
          <div><h3>Home page slideshow</h3>
            <div class="cap">The big photos at the top of your shop. Drag is not needed —
              use the arrows to reorder.</div></div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <label class="check" style="gap:7px">
              Change every
              <input type="number" id="heroInterval" min="2" max="120" value="${hero.interval}"
                     style="width:74px;padding:7px 10px;text-align:center">
              seconds
            </label>
            <button class="btn btn-ghost btn-sm" id="saveInterval">Save</button>
            <button class="btn btn-primary btn-sm" id="addSlide">
              ${icon('camera', { size: 14 })} Add photo</button>
            <input type="file" id="slideFile" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" hidden>
          </div>
        </div>
        <div class="card-body">
          ${hero.slides.length ? `
            <div class="slide-grid">
              ${hero.slides.map((sl, i) => `
                <div class="slide-card ${sl.active ? '' : 'off'}">
                  <div class="slide-art"><img src="${esc(sl.image_url)}" alt=""></div>
                  <div class="slide-tools">
                    <button class="btn btn-ghost btn-sm" data-move="${sl.id}" data-dir="-1"
                            ${i === 0 ? 'disabled' : ''} aria-label="Move earlier">←</button>
                    <button class="btn btn-ghost btn-sm" data-move="${sl.id}" data-dir="1"
                            ${i === hero.slides.length - 1 ? 'disabled' : ''} aria-label="Move later">→</button>
                    <span style="flex:1"></span>
                    <button class="btn btn-ghost btn-sm" data-toggle="${sl.id}"
                            data-active="${sl.active ? 0 : 1}">${sl.active ? 'Hide' : 'Show'}</button>
                    <button class="btn btn-danger btn-sm" data-delslide="${sl.id}"
                            aria-label="Remove">${icon('trash', { size: 13 })}</button>
                  </div>
                  <input type="text" class="slide-caption" data-caption="${sl.id}"
                         value="${esc(sl.caption || '')}" placeholder="Caption (optional)" maxlength="160">
                </div>`).join('')}
            </div>
            <p class="help" style="margin-top:14px">
              Photos fade from one to the next every ${hero.interval} seconds. Hidden photos stay
              here but are skipped on the shop.</p>`
            : `<div class="empty" style="padding:32px 20px">
                 ${icon('camera', { size: 34, stroke: 1.5 })}
                 <p style="margin-top:10px">No slideshow photos yet — the shop shows a drawn
                 bouquet instead. Add a photo to replace it.</p>
               </div>`}
        </div>
      </div>

      <div class="grid-wide">
        <div class="card">
          <div class="card-head">
            <div><h3>Questions &amp; answers</h3><div class="cap">Shown in the FAQ section.</div></div>
            <button class="btn btn-primary btn-sm" id="newFaq">${icon('plus', { size: 15 })} Add question</button>
          </div>
          <div class="card-body stack">
            ${faqs.faqs.map((f) => `
              <div style="border:1px solid var(--line);border-radius:12px;padding:15px">
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
                  <strong style="font-size:14px">${esc(f.question)}</strong>
                  <div style="display:flex;gap:7px;flex:0 0 auto">
                    ${f.active ? tag('active') : tag('hidden')}
                    <button class="btn btn-ghost btn-sm" data-faq="${f.id}">Edit</button>
                  </div>
                </div>
                <p style="color:var(--ink-2);font-size:13px;line-height:1.65;margin-top:8px">${esc(f.answer)}</p>
              </div>`).join('') || '<p class="chart-empty">No questions yet.</p>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div><h3>Categories</h3><div class="cap">The occasion chips on the shop.</div></div>
            <button class="btn btn-primary btn-sm" id="newCat">${icon('plus', { size: 15 })} Add</button>
          </div>
          <div class="card-body">
            ${cats.categories.map((c) => `
              <div style="display:flex;align-items:center;gap:11px;padding:9px 0;border-bottom:1px solid var(--line)">
                <span style="width:32px;height:32px;border-radius:50%;background:${esc(c.color)};
                  display:flex;align-items:center;justify-content:center">${
                    iconOrText(c.icon, { size: 16 })}</span>
                <span style="flex:1">
                  <strong style="font-size:13.5px">${esc(c.name)}</strong>
                  <div class="cell-sub">${c.product_count} product${c.product_count === 1 ? '' : 's'}</div>
                </span>
                <button class="btn btn-ghost btn-sm" data-cat="${c.id}">Edit</button>
              </div>`).join('') || '<p class="chart-empty">No categories yet.</p>'}
          </div>
        </div>
      </div>`;

    /* --- slideshow --- */
    $('#addSlide').onclick = () => $('#slideFile').click();

    $('#slideFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 6_000_000) return toast('That image is larger than 6 MB.', 'error');
      const btn = $('#addSlide');
      btn.disabled = true;
      btn.textContent = 'Uploading…';
      try {
        const res = await fetch('/api/admin/upload', {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file
        });
        const up = await res.json();
        if (!res.ok) throw new Error(up.error || 'Upload failed');
        const r = await api('/api/admin/hero-slides', {
          method: 'POST', body: JSON.stringify({ image_url: up.url })
        });
        toast(r.message);
        load();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Add photo';
      }
    });

    $('#saveInterval').onclick = async () => {
      const seconds = Math.min(120, Math.max(2, Number($('#heroInterval').value) || 10));
      $('#heroInterval').value = seconds;
      try {
        await api('/api/admin/settings', {
          method: 'PUT', body: JSON.stringify({ hero_interval: String(seconds) })
        });
        app.settings.hero_interval = String(seconds);
        toast(`Photos will change every ${seconds} seconds.`);
        load();
      } catch (err) { toast(err.message, 'error'); }
    };

    // Reordering sends the whole new order, so the server never has to guess.
    $$('[data-move]').forEach((b) => b.onclick = async () => {
      const ids = hero.slides.map((s) => s.id);
      const from = ids.indexOf(Number(b.dataset.move));
      const to = from + Number(b.dataset.dir);
      if (to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      try {
        await api('/api/admin/hero-slides/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
        load();
      } catch (err) { toast(err.message, 'error'); }
    });

    $$('[data-toggle]').forEach((b) => b.onclick = async () => {
      const slide = hero.slides.find((s) => s.id === Number(b.dataset.toggle));
      await api('/api/admin/hero-slides/' + b.dataset.toggle, {
        method: 'PUT',
        body: JSON.stringify({ active: Number(b.dataset.active), caption: slide?.caption || '' })
      });
      load();
    });

    $$('[data-delslide]').forEach((b) => b.onclick = async () => {
      if (!await confirmAction('Remove this photo?',
        'It disappears from the slideshow. The file itself is deleted unless a product is also using it.',
        'Remove')) return;
      const r = await api('/api/admin/hero-slides/' + b.dataset.delslide, { method: 'DELETE' });
      toast(r.message);
      load();
    });

    // Captions save when you click away, so there is no extra button to hunt for.
    $$('[data-caption]').forEach((input) => input.addEventListener('change', async () => {
      const slide = hero.slides.find((s) => s.id === Number(input.dataset.caption));
      try {
        await api('/api/admin/hero-slides/' + input.dataset.caption, {
          method: 'PUT',
          body: JSON.stringify({ caption: input.value, active: slide?.active ?? 1 })
        });
        toast('Caption saved.');
      } catch (err) { toast(err.message, 'error'); }
    }));

    $('#newFaq').onclick = () => editFaq(null, load);
    $$('[data-faq]').forEach((b) => b.onclick = () =>
      editFaq(faqs.faqs.find((f) => f.id === Number(b.dataset.faq)), load));
    $('#newCat').onclick = () => editCategory(null, load);
    $$('[data-cat]').forEach((b) => b.onclick = () =>
      editCategory(cats.categories.find((c) => c.id === Number(b.dataset.cat)), load));
  };

  await load();
}

function editFaq(f, reload) {
  const isNew = !f;
  const d = f || { question: '', answer: '', sort_order: 99, active: 1 };

  openModal(isNew ? 'New question' : 'Edit question', `
    <div class="field-row"><label for="fQ">Question</label>
      <input type="text" id="fQ" name="question" value="${esc(d.question)}" maxlength="300"></div>
    <div class="field-row"><label for="fA">Answer</label>
      <textarea id="fA" name="answer" maxlength="2000">${esc(d.answer)}</textarea></div>
    <div class="field-grid">
      <div class="field-row"><label for="fOrder">Order</label>
        <input type="number" id="fOrder" name="sort_order" value="${d.sort_order}"></div>
      <div class="field-row" style="justify-content:flex-end">
        <label class="check"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}> Show on the shop</label></div>
    </div>`,
    `${isNew ? '' : '<button class="btn btn-danger btn-sm" id="delFaq">Delete</button>'}
     <span style="flex:1"></span>
     <button class="btn btn-ghost" data-close>Cancel</button>
     <button class="btn btn-primary" id="saveFaq">Save</button>`);

  $('#saveFaq').onclick = async () => {
    const body = formValues($('#modal'));
    try {
      const r = isNew
        ? await api('/api/admin/faqs', { method: 'POST', body: JSON.stringify(body) })
        : await api('/api/admin/faqs/' + f.id, { method: 'PUT', body: JSON.stringify(body) });
      closeModal();
      toast(r.message);
      reload();
    } catch (err) { toast(err.message, 'error'); }
  };
  if (!isNew) $('#delFaq').onclick = async () => {
    closeModal();
    if (!await confirmAction('Delete this question?', 'It will disappear from the shop.')) return;
    await api('/api/admin/faqs/' + f.id, { method: 'DELETE' });
    toast('Question deleted.');
    reload();
  };
}

function editCategory(c, reload) {
  const isNew = !c;
  const d = c || { name: '', icon: 'flower', color: '#F2C9D9', sort_order: 99, active: 1 };

  openModal(isNew ? 'New category' : `Edit ${d.name}`, `
    <div class="field-grid">
      <div class="field-row"><label for="catName">Name</label>
        <input type="text" id="catName" name="name" value="${esc(d.name)}" maxlength="60"></div>
      <div class="field-row"><label for="catColor">Chip colour</label>
        <input type="text" id="catColor" name="color" value="${esc(d.color)}" maxlength="20"></div>
      <div class="field-row full">
        <label>Icon</label>
        <div class="icon-picker" id="iconPicker">
          ${PICKABLE.map((name) => `
            <button type="button" class="icon-choice ${d.icon === name ? 'on' : ''}"
              data-icon="${name}" title="${name}" aria-label="${name}">${icon(name, { size: 20 })}</button>`).join('')}
        </div>
      </div>
      <div class="field-row"><label for="catOrder">Order</label>
        <input type="number" id="catOrder" name="sort_order" value="${d.sort_order}"></div>
      <div class="field-row" style="justify-content:flex-end">
        <label class="check"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}> Show on the shop</label></div>
    </div>
    <input type="hidden" name="icon" id="catIcon" value="${esc(d.icon)}">`,
    `${isNew ? '' : '<button class="btn btn-danger btn-sm" id="delCat">Delete</button>'}
     <span style="flex:1"></span>
     <button class="btn btn-ghost" data-close>Cancel</button>
     <button class="btn btn-primary" id="saveCat">Save</button>`);

  $('#iconPicker').addEventListener('click', (e) => {
    const choice = e.target.closest('[data-icon]');
    if (!choice) return;
    $$('.icon-choice').forEach((b) => b.classList.remove('on'));
    choice.classList.add('on');
    $('#catIcon').value = choice.dataset.icon;
  });

  $('#saveCat').onclick = async () => {
    const body = formValues($('#modal'));
    try {
      const r = isNew
        ? await api('/api/admin/categories', { method: 'POST', body: JSON.stringify(body) })
        : await api('/api/admin/categories/' + c.id, { method: 'PUT', body: JSON.stringify(body) });
      closeModal();
      toast(r.message);
      reload();
    } catch (err) { toast(err.message, 'error'); }
  };
  if (!isNew) $('#delCat').onclick = async () => {
    closeModal();
    if (!await confirmAction('Delete this category?',
      `Products in "${c.name}" are kept — they simply become uncategorised.`)) return;
    await api('/api/admin/categories/' + c.id, { method: 'DELETE' });
    toast('Category deleted.');
    reload();
  };
}

/* ================================================================== */
/* View: settings                                                      */
/* ================================================================== */

const SETTING_GROUPS = [
  ['Shop identity', [
    ['shop_name', 'Shop name', 'text'],
    ['tagline', 'Tagline', 'text'],
    ['announcement', 'Announcement bar', 'text'],
    ['about', 'Footer blurb', 'textarea'],
    ['hero_title', 'Home page headline', 'text']
  ]],
  ['Product page', [
    ['product_badges', 'Badges under the description', 'textarea'],
    ['product_trust', 'Boxes under "Add to basket"', 'textarea']
  ]],
  ['Contact details', [
    ['email', 'Email', 'text'],
    ['phone', 'Phone', 'text'],
    ['address', 'Address', 'text'],
    ['hours', 'Opening hours', 'text']
  ]],
  ['Money & delivery', [
    ['currency_symbol', 'Currency symbol', 'text'],
    ['currency_code', 'Currency code', 'text'],
    ['shipping_flat', 'Flat shipping fee', 'number'],
    ['free_shipping_over', 'Free shipping over', 'number'],
    ['low_stock_threshold', 'Low stock warning at', 'number'],
    ['order_prefix', 'Order number prefix', 'text'],
    ['payment_methods', 'Payment methods', 'text']
  ]],
  ['Social links', [
    ['instagram', 'Instagram', 'text'],
    ['facebook', 'Facebook', 'text'],
    ['tiktok', 'TikTok', 'text'],
    ['pinterest', 'Pinterest', 'text']
  ]]
];

async function viewSettings() {
  const d = await api('/api/admin/settings');
  app.settings = d.settings;

  $('#view').innerHTML = pageHead('Settings', 'Everything the shop shows and charges.') + `
    <div class="card" style="margin-bottom:20px">
      <div class="card-head"><div><h3>Logo</h3>
        <div class="cap">Shown in the shop header next to the shop name. A square image works best.</div></div></div>
      <div class="card-body logo-setting">
        <div class="logo-preview" id="logoPreview"></div>
        <div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" type="button" id="logoUpload">Upload logo</button>
            <button class="btn btn-ghost" type="button" id="logoRemove">Use placeholder</button>
          </div>
          <span class="help" style="display:block;margin-top:8px">JPG, PNG or WebP, up to 6 MB.
            Saved straight away — no need to press Save settings.</span>
          <input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp" hidden>
        </div>
      </div>
    </div>

    <form id="settingsForm">
      <div class="grid-2">
        ${SETTING_GROUPS.map(([title, fields]) => `
          <div class="card">
            <div class="card-head"><div><h3>${esc(title)}</h3></div></div>
            <div class="card-body">
              ${fields.map(([key, label, type]) => `
                <div class="field-row">
                  <label for="set-${key}">${esc(label)}</label>
                  ${type === 'textarea'
                    ? `<textarea id="set-${key}" name="${key}">${esc(d.settings[key] ?? '')}</textarea>`
                    : `<input type="${type}" id="set-${key}" name="${key}" value="${esc(d.settings[key] ?? '')}"
                        ${type === 'number' ? 'step="0.01" min="0"' : ''}>`}
                  ${key === 'payment_methods'
                    ? '<span class="help">Comma-separated. Available: stripe, cod, bank, card.</span>' : ''}
                  ${key === 'product_badges' || key === 'product_trust'
                    ? `<span class="help">One per line. Delete a line to remove it; leave empty to hide the whole row.${
                      key === 'product_trust' ? ' Write {shipping} for a shipping line worked out from your shipping fee.' : ''}</span>` : ''}
                  ${key === 'order_prefix'
                    ? '<span class="help">Order numbers look like PREFIX-10001.</span>' : ''}
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:10px;margin-top:20px">
        <button class="btn btn-primary" type="submit" id="saveSettings">Save settings</button>
      </div>
    </form>

    <div class="grid-2 mt">
      <div class="card">
        <div class="card-head"><div><h3>Your password</h3>
          <div class="cap">Changing it signs out every other device.</div></div></div>
        <div class="card-body">
          <div class="field-row"><label for="pwCurrent">Current password</label>
            <input type="password" id="pwCurrent" autocomplete="current-password"></div>
          <div class="field-row"><label for="pwNew">New password</label>
            <input type="password" id="pwNew" autocomplete="new-password">
            <span class="help">At least 8 characters.</span></div>
          <button class="btn btn-ghost" id="changePw">Change password</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><h3>Snapshots</h3>
            <div class="cap">Taken automatically before anything is deleted.</div></div>
          <button class="btn btn-ghost btn-sm" id="makeBackup">${icon('download', { size: 14 })} Snapshot now</button>
        </div>
        <div class="card-body" id="backupList"><p class="chart-empty">Loading…</p></div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>Sample data</h3>
          <div class="cap">For trying the dashboard out before real orders arrive.</div></div></div>
        <div class="card-body">
          <p style="color:var(--ink-2);line-height:1.7;font-size:13.5px;margin-bottom:16px">
            Generate a few months of realistic orders, customers and traffic so every chart has
            something to show — then clear it in one click before you go live.</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-ghost" id="genDemo">Generate 120 days of samples</button>
            <button class="btn btn-danger" id="clearDemo">Clear all orders &amp; analytics</button>
          </div>
        </div>
      </div>
    </div>`;
  wireHead();

  /* --- logo --- */
  const paintLogo = () => {
    const url = app.settings.logo_url;
    $('#logoPreview').innerHTML =
      `<img src="${esc(url || '/img/logo.svg')}" alt="Current logo">`;
    $('#logoRemove').hidden = !url;
  };
  const saveLogo = async (url) => {
    const r = await api('/api/admin/settings', {
      method: 'PUT', body: JSON.stringify({ logo_url: url })
    });
    app.settings = r.settings;
    paintLogo();
  };
  paintLogo();

  $('#logoUpload').onclick = () => $('#logoFile').click();
  $('#logoFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 6_000_000) return toast('That image is larger than 6 MB.', 'error');
    const btn = $('#logoUpload');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file
      });
      const up = await res.json();
      if (!res.ok) throw new Error(up.error || 'Upload failed');
      await saveLogo(up.url);
      toast('Logo updated.');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Upload logo';
    }
  });
  $('#logoRemove').onclick = async () => {
    try {
      await saveLogo('');
      toast('Logo removed. The shop shows the placeholder again.');
    } catch (err) { toast(err.message, 'error'); }
  };

  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/admin/settings', {
        method: 'PUT', body: JSON.stringify(formValues($('#settingsForm')))
      });
      app.settings = r.settings;
      toast(r.message);
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#changePw').onclick = async () => {
    try {
      const r = await api('/api/admin/password', {
        method: 'POST',
        body: JSON.stringify({ current: $('#pwCurrent').value, password: $('#pwNew').value })
      });
      $('#pwCurrent').value = '';
      $('#pwNew').value = '';
      toast(r.message);
    } catch (err) { toast(err.message, 'error'); }
  };

  const loadBackups = async () => {
    const { backups } = await api('/api/admin/backups');
    // What triggered each snapshot, in words rather than the internal slug.
    const REASONS = {
      manual: 'Taken by hand',
      'clear-all': 'Before clearing all orders',
      'order-delete': 'Before deleting an order',
      'bulk-orders-delete': 'Before deleting orders',
      'bulk-products-delete': 'Before deleting products',
      'bulk-reviews-delete': 'Before deleting reviews',
      'bulk-messages-delete': 'Before deleting messages',
      'bulk-coupons-delete': 'Before deleting discount codes'
    };

    $('#backupList').innerHTML = backups.length ? `
      <p class="help" style="margin-bottom:12px">
        Each snapshot is a full copy of your shop as JSON. To put deleted rows back,
        download one and run <code>npm run import &lt;file&gt;</code> — it re-inserts
        anything missing and leaves everything else alone.</p>
      <div style="max-height:260px;overflow-y:auto">
        ${backups.map((b) => `
          <div style="display:flex;align-items:center;gap:10px;padding:9px 0;
            border-bottom:1px solid var(--line);font-size:13px">
            <span style="flex:1">
              <strong>${esc(dateTime(b.created_at))}</strong>
              <div class="cell-sub">${esc(REASONS[b.reason] || b.reason)} ·
                ${Math.round(b.bytes / 1024)} KB</div>
            </span>
            <a class="btn btn-ghost btn-sm" href="/api/admin/backups/${encodeURIComponent(b.id)}">
              ${icon('download', { size: 13 })} Download</a>
          </div>`).join('')}
      </div>`
      : '<p class="chart-empty">No snapshots yet. One is taken automatically before any deletion.</p>';
  };

  $('#makeBackup').onclick = async () => {
    try {
      const r = await api('/api/admin/backups', { method: 'POST' });
      toast(r.message);
      loadBackups();
    } catch (err) { toast(err.message, 'error'); }
  };

  loadBackups();

  $('#genDemo').onclick = async () => {
    if (!await confirmAction('Generate sample data?',
      'This adds around 300–400 made-up orders so the charts have something to show. You can clear them again at any time.',
      'Generate')) return;
    toast('Generating…');
    const r = await api('/api/admin/demo-data', { method: 'POST', body: JSON.stringify({ days: 120 }) });
    toast(r.message);
  };

  $('#clearDemo').onclick = resetShop;
}

/** One-click reset of orders, customers and analytics — shared by Dashboard and Settings. */
async function resetShop() {
  if (!await confirmAction('Reset the shop?',
    'Every order, customer, visitor statistic and activity log entry is deleted, and order numbers start again. ' +
    'Products, stock, photos, settings and discount codes are kept. A snapshot is saved first (Settings → Snapshots).',
    'Reset everything', 'RESET')) return;
  try {
    const r = await api('/api/admin/demo-data', { method: 'POST', body: JSON.stringify({ action: 'clear' }) });
    toast(r.message);
    route();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ================================================================== */
/* Router                                                              */
/* ================================================================== */

const VIEWS = {
  dashboard: viewDashboard, analytics: viewAnalytics, orders: viewOrders,
  products: viewProducts, customers: viewCustomers, coupons: viewCoupons,
  reviews: viewReviews, messages: viewMessages, content: viewContent, settings: viewSettings
};

async function route() {
  if (!app.admin) return;
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, query] = raw.split('?');
  const view = VIEWS[name] || viewDashboard;
  setActiveNav(VIEWS[name] ? name : 'dashboard');
  $('#sidebar')?.classList.remove('open');

  try {
    await view(new URLSearchParams(query || ''));
  } catch (err) {
    if (err.message === 'Session expired') return;
    console.error(err);
    $('#view').innerHTML = pageHead('Something went wrong', err.message) +
      `<div class="card"><div class="empty"><div class="e-ico">${icon('offline', { size: 34, stroke: 1.5 })}</div>
        <p>${esc(err.message)}</p>
        <button class="btn btn-ghost btn-sm" style="margin-top:14px" onclick="location.reload()">Reload</button>
      </div></div>`;
    wireHead();
  }
}

window.addEventListener('hashchange', route);

/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */

async function boot() {
  try {
    const me = await api('/api/admin/me');
    app.admin = me.admin;
    app.settings = me.settings;
  } catch {
    return renderLogin();
  }
  document.title = `Shop Admin | ${app.settings.shop_name || 'Shop'}`;
  renderShell();
  paintAlerts();
  await route();
}

boot();

# Phool Maya

A working online shop for handmade pipe cleaner bouquets, with a full admin panel
and sales analytics.

Runs on Vercel's free tier with a free Neon Postgres database and Vercel Blob for
product photos. No build step, three dependencies, and the same code runs locally
against an embedded Postgres so you can develop with nothing installed.

---

## Running it locally

```bash
npm install
npm start
```

| | |
|---|---|
| Shop | http://localhost:3000 |
| Admin | http://localhost:3000/admin |
| Login | `admin@phoolmaya.com` / `admin1234` |

**Change that password immediately** in Admin → Settings. Everything else about the
shop — name, prices, currency, shipping, text, contact details — is editable from
the admin panel; nothing is hard-coded.

With no `DATABASE_URL` set, the shop runs on **PGlite** — a real Postgres compiled
to WebAssembly — storing its data in `data/pg`. Nothing to install. The first start
takes a few seconds while it builds the schema.

Two things to know about the local database:

- **Stop the server with Ctrl+C, not by killing the process.** PGlite holds its
  filesystem in memory and flushes on close; a hard kill can corrupt `data/pg`.
  This does not apply in production — Neon is an ordinary Postgres server.
- **Only one process can open it at a time**, so stop the server before running
  `npm run import`.

To develop against the real thing instead, put your Neon connection string in
`DATABASE_URL`. Identical code either way.

---

## Deploying to Vercel

Vercel has no persistent disk, so the database and the photos live outside it.
Both have free tiers that fit a small shop comfortably.

### 1. Push the code to GitHub

```bash
git init
git add .
git commit -m "Phool Maya"
git remote add origin https://github.com/YOUR-NAME/phool-maya.git
git push -u origin main
```

### 2. Import the project on Vercel

At [vercel.com/new](https://vercel.com/new), pick the repository and deploy.
There is no build step to configure — leave the defaults.

### 3. Add the database

In the project: **Storage → Create Database → Neon (Postgres) → Connect**.
Vercel sets `DATABASE_URL` for you. The schema is created automatically on the
first request.

### 4. Add photo storage

**Storage → Create → Blob → Connect.** Vercel sets `BLOB_READ_WRITE_TOKEN`.
Until you do this, photo uploads fail in production; everything else works.

### 5. Set the remaining environment variables

**Settings → Environment Variables:**

| Name | Value | Why |
|---|---|---|
| `SECURE_COOKIES` | `1` | Admin session cookie becomes HTTPS-only |
| `ADMIN_EMAIL` | your email | The account created on first run |
| `ADMIN_PASSWORD` | a real password | Otherwise it seeds `admin1234` |
| `SEED_SAMPLE_DATA` | `0` | Start with an empty catalogue, not 12 demo bouquets |

Redeploy after adding them (**Deployments → ⋯ → Redeploy**), because the first run
is what creates your admin account.

### 6. Move existing data across (optional)

If you already have a shop running locally:

```bash
DATABASE_URL="postgres://…your Neon string…" npm run import data/sqlite-export.json
```

Rows keep their ids, existing rows are left alone, and the id sequences are moved
past the imported data so nothing collides afterwards.

### Free tier limits

Neon's free plan gives around 0.5 GB of storage and far more queries per month
than a small shop will use. Vercel Blob's free plan covers a few gigabytes of
photos. Note that **Vercel's Hobby plan does not permit commercial use** — once
you are taking real money you need their Pro plan, or host the same code on a
small VPS instead (it runs as a normal Node process anywhere).

### Gotchas

- **Cold starts.** After a quiet period the first request takes a second or two
  while the function wakes and reconnects. Normal for serverless.
- **Sample data.** *Generate samples* in Settings writes a few hundred rows.
  Fine on the free tier, but clear it before going live.
- **The filesystem is read-only.** Never write files at runtime — that is exactly
  why photos go to Blob and snapshots go into the database.

---

## What the shop does

- **A hero slideshow** at the top of the home page. Upload photos in the admin,
  reorder them, caption them, hide one without deleting it, and set how many
  seconds each stays on screen. With no photos uploaded it falls back to the
  drawn bouquet, so the page is never empty.
- **A drifting photo strip on the home page** showing every recent bouquet. It
  scrolls itself, pauses when you point at it, can be dragged or swiped, and
  wraps seamlessly. Tapping a photo opens a buy panel — quantity, *Add to
  basket*, *Buy now* — without leaving the page.
- **Catalogue** with categories, search, sorting, and stock levels
- **Product pages** with reviews, related products, and quantity selection
- **Basket** that survives a page refresh and is re-priced by the server every time
- **Checkout** with delivery details, discount codes, and a choice of payment method
- **Order tracking** — customers enter their order number and email to see progress
- **Reviews** submitted by customers, held until you approve them
- **Contact form** and **newsletter sign-up**, both landing in the admin inbox
- **Product photos** uploaded straight from your phone or computer. Until a product
  has one, its picture is **drawn by code** from a palette and a seed — so the shop
  never looks half-finished while you are still taking photos.

### A note on payments

Payment methods are cash on delivery, bank transfer, and card on delivery — all
settled off-site. **No card details are collected or stored anywhere in this
codebase.** If you later want to take card payments online, that means adding a
payment provider (Stripe, eSewa, Khalti, or similar); the order flow is already
structured so the provider slots in between "place order" and "order confirmed".

---

## What the admin panel does

**Dashboard** — revenue, orders, average order value, profit and margin, visitors
and conversion rate, each against the previous period. Revenue and profit over
time, orders per day, order status breakdown, best sellers, low-stock warnings and
the latest orders. A range switch (7 / 30 / 90 days / 12 months) scopes everything.

**Analytics** — visitors and page views, a visit-to-order funnel, a weekday × time
heatmap of when people order, sales by occasion, per-product profit and margin,
payment method split, and best customers.

**Orders** — search and filter, open any order to see its items, costs and history,
change status and payment state, add notes. Cancelling or refunding puts stock back
on the shelf automatically.

**Products** — full add/edit/delete with price, compare-at price, cost, stock, SKU,
category and badge. **Upload a photo from your device** (click the picture, or drag
one onto it) — JPG, PNG, WebP, GIF or AVIF up to 6 MB. If a product has no photo
yet, it falls back to a drawn bouquet you can style with a palette and flower count.
Deleting a product that appears on past orders hides it instead, so your sales
history stays accurate.

**Customers** — lifetime spend, order count and history, editable details and
private notes.

**Discounts** — percentage or fixed-amount codes, minimum spend, usage limits and
expiry dates, with redemption counts.

**Reviews** — approve or reject before anything appears on the shop.

**Inbox** — contact messages and the newsletter list.

**Shop content** — the home page slideshow (upload, reorder, caption, hide, and
the seconds between photos), your categories, and the FAQ shown on the shop.

**Settings** — shop name, currency, shipping rates, contact details, social links,
home page copy, your password, and CSV exports of orders, products, customers and
subscribers.

### Sample data

The shop ships with ~390 generated orders spread over 120 days so every chart has
something to show while you are trying it out. **Before going live**, open
Settings → Sample data → *Clear all orders & analytics*. That removes every order,
customer and visitor statistic while keeping your products, settings and discount
codes.

---

## Analytics and privacy

Visitor statistics are counted first-party by this server. There are no third-party
trackers, no cookies for visitors, and no personal data in the analytics tables —
a visitor is identified by a one-way hash of their IP and browser string, which is
enough to count unique people and nothing more.

---

## Environment variables

| Name | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | *(unset)* | Neon connection string. Unset → embedded PGlite in `data/pg` |
| `BLOB_READ_WRITE_TOKEN` | *(unset)* | Vercel Blob token. Unset → photos written to `public/uploads` |
| `SECURE_COOKIES` | `0` | Set to `1` behind HTTPS so the admin cookie is secure-only |
| `SEED_SAMPLE_DATA` | `1` | `0` creates the admin and settings but no sample bouquets |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@phoolmaya.com` / `admin1234` | First-run admin account |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Local server only |
| `LOG_REQUESTS` | `0` | `1` logs every request |

It also runs as an ordinary long-lived Node process anywhere — a VPS, Fly.io, a
Raspberry Pi — with `npm start` behind a TLS reverse proxy, pointed at any
Postgres.

**Snapshots.** Before anything is deleted — a bulk delete, or *Clear all orders* —
the server writes a gzipped JSON copy of every table into the `snapshots` table.
Settings lists them with a Download button and keeps the last 8. Neon also keeps
its own point-in-time history on the free plan, which covers losing the whole
database rather than a few rows.

Uploaded photos are validated by their actual file signature rather than by what the
browser claims, and SVG is refused because it can carry script. Each file is stored
under a hash of its contents, so uploading the same photo twice reuses one file.

---

## Layout

```
server.js              Local server — wraps the handler in node:http
api/index.js           Vercel entry point — the same handler, serverless
vercel.json            Routes everything except /uploads to the function
src/
  app.js               The request handler: routing, sessions, static files
  sql.js               Postgres access — Neon in production, PGlite locally
  db.js                Schema, settings, first-run seed
  auth.js              Password hashing (scrypt) and sessions
  storage.js           Product photos — Vercel Blob or local disk
  backup.js            Snapshots (gzipped JSON, stored in the database)
  lib/http.js          Router, body parsing, JSON/static replies, validation
  api/shop.js          Public API — catalogue, pricing, checkout, tracking, forms
  api/admin.js         Admin API — CRUD, analytics, bulk actions, CSV, samples
scripts/
  import-sqlite.js     Load a JSON dump into Postgres
public/
  index.html           Storefront shell
  css/site.css         Storefront styles
  js/site.js           Storefront app
  js/bouquet.js        Bouquet illustrator, shared by browser and server
  js/icons.js          Inline SVG icon set, shared by shop and admin
  admin/               Admin panel (index.html, admin.css, admin.js, charts.js)
  uploads/             Product photos when running locally
data/pg/               The embedded local database
```

### About the charts

`public/admin/charts.js` is a small purpose-built SVG chart library — area, column,
donut, ranked bars, funnel, heatmap, sparkline and meter. It is deliberately not a
chart package: it is a few hundred lines with no dependency to install or keep
updated, and it is styled to match the shop.

The colours are not decorative. The categorical series order was checked with a
colour-vision-deficiency validator so that neighbouring series stay distinguishable
for colourblind readers; ordered data (the order lifecycle, the funnel) uses a
single-hue ramp instead; and reserved status colours are never used as a data
series. Every chart has a hover readout, a keyboard-reachable equivalent, and a
"View as table" toggle so no number is only available by pointing at it.

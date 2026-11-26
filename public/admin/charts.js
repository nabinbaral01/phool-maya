/**
 * Chart library for the Maya Flora dashboard.
 *
 * Hand-rolled SVG — no chart dependency to install, break, or wait on.
 * Every form here follows one house style: thin marks, hairline grid,
 * a 2px surface gap between touching fills, a legend whenever more than
 * one series is on screen, and a hover/focus readout on every plot.
 *
 * The categorical order is fixed and validated for colour-vision
 * deficiency — see PALETTE below. Colours are assigned by entity, never
 * by rank, so filtering never repaints the survivors.
 */

/* Validated categorical order (adjacent CVD ΔE ≥ 8 on the #FFFDFB surface). */
export const PALETTE = [
  '#C3728F', // 1 rose — the house colour
  '#008300', // 2 green
  '#4A3AA7', // 3 violet
  '#E34948', // 4 red
  '#2A78D6', // 5 blue
  '#EB6834', // 6 orange
  '#1BAF7A', // 7 aqua
  '#EDA100'  // 8 yellow
];

/* Single-hue sequential ramp, light → dark, for magnitude (heatmap). */
export const SEQ = ['#FBE9F0', '#F6D3E0', '#EEB4C9', '#E294B0', '#D07494', '#B85778', '#99405D', '#7A2C45'];

/* Ordinal steps for ordered stages (funnel) — none lighter than 2:1 on surface. */
export const ORDINAL = ['#E294B0', '#D07494', '#B85778', '#99405D', '#7A2C45'];

const SURFACE = '#FFFDFB';
const GRID = '#EDE1DA';
const INK = '#2E2422';
const INK_2 = '#6B5A55';
const INK_3 = '#93817B';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  return node;
};

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function compact(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return v.toLocaleString(undefined, { maximumFractionDigits: abs < 10 ? 1 : 0 });
}

const shortDate = (iso) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Round an axis maximum up to a clean 1/2/5 × 10ⁿ step. */
function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { max: 1, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

/**
 * A domain that can span zero. Profit goes negative on a real shop — a refund,
 * a clearance sale, a mispriced item — so the axis has to be able to say so
 * instead of drawing the line off the bottom of the card.
 */
function niceDomain(min, max, ticks = 4) {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  const span = hi - lo;
  if (span === 0) return { lo: 0, hi: 1, step: 1 };
  const raw = span / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

/* ------------------------------------------------------------------ */
/* Shared tooltip                                                      */
/* ------------------------------------------------------------------ */

let tipEl;
function tooltip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    tipEl.setAttribute('role', 'status');
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

/**
 * @param {{title:string, rows:{label:string,value:string,color?:string}[]}} content
 * Labels come from the API, so they are inserted as text nodes — never markup.
 */
function showTip(x, y, content) {
  const tip = tooltip();
  tip.replaceChildren();

  const head = document.createElement('div');
  head.className = 'tip-head';
  head.textContent = content.title;
  tip.appendChild(head);

  for (const row of content.rows) {
    const line = document.createElement('div');
    line.className = 'tip-row';
    if (row.color) {
      const key = document.createElement('span');
      key.className = 'tip-key';
      key.style.background = row.color;
      line.appendChild(key);
    }
    const val = document.createElement('strong');
    val.textContent = row.value;
    const lab = document.createElement('span');
    lab.className = 'tip-label';
    lab.textContent = row.label;
    line.append(val, lab);
    tip.appendChild(line);
  }

  tip.classList.add('show');
  const box = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - box.width / 2), window.innerWidth - box.width - 8);
  const top = y - box.height - 14 < 8 ? y + 18 : y - box.height - 14;
  tip.style.transform = `translate(${left}px, ${top}px)`;
}

const hideTip = () => tipEl?.classList.remove('show');
document.addEventListener('scroll', hideTip, true);

/* ------------------------------------------------------------------ */
/* Legend + table view (the relief rule for low-contrast hues)         */
/* ------------------------------------------------------------------ */

export function legend(container, series, shape = 'rect') {
  if (series.length < 2) return;
  const box = document.createElement('div');
  box.className = 'chart-legend';
  for (const s of series) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const key = document.createElement('span');
    key.className = shape === 'line' ? 'legend-line' : 'legend-swatch';
    key.style.background = s.color;
    const text = document.createElement('span');
    text.textContent = s.label;
    item.append(key, text);
    box.appendChild(item);
  }
  container.appendChild(box);
}

/** Every chart ships a table view, so no value is reachable only by hovering. */
export function tableView(container, columns, rows) {
  const details = document.createElement('details');
  details.className = 'chart-table';
  const summary = document.createElement('summary');
  summary.textContent = 'View as table';
  details.appendChild(summary);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const cell of r) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  details.appendChild(table);
  container.appendChild(details);
}

function mount(target) {
  const host = typeof target === 'string' ? document.querySelector(target) : target;
  if (!host) return null;
  host.replaceChildren();
  return host;
}

function emptyNote(host, message) {
  const p = document.createElement('p');
  p.className = 'chart-empty';
  p.textContent = message;
  host.appendChild(p);
}

/* ================================================================== */
/* Area / line chart — change over time                                */
/* ================================================================== */

/**
 * @param {object[]} data rows
 * @param {{key:string,label:string,color:string}[]} series
 * @param {{x:string, format?:(n:number)=>string, height?:number, area?:boolean}} opts
 */
export function areaChart(target, data, series, opts = {}) {
  const host = mount(target);
  if (!host) return;
  if (!data.length) return emptyNote(host, 'No activity in this period yet.');

  const fmt = opts.format || compact;
  const H = opts.height || 260;
  const W = 800;
  const pad = { top: 16, right: 54, bottom: 28, left: 52 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const values = data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0));
  const { lo, hi, step } = niceDomain(Math.min(...values, 0), Math.max(...values, 0));
  const x = (i) => pad.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v) => pad.top + plotH - (((Number(v) || 0) - lo) / (hi - lo)) * plotH;
  const zeroY = y(0);

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', preserveAspectRatio: 'none',
    role: 'img', 'aria-label': opts.ariaLabel || 'Time series chart'
  });

  const defs = el('defs');
  series.forEach((s, i) => {
    const grad = el('linearGradient', { id: `g-${opts.id || 'a'}-${i}`, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(
      el('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.16 }),
      el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0.01 })
    );
    defs.appendChild(grad);
  });
  svg.appendChild(defs);

  // hairline grid + y ticks; the zero line is drawn stronger when the axis
  // crosses it, so a loss reads as a loss rather than a small bar
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const isZero = Math.abs(v) < 1e-9 && lo < 0;
    svg.appendChild(el('line', {
      x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v),
      stroke: isZero ? INK_3 : GRID, 'stroke-width': 1
    }));
    const t = el('text', { x: pad.left - 10, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = fmt(v);
    svg.appendChild(t);
  }

  // x ticks — first, middle, last only, so labels never collide
  [0, Math.floor((data.length - 1) / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i)
    .forEach((i) => {
      const t = el('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle', class: 'axis-text' });
      t.textContent = shortDate(data[i][opts.x]);
      svg.appendChild(t);
    });

  // Direct end-labels only work while the series separate at the right edge.
  // Track where each one lands and drop any that would sit on top of another —
  // the legend, tooltip and table view still carry those values.
  const placedLabels = [];

  series.forEach((s, si) => {
    const pts = data.map((d, i) => [x(i), y(d[s.key])]);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

    if (opts.area !== false) {
      // Close the fill on the zero line, not the floor, so negative stretches
      // hang below zero instead of painting off the bottom of the chart.
      svg.appendChild(el('path', {
        d: `${path} L${pts.at(-1)[0].toFixed(1)},${zeroY.toFixed(1)} L${pts[0][0].toFixed(1)},${zeroY.toFixed(1)} Z`,
        fill: `url(#g-${opts.id || 'a'}-${si})`
      }));
    }
    svg.appendChild(el('path', {
      d: path, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));

    // end marker with a surface ring, plus one direct label at the endpoint
    const last = pts.at(-1);
    svg.appendChild(el('circle', { cx: last[0], cy: last[1], r: 4.5, fill: s.color, stroke: SURFACE, 'stroke-width': 2 }));

    if (!placedLabels.some((yy) => Math.abs(yy - last[1]) < 13)) {
      placedLabels.push(last[1]);
      const label = el('text', {
        x: Math.min(last[0] + 9, W - 4), y: last[1] + 4,
        class: 'axis-text strong', 'text-anchor': 'start'
      });
      label.textContent = fmt(data.at(-1)[s.key]);
      svg.appendChild(label);
    }
  });

  // crosshair + hover readout
  const cross = el('line', { y1: pad.top, y2: pad.top + plotH, stroke: INK_3, 'stroke-width': 1, opacity: 0 });
  svg.appendChild(cross);
  const dots = series.map((s) => {
    const c = el('circle', { r: 5, fill: s.color, stroke: SURFACE, 'stroke-width': 2, opacity: 0 });
    svg.appendChild(c);
    return c;
  });

  const hit = el('rect', { x: pad.left, y: pad.top, width: plotW, height: plotH, fill: 'transparent', tabindex: 0 });
  svg.appendChild(hit);

  const focusIndex = (clientX) => {
    const box = svg.getBoundingClientRect();
    const rel = ((clientX - box.left) / box.width) * W;
    return Math.max(0, Math.min(data.length - 1, Math.round(((rel - pad.left) / plotW) * (data.length - 1))));
  };

  const showAt = (i, clientX, clientY) => {
    const row = data[i];
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('opacity', 0.45);
    dots.forEach((d, si) => {
      d.setAttribute('cx', x(i));
      d.setAttribute('cy', y(row[series[si].key]));
      d.setAttribute('opacity', 1);
    });
    showTip(clientX, clientY, {
      title: shortDate(row[opts.x]),
      rows: series.map((s) => ({ label: s.label, value: fmt(row[s.key]), color: s.color }))
    });
  };

  hit.addEventListener('pointermove', (e) => showAt(focusIndex(e.clientX), e.clientX, e.clientY));
  hit.addEventListener('focus', () => {
    const box = svg.getBoundingClientRect();
    showAt(data.length - 1, box.right - 60, box.top + 40);
  });
  const clear = () => {
    cross.setAttribute('opacity', 0);
    dots.forEach((d) => d.setAttribute('opacity', 0));
    hideTip();
  };
  hit.addEventListener('pointerleave', clear);
  hit.addEventListener('blur', clear);

  host.appendChild(svg);
  legend(host, series, 'line');
  tableView(host,
    [opts.xLabel || 'Date', ...series.map((s) => s.label)],
    data.map((d) => [shortDate(d[opts.x]), ...series.map((s) => fmt(d[s.key]))]));
}

/* ================================================================== */
/* Column chart — counts over time                                     */
/* ================================================================== */

export function columnChart(target, data, opts = {}) {
  const host = mount(target);
  if (!host) return;
  if (!data.length) return emptyNote(host, 'Nothing to show yet.');

  const key = opts.key || 'value';
  const fmt = opts.format || compact;
  const color = opts.color || PALETTE[0];
  const H = opts.height || 220;
  const W = 800;
  const pad = { top: 14, right: 14, bottom: 26, left: 44 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const { max, step } = niceScale(Math.max(...data.map((d) => Number(d[key]) || 0), 0));
  const band = plotW / data.length;
  const barW = Math.min(24, band - 2); // 2px surface gap between neighbours
  const y = (v) => pad.top + plotH - ((Number(v) || 0) / max) * plotH;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', preserveAspectRatio: 'none', role: 'img', 'aria-label': opts.ariaLabel || 'Column chart' });

  for (let v = 0; v <= max + 1e-9; v += step) {
    svg.appendChild(el('line', { x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v), stroke: GRID, 'stroke-width': 1 }));
    const t = el('text', { x: pad.left - 10, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = fmt(v);
    svg.appendChild(t);
  }

  data.forEach((d, i) => {
    const value = Number(d[key]) || 0;
    const cx = pad.left + band * i + band / 2;
    const top = y(value);
    const h = Math.max(0, pad.top + plotH - top);
    const r = Math.min(4, h / 2, barW / 2);

    // square at the baseline, 4px rounded at the data end
    const path = h <= 0 ? '' :
      `M${cx - barW / 2},${pad.top + plotH} V${top + r} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} V${pad.top + plotH} Z`;
    if (path) svg.appendChild(el('path', { d: path, fill: color }));

    const hit = el('rect', {
      x: cx - band / 2, y: pad.top, width: band, height: plotH, fill: 'transparent', tabindex: 0,
      role: 'img', 'aria-label': `${shortDate(d[opts.x])}: ${fmt(value)}`
    });
    const show = (e) => {
      const box = e.target.getBoundingClientRect();
      showTip(e.clientX || box.left + box.width / 2, e.clientY || box.top, {
        title: shortDate(d[opts.x]),
        rows: [{ label: opts.label || 'Orders', value: fmt(value), color }]
      });
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', hideTip);
    hit.addEventListener('blur', hideTip);
    svg.appendChild(hit);
  });

  [0, data.length - 1].filter((v, i, a) => a.indexOf(v) === i).forEach((i) => {
    const t = el('text', {
      x: pad.left + band * i + band / 2, y: H - 8,
      'text-anchor': i === 0 ? 'start' : 'end', class: 'axis-text'
    });
    t.textContent = shortDate(data[i][opts.x]);
    svg.appendChild(t);
  });

  host.appendChild(svg);
  tableView(host, [opts.xLabel || 'Date', opts.label || 'Value'],
    data.map((d) => [shortDate(d[opts.x]), fmt(d[key])]));
}

/* ================================================================== */
/* Donut — part to whole, ≤ 6 segments                                 */
/* ================================================================== */

export function donutChart(target, slices, opts = {}) {
  const host = mount(target);
  if (!host) return;
  const rows = slices.filter((s) => Number(s.value) > 0);
  if (!rows.length) return emptyNote(host, 'No data in this period yet.');

  const fmt = opts.format || compact;
  const total = rows.reduce((s, r) => s + Number(r.value), 0);
  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = 88;
  const rInner = 56;
  const GAP = 2; // surface gap, in px along the arc

  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, class: 'chart-donut', role: 'img', 'aria-label': opts.ariaLabel || 'Proportion chart' });

  let angle = -Math.PI / 2;
  rows.forEach((row, i) => {
    const frac = Number(row.value) / total;
    const sweep = frac * Math.PI * 2;
    const gapAngle = Math.min(GAP / rOuter, sweep / 3);
    const a0 = angle + gapAngle / 2;
    const a1 = angle + sweep - gapAngle / 2;
    angle += sweep;

    const color = row.color || PALETTE[i % PALETTE.length];
    const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = `M${p(rOuter, a0)} A${rOuter},${rOuter} 0 ${large} 1 ${p(rOuter, a1)} L${p(rInner, a1)} A${rInner},${rInner} 0 ${large} 0 ${p(rInner, a0)} Z`;

    const arc = el('path', { d, fill: color, tabindex: 0, class: 'donut-arc', role: 'img', 'aria-label': `${row.label}: ${fmt(row.value)}` });
    const show = (e) => {
      const box = e.target.getBoundingClientRect();
      showTip(e.clientX || box.left + box.width / 2, e.clientY || box.top, {
        title: row.label,
        rows: [{ label: `${(frac * 100).toFixed(1)}% of total`, value: fmt(row.value), color }]
      });
    };
    arc.addEventListener('pointerenter', show);
    arc.addEventListener('focus', show);
    arc.addEventListener('pointerleave', hideTip);
    arc.addEventListener('blur', hideTip);
    svg.appendChild(arc);
  });

  const centreValue = el('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'donut-centre' });
  centreValue.textContent = opts.centreValue ?? fmt(total);
  const centreLabel = el('text', { x: cx, y: cy + 18, 'text-anchor': 'middle', class: 'donut-caption' });
  centreLabel.textContent = opts.centreLabel || 'total';
  svg.append(centreValue, centreLabel);

  const wrapper = document.createElement('div');
  wrapper.className = 'donut-wrap';
  wrapper.appendChild(svg);

  // Legend doubles as the direct-label channel: name, value, share.
  const list = document.createElement('div');
  list.className = 'donut-legend';
  rows.forEach((row, i) => {
    const item = document.createElement('div');
    item.className = 'donut-legend-row';
    const key = document.createElement('span');
    key.className = 'legend-swatch';
    key.style.background = row.color || PALETTE[i % PALETTE.length];
    const name = document.createElement('span');
    name.className = 'dl-name';
    name.textContent = row.label;
    const value = document.createElement('span');
    value.className = 'dl-value';
    value.textContent = `${fmt(row.value)} · ${Math.round((row.value / total) * 100)}%`;
    item.append(key, name, value);
    list.appendChild(item);
  });
  wrapper.appendChild(list);
  host.appendChild(wrapper);

  tableView(host, [opts.nameLabel || 'Category', opts.valueLabel || 'Value', 'Share'],
    rows.map((r) => [r.label, fmt(r.value), `${Math.round((r.value / total) * 100)}%`]));
}

/* ================================================================== */
/* Horizontal bars — ranked categories, one colour                     */
/* ================================================================== */

export function barChart(target, rows, opts = {}) {
  const host = mount(target);
  if (!host) return;
  if (!rows.length) return emptyNote(host, 'No sales in this period yet.');

  const fmt = opts.format || compact;
  const color = opts.color || PALETTE[0];
  const max = Math.max(...rows.map((r) => Number(r.value) || 0), 1);

  const list = document.createElement('div');
  list.className = 'hbar-list';

  rows.forEach((row) => {
    const item = document.createElement('div');
    item.className = 'hbar-row';
    item.tabIndex = 0;

    const name = document.createElement('span');
    name.className = 'hbar-name';
    name.textContent = row.label;

    const track = document.createElement('span');
    track.className = 'hbar-track';
    const fill = document.createElement('span');
    fill.className = 'hbar-fill';
    fill.style.background = color;
    fill.style.width = `${Math.max(2, (Number(row.value) / max) * 100)}%`;
    track.appendChild(fill);

    const value = document.createElement('span');
    value.className = 'hbar-value';
    value.textContent = fmt(row.value);

    item.append(name, track, value);

    const show = (e) => {
      const box = item.getBoundingClientRect();
      showTip(e.clientX || box.left + 80, e.clientY || box.top, {
        title: row.label,
        rows: [
          { label: opts.valueLabel || 'Revenue', value: fmt(row.value), color },
          ...(row.sub ? [{ label: row.subLabel || 'Units', value: row.sub }] : [])
        ]
      });
    };
    item.addEventListener('pointerenter', show);
    item.addEventListener('focus', show);
    item.addEventListener('pointerleave', hideTip);
    item.addEventListener('blur', hideTip);

    list.appendChild(item);
  });

  host.appendChild(list);
  tableView(host, [opts.nameLabel || 'Name', opts.valueLabel || 'Value'],
    rows.map((r) => [r.label, fmt(r.value)]));
}

/* ================================================================== */
/* Funnel — ordered stages on the ordinal ramp                         */
/* ================================================================== */

export function funnelChart(target, steps, opts = {}) {
  const host = mount(target);
  if (!host) return;
  const top = Number(steps[0]?.value) || 0;
  if (!top) return emptyNote(host, 'No visitor activity recorded yet.');

  const list = document.createElement('div');
  list.className = 'funnel';

  steps.forEach((s, i) => {
    const value = Number(s.value) || 0;
    const share = (value / top) * 100;
    const prev = i > 0 ? Number(steps[i - 1].value) || 0 : value;
    const color = ORDINAL[Math.min(i, ORDINAL.length - 1)];

    const row = document.createElement('div');
    row.className = 'funnel-row';
    row.tabIndex = 0;

    const head = document.createElement('div');
    head.className = 'funnel-head';
    const label = document.createElement('span');
    label.textContent = s.step;
    const val = document.createElement('strong');
    val.textContent = compact(value);
    head.append(label, val);

    const track = document.createElement('div');
    track.className = 'funnel-track';
    const fill = document.createElement('div');
    fill.className = 'funnel-fill';
    fill.style.width = `${Math.max(1.5, share)}%`;
    fill.style.background = color;
    track.appendChild(fill);

    const meta = document.createElement('div');
    meta.className = 'funnel-meta';
    meta.textContent = i === 0
      ? '100% of visitors'
      : `${share.toFixed(1)}% of visitors · ${prev ? ((value / prev) * 100).toFixed(0) : 0}% of previous step`;

    row.append(head, track, meta);

    const show = (e) => {
      const box = row.getBoundingClientRect();
      showTip(e.clientX || box.left + 80, e.clientY || box.top, {
        title: s.step,
        rows: [
          { label: 'people', value: compact(value), color },
          { label: 'of all visitors', value: `${share.toFixed(1)}%` }
        ]
      });
    };
    row.addEventListener('pointerenter', show);
    row.addEventListener('focus', show);
    row.addEventListener('pointerleave', hideTip);
    row.addEventListener('blur', hideTip);

    list.appendChild(row);
  });

  host.appendChild(list);
  tableView(host, ['Step', 'People', 'Share of visitors'],
    steps.map((s) => [s.step, compact(s.value), `${((s.value / top) * 100).toFixed(1)}%`]));
}

/* ================================================================== */
/* Heatmap — weekday × hour, single-hue magnitude                      */
/* ================================================================== */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function heatmap(target, cells, opts = {}) {
  const host = mount(target);
  if (!host) return;
  if (!cells.length) return emptyNote(host, 'Not enough orders yet to see a pattern.');

  // Collapse 24 hours into 3-hour blocks so cells stay big enough to hit.
  const blocks = 8;
  const grid = Array.from({ length: 7 }, () => Array(blocks).fill(0));
  for (const c of cells) grid[c.dow % 7][Math.floor(c.hour / 3) % blocks] += c.n;
  const max = Math.max(...grid.flat(), 1);

  const table = document.createElement('div');
  table.className = 'heat';

  const corner = document.createElement('span');
  corner.className = 'heat-corner';
  table.appendChild(corner);
  for (let b = 0; b < blocks; b++) {
    const h = document.createElement('span');
    h.className = 'heat-col-label';
    h.textContent = `${String(b * 3).padStart(2, '0')}`;
    table.appendChild(h);
  }

  grid.forEach((row, d) => {
    const label = document.createElement('span');
    label.className = 'heat-row-label';
    label.textContent = DOW[d];
    table.appendChild(label);

    row.forEach((n, b) => {
      const cell = document.createElement('span');
      cell.className = 'heat-cell';
      cell.tabIndex = 0;
      const intensity = n === 0 ? 0 : Math.ceil((n / max) * (SEQ.length - 1));
      cell.style.background = n === 0 ? '#F7F0EC' : SEQ[intensity];
      cell.setAttribute('aria-label', `${DOW[d]} ${b * 3}:00 — ${n} orders`);

      const show = (e) => {
        const box = cell.getBoundingClientRect();
        showTip(e.clientX || box.left, e.clientY || box.top, {
          title: `${DOW[d]}, ${String(b * 3).padStart(2, '0')}:00–${String(b * 3 + 2).padStart(2, '0')}:59`,
          rows: [{ label: 'orders', value: String(n), color: n === 0 ? GRID : SEQ[intensity] }]
        });
      };
      cell.addEventListener('pointerenter', show);
      cell.addEventListener('focus', show);
      cell.addEventListener('pointerleave', hideTip);
      cell.addEventListener('blur', hideTip);
      table.appendChild(cell);
    });
  });

  host.appendChild(table);

  const scale = document.createElement('div');
  scale.className = 'heat-scale';
  const low = document.createElement('span');
  low.textContent = 'Quieter';
  const ramp = document.createElement('span');
  ramp.className = 'heat-ramp';
  SEQ.forEach((c) => {
    const s = document.createElement('i');
    s.style.background = c;
    ramp.appendChild(s);
  });
  const high = document.createElement('span');
  high.textContent = `Busier (${max})`;
  scale.append(low, ramp, high);
  host.appendChild(scale);

  tableView(host, ['Day', ...Array.from({ length: blocks }, (_, b) => `${b * 3}:00`)],
    grid.map((row, d) => [DOW[d], ...row.map(String)]));
}

/* ================================================================== */
/* Sparkline — the trend inside a stat tile                            */
/* ================================================================== */

export function sparkline(values, { width = 108, height = 30, color = PALETTE[0] } = {}) {
  const nums = values.map((v) => Number(v) || 0);
  if (nums.length < 2) return '';
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || 1;
  const pts = nums.map((v, i) => [
    (i / (nums.length - 1)) * (width - 4) + 2,
    height - 3 - ((v - min) / span) * (height - 8)
  ]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const last = pts.at(-1);
  return `<svg viewBox="0 0 ${width} ${height}" class="spark" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>
  </svg>`;
}

/* ================================================================== */
/* Meter — a single bounded value (stock level, target progress)       */
/* ================================================================== */

export function meter(value, max, { color = PALETTE[0], track = '#F6E4EB' } = {}) {
  const share = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return `<span class="meter" style="background:${track}">
    <span class="meter-fill" style="width:${share.toFixed(1)}%;background:${color}"></span>
  </span>`;
}

/**
 * Procedural pipe-cleaner bouquet illustrator.
 *
 * Pure ES module with no DOM access, so the browser and the Node server can
 * both import it — the storefront draws product cards with it, and the server
 * uses it for the /img/bouquet.svg endpoint.
 */

export const PALETTES = {
  rose:   { label: 'Rose',    colors: ['#E39AB6', '#F2C9D9', '#C3728F'] },
  sunset: { label: 'Sunset',  colors: ['#EFC98A', '#E39AB6', '#E8975C'] },
  lilac:  { label: 'Lilac',   colors: ['#C9B7DE', '#E9D6E8', '#A78BC4'] },
  cream:  { label: 'Cream',   colors: ['#F6E3C0', '#F3E3D8', '#E8975C'] },
  berry:  { label: 'Berry',   colors: ['#B4587A', '#E39AB6', '#7A3A54'] },
  sage:   { label: 'Sage',    colors: ['#A8C3A0', '#D7E6D2', '#77996E'] },
  sky:    { label: 'Sky',     colors: ['#9BBFD9', '#D3E5F0', '#6D97B5'] },
  sunny:  { label: 'Sunny',   colors: ['#F2CF6B', '#F7E4A8', '#D9A93F'] }
};

export const paletteColors = (name) => (PALETTES[name] || PALETTES.rose).colors;

/** Deterministic PRNG so a given seed always draws the same bouquet. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function flowerHead(fx, fy, scale, rot, color, petals, rand) {
  let paths = '';
  const wobble = 0.85 + rand() * 0.3;
  for (let p = 0; p < petals; p++) {
    const angle = (360 / petals) * p + rand() * 4 - 2;
    paths += `<path transform="rotate(${angle.toFixed(1)} 0 0)" ` +
      `d="M0,0 C -11,-9 -12,${(-25 * wobble).toFixed(1)} 0,${(-32 * wobble).toFixed(1)} ` +
      `C 12,${(-25 * wobble).toFixed(1)} 11,-9 0,0 Z" ` +
      `fill="none" stroke="${color}" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<g transform="translate(${fx.toFixed(1)} ${fy.toFixed(1)}) rotate(${rot.toFixed(1)}) scale(${scale.toFixed(2)})">
    ${paths}
    <circle r="7" fill="#EFC98A"/>
    <circle r="7" fill="none" stroke="#E0B269" stroke-width="1.4" stroke-dasharray="2 2"/>
  </g>`;
}

/**
 * @returns {string} SVG inner markup sized for a `0 0 width height` viewBox.
 */
export function bouquetSVG(seed, palette, count, width = 240, height = 240) {
  const rand = mulberry32(Number(seed) || 1);
  const colors = Array.isArray(palette) ? palette : paletteColors(palette);
  const n = Math.max(1, Math.min(9, Number(count) || 4));
  const cx = width / 2;
  const baseY = height * 0.92;

  const flowers = [];
  for (let i = 0; i < n; i++) {
    const spread = (i - (n - 1) / 2) * (width * 0.15);
    flowers.push({
      fx: cx + spread + (rand() - 0.5) * 14,
      fy: height * 0.34 + Math.abs(spread) * 0.28 + (rand() - 0.5) * 10,
      scale: 0.72 + rand() * 0.5 - Math.min(Math.abs(spread) / width, 0.25),
      rot: (rand() - 0.5) * 22,
      color: colors[Math.floor(rand() * colors.length)],
      petals: rand() > 0.75 ? 5 : 6
    });
  }
  flowers.sort((a, b) => a.fy - b.fy);

  let stems = '';
  let heads = '';
  flowers.forEach((f, idx) => {
    const midX = cx + (f.fx - cx) * 0.45;
    const midY = baseY - (baseY - f.fy) * 0.55 + (rand() - 0.5) * 20;
    stems += `<path d="M ${cx} ${baseY} Q ${midX.toFixed(1)} ${midY.toFixed(1)} ${f.fx.toFixed(1)} ${(f.fy + 18 * f.scale).toFixed(1)}" fill="none" stroke="#8FB088" stroke-width="7" stroke-linecap="round" opacity="0.9"/>`;
    if (idx % 2 === 0) {
      const lx = cx + (f.fx - cx) * 0.6;
      const ly = baseY - (baseY - f.fy) * 0.35;
      stems += `<path d="M ${lx.toFixed(1)} ${ly.toFixed(1)} q 22 -6 30 -26 q -26 4 -30 26 Z" fill="#9DC095" opacity="0.85"/>`;
    }
    heads += flowerHead(f.fx, f.fy, f.scale, f.rot, f.color, f.petals, rand);
  });

  const wrap =
    `<path d="M ${cx - 58} ${baseY - 6} L ${cx + 58} ${baseY - 6} L ${cx + 34} ${height} L ${cx - 34} ${height} Z" fill="#FBF3EF" stroke="#E8D8CE" stroke-width="2"/>` +
    `<path d="M ${cx - 58} ${baseY - 6} L ${cx + 58} ${baseY - 6} L ${cx + 48} ${baseY + 18} L ${cx - 48} ${baseY + 18} Z" fill="#F2C9D9" opacity="0.55"/>`;

  return stems + wrap + heads;
}

/** Full standalone `<svg>` document — used by the server image endpoint. */
export function bouquetDocument(seed, palette, count, size = 480) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" fill="#FBF3EF"/>` +
    bouquetSVG(seed, palette, count, size, size) +
    `</svg>`;
}

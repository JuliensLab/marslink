// simThumbs.js — top-down, links-only thumbnails of the solar system, captured
// at measurement time: one image colored by CAPACITY, one by FLOW (when a flow
// solve ran). No satellites are drawn — links, faint orbit guides, Sun, and the
// two planets — so the picture reads as the topology itself, the visual sanity
// check for every archived measurement (off-center arcs, single-sided feeding,
// unused corridors are all visible at a glance).
//
// Split in two so both execution paths share one implementation:
//   linksToThumbData(links, posOf, planets)  — DOM-free geometry extraction;
//     runs in the WORKER for scenario runs (positions only exist there) and on
//     the main thread for live captures. Output is a compact flat array.
//   renderThumbDataURL(thumbData, mode)      — main-thread canvas render to a
//     compressed dataURL (WebP, JPEG fallback), ~15–40 KB per image.
//
// Thumbnails are stored on the archive entries (IndexedDB has room) but are
// STRIPPED from the copy-paste JSON export — images leave via the archive UI,
// not the clipboard.

import { positionFromSolarAngle } from "./simOrbits.js?v=5.53";

/**
 * Compact geometry for the two thumbnails: per link [x1,y1,x2,y2,capMbps,flowMbps]
 * flattened into one numeric array (ecliptic-plane AU; the top-down view is the
 * (x, y) projection). Links above MAXSEG are stride-sampled — the stride is
 * recorded and printed on the image so a thinned picture is never mistaken for
 * a complete one.
 *
 * @param {Array}    links   link objects {fromId, toId, gbpsCapacity, gbpsFlow}
 * @param {Function} posOf   id → {x, y} | undefined (sim-space AU)
 * @param {Array}    planets planet objects with {name, position}
 */
export function linksToThumbData(links, posOf, planets) {
  if (!Array.isArray(links) || !links.length) return null;
  const MAXSEG = 150000;
  const stride = Math.max(1, Math.ceil(links.length / MAXSEG));
  const seg = [];
  for (let i = 0; i < links.length; i += stride) {
    const l = links[i];
    const a = posOf(l.fromId), b = posOf(l.toId);
    if (!a || !b) continue;
    seg.push(a.x, a.y, b.x, b.y, (l.gbpsCapacity || 0) * 1000, (l.gbpsFlow || 0) * 1000);
  }
  if (!seg.length) return null;
  const P = (name) => {
    const p = (planets || []).find((q) => q && q.name === name)?.position;
    return p ? [p.x, p.y] : null;
  };
  return { seg, earth: P("Earth"), mars: P("Mars"), stride, orbits: orbitGuides(planets) };
}

/**
 * True orbit polylines for the Earth/Mars guides — the planets' actual ellipses
 * (from their orbital elements, which ride the planet objects), not the e = 0
 * circles the renderer previously drew at the semi-major axes. Flat [x0,y0,x1,y1…]
 * per planet, ~3 significant digits; absent (renderer falls back to circles)
 * when the elements are missing.
 */
export function orbitGuides(planets) {
  const out = {};
  for (const p of planets || []) {
    if (!p || (p.name !== "Earth" && p.name !== "Mars")) continue;
    if (!(p.a > 0) || p.e === undefined) continue;
    const pts = [];
    for (let ang = 0; ang <= 360; ang += 4) {
      const q = positionFromSolarAngle(p, ang);
      if (q && Number.isFinite(q.x) && Number.isFinite(q.y)) pts.push(Math.round(q.x * 1000) / 1000, Math.round(q.y * 1000) / 1000);
    }
    if (pts.length >= 8) out[p.name === "Earth" ? "earth" : "mars"] = pts;
  }
  return (out.earth || out.mars) ? out : undefined;
}

/**
 * Render one thumbnail from thumbData. mode "capacity" colors every link by its
 * capacity; mode "flow" draws only links carrying flow, colored by flow. The
 * color scale is normalized at the 95th percentile of the drawn value (printed
 * on the image), blue → red. Main thread only (uses a DOM canvas).
 */
export function renderThumbDataURL(td, mode, size = 480) {
  if (!td || !Array.isArray(td.seg) || !td.seg.length) return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0b0f1a";
  ctx.fillRect(0, 0, size, size);
  const R = 1.8; // view half-extent in AU (Mars aphelion ≈ 1.67)
  const s = size / (2 * R);
  const X = (x) => size / 2 + x * s;
  const Y = (y) => size / 2 - y * s;

  // Faint orbit guides — the TRUE Earth/Mars ellipses when the capture recorded
  // them (td.orbits), else the legacy e = 0 circles at the semi-major axes.
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  if (td.orbits && (td.orbits.earth || td.orbits.mars)) {
    for (const key of ["earth", "mars"]) {
      const pts = td.orbits[key];
      if (!pts || pts.length < 8) continue;
      ctx.beginPath();
      ctx.moveTo(X(pts[0]), Y(pts[1]));
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(X(pts[i]), Y(pts[i + 1]));
      ctx.closePath();
      ctx.stroke();
    }
  } else {
    for (const r of [1.0, 1.524]) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, r * s, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }

  const seg = td.seg;
  const vi = mode === "flow" ? 5 : 4;
  // Scale: 95th percentile of the drawn (positive) values.
  const vals = [];
  for (let i = 0; i < seg.length; i += 6) {
    const v = seg[i + vi];
    if (v > 0) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const vmax = vals.length ? (vals[Math.floor(vals.length * 0.95)] || vals[vals.length - 1]) : 1;

  // Bucket links into hue bins (one stroked path per bin — 10× faster than
  // per-link strokes at 10⁵ links).
  const BINS = 24;
  const paths = Array.from({ length: BINS + 1 }, () => new Path2D());
  let drawn = 0;
  for (let i = 0; i < seg.length; i += 6) {
    const v = seg[i + vi];
    if (mode === "flow" && !(v > 0)) continue; // unused links invisible in the flow view
    const u = Math.max(0, Math.min(1, v / vmax));
    const p = paths[Math.round(u * BINS)];
    p.moveTo(X(seg[i]), Y(seg[i + 1]));
    p.lineTo(X(seg[i + 2]), Y(seg[i + 3]));
    drawn++;
  }
  ctx.lineWidth = 1;
  ctx.globalAlpha = mode === "flow" ? 0.75 : 0.4;
  for (let b = 0; b <= BINS; b++) {
    ctx.strokeStyle = `hsl(${Math.round(240 - (240 * b) / BINS)}, 85%, 55%)`;
    ctx.stroke(paths[b]);
  }
  ctx.globalAlpha = 1;

  // Sun + planets — deliberately no satellites.
  const dot = (xy, r, c) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(X(xy[0]), Y(xy[1]), r, 0, 2 * Math.PI);
    ctx.fill();
  };
  dot([0, 0], 4, "#ffd76b");
  if (td.earth) dot(td.earth, 5, "#4a90e2");
  if (td.mars) dot(td.mars, 4.5, "#dd4a2a");

  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "12px ui-monospace, monospace";
  const fmt = vmax >= 1000 ? (vmax / 1000).toFixed(1) + " Gbps" : Math.round(vmax) + " Mbps";
  ctx.fillText(
    `${mode === "flow" ? "flow" : "capacity"} · scale max ≈ ${fmt}` +
    `${td.stride > 1 ? ` · 1/${td.stride} links` : ""}${mode === "flow" ? ` · ${drawn} carrying` : ""}`,
    8, size - 10
  );

  let url = canvas.toDataURL("image/webp", 0.8);
  if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", 0.8);
  return url;
}

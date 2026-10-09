// ASH Draw Studio - SVG export (pure ES module, no DOM).
//
//   const svg = exportSvg(doc, { background: '#ffffff', unitsPerMm: 1 });
//
// Also holds the scene helpers shared with exportPdf.js (path walking, colours, lineweights, dashes,
// hatch pattern lines, text layout).
import { buildScene } from './render.js';
import { aciToRgb } from './aci.js';
import { layoutMText, approxMeasure } from './mtext.js';

const TAU = Math.PI * 2;
const OP_M = 0, OP_L = 1, OP_A = 2, OP_E = 3, OP_Z = 4;
export const DEFAULT_LW_MM = 0.25;
const MAX_HATCH_LINES = 4000;

// ---------------------------------------------------------------------------------------------
// shared helpers

/**
 * Walk scene path ops, calling sink.moveTo(x,y), sink.lineTo(x,y), sink.close(),
 * sink.arc(cx,cy,rx,ry,rot,t0,sweep) (elliptical arc by parameter, world coords, Y up).
 * Like Canvas2D, an arc whose start is away from the current point is joined to it with a line.
 */
export function walkOps(ops, sink) {
  let cur = null, start = null;
  const join = (x, y) => {
    if (!cur) { sink.moveTo(x, y); start = { x, y }; } else if (Math.hypot(x - cur.x, y - cur.y) > 1e-9 * (1 + Math.abs(x) + Math.abs(y))) sink.lineTo(x, y);
  };
  const arc = (cx, cy, rx, ry, rot, t0, sw) => {
    const c = Math.cos(rot), s = Math.sin(rot);
    const pt = (t) => ({ x: cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, y: cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c });
    const p0 = pt(t0), p1 = pt(t0 + sw);
    join(p0.x, p0.y);
    if (rx > 0 && ry > 0 && sw !== 0) sink.arc(cx, cy, rx, ry, rot, t0, sw, p0, p1);
    else if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > 0) sink.lineTo(p1.x, p1.y);
    cur = p1;
  };
  for (let i = 0; i < ops.length;) {
    switch (ops[i]) {
      case OP_M: cur = start = { x: ops[i + 1], y: ops[i + 2] }; sink.moveTo(cur.x, cur.y); i += 3; break;
      case OP_L:
        if (!cur) { start = { x: ops[i + 1], y: ops[i + 2] }; sink.moveTo(start.x, start.y); } else sink.lineTo(ops[i + 1], ops[i + 2]);
        cur = { x: ops[i + 1], y: ops[i + 2] }; i += 3; break;
      case OP_A: arc(ops[i + 1], ops[i + 2], ops[i + 3], ops[i + 3], 0, ops[i + 4], ops[i + 5]); i += 6; break;
      case OP_E: arc(ops[i + 1], ops[i + 2], ops[i + 3], ops[i + 4], ops[i + 5], ops[i + 6], ops[i + 7]); i += 8; break;
      case OP_Z: sink.close(); cur = start; i += 1; break;
      default: throw new Error(`bad path op ${ops[i]}`);
    }
  }
}

/** item colour as [r,g,b] 0..255; `auto` colours contrast with the background (black on white / no background) */
export function colorRgb(style, { monochrome = false, darkBackground = false } = {}) {
  if (monochrome) return [0, 0, 0];
  const c = style && style.color;
  if (!c || c.auto || !c.rgb) return darkBackground ? [255, 255, 255] : [0, 0, 0];
  return c.rgb;
}

/** colour of an MTEXT run (null = the item's colour) as [r,g,b]; ACI 7 contrasts with the background */
export function runRgb(c, style, colOpts = {}) {
  if (colOpts.monochrome || !c) return colorRgb(style, colOpts);
  if (c.rgb) return c.rgb;
  if (c.aci === 7) return colOpts.darkBackground ? [255, 255, 255] : [0, 0, 0];
  return aciToRgb(c.aci);
}

/** MTEXT layout of a scene item (local frame: origin at item.p, y down, drawing units); a fixed it.lay (SHX runs) first */
export const mtextItemLayout = (it, measure = approxMeasure) => it.lay ?? layoutMText(it.mt, { width: it.boxW, attach: it.attach, lineSpacing: it.lineSpacing, measure });

/** plotted lineweight in mm; negative (default/ByLayer/ByBlock left over) = 0.25 mm */
export function lineweightMm(style, lineweights = true) {
  const lw = style ? style.lw : -3;
  if (!lineweights || !(lw >= 0)) return DEFAULT_LW_MM;
  return lw;
}

/** linetype dash pattern in drawing units (dot = 0), even length; null = continuous */
export function dashUnits(doc, style) {
  const name = String(style?.lt ?? 'CONTINUOUS').toUpperCase();
  if (name === 'CONTINUOUS' || name === 'BYLAYER' || name === 'BYBLOCK') return null;
  const def = doc.linetypes && doc.linetypes.get(name);
  if (!def || !def.pattern || !def.pattern.length) return null;
  const k = style.lts || 1;
  const arr = def.pattern.map((d) => Math.abs(d) * k);
  if (!(arr.reduce((a, b) => a + b, 0) > 0)) return null;
  return arr.length % 2 ? [...arr, ...arr] : arr;
}

/**
 * Pattern hatch line segments (world coords) covering the hatch bbox, ready to be clipped by the boundary.
 * Returns [{segs:[[x0,y0,x1,y1],...], dashes:[...]|null}] or null when a family is too dense to draw.
 */
export function hatchFamilies(it) {
  const b = it.bbox;
  if (!b || !it.lines) return [];
  const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2, R = Math.hypot(b.maxx - b.minx, b.maxy - b.miny) / 2 + 1e-9;
  const out = [];
  for (const L of it.lines) {
    const a = L.angle * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    const spacing = L.offset.x * nx + L.offset.y * ny;
    if (Math.abs(spacing) < 1e-12) continue;
    // family member k passes through base + k*offset; keep the members whose distance from the bbox centre is <= R
    const d0 = (cx - L.base.x) * nx + (cy - L.base.y) * ny;
    const k0 = Math.floor((d0 - R) / spacing), k1 = Math.ceil((d0 + R) / spacing);
    const lo = Math.min(k0, k1) - 1, hi = Math.max(k0, k1) + 1;
    if (hi - lo > MAX_HATCH_LINES) return null;
    const dashes = L.dashes && L.dashes.length ? L.dashes.map((d) => Math.abs(d)) : null;
    const period = dashes ? dashes.reduce((s, d) => s + d, 0) : 0;
    const segs = [];
    for (let k = lo; k <= hi; k++) {
      const ox = L.base.x + k * L.offset.x, oy = L.base.y + k * L.offset.y;
      const t0 = (cx - ox) * dx + (cy - oy) * dy;
      // start on a whole dash period from the line's origin so the dash phase matches the pattern definition
      let ta = t0 - R;
      if (period > 0) ta = Math.floor(ta / period) * period;
      const tb = t0 + R;
      segs.push([ox + dx * ta, oy + dy * ta, ox + dx * tb, oy + dy * tb]);
    }
    out.push({ segs, dashes: dashes && period > 0 ? (dashes.length % 2 ? [...dashes, ...dashes] : dashes) : null });
  }
  return out;
}

/**
 * Text layout in the text's local frame (origin at item.p, x along the baseline before width factor,
 * y DOWN, in drawing units). measure(str) -> width in drawing units at height it.h (before width factor).
 * Mirrors drawText in render.js. Returns {anchor:'start'|'middle'|'end', lines:[{text, x, y, width}]}.
 */
export function layoutText(it, measure) {
  const h = it.h;
  const lineH = h * (it.mtext ? 1.25 : 1);
  let lines = it.lines.map((l) => l.replace(/\t/g, ' '));
  if (it.mtext && it.boxW > 0) lines = wrap(lines, it.boxW / (it.wf || 1), measure);
  const n = lines.length;
  let hAlign = it.hAlign, vOff;
  if (it.mtext) {
    const col = (it.attach - 1) % 3, row = Math.floor((it.attach - 1) / 3);
    hAlign = col;
    vOff = row === 0 ? h * 0.9 : row === 1 ? h * 0.9 - (n * lineH) / 2 : h * 0.9 - n * lineH + lineH * 0.9;
  } else {
    const v = it.vAlign; // 0 baseline, 1 bottom, 2 middle, 3 top
    vOff = v === 1 ? -h * 0.2 : v === 2 || hAlign === 4 ? h * 0.35 : v === 3 ? h * 0.8 : 0;
  }
  const anchor = hAlign === 1 || hAlign === 4 ? 'middle' : hAlign === 2 ? 'end' : 'start';
  return {
    anchor,
    lines: lines.map((text, i) => {
      const width = measure(text);
      const x = anchor === 'middle' ? -width / 2 : anchor === 'end' ? -width : 0;
      return { text, x, y: vOff + i * lineH, width };
    }),
  };
}

function wrap(lines, maxW, measure) {
  const out = [];
  for (const line of lines) {
    if (measure(line) <= maxW) { out.push(line); continue; }
    let cur = '';
    for (const word of line.split(' ')) {
      const t = cur ? `${cur} ${word}` : word;
      if (measure(t) > maxW && cur) { out.push(cur); cur = word; } else cur = t;
    }
    out.push(cur);
  }
  return out;
}

/** size of leader arrowheads / point markers: scene bbox diagonal / 400 */
export function markerSize(bbox) {
  return bbox ? Math.hypot(bbox.maxx - bbox.minx, bbox.maxy - bbox.miny) / 400 || 1 : 1;
}

/** arrowhead triangle [tip, back-left, back-right] for arrow [from, to] (render.js proportions) */
export function arrowTriangle(arrow, size) {
  const [a, b] = arrow;
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
  return [
    { x: b.x, y: b.y },
    { x: b.x - ux * size - uy * size * 0.2, y: b.y - uy * size + ux * size * 0.2 },
    { x: b.x - ux * size + uy * size * 0.2, y: b.y - uy * size - ux * size * 0.2 },
  ];
}

// ---------------------------------------------------------------------------------------------
// SVG

const num = (n) => {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
};
// eslint-disable-next-line no-control-regex
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const xmlEscape = (s) => String(s).replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** SVG path data with the Y flip folded into the numbers (svg y = -world y) */
export function svgPathData(ops) {
  const d = [];
  const P = (x, y) => `${num(x)} ${num(-y)}`;
  walkOps(ops, {
    moveTo: (x, y) => d.push(`M${P(x, y)}`),
    lineTo: (x, y) => d.push(`L${P(x, y)}`),
    close: () => d.push('Z'),
    arc: (cx, cy, rx, ry, rot, t0, sw, p0, p1) => {
      // World sweeps are CCW-positive with Y up. After negating y, a CCW (positive) world sweep is a
      // negative-angle sweep in SVG's Y-down frame, i.e. sweep-flag 0; a negative world sweep is flag 1.
      // The ellipse's x-axis rotation flips sign for the same reason.
      const flag = sw > 0 ? 0 : 1, xrot = num(-rot * 180 / Math.PI), r = `${num(rx)} ${num(ry)} ${xrot}`;
      if (Math.abs(sw) >= TAU - 1e-9) {
        // a full turn has coincident endpoints, which SVG cannot express: two half arcs
        const c = Math.cos(rot), s = Math.sin(rot), t = t0 + sw / 2;
        const mx = cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, my = cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c;
        d.push(`A${r} 0 ${flag} ${P(mx, my)}`, `A${r} 0 ${flag} ${P(p1.x, p1.y)}`);
      } else {
        d.push(`A${r} ${Math.abs(sw) > Math.PI ? 1 : 0} ${flag} ${P(p1.x, p1.y)}`);
      }
    },
  });
  return d.join('');
}

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

const fontFamily = (font) => {
  const base = String(font || 'Arial').replace(/\.(ttf|otf|ttc|shx)$/i, '');
  return `'${base.replace(/['"\\]/g, '')}', Arial, sans-serif`;
};

/**
 * exportSvg(doc, opts) -> standalone SVG 1.1 document string.
 * opts: scene (prebuilt), background ('#ffffff' default | null = transparent), monochrome (false),
 * lineweights (true), unitsPerMm (drawing units per plotted millimetre; when given, width/height are in mm),
 * margin (fraction of the larger drawing dimension, 0.02).
 * Stroke width in SVG user units (= drawing units): max(lineweightMm, 0.18) * (unitsPerMm ?? 1);
 * default lineweight (-3) and lineweights:false use 0.25 mm.
 */
export function exportSvg(doc, opts = {}) {
  const scene = opts.scene || buildScene(doc);
  const { background = '#ffffff', monochrome = false, lineweights = true, margin = 0.02 } = opts;
  const upm = opts.unitsPerMm > 0 ? opts.unitsPerMm : 1;
  const bb = scene.bbox;
  const colOpts = { monochrome, darkBackground: background != null && luminance(background) < 0.5 };
  const rgb = (style) => `rgb(${colorRgb(style, colOpts).map((v) => Math.round(v)).join(',')})`;
  const strokeW = (style) => num(Math.max(lineweightMm(style, lineweights), 0.18) * upm);

  let vx = 0, vy = 0, vw = 1, vh = 1;
  if (bb) {
    const w = bb.maxx - bb.minx, h = bb.maxy - bb.miny;
    const m = (Math.max(w, h) || 1) * margin;
    vx = bb.minx - m; vy = -bb.maxy - m; vw = (w + 2 * m) || 1; vh = (h + 2 * m) || 1;
  }
  const size = opts.unitsPerMm > 0 ? ` width="${num(vw / upm)}mm" height="${num(vh / upm)}mm"` : ` width="${num(vw)}" height="${num(vh)}"`;
  const out = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1"${size} viewBox="${num(vx)} ${num(vy)} ${num(vw)} ${num(vh)}">`,
  ];
  if (background != null) out.push(`<rect x="${num(vx)}" y="${num(vy)}" width="${num(vw)}" height="${num(vh)}" fill="${xmlEscape(background)}"/>`);
  out.push('<g fill="none" stroke-linecap="round" stroke-linejoin="round">');

  const msize = markerSize(bb);
  // dots (0) stay zero-length dashes: with round caps they draw as dots
  const dashAttr = (arr) => (arr ? ` stroke-dasharray="${arr.map(num).join(',')}"` : '');
  let clipN = 0;

  // transparency: the item's opacity on its own element (a group for clipped hatches and text runs)
  const op = (st) => { const a = opts.transparency === false ? 1 : st.alpha ?? 1; return a < 1 ? ` opacity="${num(a)}"` : ''; };
  for (const it of scene.items) {
    const col = rgb(it.style), oa = op(it.style);
    if (it.kind === 'path') {
      const sw = strokeW(it.style);
      out.push(`<path d="${svgPathData(it.ops)}" stroke="${col}" stroke-width="${sw}"${dashAttr(dashUnits(doc, it.style))}${oa}/>`);
      if (it.arrow) {
        const t = arrowTriangle(it.arrow, msize);
        out.push(`<path d="M${t.map((p) => `${num(p.x)} ${num(-p.y)}`).join('L')}Z" fill="${col}" stroke="none"${oa}/>`);
      }
    } else if (it.kind === 'fill' || (it.kind === 'hatch' && it.solid)) {
      out.push(`<path d="${svgPathData(it.ops)}" fill="${col}" fill-rule="evenodd" stroke="none"${oa}/>`);
    } else if (it.kind === 'hatch') {
      const fams = hatchFamilies(it);
      const d = svgPathData(it.ops);
      if (fams === null) {
        out.push(`<path d="${d}" fill="${col}" fill-opacity="0.3" fill-rule="evenodd" stroke="none"${oa}/>`);
        continue;
      }
      const id = `hatch${++clipN}`;
      const sw = strokeW(it.style);
      out.push(`<clipPath id="${id}"><path d="${d}" clip-rule="evenodd"/></clipPath><g clip-path="url(#${id})" stroke="${col}" stroke-width="${sw}"${oa}>`);
      for (const f of fams) {
        const pd = f.segs.map((s) => `M${num(s[0])} ${num(-s[1])}L${num(s[2])} ${num(-s[3])}`).join('');
        if (pd) out.push(`<path d="${pd}"${dashAttr(f.dashes)}/>`);
      }
      out.push('</g>');
    } else if (it.kind === 'text' && it.mt) {
      // rich MTEXT: one <text> per glyph run, decorations (underline / overline / strike / fraction bar) as <line>
      const lay = mtextItemLayout(it);
      const deg = num(-it.rot * 180 / Math.PI);
      const rc = (c) => `rgb(${runRgb(c, it.style, colOpts).map((v) => Math.round(v)).join(',')})`;
      out.push(`<g transform="translate(${num(it.p.x)} ${num(-it.p.y)})${deg !== '0' ? ` rotate(${deg})` : ''}" stroke="none"${oa}>`);
      for (const g of lay.glyphs) {
        const tf = `translate(${num(g.x)} ${num(g.y)})${g.oblique ? ` skewX(${num(-g.oblique)})` : ''}${g.wf && g.wf !== 1 ? ` scale(${num(g.wf)} 1)` : ''}`;
        const attrs = `${g.bold ? ' font-weight="bold"' : ''}${g.italic ? ' font-style="italic"' : ''}${g.track && g.track !== 1 ? ` letter-spacing="${num((g.track - 1) * g.h * 0.6)}"` : ''}`;
        out.push(`<text transform="${tf}" font-family="${xmlEscape(fontFamily(g.font || it.font))}" font-size="${num(g.h)}"${attrs} fill="${rc(g.color)}" xml:space="preserve">${xmlEscape(g.text)}</text>`);
      }
      for (const r of lay.rules) out.push(`<line x1="${num(r.x1)}" y1="${num(r.y)}" x2="${num(r.x2)}" y2="${num(r.y)}" stroke="${rc(r.color)}" stroke-width="${num(r.h * 0.06)}"/>`);
      out.push('</g>');
    } else if (it.kind === 'text') {
      const lay = layoutText(it, (s) => s.length * it.h * 0.6);
      const deg = num(-it.rot * 180 / Math.PI);
      const tf = `translate(${num(it.p.x)} ${num(-it.p.y)})${deg !== '0' ? ` rotate(${deg})` : ''}${it.wf !== 1 ? ` scale(${num(it.wf)} 1)` : ''}`;
      const spans = lay.lines.map((l) => `<tspan x="0" y="${num(l.y)}">${xmlEscape(l.text)}</tspan>`).join('');
      out.push(`<text transform="${tf}" font-family="${xmlEscape(fontFamily(it.font))}" font-size="${num(it.h)}" text-anchor="${lay.anchor}" fill="${col}" stroke="none"${oa} xml:space="preserve">${spans}</text>`);
    } else if (it.kind === 'point') {
      const s = msize / 3, x = it.p.x, y = -it.p.y;
      out.push(`<path d="M${num(x - s)} ${num(y)}L${num(x + s)} ${num(y)}M${num(x)} ${num(y - s)}L${num(x)} ${num(y + s)}" stroke="${col}" stroke-width="${strokeW(it.style)}"${oa}/>`);
    }
  }
  out.push('</g>', '</svg>', '');
  return out.join('\n');
}

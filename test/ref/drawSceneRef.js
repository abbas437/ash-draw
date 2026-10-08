// Frozen copy of drawScene from main 77de0f5 (before the perf2 work): the reference for the pixel-parity test.
import { aciToRgb } from '../../src/core/aci.js';
import { DEG } from '../../src/core/geom.js';
import { mtextLayout, mtextFont } from '../../src/core/render.js';
const OP_M = 0, OP_L = 1, OP_A = 2, OP_E = 3, OP_Z = 4;
const rgbCss = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
const luminance = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

function dashFor(doc, style, zoom) {
  const name = String(style.lt ?? 'CONTINUOUS').toUpperCase();
  if (name === 'CONTINUOUS' || name === 'BYLAYER') return null;
  const def = doc.linetypes.get(name);
  if (!def || !def.pattern.length) return null;
  const k = style.lts * zoom;
  const period = def.pattern.reduce((a, b) => a + Math.abs(b), 0) * k;
  if (period < 2.5) return null;       // too small to be visible: draw solid
  const arr = def.pattern.map((d) => (d === 0 ? 1 : Math.max(Math.abs(d) * k, 0.5)));  // dots get a 1px mark
  return arr.length % 2 ? [...arr, ...arr] : arr;
}

export function drawSceneRef(ctx, scene, view, opts = {}) {
  const { width: W, height: H, zoom: z } = view;
  const bg = opts.background ?? '#1b1f23';
  const dark = luminance(bg) < 0.5;
  const doc = scene.doc;
  const dpr = opts.dpr ?? 1;
  if (opts.baseTransform) ctx.setTransform(opts.baseTransform); // drawLayout: viewport placement (clip, twist)
  else ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // view.width/height are CSS pixels
  if (!opts.noClear) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const sx = (x) => (x - view.cx) * z + W / 2;
  const sy = (y) => H / 2 - (y - view.cy) * z;
  const minx = view.cx - W / 2 / z, maxx = view.cx + W / 2 / z, miny = view.cy - H / 2 / z, maxy = view.cy + H / 2 / z;
  const visible = (it) => !it.bbox || !(it.bbox.maxx < minx || it.bbox.minx > maxx || it.bbox.maxy < miny || it.bbox.miny > maxy);
  const hi = opts.highlight instanceof Set ? opts.highlight : null;
  const colorOf = (st) => (st.color.auto ? (dark ? '#ffffff' : '#000000') : rgbCss(st.color.rgb));
  const lwPx = (st) => {
    if (!opts.showLineweight) return 1;
    const mm = st.lw >= 0 ? st.lw : 0.25;
    return Math.min(8, Math.max(1, mm * (opts.pixelsPerMm ?? 3.78)));
  };

  const tracePath = (ops) => {
    for (let i = 0; i < ops.length;) {
      const op = ops[i];
      if (op === OP_M) { ctx.moveTo(sx(ops[i + 1]), sy(ops[i + 2])); i += 3; }
      else if (op === OP_L) { ctx.lineTo(sx(ops[i + 1]), sy(ops[i + 2])); i += 3; }
      else if (op === OP_A) {
        const r = ops[i + 3] * z;
        const a0 = ops[i + 4], sw = ops[i + 5];
        if (r < 0.01) { i += 6; continue; }
        ctx.arc(sx(ops[i + 1]), sy(ops[i + 2]), r, -a0, -(a0 + sw), sw > 0);
        i += 6;
      } else if (op === OP_E) {
        const rx = ops[i + 3] * z, ry = ops[i + 4] * z;
        if (rx < 0.01) { i += 8; continue; }
        const t0 = ops[i + 6], sw = ops[i + 7];
        ctx.ellipse(sx(ops[i + 1]), sy(ops[i + 2]), rx, Math.max(ry, 0.01), -ops[i + 5], -t0, -(t0 + sw), sw > 0);
        i += 8;
      } else if (op === OP_Z) { ctx.closePath(); i += 1; } else break;
    }
  };

  // 1. hatches and solid fills
  const fillAlphaPattern = opts.patternFallbackAlpha ?? 0.25;
  for (const it of scene.items) {
    if (it.kind !== 'hatch' && it.kind !== 'fill') continue;
    if (!visible(it)) continue;
    const col = colorOf(it.style);
    if (it.kind === 'fill' || it.solid) {
      ctx.beginPath(); tracePath(it.ops);
      ctx.fillStyle = col; ctx.fill('evenodd');
    } else if (it.lines) {
      drawPatternHatch(ctx, it, view, col, tracePath, sx, sy, fillAlphaPattern);
    } else {
      ctx.beginPath(); tracePath(it.ops); ctx.save(); ctx.globalAlpha = fillAlphaPattern; ctx.fillStyle = col; ctx.fill('evenodd'); ctx.restore();
    }
  }

  // 2. line work, batched by style
  const batches = new Map();
  for (const it of scene.items) {
    if (it.kind !== 'path' && it.kind !== 'hatchOutline') continue;
    if (!visible(it)) continue;
    const st = it.style;
    const key = `${st.color.auto ? 'a' : st.color.rgb.join(',')}|${lwPx(st)}|${st.lt}|${st.lts}`;
    let b = batches.get(key);
    if (!b) batches.set(key, (b = { st, items: [] }));
    b.items.push(it);
  }
  for (const { st, items } of batches.values()) {
    ctx.beginPath();
    for (const it of items) tracePath(it.ops);
    ctx.strokeStyle = colorOf(st);
    ctx.lineWidth = lwPx(st);
    const dash = dashFor(doc, st, z);
    ctx.setLineDash(dash ?? []);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // leader arrow heads and points
  for (const it of scene.items) {
    if (!visible(it)) continue;
    if (it.arrow) {
      ctx.fillStyle = colorOf(it.style);
      const a = it.arrow[0], b = it.arrow[1];
      const dx = sx(b.x) - sx(a.x), dy = sy(b.y) - sy(a.y), l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l, size = 9;
      ctx.beginPath(); ctx.moveTo(sx(b.x), sy(b.y));
      ctx.lineTo(sx(b.x) - ux * size + uy * size * 0.2, sy(b.y) - uy * size - ux * size * 0.2);
      ctx.lineTo(sx(b.x) - ux * size - uy * size * 0.2, sy(b.y) - uy * size + ux * size * 0.2);
      ctx.closePath(); ctx.fill();
    } else if (it.kind === 'point') {
      const x = sx(it.p.x), y = sy(it.p.y);
      ctx.strokeStyle = colorOf(it.style); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); ctx.stroke();
    }
  }

  // 3. text
  for (const it of scene.items) {
    if (it.kind !== 'text' || !visible(it)) continue;
    if (it.mt) drawMText(ctx, it, sx(it.p.x), sy(it.p.y), z, colorOf(it.style), dark);
    else drawText(ctx, it, sx(it.p.x), sy(it.p.y), z, colorOf(it.style));
  }

  // 4. highlight / selection overlay
  if (hi && hi.size) {
    ctx.save();
    ctx.strokeStyle = opts.highlightColor ?? '#4dd2ff';
    ctx.fillStyle = opts.highlightColor ?? '#4dd2ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    for (const id of hi) {
      const list = scene.byId.get(id);
      if (!list) continue;
      for (const it of list) {
        if (it.kind === 'path' || it.kind === 'hatch' || it.kind === 'fill') { ctx.beginPath(); tracePath(it.ops); ctx.stroke(); }
        else if (it.kind === 'text' || it.kind === 'point') {
          const b = it.bbox;
          if (b) ctx.strokeRect(sx(b.minx) - 2, sy(b.maxy) - 2, (b.maxx - b.minx) * z + 4, (b.maxy - b.miny) * z + 4);
        }
      }
    }
    ctx.restore();
  }
}

function drawText(ctx, it, x, y, z, color) {
  const px = it.h * z;
  const lineH = px * (it.mtext ? 1.25 : 1);
  if (px < 2) {
    // too small to read: a thin bar the width of the text keeps the layout visible
    const w = Math.max(...it.lines.map((l) => l.length)) * px * 0.6 * it.wf;
    ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w * Math.cos(it.rot), y - w * Math.sin(it.rot)); ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-it.rot);
  ctx.scale(it.wf, 1);
  ctx.font = `${px}px "${it.font}", Arial, "Segoe UI", sans-serif`;
  ctx.fillStyle = color;
  let lines = it.lines;
  if (it.mtext && it.boxW > 0) lines = wrapLines(ctx, lines, it.boxW * z / it.wf);
  const n = lines.length;
  // MTEXT attachment: 1-3 top, 4-6 middle, 7-9 bottom ; left/centre/right = 1,2,3 mod 3
  let hAlign = it.hAlign, vOff = 0;
  if (it.mtext) {
    const col = ((it.attach - 1) % 3), row = Math.floor((it.attach - 1) / 3);
    hAlign = col === 0 ? 0 : col === 1 ? 1 : 2;
    ctx.textBaseline = 'alphabetic';
    vOff = row === 0 ? px * 0.9 : row === 1 ? px * 0.9 - (n * lineH) / 2 + px * 0.0 : px * 0.9 - n * lineH + lineH * 0.9;
  } else {
    ctx.textBaseline = 'alphabetic';
    const v = it.vAlign; // 0 baseline, 1 bottom, 2 middle, 3 top
    vOff = v === 1 ? -px * 0.2 : v === 2 || hAlign === 4 ? px * 0.35 : v === 3 ? px * 0.8 : 0;
  }
  ctx.textAlign = hAlign === 1 || hAlign === 4 ? 'center' : hAlign === 2 ? 'right' : 'left';
  for (let i = 0; i < n; i++) ctx.fillText(lines[i], 0, vOff + i * lineH);
  ctx.restore();
}



function drawMText(ctx, it, x, y, z, color, dark) {
  ctx.save();
  const lay = mtextLayout(ctx, it);
  const colOf = (c) => (!c ? color : c.rgb ? rgbCss(c.rgb) : c.aci === 7 ? (dark ? '#ffffff' : '#000000') : rgbCss(aciToRgb(c.aci)));
  ctx.translate(x, y);
  ctx.rotate(-it.rot);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  for (const g of lay.glyphs) {
    const px = g.h * z;
    ctx.fillStyle = colOf(g.color);
    if (px < 2) { ctx.globalAlpha = 0.5; ctx.fillRect(g.x * z, g.y * z - 1, (g.w ?? g.text.length * g.h * 0.6) * z, 1); ctx.globalAlpha = 1; continue; }
    ctx.save();
    ctx.translate(g.x * z, g.y * z);
    if (g.oblique) ctx.transform(1, 0, -Math.tan(g.oblique * DEG), 1, 0, 0);
    ctx.scale(g.wf || 1, 1);
    ctx.font = mtextFont(g, px, it.font);
    if (g.track && g.track !== 1) ctx.letterSpacing = `${(g.track - 1) * px * 0.6}px`;
    ctx.fillText(g.text, 0, 0);
    ctx.restore();
  }
  for (const r of lay.rules) {
    ctx.strokeStyle = colOf(r.color); ctx.lineWidth = Math.max(1, r.h * z * 0.06);
    ctx.beginPath(); ctx.moveTo(r.x1 * z, r.y * z); ctx.lineTo(r.x2 * z, r.y * z); ctx.stroke();
  }
  ctx.restore();
}

function wrapLines(ctx, lines, maxW) {
  const out = [];
  for (const line of lines) {
    if (ctx.measureText(line).width <= maxW) { out.push(line); continue; }
    let cur = '';
    for (const word of line.split(' ')) {
      const t = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = word; } else cur = t;
    }
    out.push(cur);
  }
  return out;
}

/** Pattern hatch: clip to the boundary, then draw each pattern line family across the bounding box. */
function drawPatternHatch(ctx, it, view, color, tracePath, sx, sy, fallbackAlpha) {
  const z = view.zoom;
  ctx.save();
  ctx.beginPath(); tracePath(it.ops); ctx.clip('evenodd');
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  const vminx = view.cx - view.width / 2 / z, vmaxx = view.cx + view.width / 2 / z;
  const vminy = view.cy - view.height / 2 / z, vmaxy = view.cy + view.height / 2 / z;
  const b = it.bbox;
  const bx0 = Math.max(b.minx, vminx), bx1 = Math.min(b.maxx, vmaxx), by0 = Math.max(b.miny, vminy), by1 = Math.min(b.maxy, vmaxy);
  if (bx1 <= bx0 || by1 <= by0) { ctx.restore(); return; }
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, R = Math.hypot(bx1 - bx0, by1 - by0) / 2 + 1e-9;
  let dense = false;
  for (const L of it.lines) {
    const a = L.angle * DEG, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    const spacing = Math.abs(L.offset.x * nx + L.offset.y * ny);
    if (spacing * z < 3) { dense = true; break; }
  }
  if (dense) { ctx.globalAlpha = fallbackAlpha; ctx.fillStyle = color; ctx.fillRect(0, 0, view.width, view.height); ctx.restore(); return; }
  ctx.beginPath();
  for (const L of it.lines) {
    const a = L.angle * DEG, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    const spacing = L.offset.x * nx + L.offset.y * ny;
    if (Math.abs(spacing) < 1e-9) continue;
    const d0 = (cx - L.base.x) * nx + (cy - L.base.y) * ny; // perpendicular distance of box centre from the base line
    const k0 = Math.floor((d0 - R) / spacing), k1 = Math.ceil((d0 + R) / spacing);
    const lo = Math.min(k0, k1) - 1, hi = Math.max(k0, k1) + 1;
    if (hi - lo > 4000) continue;
    for (let k = lo; k <= hi; k++) {
      const ox = L.base.x + k * L.offset.x, oy = L.base.y + k * L.offset.y;
      const t0 = (cx - ox) * dx + (cy - oy) * dy;
      ctx.moveTo(sx(ox + dx * (t0 - R)), sy(oy + dy * (t0 - R)));
      ctx.lineTo(sx(ox + dx * (t0 + R)), sy(oy + dy * (t0 + R)));
    }
    if (L.dashes && L.dashes.length) {
      // dashes apply along each line; draw per family
      ctx.setLineDash(L.dashes.map((d) => Math.max(Math.abs(d) * z, 0.5)));
    }
    ctx.stroke(); ctx.beginPath();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

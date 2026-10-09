// ASH Draw Studio - MLEADER (multileader) entity: DXF read/write and display parts.
// Pure ES module. Model:
//   { type:'MLEADER', text, textP:{x,y}, textHeight, textAttach, textRot (deg), textWidth, arrowSize, landingGap,
//     scale, base:{x,y}, style:'Standard', arrow, dogleg,
//     leaders:[{ last:{x,y}, dir:{x,y}, doglegLen, lines:[ [{x,y} arrow tip first, ...] ] }] }
// Display (render/extents) goes through mleaderParts(): leader polylines, SOLID arrowheads, MTEXT content.
// textHeight / arrowSize / landingGap are final drawing units: the CONTEXT_DATA values (41 / 140 / 145) already hold
// the overall (annotative) scale 40, as AutoCAD writes them; only the MLEADERSTYLE defaults are scaled when read.

const decodeU = (s) => String(s).replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const P = (x, y) => ({ x: +x || 0, y: +y || 0 });

/** MLEADERSTYLE object tags -> defaults */
export function mleaderStyleFromTags(tags) {
  const g = (c, d) => { const t = tags.find(([k]) => k === c); return t ? parseFloat(t[1]) : d; };
  const n = tags.find(([k]) => k === 3);
  return { name: n ? n[1] : 'Standard', arrowSize: g(44, 4), textHeight: g(45, 4), landingGap: g(42, 2), doglegLen: g(43, 8) };
}

/** MLEADER / MULTILEADER entity tags ([code, raw value] after the 0 tag) -> partial model */
export function mleaderFromTags(tags, style = null) {
  const e = {
    text: '', textP: null, textHeight: style?.textHeight ?? 2.5, textAttach: 1, textRot: 0, textWidth: 0,
    arrowSize: style?.arrowSize ?? 4, landingGap: style?.landingGap ?? 2, scale: 1, base: P(0, 0), style: style?.name ?? 'Standard',
    arrow: true, dogleg: true, leaders: [],
  };
  let ctx = false, leader = null, line = null, cur = null, hasText = false;
  const own = new Set(); // context values present (already scaled)
  for (const [c, v] of tags) {
    if (c === 300 && v.startsWith('CONTEXT_DATA')) { ctx = true; continue; }
    if (c === 301) { ctx = false; continue; }
    if (c === 302) { leader = { last: P(0, 0), dir: P(1, 0), doglegLen: 0, lines: [] }; e.leaders.push(leader); continue; }
    if (c === 303) { leader = null; continue; }
    if (c === 304 && leader) { line = []; leader.lines.push(line); continue; }
    if (c === 305) { line = null; continue; }
    const f = parseFloat(v);
    if (line) { if (c === 10) { cur = P(f, 0); line.push(cur); } else if (c === 20 && cur) cur.y = f; continue; }
    if (leader) {
      if (c === 10) leader.last.x = f; else if (c === 20) leader.last.y = f;
      else if (c === 11) leader.dir.x = f; else if (c === 21) leader.dir.y = f;
      else if (c === 40) leader.doglegLen = f;
      continue;
    }
    if (ctx) {
      switch (c) {
        case 40: e.scale = f || 1; break;
        case 10: e.base.x = f; break; case 20: e.base.y = f; break;
        case 41: e.textHeight = f; own.add(c); break;
        case 140: e.arrowSize = f; own.add(c); break;
        case 145: e.landingGap = f; own.add(c); break;
        case 290: hasText = f !== 0; break;
        case 304: e.text = decodeU(v); break;
        case 12: e.textP = P(f, 0); break; case 22: if (e.textP) e.textP.y = f; break;
        case 13: e.textDir = P(f, 0); break; case 23: if (e.textDir) e.textDir.y = f; break;
        case 43: e.textWidth = f; break;
        case 171: e.textAttach = f || 1; break;
        default: break;
      }
      continue;
    }
    if (c === 290) e.landing = f !== 0;
    else if (c === 291) e.dogleg = f !== 0;
    else if (c === 42) { if (!e.arrowSize) e.arrowSize = f; }
  }
  // style defaults (no context value) are unscaled sizes
  if (!own.has(41)) e.textHeight *= e.scale;
  if (!own.has(140)) e.arrowSize *= e.scale;
  if (!own.has(145)) e.landingGap *= e.scale;
  if (e.textDir) { e.textRot = Math.atan2(e.textDir.y, e.textDir.x) * 180 / Math.PI; delete e.textDir; }
  if (!hasText) e.text = '';
  e.leaders = e.leaders.filter((l) => l.lines.some((ln) => ln.length));
  if (!e.leaders.length && !e.text) return null;
  if (!e.textP) e.textP = { ...e.base };
  return e;
}

/** Display parts in world coordinates (BYBLOCK so they take the MLEADER's own properties). */
export function mleaderParts(e) {
  const o = { layer: '0', color: 0, linetype: 'BYBLOCK', lineweight: -2, ltscale: 1 };
  const out = [];
  const sz = e.arrowSize || 0;
  for (const l of e.leaders || []) {
    for (const ln of l.lines) {
      const pts = [...ln, l.last];
      if (e.dogleg !== false && l.doglegLen) pts.push({ x: l.last.x + l.dir.x * l.doglegLen, y: l.last.y + l.dir.y * l.doglegLen });
      out.push({ id: 0, type: 'LWPOLYLINE', ...o, vertices: pts.map((p) => ({ x: p.x, y: p.y, bulge: 0 })), closed: false });
      if (e.arrow === false || !(sz > 0)) continue;
      const tip = pts[0], nx = pts[1];
      const d = Math.hypot(nx.x - tip.x, nx.y - tip.y) || 1, ux = (nx.x - tip.x) / d, uy = (nx.y - tip.y) / d, w = sz / 6;
      const b = { x: tip.x + ux * sz, y: tip.y + uy * sz };
      const p1 = { x: b.x - uy * w, y: b.y + ux * w }, p2 = { x: b.x + uy * w, y: b.y - ux * w };
      out.push({ id: 0, type: 'SOLID', ...o, pts: [tip, p1, tip, p2].map((p) => ({ ...p })), arrowHead: true });
    }
  }
  if (e.text) {
    out.push({ id: 0, type: 'MTEXT', ...o, p: { ...e.textP }, height: e.textHeight, text: e.text,
      width: e.textWidth || 0, rot: e.textRot || 0, attach: e.textAttach || 1, style: 'STANDARD' });
  }
  return out;
}

/** Created multileader: arrow tip -> landing point, text to the side the leader runs. */
export function makeMLeader(tip, landing, text, o = {}) {
  const arrowSize = o.arrowSize ?? 2.5, textHeight = o.textHeight ?? 2.5, landingGap = o.landingGap ?? 1, doglegLen = o.doglegLen ?? 2.5;
  const sgn = landing.x >= tip.x ? 1 : -1;
  const end = { x: landing.x + sgn * doglegLen, y: landing.y };
  return {
    id: 0, type: 'MLEADER', layer: o.layer ?? '0', color: o.color ?? 256, linetype: o.linetype ?? 'BYLAYER', lineweight: o.lineweight ?? -1, ltscale: 1,
    text, textP: { x: end.x + sgn * landingGap, y: end.y + textHeight / 2 }, textHeight, textAttach: sgn > 0 ? 1 : 3, textRot: 0, textWidth: 0,
    arrowSize, landingGap, scale: 1, base: end, style: 'Standard', arrow: true, dogleg: true,
    leaders: [{ last: { ...landing }, dir: { x: sgn, y: 0 }, doglegLen, lines: [[{ ...tip }]] }],
  };
}

export const transformMLeader = (e, apply) => {
  const c = structuredClone(e);
  const tp = (p) => { const q = apply(p); p.x = q.x; p.y = q.y; };
  tp(c.base); tp(c.textP);
  for (const l of c.leaders) { tp(l.last); for (const ln of l.lines) ln.forEach(tp); }
  return c;
};

/** Tags (after head) of a MULTILEADER entity; `h` = { style, textStyle } handles. */
export function mleaderTags(e, h, encode) {
  const t = [];
  const p = (c, v) => t.push([c, v]);
  const pt = (c, q) => { p(c, q.x); p(c + 10, q.y); p(c + 20, 0); };
  const BYBLOCK = -1056964608;
  p(100, 'AcDbMLeader'); p(270, 2); p(300, 'CONTEXT_DATA{');
  p(40, e.scale || 1); pt(10, e.base); p(41, e.textHeight); p(140, e.arrowSize); p(145, e.landingGap);
  p(174, 1); p(175, 1); p(176, 0); p(177, 0);
  p(290, e.text ? 1 : 0);
  if (e.text) {
    p(304, encode(String(e.text).replace(/\r?\n/g, '\\P')));
    p(11, 0); p(21, 0); p(31, 1); p(340, h.textStyle); pt(12, e.textP);
    const r = (e.textRot || 0) * Math.PI / 180; p(13, Math.cos(r)); p(23, Math.sin(r)); p(33, 0);
    p(42, 0); p(43, e.textWidth || 0); p(44, 0); p(45, 1); p(170, 1); p(90, BYBLOCK); p(171, e.textAttach || 1); p(172, 1);
    p(91, -939524096); p(141, 1.5); p(92, 0); p(291, 0); p(292, 0); p(173, 0); p(293, 0); p(142, 0); p(143, 0); p(294, 0); p(295, 1);
  }
  p(296, 0);
  p(110, 0); p(120, 0); p(130, 0); p(111, 1); p(121, 0); p(131, 0); p(112, 0); p(122, 1); p(132, 0); p(297, 0);
  e.leaders.forEach((l, i) => {
    p(302, 'LEADER{'); p(290, 1); p(291, 1); pt(10, l.last); p(11, l.dir.x); p(21, l.dir.y); p(31, 0); p(90, i); p(40, l.doglegLen || 0);
    l.lines.forEach((ln, j) => { p(304, 'LEADER_LINE{'); ln.forEach((q) => pt(10, q)); p(91, j); p(92, BYBLOCK); p(305, '}'); });
    p(271, 0); p(303, '}');
  });
  p(301, '}');
  p(340, h.style); p(90, 0); p(170, 1); p(91, BYBLOCK); p(171, -2); p(290, 1); p(291, e.dogleg === false ? 0 : 1);
  p(41, e.leaders[0]?.doglegLen ?? 8); p(42, e.arrowSize); p(172, e.text ? 2 : 0); p(343, h.textStyle);
  p(173, 1); p(95, 1); p(174, 1); p(175, 0); p(92, BYBLOCK); p(292, 0); p(93, BYBLOCK); p(10, 1); p(20, 1); p(30, 1); p(43, 0); p(176, 0);
  p(293, 0); p(294, 0); p(178, 0); p(179, 1); p(45, 1); p(271, 0); p(272, 9); p(273, 9);
  return t;
}

/** MLEADERSTYLE "Standard" object body (after 0/5/330 head). */
export function mleaderStyleTags(textStyleH, st = {}) {
  return [[100, 'AcDbMLeaderStyle'], [179, 2], [170, 2], [171, 1], [172, 0], [90, 2], [40, 0], [41, 0], [173, 1], [91, -1056964608], [92, -2],
    [290, 1], [42, st.landingGap ?? 2], [291, 1], [43, st.doglegLen ?? 8], [3, 'Standard'], [44, st.arrowSize ?? 4], [300, ''], [342, textStyleH],
    [174, 1], [175, 1], [176, 0], [178, 1], [93, -1056964608], [45, st.textHeight ?? 4], [292, 0], [297, 0], [46, 4], [94, -1056964608],
    [47, 1], [49, 1], [140, 1], [294, 1], [141, 0], [177, 0], [142, 1], [295, 0], [296, 0], [143, 3.75], [271, 0], [272, 9], [273, 9]];
}

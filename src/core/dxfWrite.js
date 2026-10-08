// ASH Draw Studio - DXF writer: ASCII DXF R2000 (AC1015), model space only.
// Output is plain ASCII (non-ASCII text is written as \U+XXXX), CRLF line ends.
// doc.lastWriteReport = { version, entities, blocks, skipped:{TYPE:n}, notes:[...] } is set on every call.
import { docExtents, ccwSweep, DEG } from './geom.js';
import { patternLines, hasPattern } from './patterns.js';

const TAU = Math.PI * 2;
const STD_LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

const num = (n) => {
  if (!Number.isFinite(n)) return '0';
  const s = String(Number(n.toPrecision(15)));
  return s;
};
import { dimStyleTags } from './dimsStyle.js';
import { dimensionTags, arrowEntities } from './dims.js';
import { mleaderTags, mleaderStyleTags, mleaderParts } from './mleader.js';
import { viewportTags } from './layouts.js';
const encode = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, (c) => {
  const code = c.charCodeAt(0);
  return code < 32 ? ' ' : `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
});
function chunkEncoded(s, max = 240) {
  const out = [];
  let cur = '';
  for (const ch of String(s)) {
    const e = encode(ch);
    if (cur.length + e.length > max) { out.push(cur); cur = ''; }
    cur += e;
  }
  out.push(cur);
  return out;
}
const snapLw = (mm) => {
  const v = Math.round(mm * 100);
  let best = STD_LW[0];
  for (const w of STD_LW) if (Math.abs(w - v) < Math.abs(best - v)) best = w;
  return best;
};

class Out {
  constructor() { this.lines = []; }
  p(code, v) { this.lines.push(String(code), typeof v === 'number' ? num(v) : String(v)); }
  s(code, v) { this.p(code, encode(v)); }
  pt(code, x, y, z = 0, hasZ = true) { this.p(code, x); this.p(code + 10, y); if (hasZ) this.p(code + 20, z); }
  append(other) { for (let i = 0; i < other.lines.length; i++) this.lines.push(other.lines[i]); }
  text() { return this.lines.join('\r\n') + '\r\n'; }
}

/** opts.dimensionsAsGeometry: write DIMENSION entities as plain INSERTs of their blocks (used for DWG, where the
 *  converter cannot handle every dimension type), and MLEADERs as their lines, arrows and text (R2000 has no
 *  multileaders, and LibreDWG drops the whole drawing when the DXF holds MLEADERSTYLE / MULTILEADER objects). */
export function writeDxf(doc, opts = {}) {
  let reportedDim = false, reportedMleader = false;
  const report = { version: 'AC1015', entities: 0, blocks: 0, skipped: {}, notes: [] };
  let nextHandle = 0x30;
  const H = () => (nextHandle++).toString(16).toUpperCase();

  // fixed objects (low handles mirror the layout other CAD tools expect)
  const hRootDict = 'A', hGroupDict = 'C', hLayoutDict = 'D', hMlineDict = '10', hPlotDict = '12', hPlotPlaceholder = '13', hMlineStyle = '22';
  const hMleaderDict = H(), hMleaderStyle = H();
  const hModelRec = '17', hPaperRec = '1B', hModelLayout = '1A', hPaperLayout = '1E';
  const tbl = { LAYER: '1', LTYPE: '2', APPID: '3', DIMSTYLE: '4', STYLE: '5', UCS: '6', VIEW: '7', VPORT: '8', BLOCK_RECORD: '9' };
  const asGeometry = !!(opts && opts.dimensionsAsGeometry);
  let paperMode = false;
  const layerH = new Map([...doc.layers.keys()].map((n) => [n, H()]));

  // ---- collect what is used ---------------------------------------------------------------
  // arrowhead blocks named by dimension styles (DIMBLK) that the drawing does not define yet
  const allBlocks = new Map(doc.blocks);
  const hasBlockCI = (n) => [...allBlocks.keys()].some((k) => k.toUpperCase() === String(n).toUpperCase());
  for (const st of doc.dimStyles?.values() ?? []) {
    if (st.DIMBLK && !hasBlockCI(st.DIMBLK)) allBlocks.set(st.DIMBLK, { name: st.DIMBLK, base: { x: 0, y: 0 }, entities: arrowEntities(st.DIMBLK, { x: 0, y: 0 }, { x: 1, y: 0 }, 1) });
  }
  const blockNames = [...allBlocks.keys()];
  const blockRec = new Map(blockNames.map((n) => [n, H()]));
  const allLists = [doc.entities, ...[...doc.blocks.values()].map((b) => b.entities)];
  const ltDefs = new Map(); // upper name -> def
  for (const lt of doc.linetypes.values()) if (!/^(CONTINUOUS|BYLAYER|BYBLOCK)$/.test(lt.name)) ltDefs.set(lt.name.toUpperCase(), lt);
  const styleDefs = new Map();
  for (const st of doc.textStyles.values()) styleDefs.set(st.name.toUpperCase(), st);
  if (!styleDefs.has('STANDARD')) styleDefs.set('STANDARD', { name: 'STANDARD', font: 'Arial', height: 0, widthFactor: 1, oblique: 0 });
  const ltKnown = (n) => {
    const u = String(n).toUpperCase();
    return u === 'CONTINUOUS' || u === 'BYLAYER' || u === 'BYBLOCK' || ltDefs.has(u);
  };

  // ---- entity writer -------------------------------------------------------------------------
  function head(o, e, type, owner) {
    const hd = H();
    o.p(0, type);
    o.p(5, hd);
    o.p(330, owner);
    o.p(100, 'AcDbEntity');
    if (paperMode) o.p(67, 1);
    o.s(8, e.layer || '0');
    if (e.linetype && e.linetype !== 'BYLAYER') {
      if (ltKnown(e.linetype)) o.s(6, ltDefs.get(String(e.linetype).toUpperCase())?.name ?? e.linetype);
      else report.notes.push(`Linetype "${e.linetype}" is not defined; written as BYLAYER.`);
    }
    if (typeof e.color === 'number') { if (e.color !== 256) o.p(62, e.color); }
    else if (e.color && typeof e.color === 'object') o.p(420, (e.color.r << 16) | (e.color.g << 8) | e.color.b);
    if (e.lineweight !== undefined && e.lineweight !== -1) o.p(370, e.lineweight < 0 ? e.lineweight : snapLw(e.lineweight));
    if (e.ltscale && e.ltscale !== 1) o.p(48, e.ltscale);
    if (e.invisible) o.p(60, 1);
    return hd;
  }

  function writeSolidHatchLoops(o, loops) {
    o.p(91, loops.length);
    loops.forEach((l, idx) => {
      const external = idx === 0;
      if (l.pts) {
        const hasBulge = l.pts.some((v) => v.bulge && Math.abs(v.bulge) > 1e-12);
        o.p(92, (external ? 1 : 0) | 2 | (idx === 0 ? 4 : 0) | 0); // external polyline (derived)
        o.p(72, hasBulge ? 1 : 0);
        o.p(73, l.closed === false ? 0 : 1);
        o.p(93, l.pts.length);
        for (const v of l.pts) { o.p(10, v.x); o.p(20, v.y); if (hasBulge) o.p(42, v.bulge || 0); }
        o.p(97, 0);
      } else {
        o.p(92, external ? 1 | 4 : 0);
        o.p(93, l.segs.length);
        for (const s of l.segs) {
          if (s.type === 'line') { o.p(72, 1); o.p(10, s.p1.x); o.p(20, s.p1.y); o.p(11, s.p2.x); o.p(21, s.p2.y); }
          else if (s.type === 'arc') { o.p(72, 2); o.p(10, s.c.x); o.p(20, s.c.y); o.p(40, s.r); o.p(50, s.a0); o.p(51, s.a1); o.p(73, s.ccw === false ? 0 : 1); }
          else if (s.type === 'ellipse') { o.p(72, 3); o.p(10, s.c.x); o.p(20, s.c.y); o.p(11, s.major.x); o.p(21, s.major.y); o.p(40, s.ratio); o.p(50, s.a0 / DEG); o.p(51, s.a1 / DEG); o.p(73, s.ccw === false ? 0 : 1); }
          else if (s.type === 'spline') {
            const deg = s.degree || 3, n = s.ctrl.length;
            const knots = s.knots && s.knots.length === n + deg + 1 ? s.knots : clamped(n, deg);
            o.p(72, 4); o.p(94, deg); o.p(73, 0); o.p(74, 0); o.p(95, knots.length); o.p(96, n);
            knots.forEach((k) => o.p(40, k));
            s.ctrl.forEach((c) => { o.p(10, c.x); o.p(20, c.y); });
          }
        }
        o.p(97, 0);
      }
    });
  }

  function clamped(n, deg) {
    const k = [];
    for (let i = 0; i <= deg; i++) k.push(0);
    const inner = n - deg - 1;
    for (let i = 1; i <= inner; i++) k.push(i);
    for (let i = 0; i <= deg; i++) k.push(inner + 1);
    return k;
  }

  function writeEntity(o, e, owner) {
    switch (e.type) {
      case 'LINE':
        head(o, e, 'LINE', owner); o.p(100, 'AcDbLine'); o.pt(10, e.p1.x, e.p1.y); o.pt(11, e.p2.x, e.p2.y); return true;
      case 'CIRCLE':
        head(o, e, 'CIRCLE', owner); o.p(100, 'AcDbCircle'); o.pt(10, e.c.x, e.c.y); o.p(40, e.r); return true;
      case 'ARC':
        head(o, e, 'ARC', owner); o.p(100, 'AcDbCircle'); o.pt(10, e.c.x, e.c.y); o.p(40, e.r);
        o.p(100, 'AcDbArc'); o.p(50, e.a0); o.p(51, e.a1); return true;
      case 'ELLIPSE': {
        head(o, e, 'ELLIPSE', owner); o.p(100, 'AcDbEllipse'); o.pt(10, e.c.x, e.c.y); o.pt(11, e.major.x, e.major.y);
        o.p(210, 0); o.p(220, 0); o.p(230, 1); o.p(40, e.ratio);
        const full = Math.abs((e.a1 ?? TAU) - (e.a0 ?? 0)) >= TAU - 1e-9;
        o.p(41, full ? 0 : e.a0 ?? 0); o.p(42, full ? TAU : e.a1 ?? TAU); return true;
      }
      case 'LWPOLYLINE': {
        if (!e.vertices || e.vertices.length < 2) { report.skipped['LWPOLYLINE (fewer than 2 vertices)'] = (report.skipped['LWPOLYLINE (fewer than 2 vertices)'] ?? 0) + 1; return false; }
        head(o, e, 'LWPOLYLINE', owner); o.p(100, 'AcDbPolyline'); o.p(90, e.vertices.length); o.p(70, e.closed ? 1 : 0);
        if (e.width > 0) o.p(43, e.width);
        for (const v of e.vertices) { o.p(10, v.x); o.p(20, v.y); if (v.bulge && Math.abs(v.bulge) > 1e-12) o.p(42, v.bulge); }
        return true;
      }
      case 'SPLINE': {
        const deg = e.degree || 3, n = e.ctrl.length;
        if (n < 2 && (!e.fit || e.fit.length < 2)) return false;
        head(o, e, 'SPLINE', owner); o.p(100, 'AcDbSpline'); o.p(210, 0); o.p(220, 0); o.p(230, 1);
        const rational = e.weights && e.weights.length === n;
        o.p(70, (e.closed ? 1 : 0) | (rational ? 4 : 0) | 8);
        const knots = n ? (e.knots && e.knots.length === n + deg + 1 ? e.knots : clamped(n, deg)) : [];
        o.p(71, deg); o.p(72, knots.length); o.p(73, n); o.p(74, e.fit ? e.fit.length : 0);
        o.p(42, 1e-7); o.p(43, 1e-7); o.p(44, 1e-10);
        knots.forEach((k) => o.p(40, k));
        if (rational) e.weights.forEach((w) => o.p(41, w));
        e.ctrl.forEach((c) => o.pt(10, c.x, c.y));
        (e.fit || []).forEach((c) => o.pt(11, c.x, c.y));
        return true;
      }
      case 'TEXT': {
        // ATTDEF (e.attdef) and ATTRIB (e.attrib, written after their INSERT) share the TEXT body; value in 1
        const kind = e.attdef ? 'ATTDEF' : e.attrib ? 'ATTRIB' : 'TEXT';
        head(o, e, kind, owner); o.p(100, 'AcDbText'); o.pt(10, e.p.x, e.p.y); o.p(40, e.height); o.s(1, e.attdef ? e.attdef.default : e.text);
        if (e.rot) o.p(50, e.rot);
        if (e.widthFactor && e.widthFactor !== 1) o.p(41, e.widthFactor);
        const st = String(e.style || 'STANDARD').toUpperCase();
        o.s(7, styleDefs.has(st) ? styleDefs.get(st).name : 'Standard');
        const aligned = (e.hAlign || 0) !== 0 || (e.vAlign || 0) !== 0;
        if (e.hAlign) o.p(72, e.hAlign);
        if (aligned) o.pt(11, e.p.x, e.p.y);
        if (kind !== 'TEXT') {
          const at = e.attdef ?? e.attrib;
          o.p(100, kind === 'ATTDEF' ? 'AcDbAttributeDefinition' : 'AcDbAttribute');
          if (e.attdef) o.s(3, e.attdef.prompt ?? '');
          o.s(2, at.tag); o.p(70, at.flags || 0);
          if (e.vAlign) o.p(74, e.vAlign);
          return true;
        }
        o.p(100, 'AcDbText');
        if (e.vAlign) o.p(73, e.vAlign);
        return true;
      }
      case 'MTEXT': {
        head(o, e, 'MTEXT', owner); o.p(100, 'AcDbMText'); o.pt(10, e.p.x, e.p.y); o.p(40, e.height);
        if (e.width > 0) o.p(41, e.width);
        o.p(71, e.attach || 1); o.p(72, 5);
        const raw = String(e.text ?? '').replace(/\r?\n/g, '\\P');
        const chunks = chunkEncoded(raw);
        for (let i = 0; i < chunks.length - 1; i++) o.p(3, chunks[i]);
        o.p(1, chunks[chunks.length - 1]);
        const st = String(e.style || 'STANDARD').toUpperCase();
        o.s(7, styleDefs.has(st) ? styleDefs.get(st).name : 'Standard');
        if (e.rot) { const r = e.rot * DEG; o.pt(11, Math.cos(r), Math.sin(r)); }
        // group 73 line spacing style (1 = at least), 44 line spacing factor
        if (e.lineSpacing > 0 && e.lineSpacing !== 1) { o.p(73, 1); o.p(44, e.lineSpacing); }
        return true;
      }
      case 'POINT':
        head(o, e, 'POINT', owner); o.p(100, 'AcDbPoint'); o.pt(10, e.p.x, e.p.y); return true;
      case 'SOLID': {
        head(o, e, 'SOLID', owner); o.p(100, 'AcDbTrace');
        const p = e.pts; const p4 = p[3] ?? p[2];
        o.pt(10, p[0].x, p[0].y); o.pt(11, p[1].x, p[1].y); o.pt(12, p[2].x, p[2].y); o.pt(13, p4.x, p4.y); return true;
      }
      case 'INSERT': {
        if (!doc.blocks.has(e.block)) { report.skipped['INSERT (block missing)'] = (report.skipped['INSERT (block missing)'] ?? 0) + 1; return false; }
        const atts = e.attribs?.length ? e.attribs : null;
        const hIns = head(o, e, 'INSERT', owner); o.p(100, 'AcDbBlockReference'); if (atts) o.p(66, 1); o.s(2, e.block); o.pt(10, e.p.x, e.p.y);
        if (e.sx !== 1) o.p(41, e.sx); if (e.sy !== 1) o.p(42, e.sy); if (e.sx !== 1 || e.sy !== 1) o.p(43, 1);
        if (e.rot) o.p(50, e.rot);
        if ((e.cols || 1) > 1 || (e.rows || 1) > 1) { o.p(70, e.cols || 1); o.p(71, e.rows || 1); o.p(44, e.colSp || 0); o.p(45, e.rowSp || 0); }
        if (atts) {
          for (const a of atts) writeEntity(o, a, hIns);
          o.p(0, 'SEQEND'); o.p(5, H()); o.p(330, hIns); o.p(100, 'AcDbEntity'); o.s(8, e.layer || '0');
        }
        return true;
      }
      case 'DIMENSION': {
        if (!doc.blocks.has(e.block)) { report.skipped['DIMENSION (block missing)'] = (report.skipped['DIMENSION (block missing)'] ?? 0) + 1; return false; }
        if (e.raw && e.raw.length && !asGeometry) {
          head(o, e, 'DIMENSION', owner);
          for (const [c, v] of e.raw) o.p(c, v);
          return true;
        }
        if (e.def && !asGeometry) {
          head(o, e, 'DIMENSION', owner);
          for (const [c, v] of dimensionTags(e)) if (typeof v === 'string') o.s(c, v); else o.p(c, v);
          return true;
        }
        head(o, { ...e }, 'INSERT', owner); o.p(100, 'AcDbBlockReference'); o.s(2, e.block); o.pt(10, 0, 0);
        if (!reportedDim) { reportedDim = true; report.notes.push(asGeometry ? 'Dimensions are saved as plain geometry in DWG files (they stay visible but are no longer editable as dimensions).' : 'A dimension without full source data was saved as plain geometry.'); }
        return true;
      }
      case 'MLEADER': {
        if (!e.leaders?.length && !e.text) return false;
        if (asGeometry) {
          // R2000 DWG has no multileaders: LibreDWG drops every entity of a DXF that holds MLEADERSTYLE / MULTILEADER objects
          const own = { layer: e.layer, color: e.color, linetype: e.linetype, lineweight: e.lineweight };
          for (const sub of mleaderParts(e)) writeEntity(o, { ...sub, ...own }, owner);
          if (!reportedMleader) { reportedMleader = true; report.notes.push('Multileaders are saved as plain geometry in DWG files (they stay visible but are no longer editable as multileaders).'); }
          return true;
        }
        head(o, e, 'MULTILEADER', owner);
        for (const [c, v] of mleaderTags(e, { style: hMleaderStyle, textStyle: '__STDSTYLE__' }, encode)) o.p(c, v);
        return true;
      }
      case 'LEADER': {
        if (!e.pts || e.pts.length < 2) return false;
        head(o, e, 'LEADER', owner); o.p(100, 'AcDbLeader'); o.s(3, 'Standard'); o.p(71, e.arrow === false ? 0 : 1); o.p(72, 0); o.p(73, 3);
        o.p(74, 1); o.p(75, 0); o.p(40, 0); o.p(41, 0); o.p(76, e.pts.length);
        e.pts.forEach((c) => o.pt(10, c.x, c.y));
        o.p(77, 256); o.p(210, 0); o.p(220, 0); o.p(230, 1); o.p(211, 1); o.p(221, 0); o.p(231, 0); o.p(212, 0); o.p(222, 0); o.p(232, 0); o.p(213, 0); o.p(223, 0); o.p(233, 0);
        return true;
      }
      case 'HATCH': {
        if (!e.loops || !e.loops.length) return false;
        let solid = e.solid !== false && (e.pattern === 'SOLID' || e.solid);
        let lines = null;
        if (!solid) {
          lines = e.patLines && e.patLines.length ? e.patLines : (hasPattern(e.pattern) ? patternLines(e.pattern, e.scale || 1, e.angle || 0) : null);
          if (!lines) { solid = true; report.notes.push(`Hatch pattern "${e.pattern}" is unknown; saved as solid fill.`); }
        }
        head(o, e, 'HATCH', owner); o.p(100, 'AcDbHatch'); o.pt(10, 0, 0, 0); o.p(210, 0); o.p(220, 0); o.p(230, 1);
        o.s(2, solid ? 'SOLID' : e.pattern); o.p(70, solid ? 1 : 0); o.p(71, 0);
        writeSolidHatchLoops(o, e.loops);
        o.p(75, 0); o.p(76, 1);
        if (!solid) {
          o.p(52, e.angle || 0); o.p(41, e.scale || 1); o.p(77, 0); o.p(78, lines.length);
          for (const L of lines) {
            o.p(53, L.angle); o.p(43, L.base.x); o.p(44, L.base.y); o.p(45, L.offset.x); o.p(46, L.offset.y);
            o.p(79, L.dashes.length); L.dashes.forEach((d) => o.p(49, d));
          }
        }
        o.p(47, 1); o.p(98, 0);
        return true;
      }
      case 'VIEWPORT': {
        head(o, e, 'VIEWPORT', owner);
        for (const [c, v] of viewportTags(e, (n) => layerH.get(n))) o.p(c, v);
        return true;
      }
      default:
        report.skipped[e.type] = (report.skipped[e.type] ?? 0) + 1;
        return false;
    }
  }

  // ---- BLOCKS + ENTITIES (written first so handles exist; assembled later) -------------------
  const blocksOut = new Out();
  const entOut = new Out();
  for (const [name, blk] of allBlocks) {
    const rec = blockRec.get(name);
    blocksOut.p(0, 'BLOCK'); blocksOut.p(5, H()); blocksOut.p(330, rec); blocksOut.p(100, 'AcDbEntity'); blocksOut.p(8, '0');
    blocksOut.p(100, 'AcDbBlockBegin'); blocksOut.s(2, name); blocksOut.p(70, name.startsWith('*') ? 1 : 0);
    blocksOut.pt(10, blk.base.x, blk.base.y); blocksOut.s(3, name); blocksOut.p(1, '');
    for (const e of blk.entities) if (writeEntity(blocksOut, e, rec)) report.entities++;
    blocksOut.p(0, 'ENDBLK'); blocksOut.p(5, H()); blocksOut.p(330, rec); blocksOut.p(100, 'AcDbEntity'); blocksOut.p(8, '0'); blocksOut.p(100, 'AcDbBlockEnd');
    report.blocks++;
  }
  for (const e of doc.entities) if (writeEntity(entOut, e, hModelRec)) report.entities++;
  // paper space: the first layout is the active one (*Paper_Space, entities in ENTITIES), the others own *Paper_SpaceN
  // blocks. Viewports go last in each list.
  const paperOrder = (list) => [...list.filter((e) => e.type !== 'VIEWPORT'), ...list.filter((e) => e.type === 'VIEWPORT')];
  const paperLayouts = (doc.layouts?.length ? doc.layouts : [{ name: 'Layout1', tab: 1, entities: [], plot: null }]).map((lo, i) => ({
    lo, name: i === 0 ? '*Paper_Space' : `*Paper_Space${i - 1}`, rec: i === 0 ? hPaperRec : H(), layoutH: i === 0 ? hPaperLayout : H(),
  }));
  paperMode = true;
  for (const pl of paperLayouts) {
    const ents = paperOrder(pl.lo.entities ?? []);
    if (pl.rec === hPaperRec) { for (const e of ents) if (writeEntity(entOut, e, hPaperRec)) report.entities++; continue; }
    blocksOut.p(0, 'BLOCK'); blocksOut.p(5, H()); blocksOut.p(330, pl.rec); blocksOut.p(100, 'AcDbEntity'); blocksOut.p(67, 1); blocksOut.p(8, '0');
    blocksOut.p(100, 'AcDbBlockBegin'); blocksOut.s(2, pl.name); blocksOut.p(70, 0); blocksOut.pt(10, 0, 0); blocksOut.s(3, pl.name); blocksOut.p(1, '');
    for (const e of ents) if (writeEntity(blocksOut, e, pl.rec)) report.entities++;
    blocksOut.p(0, 'ENDBLK'); blocksOut.p(5, H()); blocksOut.p(330, pl.rec); blocksOut.p(100, 'AcDbEntity'); blocksOut.p(67, 1); blocksOut.p(8, '0'); blocksOut.p(100, 'AcDbBlockEnd');
  }
  paperMode = false;

  // ---- header ----------------------------------------------------------------------------------
  const ext = docExtents(doc);
  const out = new Out();
  out.p(0, 'SECTION'); out.p(2, 'HEADER');
  out.p(9, '$ACADVER'); out.p(1, 'AC1015');
  out.p(9, '$DWGCODEPAGE'); out.p(3, 'ANSI_1252');
  out.p(9, '$INSBASE'); out.pt(10, 0, 0, 0);
  out.p(9, '$EXTMIN'); if (ext) out.pt(10, ext.minx, ext.miny, 0); else out.pt(10, 1e20, 1e20, 1e20);
  out.p(9, '$EXTMAX'); if (ext) out.pt(10, ext.maxx, ext.maxy, 0); else out.pt(10, -1e20, -1e20, -1e20);
  out.p(9, '$LTSCALE'); out.p(40, doc.header.ltscale || 1);
  out.p(9, '$TEXTSTYLE'); out.p(7, 'Standard');
  out.p(9, '$CLAYER'); out.p(8, '0');
  out.p(9, '$CELTYPE'); out.p(6, 'ByLayer');
  out.p(9, '$CECOLOR'); out.p(62, 256);
  out.p(9, '$DIMSTYLE'); out.s(2, doc.header.currentDimStyle || 'Standard');
  out.p(9, '$LUNITS'); out.p(70, 2);
  out.p(9, '$LUPREC'); out.p(70, 4);
  out.p(9, '$AUNITS'); out.p(70, 0);
  out.p(9, '$AUPREC'); out.p(70, 2);
  out.p(9, '$INSUNITS'); out.p(70, doc.units || 0);
  out.p(9, '$HANDSEED'); out.p(5, '__HANDSEED__');
  out.p(0, 'ENDSEC');

  out.p(0, 'SECTION'); out.p(2, 'CLASSES');
  const cls = (name, cpp, app, flags) => { out.p(0, 'CLASS'); out.p(1, name); out.p(2, cpp); out.p(3, app); out.p(90, flags); out.p(280, 0); out.p(281, 0); };
  cls('ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault', 'ObjectDBX Classes', 0);
  cls('ACDBPLACEHOLDER', 'AcDbPlaceHolder', 'ObjectDBX Classes', 0);
  cls('LAYOUT', 'AcDbLayout', 'ObjectDBX Classes', 0);
  if (!asGeometry) {
    cls('MLEADERSTYLE', 'AcDbMLeaderStyle', 'ACDB_MLEADERSTYLE_CLASS', 4095);
    cls('MULTILEADER', 'AcDbMLeader', 'ACDB_MLEADER_CLASS', 1025);
  }
  out.p(0, 'ENDSEC');

  // ---- tables ------------------------------------------------------------------------------------
  out.p(0, 'SECTION'); out.p(2, 'TABLES');
  const table = (name, count, extra) => { out.p(0, 'TABLE'); out.p(2, name); out.p(5, tbl[name]); out.p(330, 0); out.p(100, 'AcDbSymbolTable'); out.p(70, count); if (extra) out.p(100, extra); };
  const rec = (type, name, sub, ownerTable, handleCode = 5, preH = null) => { const h = preH ?? H(); out.p(0, type); out.p(handleCode, h); out.p(330, tbl[ownerTable]); out.p(100, 'AcDbSymbolTableRecord'); out.p(100, sub); out.s(2, name); return h; };

  table('VPORT', 1);
  rec('VPORT', '*Active', 'AcDbViewportTableRecord', 'VPORT');
  {
    const cx = ext ? (ext.minx + ext.maxx) / 2 : 0, cy = ext ? (ext.miny + ext.maxy) / 2 : 0;
    const w = ext ? ext.maxx - ext.minx : 100, h = ext ? ext.maxy - ext.miny : 100;
    const vh = Math.max(h, w / 1.34, 1e-6) * 1.1;
    out.p(70, 0); out.pt(10, 0, 0, 0, false); out.pt(11, 1, 1, 0, false); out.pt(12, cx, cy, 0, false); out.pt(13, 0, 0, 0, false);
    out.pt(14, 10, 10, 0, false); out.pt(15, 10, 10, 0, false); out.pt(16, 0, 0, 1); out.pt(17, cx, cy, 0);
    out.p(42, 50); out.p(43, 0); out.p(44, 0); out.p(50, 0); out.p(51, 0);
    out.p(71, 0); out.p(72, 100); out.p(73, 1); out.p(74, 3); out.p(75, 0); out.p(76, 0); out.p(77, 0); out.p(78, 0);
    // view height and aspect
    out.p(40, vh); out.p(41, 1.34);
  }
  out.p(0, 'ENDTAB');

  const ltList = [...ltDefs.values()];
  table('LTYPE', 3 + ltList.length);
  for (const n of ['ByBlock', 'ByLayer', 'Continuous']) { rec('LTYPE', n, 'AcDbLinetypeTableRecord', 'LTYPE'); out.p(70, 0); out.p(3, n === 'Continuous' ? 'Solid line' : ''); out.p(72, 65); out.p(73, 0); out.p(40, 0); }
  for (const lt of ltList) {
    rec('LTYPE', lt.name, 'AcDbLinetypeTableRecord', 'LTYPE'); out.p(70, 0); out.s(3, lt.description || ''); out.p(72, 65);
    out.p(73, lt.pattern.length); out.p(40, lt.pattern.reduce((a, b) => a + Math.abs(b), 0));
    lt.pattern.forEach((d) => { out.p(49, d); out.p(74, 0); });
  }
  out.p(0, 'ENDTAB');

  const layers = [...doc.layers.values()];
  table('LAYER', layers.length);
  for (const l of layers) {
    rec('LAYER', l.name, 'AcDbLayerTableRecord', 'LAYER', 5, layerH.get(l.name));
    out.p(70, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0));
    const c = typeof l.color === 'number' ? l.color : 7;
    out.p(62, l.visible === false ? -Math.abs(c || 7) : Math.abs(c || 7));
    if (l.color && typeof l.color === 'object') out.p(420, (l.color.r << 16) | (l.color.g << 8) | l.color.b);
    const lt = ltKnown(l.linetype) ? (ltDefs.get(String(l.linetype).toUpperCase())?.name ?? 'Continuous') : 'Continuous';
    out.s(6, lt === 'CONTINUOUS' ? 'Continuous' : lt);
    if (l.plot === false) out.p(290, 0);
    out.p(370, l.lineweight < 0 || l.lineweight === undefined ? -3 : snapLw(l.lineweight));
    out.p(390, hPlotPlaceholder);
  }
  out.p(0, 'ENDTAB');

  const styles = [...styleDefs.values()];
  table('STYLE', styles.length);
  const styleHandle = new Map();
  for (const st of styles) {
    styleHandle.set(String(st.name).toUpperCase(), rec('STYLE', st.name === 'STANDARD' ? 'Standard' : st.name, 'AcDbTextStyleTableRecord', 'STYLE'));
    out.p(70, 0); out.p(40, st.height || 0); out.p(41, st.widthFactor || 1); out.p(50, st.oblique || 0); out.p(71, 0); out.p(42, 2.5);
    const file = st.fontFile && !/\.shx$/i.test(st.fontFile) ? st.fontFile : `${st.font || 'Arial'}.ttf`;
    out.s(3, file); out.p(4, '');
  }
  out.p(0, 'ENDTAB');

  table('VIEW', 0); out.p(0, 'ENDTAB');
  table('UCS', 0); out.p(0, 'ENDTAB');
  table('APPID', 1); rec('APPID', 'ACAD', 'AcDbRegAppTableRecord', 'APPID'); out.p(70, 0); out.p(0, 'ENDTAB');

  const dimNames = ['Standard'];
  for (const n of [...(doc.header.dimStyles ?? []), ...(doc.dimStyles?.keys() ?? []), doc.header.currentDimStyle || 'Standard']) if (!dimNames.some((d) => d.toLowerCase() === n.toLowerCase())) dimNames.push(n);
  const dimModel = (n) => [...(doc.dimStyles?.values() ?? [])].find((st) => st.name.toLowerCase() === n.toLowerCase());
  const dimHandle = (k, v) => {
    const u = String(v).toUpperCase();
    if (k === 'DIMTXSTY') return styleHandle.get(u);
    const bn = blockNames.find((b) => b.toUpperCase() === u);
    return bn ? blockRec.get(bn) : undefined;
  };
  table('DIMSTYLE', dimNames.length, 'AcDbDimStyleTable');
  for (const dn of dimNames) {
    rec('DIMSTYLE', dimModel(dn)?.name ?? dn, 'AcDbDimStyleTableRecord', 'DIMSTYLE', 105);
    const model = dimModel(dn);
    if (model) { for (const [c, v] of dimStyleTags(model, dimHandle)) if (typeof v === 'string') out.s(c, v); else out.p(c, v); continue; }
    out.p(70, 0); out.p(3, ''); out.p(4, ''); out.p(40, 1); out.p(41, 2.5); out.p(42, 0.625); out.p(43, 3.75); out.p(44, 1.25);
    out.p(140, 2.5); out.p(141, 2.5); out.p(143, 0.03937007874); out.p(144, 1); out.p(146, 1); out.p(147, 0.625);
    out.p(71, 0); out.p(72, 0); out.p(73, 0); out.p(74, 0); out.p(75, 0); out.p(76, 0); out.p(77, 1); out.p(78, 8); out.p(79, 3);
    out.p(170, 0); out.p(171, 3); out.p(172, 1); out.p(173, 0); out.p(174, 0); out.p(175, 0); out.p(176, 0); out.p(177, 0); out.p(178, 0);
    out.p(271, 2); out.p(272, 2); out.p(273, 2); out.p(274, 3); out.p(275, 0); out.p(276, 0); out.p(277, 2); out.p(278, 44);
    out.p(279, 0); out.p(280, 0); out.p(281, 0); out.p(282, 0); out.p(283, 0); out.p(284, 8); out.p(285, 0); out.p(286, 0); out.p(288, 0);
    out.p(289, 3); out.p(371, -2); out.p(372, -2);
  }
  out.p(0, 'ENDTAB');

  table('BLOCK_RECORD', 1 + paperLayouts.length + blockNames.length);
  out.p(0, 'BLOCK_RECORD'); out.p(5, hModelRec); out.p(330, tbl.BLOCK_RECORD); out.p(100, 'AcDbSymbolTableRecord'); out.p(100, 'AcDbBlockTableRecord'); out.p(2, '*Model_Space'); out.p(340, hModelLayout);
  out.p(0, 'BLOCK_RECORD'); out.p(5, hPaperRec); out.p(330, tbl.BLOCK_RECORD); out.p(100, 'AcDbSymbolTableRecord'); out.p(100, 'AcDbBlockTableRecord'); out.p(2, '*Paper_Space'); out.p(340, hPaperLayout);
  for (const pl of paperLayouts.slice(1)) { out.p(0, 'BLOCK_RECORD'); out.p(5, pl.rec); out.p(330, tbl.BLOCK_RECORD); out.p(100, 'AcDbSymbolTableRecord'); out.p(100, 'AcDbBlockTableRecord'); out.s(2, pl.name); out.p(340, pl.layoutH); }
  for (const n of blockNames) { out.p(0, 'BLOCK_RECORD'); out.p(5, blockRec.get(n)); out.p(330, tbl.BLOCK_RECORD); out.p(100, 'AcDbSymbolTableRecord'); out.p(100, 'AcDbBlockTableRecord'); out.s(2, n); }
  out.p(0, 'ENDTAB');
  out.p(0, 'ENDSEC');

  // ---- blocks -------------------------------------------------------------------------------------
  out.p(0, 'SECTION'); out.p(2, 'BLOCKS');
  const layoutBlock = (name, recH) => {
    out.p(0, 'BLOCK'); out.p(5, H()); out.p(330, recH); out.p(100, 'AcDbEntity'); out.p(8, '0'); out.p(100, 'AcDbBlockBegin'); out.p(2, name); out.p(70, 0);
    out.pt(10, 0, 0, 0); out.p(3, name); out.p(1, '');
    out.p(0, 'ENDBLK'); out.p(5, H()); out.p(330, recH); out.p(100, 'AcDbEntity'); out.p(8, '0'); out.p(100, 'AcDbBlockEnd');
  };
  layoutBlock('*Model_Space', hModelRec);
  layoutBlock('*Paper_Space', hPaperRec);
  out.append(blocksOut);
  out.p(0, 'ENDSEC');

  out.p(0, 'SECTION'); out.p(2, 'ENTITIES');
  out.append(entOut);
  out.p(0, 'ENDSEC');

  // ---- objects -----------------------------------------------------------------------------------
  out.p(0, 'SECTION'); out.p(2, 'OBJECTS');
  out.p(0, 'DICTIONARY'); out.p(5, hRootDict); out.p(330, 0); out.p(100, 'AcDbDictionary'); out.p(281, 1);
  out.p(3, 'ACAD_GROUP'); out.p(350, hGroupDict); out.p(3, 'ACAD_LAYOUT'); out.p(350, hLayoutDict);
  if (!asGeometry) { out.p(3, 'ACAD_MLEADERSTYLE'); out.p(350, hMleaderDict); }
  out.p(3, 'ACAD_MLINESTYLE'); out.p(350, hMlineDict); out.p(3, 'ACAD_PLOTSTYLENAME'); out.p(350, hPlotDict);
  const dict = (h, entries) => { out.p(0, 'DICTIONARY'); out.p(5, h); out.p(330, hRootDict); out.p(100, 'AcDbDictionary'); out.p(281, 1); for (const [k, v] of entries) { out.p(3, k); out.p(350, v); } };
  dict(hGroupDict, []);
  dict(hLayoutDict, [['Model', hModelLayout], ...paperLayouts.map((pl) => [pl.lo.name, pl.layoutH])]);
  dict(hMlineDict, [['Standard', hMlineStyle]]);
  if (!asGeometry) dict(hMleaderDict, [['Standard', hMleaderStyle]]);
  out.p(0, 'ACDBDICTIONARYWDFLT'); out.p(5, hPlotDict); out.p(330, hRootDict); out.p(100, 'AcDbDictionary'); out.p(281, 1);
  out.p(3, 'Normal'); out.p(350, hPlotPlaceholder); out.p(100, 'AcDbDictionaryWithDefault'); out.p(340, hPlotPlaceholder);
  out.p(0, 'ACDBPLACEHOLDER'); out.p(5, hPlotPlaceholder); out.p(330, hPlotDict);
  const layout = (h, name, isModel, tab, ownerRec, lo = null) => {
    const p = lo?.plot, m = p?.margins ?? { l: 7.5, b: 20, r: 7.5, t: 20 };
    out.p(0, 'LAYOUT'); out.p(5, h); out.p(330, hLayoutDict); out.p(100, 'AcDbPlotSettings');
    out.s(1, p?.pageName ?? ''); if (p?.printer) out.s(2, p.printer); out.s(4, p?.paperName || 'A3'); out.p(6, ''); out.p(40, m.l); out.p(41, m.b); out.p(42, m.r); out.p(43, m.t); out.p(44, p?.paperW || 420); out.p(45, p?.paperH || 297);
    out.p(46, p?.origin.x ?? 0); out.p(47, p?.origin.y ?? 0); out.p(48, 0); out.p(49, 0); out.p(140, 0); out.p(141, 0); out.p(142, p?.scaleNum || 1); out.p(143, p?.scaleDen || 1);
    out.p(70, isModel ? 1024 : (p?.flags ?? 0)); out.p(72, p?.units ?? 1); out.p(73, p?.rotation ?? 0); out.p(74, p?.plotType ?? 5); out.p(7, ''); out.p(75, 16); out.p(76, 0); out.p(77, 2); out.p(78, 300);
    out.p(147, (p?.scaleNum || 1) / (p?.scaleDen || 1)); out.p(148, 0); out.p(149, 0);
    out.p(100, 'AcDbLayout'); out.s(1, name); out.p(70, 1); out.p(71, tab);
    out.pt(10, lo?.limMin.x ?? 0, lo?.limMin.y ?? 0, 0, false); out.pt(11, lo?.limMax.x ?? 420, lo?.limMax.y ?? 297, 0, false); out.pt(12, 0, 0, 0); out.pt(14, 1e20, 1e20, 1e20); out.pt(15, -1e20, -1e20, -1e20);
    out.p(146, 0); out.pt(13, 0, 0, 0); out.pt(16, 1, 0, 0); out.pt(17, 0, 1, 0); out.p(76, 1); out.p(330, ownerRec);
  };
  layout(hModelLayout, 'Model', true, 0, hModelRec);
  paperLayouts.forEach((pl, i) => layout(pl.layoutH, pl.lo.name, false, i + 1, pl.rec, pl.lo.plot ? pl.lo : null));
  out.p(0, 'MLINESTYLE'); out.p(5, hMlineStyle); out.p(102, '{ACAD_REACTORS'); out.p(330, hMlineDict); out.p(102, '}'); out.p(330, hMlineDict);
  out.p(100, 'AcDbMlineStyle'); out.p(2, 'Standard'); out.p(70, 0); out.p(3, ''); out.p(62, 256); out.p(51, 90); out.p(52, 90); out.p(71, 2);
  out.p(49, 0.5); out.p(62, 256); out.p(6, 'BYLAYER'); out.p(49, -0.5); out.p(62, 256); out.p(6, 'BYLAYER');
  if (!asGeometry) {
    out.p(0, 'MLEADERSTYLE'); out.p(5, hMleaderStyle); out.p(102, '{ACAD_REACTORS'); out.p(330, hMleaderDict); out.p(102, '}'); out.p(330, hMleaderDict);
    for (const [c, v] of mleaderStyleTags('__STDSTYLE__')) out.p(c, v);
  }
  out.p(0, 'ENDSEC');
  out.p(0, 'EOF');

  const text = out.text().replace('__HANDSEED__', nextHandle.toString(16).toUpperCase()).replaceAll('\r\n__STDSTYLE__\r\n', `\r\n${styleHandle.get('STANDARD')}\r\n`);

  for (const [t, n] of Object.entries(doc.skipped)) report.skipped[`${t} (not read)`] = n;
  doc.lastWriteReport = report;
  void ccwSweep;
  return text;
}

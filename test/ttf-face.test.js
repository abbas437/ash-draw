// TrueType text styles: the STYLE XDATA family and bold / italic flags give the face text is drawn in (checked
// against DWG TrueView: axis bubble letters in swissb.ttf "Swis721 BT" bold are drawn bold, as Arial bold here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ttfFace } from '../src/core/dxfRead.js';
import { buildScene } from '../src/core/render.js';
import { newDocument, addEntity } from '../src/core/model.js';

test('STYLE XDATA ACAD family / flags -> display family, bold, italic', () => {
  const x = (fam, flags) => [[1001, 'ACAD'], [1000, fam], [1071, String(flags)]];
  assert.deepEqual(ttfFace(x('Swis721 BT', 33554466), 'swissb.ttf'), { family: 'Arial', bold: true, acadFace: { family: 'Swis721 BT', flags: 33554466 } });
  assert.deepEqual(ttfFace(x('Swis721 Cn BT', 33554466), 'swisscb.ttf'), { family: 'Arial Narrow', bold: true, acadFace: { family: 'Swis721 Cn BT', flags: 33554466 } });
  assert.deepEqual(ttfFace(x('Arial', 34), 'arial.ttf'), { family: 'Arial', acadFace: { family: 'Arial', flags: 34 } });
  assert.deepEqual(ttfFace(x('Arial', 0x1000000 | 34), 'ariali.ttf'), { family: 'Arial', italic: true, acadFace: { family: 'Arial', flags: 0x1000000 | 34 } });
  assert.deepEqual(ttfFace([], 'swissb.ttf'), { family: 'Arial', bold: true }); // no XDATA: from the file name
  assert.deepEqual(ttfFace([], 'romans.shx'), {});
});

test('TEXT and MTEXT in a bold TrueType style are drawn bold in the display family', () => {
  const doc = newDocument();
  doc.textStyles.set('BOLD-HARD', { name: 'BOLD-HARD', font: 'swissb', fontFile: 'swissb.ttf', family: 'Arial', bold: true, height: 0, widthFactor: 1, oblique: 0 });
  addEntity(doc, { id: 0, type: 'TEXT', layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p: { x: 0, y: 0 }, height: 5, text: 'E', style: 'BOLD-HARD', rot: 0 });
  addEntity(doc, { id: 0, type: 'MTEXT', layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p: { x: 0, y: 20 }, height: 5, text: 'C', style: 'BOLD-HARD', rot: 0, attach: 1, width: 0 });
  const [t, m] = buildScene(doc).items.filter((it) => it.kind === 'text').sort((a, b) => a.p.y - b.p.y);
  assert.equal(t.font, 'Arial'); assert.equal(t.bold, true);
  assert.equal(m.font, 'Arial'); assert.ok(m.mt.paras[0].runs.every((r) => !r.props || r.props.bold), 'MTEXT runs bold');
});

test('the STYLE face XDATA is written back as read', async () => {
  const { parseDxf } = await import('../src/core/dxfRead.js');
  const { writeDxf } = await import('../src/core/dxfWrite.js');
  const doc = newDocument();
  doc.textStyles.set('BOLD-HARD', { name: 'BOLD-HARD', font: 'swissb', fontFile: 'swissb.ttf', family: 'Arial', bold: true, height: 0, widthFactor: 1, oblique: 0, acadFace: { family: 'Swis721 BT', flags: 33554466 } });
  addEntity(doc, { id: 0, type: 'TEXT', layer: '0', color: 256, linetype: 'BYLAYER', lineweight: -1, ltscale: 1, p: { x: 0, y: 0 }, height: 5, text: 'E', style: 'BOLD-HARD', rot: 0 });
  const st = parseDxf(writeDxf(doc)).textStyles.get('BOLD-HARD');
  assert.deepEqual([st.family, st.bold, st.acadFace], ['Arial', true, { family: 'Swis721 BT', flags: 33554466 }]);
});

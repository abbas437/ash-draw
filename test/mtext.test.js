import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMText, serializeMText, layoutMText, mtextPlain } from '../src/core/mtext.js';
import { plainText } from '../src/core/dxfRead.js';

const runs = (raw, o) => parseMText(raw, o).paras.flatMap((p) => p.runs);
const one = (raw, o) => runs(raw, o).find((r) => r.text);

test('paragraphs, nbsp, escapes and specials', () => {
  assert.equal(parseMText('a\\Pb\\Pc').paras.length, 3);
  assert.equal(mtextPlain('a\\~b'), 'a\u00A0b');
  assert.equal(mtextPlain('\\{x\\} \\\\ y'), '{x} \\ y');
  assert.equal(mtextPlain('%%c25 %%d %%p1'), 'Ø25 ° ±1');
  assert.ok(!plainText('\\{c\\}').includes('\u0001'));
  assert.equal(plainText('\\{c\\}'), '{c}');
});

test('groups nest and restore properties', () => {
  const r = runs('{\\C1;red {\\H2x;big} red}plain', { height: 2 });
  assert.deepEqual(r.map((x) => [x.text, x.props.color?.aci ?? null, x.props.h]),
    [['red ', 1, 2], ['big', 1, 4], [' red', 1, 2], ['plain', null, 2]]);
});

test('underline / overline / strike', () => {
  const r = runs('\\Lu\\l\\Oo\\o\\Kk\\kn');
  assert.deepEqual(r.map((x) => [x.text, x.props.u, x.props.o, x.props.k]),
    [['u', true, false, false], ['o', false, true, false], ['k', false, false, true], ['n', false, false, false]]);
});

test('colour: ACI and true colour (BGR)', () => {
  assert.deepEqual(one('\\C3;g').props.color, { aci: 3 });
  assert.equal(one('\\C256;g').props.color, null);
  assert.deepEqual(one('\\c779263;y').props.color, { rgb: [255, 227, 11] });
});

test('height absolute and relative, font flags, oblique, width, tracking, alignment', () => {
  assert.equal(one('\\H2.5;x', { height: 1 }).props.h, 2.5);
  assert.equal(one('\\H3;\\H0.5x;x').props.h, 1.5);
  const f = one('\\fArial|b1|i1|c0|p34;x').props;
  assert.deepEqual([f.font, f.bold, f.italic], ['Arial', true, true]);
  assert.equal(one('\\FTimes|b0;x').props.font, 'Times');
  assert.equal(one('\\Q15;x').props.oblique, 15);
  assert.equal(one('\\W0.8;x').props.wf, 0.8);
  assert.equal(one('\\T1.5;x').props.track, 1.5);
  assert.equal(one('\\A1;x').props.valign, 1);
  assert.equal(parseMText('\\pxqc;centre').paras[0].align, 1);
});

test('stacking: / ^ #', () => {
  for (const [raw, type] of [['\\S1/2;', '/'], ['\\S1^ 2;', '^'], ['\\S1#2;', '#']]) {
    const st = runs(raw)[0].stack;
    assert.deepEqual(st, { a: '1', b: '2', type }, raw);
  }
  assert.equal(mtextPlain('\\S1/2; INCH'), '1/2 INCH');
  const lay = layoutMText(parseMText('\\S1/2;'));
  assert.equal(lay.glyphs.length, 2);
  assert.equal(lay.rules.length, 1, 'fraction bar');
  assert.ok(lay.glyphs[0].y < lay.glyphs[1].y, 'numerator above denominator (y down)');
});

test('unknown codes are kept verbatim', () => {
  const raw = 'a\\X\\pi1.5;b';
  assert.deepEqual(runs(raw).filter((r) => r.raw).map((r) => r.raw), ['\\X', '\\pi1.5;']);
  assert.equal(serializeMText(parseMText(raw)), raw);
});

test('round trip parse -> serialise -> parse', () => {
  for (const raw of ['{\\fArial|b1;Bold} normal \\C1;red\\Pline2', '\\H2.5;big{\\H0.5x;small}', '\\LU\\l {\\c779263;y} \\S1/2; \\{e\\}\\~f',
    '\\pxqr;right\\Pnext', '{\\Q10;\\W0.8;\\T1.2;\\A2;\\O\\Kx}']) {
    const m = parseMText(raw, { height: 2 });
    assert.deepEqual(parseMText(serializeMText(m, { height: 2 }), { height: 2 }), m, raw);
  }
});

test('layout: paragraphs make lines, word wrap at the box width, attachment', () => {
  const m = parseMText('{\\fArial|b1;Bold} normal \\C1;red\\Pline2');
  const lay = layoutMText(m);
  assert.equal(lay.lines.length, 2);
  assert.ok(lay.glyphs.some((g) => g.bold && g.text === 'Bold'));
  assert.ok(lay.glyphs.find((g) => g.text === 'line2').y > lay.glyphs.find((g) => g.text === 'red').y);
  // width 4 units, 0.6 per char at h=1: 'aaa bbb ccc' wraps to three lines
  const w = layoutMText(parseMText('aaa bbb ccc'), { width: 4 });
  assert.deepEqual(w.lines.map((l) => l.parts.map((p) => p.text).join('')), ['aaa', 'bbb', 'ccc']);
  assert.equal(layoutMText(parseMText('aaa bbb ccc'), { width: 0 }).lines.length, 1);
  const right = layoutMText(parseMText('ab'), { attach: 9 });
  assert.ok(right.glyphs[0].x < 0 && right.glyphs[0].y < 0, 'bottom-right attachment puts text up-left of the point');
  const sp = layoutMText(parseMText('a\\Pb'), { lineSpacing: 2 });
  assert.ok(Math.abs((sp.lines[1].y - sp.lines[0].y) - 2.5) < 1e-9);
});

// ASH Draw Studio - the built-in symbol set: simple, generic HVAC / MEP plan symbols drawn here in code (original
// work, MIT like the rest of the app; no third-party drawing is copied). Pure ES module (no DOM).
//
// Every symbol is in millimetres ($INSUNITS 4) with its base point at 0,0.
//  - Equipment symbols (diffusers, grilles, dampers, VAV, FCU, AHU, fan) are drawn at a plausible real size: they are
//    inserted at 1:1 (only the units ratio applies).
//  - Device symbols (detectors, sprinklers, valves, sockets…) are paper-size symbols (paper: true), drawn as they
//    should appear on the printed sheet; the panel's "Drawing scale 1:N" multiplies them on insertion.
import { makeLine, makeCircle, makeArc, makePolyline, makeText } from './model.js';
import { makeAttdef } from './blocks.js';

const L = (x1, y1, x2, y2) => makeLine({ x: x1, y: y1 }, { x: x2, y: y2 });
const C = (x, y, r) => makeCircle({ x, y }, r);
const A = (x, y, r, a0, a1) => makeArc({ x, y }, r, a0 * Math.PI / 180, a1 * Math.PI / 180);
const P = (pts, closed = true) => makePolyline(pts.map(([x, y]) => ({ x, y })), closed);
const R = (w, h, cx = 0, cy = 0) => P([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]);
const T = (x, y, h, s) => { const t = makeText({ x, y }, h, s); t.hAlign = 1; t.vAlign = 2; t.p2 = { x, y }; return t; };
const X = (w, h) => [L(-w / 2, -h / 2, w / 2, h / 2), L(-w / 2, h / 2, w / 2, -h / 2)];
const tag = (y, h, name, def) => makeAttdef({ x: 0, y }, h, name, { prompt: `${name[0]}${name.slice(1).toLowerCase()}`, default: def });
/** duct-line component on a W-wide duct running along x, length len */
const duct = (w, len) => [L(-len / 2, -w / 2, len / 2, -w / 2), L(-len / 2, w / 2, len / 2, w / 2)];
/** inline valve body: two triangles meeting at the centre, s = paper size */
const bowtie = (s) => [P([[-s, -s / 2], [-s, s / 2], [0, 0]]), P([[s, -s / 2], [s, s / 2], [0, 0]])];

const DEFS = [
  // ---- Air terminals (real size, mm) ----
  ['Air terminals', 'Ceiling Diffuser 4-Way', () => [R(600, 600), R(300, 300), L(-300, -300, -150, -150), L(300, -300, 150, -150), L(300, 300, 150, 150), L(-300, 300, -150, 150), L(-80, 0, 80, 0), L(0, -80, 0, 80)]],
  ['Air terminals', 'Linear Slot Diffuser', () => [R(1200, 100), L(-580, -15, 580, -15), L(-580, 15, 580, 15)]],
  ['Air terminals', 'Return Grille', () => [R(600, 300), ...X(600, 300)]],
  ['Air terminals', 'Exhaust Grille', () => [R(300, 300), ...X(300, 300), C(0, 0, 60)]],
  ['Air terminals', 'Round Diffuser', () => [C(0, 0, 200), C(0, 0, 130), C(0, 0, 60)]],
  // ---- Ductline components (on a 400 mm duct) ----
  ['Ductline components', 'Fire Damper', () => [...duct(400, 300), L(-150, -200, -150, 200), L(150, -200, 150, 200), L(-150, -200, 150, 200), T(0, 300, 100, 'FD')]],
  ['Ductline components', 'Motorised Damper', () => [...duct(400, 300), L(-150, -200, -150, 200), L(150, -200, 150, 200), L(-100, -150, 100, 150), C(0, 0, 25), L(0, 200, 0, 300), R(150, 100, 0, 350), T(0, 350, 60, 'M')]],
  ['Ductline components', 'Volume Control Damper', () => [...duct(400, 300), L(-150, -200, -150, 200), L(150, -200, 150, 200), L(-100, -150, 100, 150), C(0, 0, 25), T(0, 300, 100, 'VCD')]],
  ['Ductline components', 'Flexible Connection', () => [...duct(400, 300), L(-60, -200, -60, 200), L(60, -200, 60, 200), ...[-150, -50, 50, 150].map((y) => L(-60, y - 50, 60, y + 50))]],
  ['Ductline components', 'Turning Vanes', () => [L(-200, -200, -200, 200), L(-200, 200, 200, 200), L(200, -200, 200, 200), ...[100, 200, 300].map((r) => A(-200, -200, r, 0, 90))]],
  ['Ductline components', 'Attenuator', () => [...duct(400, 900), R(900, 520), ...[-300, -100, 100, 300].map((x) => R(60, 400, x, 0))]],
  // ---- AHU and equipment (real size) ----
  ['Equipment', 'VAV Box', () => [R(600, 400), C(-300, 0, 125), L(-150, -200, -150, 200), T(80, 0, 100, 'VAV'), tag(-320, 80, 'TAG', 'VAV-01')]],
  ['Equipment', 'Fan Coil Unit', () => [R(1000, 600), L(-500, -200, 500, -200), C(-200, 50, 120), C(200, 50, 120), T(0, -350, 100, 'FCU'), tag(-480, 80, 'TAG', 'FCU-01')]],
  ['Equipment', 'Air Handling Unit', () => [R(4000, 1500), ...[-1200, -400, 400, 1200].map((x) => L(x, -750, x, 750)), ...X(800, 1500).map((l) => ({ ...l, p1: { x: l.p1.x - 1600, y: l.p1.y }, p2: { x: l.p2.x - 1600, y: l.p2.y } })), C(800, 0, 500), T(0, 900, 200, 'AHU'), tag(-1050, 150, 'TAG', 'AHU-01')]],
  ['Equipment', 'Axial Fan', () => [R(600, 500), C(0, 0, 220), P([[0, 0], [-150, 150], [-60, 200]]), P([[0, 0], [150, -150], [60, -200]])]],
  ['Equipment', 'Centrifugal Fan', () => [C(0, 0, 300), P([[0, 300], [500, 300], [500, 100], [280, 100]], false), C(0, 0, 60)]],
  // ---- Fire (paper size, mm on the sheet) ----
  ['Fire', 'Smoke Detector', () => [C(0, 0, 2.5), T(0, 0, 1.8, 'S')], true],
  ['Fire', 'Heat Detector', () => [C(0, 0, 2.5), T(0, 0, 1.8, 'H')], true],
  ['Fire', 'Sprinkler Pendent', () => [C(0, 0, 1.5), L(-2.5, 0, 2.5, 0), L(0, -2.5, 0, 0)], true],
  ['Fire', 'Sprinkler Upright', () => [C(0, 0, 1.5), L(-2.5, 0, 2.5, 0), L(0, 0, 0, 2.5)], true],
  ['Fire', 'Fire Extinguisher', () => [P([[-2, -3], [2, -3], [0, 3]]), T(0, -1, 1.5, 'E')], true],
  ['Fire', 'Hose Reel', () => [R(5, 5), C(0, 0, 1.8), C(0, 0, 0.6)], true],
  ['Fire', 'Manual Call Point', () => [R(5, 5), C(0, 0, 1.5), L(-2.5, -2.5, 2.5, 2.5)], true],
  ['Fire', 'Sounder Beacon', () => [C(0, 0, 2.5), P([[-1.2, -1], [0, -1], [1.2, -2], [1.2, 2], [0, 1], [-1.2, 1]])], true],
  // ---- Electrical (paper size) ----
  ['Electrical', 'Light Fitting', () => [C(0, 0, 2.5), ...X(3.5, 3.5)], true],
  ['Electrical', 'Socket Outlet', () => [A(0, 0, 2.5, 0, 180), L(-2.5, 0, 2.5, 0), L(0, 2.5, 0, 4)], true],
  ['Electrical', 'Isolator', () => [R(5, 5), L(-1.8, -1.2, 1.8, 1.2), C(-1.8, -1.2, 0.4)], true],
  ['Electrical', 'Thermostat', () => [C(0, 0, 2.5), T(0, 0, 1.8, 'T')], true],
  // ---- Pipework (paper size, inline along x) ----
  ['Pipework', 'Gate Valve', () => [...bowtie(2.5), L(0, 0, 0, 2.5), L(-1, 2.5, 1, 2.5)], true],
  ['Pipework', 'Globe Valve', () => [...bowtie(2.5), C(0, 0, 0.6)], true],
  ['Pipework', 'Check Valve', () => [...bowtie(2.5), L(-2.5, -1.25, 2.5, 1.25)], true],
  ['Pipework', 'Butterfly Valve', () => [L(-2.5, -1.5, -2.5, 1.5), L(2.5, -1.5, 2.5, 1.5), L(-2.5, -1.5, 2.5, 1.5), C(0, 0, 0.5)], true],
  ['Pipework', 'Ball Valve', () => [...bowtie(2.5), C(0, 0, 1)], true],
  ['Pipework', 'Strainer', () => [L(-2.5, 0, 2.5, 0), P([[-1.5, 0], [1.5, 0], [0, -2.5]]), L(-0.8, -1.2, 0.8, -1.2)], true],
  ['Pipework', 'Pump', () => [C(0, 0, 2.5), L(0, 2.5, 2.5, 2.5), L(-2.5, 0, -4, 0), L(2.5, 2.5, 4, 2.5)], true],
  ['Pipework', 'Pressure Gauge', () => [C(0, 4, 1.8), L(0, 0, 0, 2.2), L(0, 4, 1, 5)], true],
  ['Pipework', 'Thermometer', () => [L(0, 0, 0, 2), C(0, 2.6, 0.6), L(-0.4, 3.2, -0.4, 6), L(0.4, 3.2, 0.4, 6), A(0, 6, 0.4, 0, 180)], true],
  ['Pipework', 'Flow Switch', () => [C(0, 2.5, 1.8), L(0, 0, 0, 0.7), T(0, 2.5, 1.4, 'FS')], true],
];

/** the built-in symbols: [{ id, category, name, base, units, entities, blocks, paper }] (fresh copies each call) */
export function builtinSymbols() {
  return DEFS.map(([category, name, draw, paper = false]) => ({
    id: `builtin:${name}`, category, name, base: { x: 0, y: 0 }, units: 4, entities: draw(), blocks: new Map(), paper,
  }));
}
export const BUILTIN_CATEGORIES = [...new Set(DEFS.map((d) => d[0]))];

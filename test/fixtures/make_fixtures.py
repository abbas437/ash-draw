#!/usr/bin/env python3
"""Generate DXF fixtures + expected.json for ash-draw tests. Run: python3 test/fixtures/make_fixtures.py"""
import json
import math
import os
import random
from collections import Counter

import ezdxf
from ezdxf.enums import TextEntityAlignment

HERE = os.path.dirname(os.path.abspath(__file__))
EXPECTED = {}


def new(ver="R2000", setup=True):
    return ezdxf.new(ver, setup=setup)


def save(doc, name, notes=""):
    path = os.path.join(HERE, name)
    doc.saveas(path)
    back = ezdxf.readfile(path)
    counts = Counter(e.dxftype() for e in back.modelspace())
    EXPECTED[name] = {
        "version": back.dxfversion,
        "entityCounts": dict(counts),
        "layers": [l.dxf.name for l in back.layers],
        "notes": notes,
    }


def basic():
    doc = new()
    doc.layers.add("WALLS", color=1)
    doc.layers.add("DIMS", color=3)
    doc.layers.add("HIDDEN", linetype="DASHED").off()
    doc.layers.add("FROZEN").freeze()
    m = doc.modelspace()
    m.add_line((0, 0), (10, 0), dxfattribs={"layer": "WALLS"})
    m.add_line((10, 0), (10, 8), dxfattribs={"layer": "DIMS"})
    m.add_line((0, 0), (10, 8), dxfattribs={"layer": "HIDDEN"})
    m.add_circle((20, 5), 3)
    m.add_circle((30, 5), 1.5, dxfattribs={"layer": "FROZEN"})
    m.add_arc((0, 20), 5, -30, 60)  # crosses 0 deg (330 -> 60)
    m.add_arc((15, 20), 5, 300, 40)  # a0 > a1 wrap
    m.add_ellipse((30, 20), major_axis=(6, 0), ratio=0.5)
    m.add_ellipse((45, 20), major_axis=(6, 2), ratio=0.4, start_param=0.5, end_param=4.0)
    m.add_point((50, 0))
    m.add_solid([(0, 30), (5, 30), (0, 34), (5, 34)])
    save(doc, "basic_r2000.dxf", "HIDDEN layer off, FROZEN layer frozen (one entity each); arcs: one crosses 0deg, one wraps a0>a1; ellipse full + elliptical arc")


def polylines():
    doc = new()
    m = doc.modelspace()
    m.add_lwpolyline([(0, 0), (5, 0), (5, 5), (0, 8)])
    m.add_lwpolyline([(10, 0), (15, 0), (15, 5), (10, 5)], close=True)
    m.add_lwpolyline([(20, 0, 0), (26, 0, 1), (26, 4, -0.5), (20, 4, 0.3)], format="xyb")  # bulge 1 = semicircle, negative bulge
    m.add_lwpolyline([(30, 0), (36, 0), (36, 5)], dxfattribs={"const_width": 0.4})
    m.add_polyline2d([(0, 15), (5, 15), (8, 18), (12, 14)], dxfattribs={"lineweight": 80})
    save(doc, "polylines_r2000.dxf", "4 LWPOLYLINE (open, closed, bulges 1/-0.5/0.3, const width 0.4) + 1 heavy 2D POLYLINE (lineweight 80)")


def splines():
    doc = new()
    m = doc.modelspace()
    m.add_open_spline([(0, 0), (3, 6), (6, -2), (9, 5), (12, 0)], degree=3)
    m.add_rational_spline([(0, 10), (3, 16), (6, 8), (9, 15), (12, 10)], weights=[1, 2, 1, 3, 1], degree=3)
    m.add_spline(fit_points=[(0, 25), (4, 30), (8, 24), (12, 29)])
    m.add_spline(fit_points=[(25, 5), (30, 10), (35, 5), (30, 0)]).closed = True
    save(doc, "splines_r2000.dxf", "SPLINEs: control-point degree 3, rational with weights, fit-point, closed (fit points)")


def text():
    doc = new()
    doc.styles.add("NOTES", font="arial.ttf")
    m = doc.modelspace()
    m.add_text("Rotated %%c25 %%d %%p0.5", height=2, rotation=30, dxfattribs={"style": "NOTES", "width": 0.8}).set_placement((0, 0))
    t = m.add_text("Centred", height=2.5)
    t.set_placement((20, 10), align=TextEntityAlignment.MIDDLE_CENTER)
    m.add_text("Plain %%c25 %%d %%p", height=2).set_placement((0, 20))
    m.add_mtext("Line one\\PLine two {\\fArial|b1;bold} 45\\U+00B0 \\H2x;BIG", dxfattribs={"char_height": 2, "insert": (0, 40), "style": "NOTES", "width": 30})
    save(doc, "text_r2000.dxf", "TEXT x3 (rotated+width factor 0.8, centred, %%c %%d %%p codes), MTEXT with \\P, bold font run, \\U+00B0, \\H2x; ; STYLE NOTES")


def blocks():
    doc = new()
    box = doc.blocks.new("BOX")
    box.add_lwpolyline([(0, 0), (4, 0), (4, 3), (0, 3)], close=True)
    box.add_circle((2, 1.5), 1)
    room = doc.blocks.new("ROOM")
    room.add_lwpolyline([(0, 0), (12, 0), (12, 8), (0, 8)], close=True)
    room.add_blockref("BOX", (1, 1))
    anon = doc.blocks.new("*U1")  # anonymous-style block, unreferenced
    anon.add_line((0, 0), (1, 1))
    m = doc.modelspace()
    m.add_blockref("BOX", (0, 0))
    m.add_blockref("BOX", (10, 0), dxfattribs={"xscale": 2, "yscale": 2, "rotation": 30})
    m.add_blockref("BOX", (30, 0), dxfattribs={"xscale": -1, "yscale": 1})
    m.add_blockref("ROOM", (0, 20))
    m.add_blockref("BOX", (30, 20), dxfattribs={"row_count": 2, "column_count": 3, "row_spacing": 6, "column_spacing": 7})
    save(doc, "blocks_r2000.dxf", "5 INSERTs: 3 BOX (scale1, scale2/rot30, mirrored xscale -1), 1 nested ROOM(BOX), 1 array 3 cols x 2 rows; unreferenced block *U1")


def hatches():
    doc = new()
    m = doc.modelspace()
    h = m.add_hatch(color=2)
    h.paths.add_polyline_path([(0, 0), (10, 0), (10, 6), (0, 6)], is_closed=True)
    h2 = m.add_hatch(color=1)
    h2.set_pattern_fill("ANSI31", scale=0.5)
    ep = h2.paths.add_edge_path()
    ep.add_line((20, 0), (30, 0))
    ep.add_line((30, 0), (30, 5))
    ep.add_arc((25, 5), 5, 0, 180, ccw=True)
    ep.add_line((20, 5), (20, 0))
    h3 = m.add_hatch(color=3)
    h3.paths.add_polyline_path([(0, 15), (14, 15), (14, 29), (0, 29)], is_closed=True)
    h3.paths.add_polyline_path([(4, 19), (10, 19), (10, 25), (4, 25)], is_closed=True)
    save(doc, "hatch_r2000.dxf", "3 HATCH: solid polyline boundary; ANSI31 with edge-path incl. arc; solid with island (outer+inner loop)")


def dims():
    doc = new()
    m = doc.modelspace()
    m.add_linear_dim(base=(5, 5), p1=(0, 0), p2=(10, 0)).render()
    m.add_aligned_dim(p1=(0, 10), p2=(8, 16), distance=2).render()
    m.add_circle((30, 5), 4)
    m.add_radius_dim(center=(30, 5), radius=4, angle=45).render()
    m.add_circle((30, 20), 4)
    m.add_diameter_dim(center=(30, 20), radius=4, angle=135).render()
    m.add_angular_dim_3p(base=(5, 28), center=(0, 25), p1=(8, 25), p2=(5, 33)).render()
    note = "5 DIMENSIONs rendered to anonymous blocks (*D..)"
    try:
        m.add_leader([(0, 40), (5, 43), (9, 43)])
        note += " + LEADER"
    except Exception as exc:  # noqa: BLE001
        note += f"; LEADER skipped ({exc})"
    save(doc, "dims_r2000.dxf", note)


def colors():
    doc = new()
    doc.header["$LTSCALE"] = 0.5
    blk = doc.blocks.new("BYB")
    blk.add_line((0, 0), (5, 0), dxfattribs={"color": 0})  # BYBLOCK
    blk.add_circle((2.5, 0), 1, dxfattribs={"color": 0, "linetype": "BYBLOCK"})
    m = doc.modelspace()
    y = 0
    for aci in (1, 7, 30, 140, 250):
        m.add_line((0, y), (10, y), dxfattribs={"color": aci})
        y += 2
    m.add_line((0, y), (10, y), dxfattribs={"color": 256})  # BYLAYER
    y += 2
    m.add_line((0, y), (10, y), dxfattribs={"true_color": ezdxf.rgb2int((12, 200, 240))})
    y += 2
    for lw in (25, 50, -1):
        m.add_line((0, y), (10, y), dxfattribs={"lineweight": lw})
        y += 2
    for lt in ("DASHED", "CENTER", "PHANTOM", "DASHDOT"):
        m.add_line((0, y), (10, y), dxfattribs={"linetype": lt})
        y += 2
    m.add_line((0, y), (10, y), dxfattribs={"linetype": "DASHED", "ltscale": 0.5})
    m.add_blockref("BYB", (20, 0), dxfattribs={"color": 1})
    m.add_blockref("BYB", (20, 5), dxfattribs={"color": 5, "true_color": ezdxf.rgb2int((200, 40, 40))})
    save(doc, "colors_r2000.dxf", "ACI 1,7,30,140,250, BYLAYER(256), truecolor, lineweights 25/50/-1, 4 linetypes, entity ltscale 0.5, global LTSCALE 0.5, BYBLOCK entities in block BYB")


def versions():
    for ver, name, uni in (("R12", "r12_ac1009.dxf", False), ("R2007", "r2007_ac1021.dxf", True), ("R2018", "r2018_ac1032.dxf", True)):
        doc = ezdxf.new(ver, setup=False)
        m = doc.modelspace()
        m.add_line((0, 0), (10, 0))
        m.add_line((10, 0), (10, 10))
        m.add_circle((5, 5), 3)
        m.add_arc((0, 10), 4, 0, 90)
        if ver == "R12":
            m.add_polyline2d([(20, 0), (25, 0), (25, 5)])
            m.add_text("ASCII text", height=2).set_placement((0, 20))
            note = "R12: ASCII only, POLYLINE instead of LWPOLYLINE"
        else:
            m.add_lwpolyline([(20, 0), (25, 0), (25, 5)])
            m.add_text("café ü ا", height=2).set_placement((0, 20))
            note = "non-ASCII text: e-acute, u-umlaut, Arabic alef"
        save(doc, name, note)


def extrusion():
    doc = new()
    m = doc.modelspace()
    ex = {"extrusion": (0, 0, -1)}
    m.add_circle((10, 5), 3, dxfattribs=dict(ex))
    m.add_arc((20, 5), 4, 10, 100, dxfattribs=dict(ex))
    m.add_lwpolyline([(30, 0), (36, 0), (36, 5)], dxfattribs=dict(ex))
    m.add_line((0, 0, 5), (10, 10, 5))
    save(doc, "extrusion_r2000.dxf", "CIRCLE/ARC/LWPOLYLINE with extrusion (0,0,-1) => mirrored OCS (x flips); LINE at z=5 for 3D flattening")


def unsupported():
    doc = new()
    m = doc.modelspace()
    m.add_3dface([(0, 0, 0), (5, 0, 1), (5, 5, 2), (0, 5, 1)])
    notes = "Skippable: 3DFACE, XLINE, RAY"
    try:
        pm = m.add_polymesh((3, 3))
        for i in range(3):
            for j in range(3):
                pm.set_mesh_vertex((i, j), (10 + i * 2, j * 2, (i + j) % 2))
        notes += ", polyface/polymesh POLYLINE"
    except Exception as exc:  # noqa: BLE001
        notes += f" (polymesh skipped: {exc})"
    m.add_xline((0, 0), (1, 1))
    m.add_ray((0, 0), (1, 0))
    m.add_line((0, 20), (10, 20))
    m.add_line((0, 22), (10, 22))
    notes += "; 2 LINEs must still load. MESH and IMAGEDEF omitted."
    save(doc, "unsupported_r2000.dxf", notes)


def binary():
    random.seed(7)
    data = b"AutoCAD Binary DXF\r\n\x1a\x00" + bytes(random.randrange(256) for _ in range(24))
    with open(os.path.join(HERE, "binary_sentinel.dxf"), "wb") as f:
        f.write(data)
    EXPECTED["binary_sentinel.dxf"] = {
        "version": None,
        "entityCounts": {},
        "layers": [],
        "notes": "22-byte binary DXF sentinel + random bytes; importer must reject as BINARY_DXF",
    }


def big_grid():
    doc = new(setup=False)
    m = doc.modelspace()
    rnd = random.Random(1)
    for i in range(20000):
        x = (i % 200) * 5.0
        y = (i // 200) * 5.0
        m.add_line((x, y), (x + 3.0, y + round(rnd.random() * 3, 1)))
    for i in range(2000):
        m.add_circle(((i % 50) * 20.0, (i // 50) * 20.0 + 600.0), 2.5)
    save(doc, "big_grid_r2000.dxf", "performance: 20000 LINE + 2000 CIRCLE")


def new_setup_fix():
    pass


if __name__ == "__main__":
    # new(setup=False) default arg order: keep new() signature compatible
    for fn in (basic, polylines, splines, text, blocks, hatches, dims, colors, versions, extrusion, unsupported, binary, big_grid):
        fn()
    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(EXPECTED, f, indent=2)
    print(f"wrote {len(EXPECTED)} fixtures")

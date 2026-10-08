#!/usr/bin/env python3
"""Layouts fixture: 2 paper-space layouts, each with a title text and one 1:50 viewport (view height 5000 / 100)."""
import sys
import ezdxf

doc = ezdxf.new('R2000', setup=False)
doc.header['$INSUNITS'] = 4
doc.layers.add('HIDE')
doc.layers.add('VP')
msp = doc.modelspace()
msp.add_line((0, 0), (1000, 0))
msp.add_circle((500, 500), 200, dxfattribs={'layer': 'HIDE'})
for i, name in enumerate(['Layout1', 'Layout2']):
    lay = doc.layouts.get('Layout1') if i == 0 else doc.layouts.new('Layout2')
    lay.page_setup(size=(420, 297), margins=(10, 10, 10, 10), units='mm')
    lay.add_text(f'TITLE {name}', height=5, dxfattribs={'insert': (300, 20)})
    vp = lay.add_viewport(center=(200, 150), size=(300, 100), view_center_point=(500, 0), view_height=5000, dxfattribs={'layer': 'VP'})
    vp.frozen_layers = ['HIDE']
doc.saveas(sys.argv[1] if len(sys.argv) > 1 else 'layouts_r2000.dxf')

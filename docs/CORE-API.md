# ASH Draw Studio – core API (src/core)

Pure ES modules (no DOM, no Node built-ins) that run in the renderer, in Node tests and in the electron main process.
All coordinates are drawing units, **Y up**. Angles: ARC `a0/a1` degrees CCW; ELLIPSE `a0/a1` radians (parameter);
TEXT/MTEXT/INSERT `rot` degrees CCW. Matrices are canvas-style `[a,b,c,d,e,f]`.

## model.js
`newDocument()` → `{units, layers:Map, linetypes:Map, textStyles:Map, blocks:Map, entities:[], skipped:{}, header:{}, nextId, lastWriteReport}`.
Layer `{name,color,linetype,lineweight,visible,frozen,locked,plot}`. Linetype `{name,description,pattern:[dash,+/-gap,0=dot]}` (key = UPPERCASE name).
Block `{name, base:{x,y}, entities:[]}`.
Entity base fields: `id, type, layer, color (ACI int | 256 BYLAYER | 0 BYBLOCK | {r,g,b}), linetype ('BYLAYER'), lineweight (mm | -1 BYLAYER | -2 BYBLOCK | -3 default), ltscale, invisible?`.
Types and own fields:
LINE `p1,p2` · CIRCLE `c,r` · ARC `c,r,a0,a1` · ELLIPSE `c,major(vector),ratio,a0,a1` · LWPOLYLINE `vertices:[{x,y,bulge}],closed` ·
SPLINE `degree,ctrl,knots,weights,fit,closed` · TEXT `p,height,text,rot,widthFactor,style,hAlign,vAlign` · MTEXT `p,height,text,width,rot,attach,style` ·
POINT `p` · SOLID `pts` · INSERT `block,p,sx,sy,rot,cols,rows,colSp,rowSp` · DIMENSION `block,dimType,p,text,raw` (drawn through its anonymous block) ·
LEADER `pts,arrow` · HATCH `loops:[{pts,closed}|{segs}], solid, pattern, angle, scale, patLines?`.
Factories: `makeLine, makeCircle, makeArc, makeEllipse, makePolyline, makeRect, makePoint, makeText, makeMText, makeSpline, makeSolid, makeInsert, makeHatch, makeDimension, makeLeader`
(each takes geometry then an options object `{layer,color,linetype,lineweight,...}`; ids are 0 until added).
Helpers: `addEntity(doc,e)` (assigns id), `getEntity(doc,id)`, `removeEntities`, `cloneEntity`, `addLayer`, `getLayer`, `ensureLayer`, `addLinetype`, `addTextStyle`, `addBlock`, `countByType`.

## dxfRead.js / dxfWrite.js / verify.js
`readDxf(bytes)` → doc (throws `err.code` `BINARY_DXF` | `BAD_DXF`); `parseDxf(text)`; `plainText(mtextOrText)` (strips MTEXT codes, %%c/%%d/%%p).
`doc.skipped` counts entities that cannot be represented; `doc.header.paperSpaceEntities` counts ignored paper-space entities.
`writeDxf(doc, {dimensionsAsGeometry?})` → string (ASCII R2000, CRLF); sets `doc.lastWriteReport`.
`compareDocuments(a, b)` → `{ok, counts, mismatched, total}` (used to verify a DWG written by LibreDWG).

## geom.js
Matrices: `compose(a,b)` (b first), `apply(m,p)`, `translation, rotation(rad,cx,cy), scaling(sx,sy,cx,cy), mirrorLine(p1,p2), invert, isSimilarity, matScale, decompose`.
Entities: `bboxOf(e,doc)`, `docExtents(doc)`, `growBox, unionBox`, `tessellate(e,doc,tol)` → polylines, `toPrims(e,doc)`, `explode(e,doc)`,
`transformEntity(e,m)` (copy; throws `code:'SHEAR'`), `intersections(e1,e2,doc)`, `distanceToEntity(e,p,doc)`, `nearestPoint(e,p,doc)`,
`snapPoints(e,doc)` → `[{x,y,kind:'end'|'mid'|'cen'|'quad'|'node'|'ins'}]`, `offsetEntity(e,d,sidePt)`, `trimEntity(e,cutters,pick,doc)` → `{replace:[…]}|null`, `extendEntity(e,boundaries,pick)`,
`bulgeToArc, arcToBulge, ellipsePoint, ellipseAxes, ccwSweep, normAngle, DEG, dist, mid`.

## render.js
`buildScene(doc)` → `{items, byId, bbox, doc, version}` (blocks flattened, layers/colours/linetypes resolved);
`updateScene(scene, ids)` rebuilds only those entity ids; `drawScene(ctx, scene, view, opts)` with `view = {cx,cy,zoom,width,height}` (zoom = pixels per unit)
and `opts = {background, showLineweight, highlight:Set<id>, highlightColor}`; `fitView(bbox,w,h,margin)`, `screenToWorld(view,sx,sy)`, `worldToScreen(view,p)`, `zoomAt(view,sx,sy,factor)`.
Works with any CanvasRenderingContext2D (browser, `@napi-rs/canvas`).

## edit.js
`new Session(doc)` – undo/redo journal: `transact(label, fn(tx))`, `undo()`, `redo()`, `canUndo/canRedo`, `dirty`, `markSaved()`, `onChange({ids, structure, kind, label})`.
Commands (all undoable): `addEntities, eraseEntities, transformEntities, moveEntities(s,ids,dx,dy,{copy}), rotateEntities(s,ids,base,rad,{copy}), scaleEntities(s,ids,base,k,{copy}),
mirrorEntities(s,ids,p1,p2,{deleteSource}), explodeEntities, offsetCommand(s,id,d,sidePt), trimCommand(s,id,cutterIds,pick), extendCommand(s,id,boundaryIds,pick),
setEntityProps(s,ids,{layer,color,linetype,lineweight,ltscale}), setText(s,id,{text,height}), setLayerProps, deleteLayer, copyToClipboard, pasteEntities`.
Commands return `{done, failed:[{id,reason}], created?}`; they never throw for a single bad entity.

## coords.js
`parseCoordinate(text, last, direction)` – "x,y", "@dx,dy", "d<a", "@d<a", bare distance along `direction`.

## patterns.js
`patternLines(name, scale, angleDeg)`, `hasPattern`, `PATTERN_NAMES`.

## Known limits (shown to users)
Model space only (paper-space/layouts dropped on save); unsupported entities (3DFACE, XLINE, RAY, REGION, 3DSOLID, MLINE, MULTILEADER, TOLERANCE …) are skipped and counted in `doc.skipped`;
ATTRIB becomes plain TEXT; DWG *writing* goes through LibreDWG’s DXF import and is lossy (text rotation/width, some hatch edges) – the app verifies the saved DWG and warns.

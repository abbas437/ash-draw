// ASH Draw Studio - loading the raster files of a drawing's IMAGE entities.
// Fills doc.images (path as written -> { status: 'loaded' | 'notfound' | 'unreadable', bitmap }) before the scene is
// built; render.js draws a loaded image and shows the others as a red frame with the file name.

/** every distinct image path of `doc` (model space and blocks) */
function imagePaths(doc) {
  const out = new Set();
  const scan = (list) => { for (const e of list ?? []) if (e.type === 'IMAGE' && e.path) out.add(e.path); };
  scan(doc.entities);
  for (const b of doc.blocks.values()) scan(b.entities);
  for (const lo of doc.layouts ?? []) scan(lo.entities);
  return [...out];
}

/** load the images of `doc` (paths resolved against the host drawing's folder); resolves the paths not loaded */
export async function loadDrawingImages(api, doc, hostPath) {
  const paths = imagePaths(doc);
  if (!paths.length) return [];
  doc.images = new Map();
  const missing = [];
  for (const p of paths) {
    let entry = { status: 'notfound', bitmap: null };
    try {
      const r = hostPath ? await api.imageRead(hostPath, p) : null;
      if (r) entry = { status: 'loaded', bitmap: await createImageBitmap(new Blob([r.bytes], { type: r.mime })), file: r.path };
    } catch { entry = { status: 'unreadable', bitmap: null }; }
    doc.images.set(p, entry);
    if (entry.status !== 'loaded') missing.push(p);
  }
  return missing;
}

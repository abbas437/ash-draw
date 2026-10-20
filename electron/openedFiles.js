// The files chosen in the open dialog (dialog:open), as handed to the window: { path, name, bytes }.
// A .dwg comes back without bytes: the window converts it from the granted path (dwg:open reads it in main), so a
// drawing of up to 1.5 GB is not read here and cloned through IPC for nothing (reviewer #23).
import path from 'node:path';

/** `grant(p)`: grants the path, returns it resolved; `read(p)`: the file's bytes */
export async function openedFiles(paths, { grant, read }) {
  const out = [];
  for (const p of paths) {
    const f = { path: grant(p), name: path.basename(p) };
    if (path.extname(p).toLowerCase() !== '.dwg') f.bytes = await read(p);
    out.push(f);
  }
  return out;
}

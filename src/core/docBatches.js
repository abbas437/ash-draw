// ASH Draw Studio - handing a read document from the DXF worker to the window in pieces (renderer/dxfWorker.js), so
// that no single message takes the window long to deserialize: {head, total} (the doc with empty model-space and block
// entity lists; total = the entities still to come), then {ents} / {block, ents} batches in order, then {done: true}.
// Entities share no objects with each other or with the head (the parser builds each one fresh), so the pieces
// reassemble into the same document a single structured clone would give.

/** post(message) each piece of doc. A batch is grown or shrunk so that posting it (the structured serialize; reading
 *  it back costs about twice that on the receiving thread) takes about targetMs. */
export function postDocInBatches(doc, post, { targetMs = 12, first = 500 } = {}) {
  const blocks = new Map(), lists = [];
  let total = doc.entities.length;
  for (const [name, b] of doc.blocks) { blocks.set(name, { ...b, entities: [] }); if (b.entities.length) { lists.push([name, b.entities]); total += b.entities.length; } }
  post({ head: { ...doc, entities: [], blocks }, total });
  let size = first;
  const send = (block, ents) => {
    for (let i = 0; i < ents.length;) {
      const part = ents.slice(i, i + size), t = performance.now();
      post(block === null ? { ents: part } : { block, ents: part });
      const ms = performance.now() - t;
      i += part.length;
      if (part.length === size) size = Math.max(50, Math.min(50000, Math.round((size * targetMs) / Math.max(ms, 0.5))));
    }
  };
  for (const [name, ents] of lists) send(name, ents);
  send(null, doc.entities);
  post({ done: true });
}

/** the receiving side: accept(message) takes a head or batch and returns true (false for any other message);
 *  .doc is the document so far, .fraction the share of the entities received */
export function docAssembler() {
  let total = 0, got = 0;
  return {
    doc: null,
    get fraction() { return total ? got / total : 1; },
    accept(m) {
      if (m.head) { this.doc = m.head; total = m.total; return true; }
      if (!m.ents) return false;
      const into = m.block === undefined ? this.doc.entities : this.doc.blocks.get(m.block).entities;
      for (const e of m.ents) into.push(e);
      got += m.ents.length;
      return true;
    },
  };
}

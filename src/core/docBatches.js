// ASH Draw Studio - handing a read document from the DXF worker to the window in pieces (renderer/dxfWorker.js), so
// that no single message takes the window long to deserialize: {head, total} (the doc with empty model-space and block
// entity lists; total = the entities still to come), then {ents} / {block, ents} batches in order, then {done: true}.
// Entities share no objects with each other or with the head (the parser builds each one fresh), so the pieces
// reassemble into the same document a single structured clone would give. A batch's entities travel in the compact form
// of entXfer.js (post(message, transfer): its numbers are transferred), and come out of accept as the same objects.
import { encodeEnts, decodeEnts } from './entXfer.js';

/** post(message, transfer) each piece of doc. A batch is grown or shrunk so that encoding and posting it (the structured
 *  serialize; reading and decoding it back costs about twice that on the receiving thread) takes about targetMs.
 *  ready: optional () => Promise awaited before each batch (then this returns a Promise): flow control, so that the
 *  receiver never has batches queued up - read back to back they hold its thread with no timer or frame in between. */
export function postDocInBatches(doc, post, { targetMs = 12, first = 500, ready = null } = {}) {
  const steps = batchSteps(doc, post, { targetMs, first });
  if (!ready) { while (!steps.next().done); return undefined; }
  return (async () => { while (!steps.next().done) await ready(); })();
}

/** the posts of postDocInBatches; yields before each batch */
function* batchSteps(doc, post, { targetMs, first }) {
  const blocks = new Map(), lists = [];
  let total = doc.entities.length;
  for (const [name, b] of doc.blocks) { blocks.set(name, { ...b, entities: [] }); if (b.entities.length) { lists.push([name, b.entities]); total += b.entities.length; } }
  post({ head: { ...doc, entities: [], blocks }, total });
  let size = first;
  function* send(block, ents) {
    for (let i = 0; i < ents.length;) {
      yield;
      const part = ents.slice(i, i + size), t = performance.now();
      const { packet, transfer } = encodeEnts(part);
      post(block === null ? { ents: packet } : { block, ents: packet }, transfer);
      const ms = performance.now() - t;
      i += part.length;
      if (part.length === size) size = Math.max(50, Math.min(50000, Math.round((size * targetMs) / Math.max(ms, 0.5))));
    }
  }
  for (const [name, ents] of lists) yield* send(name, ents);
  yield* send(null, doc.entities);
  post({ done: true });
}

/** credits for postDocInBatches' `ready`: one batch in flight; give() (the receiver acknowledged a batch) frees it */
export function batchCredits() {
  let free = 1, wake = null;
  return {
    ready: () => (free > 0 ? (free--, Promise.resolve()) : new Promise((r) => { wake = r; })),
    give() { if (wake) { const w = wake; wake = null; w(); } else free++; },
  };
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
      const ents = Array.isArray(m.ents) ? m.ents : decodeEnts(m.ents);
      for (const e of ents) into.push(e);
      got += ents.length;
      return true;
    },
  };
}

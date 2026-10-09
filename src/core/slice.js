// ASH Draw Studio - time-sliced execution of step generators, so long jobs on the window's thread let it repaint.
// A step generator yields a progress fraction (0..1) after each small unit of work and returns its result;
// drain() runs it straight through (the synchronous path), runSliced() hands the event loop back every budgetMs.

/** run a step generator to the end, synchronously; returns its result */
export function drain(gen) {
  let r;
  while (!(r = gen.next()).done);
  return r.value;
}

/** one macrotask turn (a MessageChannel message: unlike nested setTimeout it is not clamped to 4 ms) */
export function nextTask() {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => { port1.close(); resolve(); };
    port2.postMessage(0);
  });
}

/** run a step generator in slices of about budgetMs, yielding to the event loop in between.
 *  onProgress(fraction) after each slice; `signal` (AbortSignal) rejects with Error{code:'CANCELLED'} at a slice end. */
export async function runSliced(gen, { budgetMs = 12, signal = null, onProgress = null } = {}) {
  const cancelled = () => Object.assign(new Error('Opening was cancelled.'), { code: 'CANCELLED' });
  if (signal?.aborted) throw cancelled();
  let t = performance.now();
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    if (performance.now() - t < budgetMs) continue;
    onProgress?.(r.value);
    await nextTask();
    if (signal?.aborted) { gen.return?.(); throw cancelled(); }
    t = performance.now();
  }
}

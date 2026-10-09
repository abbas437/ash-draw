// One-time hand-off of a converted drawing (DXF bytes) to the window's reader worker, by URL token.
// A token is random (192 bits), served once, and dropped when it expires, when the window releases it (a cancelled
// or failed open), or when newer hand-offs push it out — so main never holds more than `maxEntries` DXF buffers.
import { randomBytes } from 'node:crypto';

const TOKEN_RE = /^[0-9a-f]{48}$/;

export function createHandoffStore({ ttlMs = 60_000, maxEntries = 2 } = {}) {
  const entries = new Map(); // token -> {bytes, timer}, oldest first
  const drop = (token) => {
    const h = entries.get(token);
    if (!h) return null;
    entries.delete(token);
    clearTimeout(h.timer);
    return h;
  };
  return {
    /** Store the bytes; returns the token. */
    put(bytes) {
      const token = randomBytes(24).toString('hex');
      const timer = setTimeout(() => entries.delete(token), ttlMs);
      timer.unref?.();
      entries.set(token, { bytes, timer });
      while (entries.size > maxEntries) drop(entries.keys().next().value);
      return token;
    },
    /** The bytes for a token, once; null for an unknown, used, expired or malformed token. */
    take(token) {
      return TOKEN_RE.test(String(token)) ? drop(token)?.bytes ?? null : null;
    },
    /** Forget a token without serving it (no-op if already taken). */
    release(token) {
      if (TOKEN_RE.test(String(token))) drop(token);
    },
    get size() { return entries.size; },
  };
}

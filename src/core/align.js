// ASH Draw Studio - ALIGN: the 2D transform that takes source points onto destination points (AutoCAD LT ALIGN).
// Pure ES module; the matrix is in geom.js form ([a,b,c,d,e,f], applied with transformEntity / transformEntities).
import { compose, translation, rotation, scaling } from './geom.js';

const EPS = 1e-12;

/**
 * One pair (s2/d2 omitted): move s1 onto d1.
 * Two pairs: move s1 onto d1, rotate about d1 so the s1->s2 direction lies along d1->d2, and when `scale` is true
 * scale about d1 by |d2-d1| / |s2-s1| so s2 lands on d2. Coincident s1/s2 (or d1/d2) give no direction: throws.
 */
export function alignTransform(s1, d1, s2 = null, d2 = null, scale = false) {
  const move = translation(d1.x - s1.x, d1.y - s1.y);
  if (!s2 || !d2) return move;
  const sl = Math.hypot(s2.x - s1.x, s2.y - s1.y), dl = Math.hypot(d2.x - d1.x, d2.y - d1.y);
  if (sl < EPS) throw new Error('ALIGN: the source points coincide');
  if (dl < EPS) throw new Error('ALIGN: the destination points coincide');
  const turn = Math.atan2(d2.y - d1.y, d2.x - d1.x) - Math.atan2(s2.y - s1.y, s2.x - s1.x);
  const k = scale ? dl / sl : 1;
  return compose(rotation(turn, d1.x, d1.y), compose(scaling(k, k, d1.x, d1.y), move));
}

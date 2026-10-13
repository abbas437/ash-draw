// Command history view: the last 3 lines float over the bottom of the canvas (clicks go through to the canvas, the wheel
// scrolls them); F2 / View > Command history expands it upward (12 lines, selectable, Copy); Escape or F2 closes.
import { el, toast } from './ui.js';

export class CmdHistView {
  /** history: CommandHistory; the strip goes right after the canvas, below the other canvas overlays */
  constructor(history) {
    this.h = history;
    this.list = el('div', { class: 'ch-list', role: 'log', 'aria-label': 'Command history', 'aria-live': 'off' });
    this.copyBtn = el('button', { class: 'ch-copy', title: 'Copy the whole command history', onclick: () => this.copy() }, 'Copy');
    this.head = el('div', { class: 'ch-head' }, el('span', { text: 'Command history' }), el('span', { class: 'spacer' }), this.copyBtn,
      el('button', { class: 'ch-close', title: 'Close (F2, Esc)', 'aria-label': 'Close the command history', onclick: () => this.toggle(false) }, '×'));
    this.box = el('div', { class: 'ch-box' }, this.head, this.list);
    this.root = el('div', { id: 'cmdhist' }, this.box);
    const cv = document.getElementById('cv');
    cv.after(this.root);
    // collapsed, the lines take no pointer events (CSS); the wheel over them scrolls the history instead of zooming
    cv.parentElement.addEventListener('wheel', (e) => {
      if (this.open) return;
      const r = this.root.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      e.preventDefault(); e.stopPropagation();
      this.list.scrollTop += e.deltaY;
    }, { capture: true, passive: false });
    this.head.hidden = true;
    this.shown = 0;
  }
  get open() { return this.root.classList.contains('open'); }
  /** expand (true) / collapse (false) / flip (no argument) */
  toggle(on = !this.open) {
    this.root.classList.toggle('open', on);
    this.head.hidden = !on;
    this.scrollEnd();
    if (on) this.copyBtn.focus({ preventScroll: true });
  }
  /** show lines added since the last call (and drop those the history let go of) */
  update() {
    const lines = this.h.lines, add = Math.min(this.h.total - this.shown, lines.length);
    this.shown = this.h.total;
    this.list.append(...lines.slice(lines.length - add).map((t) => el('div', { class: 'ch-line', text: t || '\u00A0' })));
    while (this.list.children.length > lines.length) this.list.firstChild.remove(); // the history let go of these
    this.scrollEnd();
  }
  scrollEnd() { this.list.scrollTop = this.list.scrollHeight; }
  copy() {
    const text = this.h.toText();
    (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'))).then(() => toast('Copied to the clipboard.', 1500), () => toast('Copy failed.'));
  }
}

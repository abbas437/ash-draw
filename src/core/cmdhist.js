// Command history of one window (all tabs): every input with the prompt it answered, plus the messages commands
// choose to log (ID, LIST, errors). Keeps the last HISTORY_LIMIT lines; Up/Down recall walks the earlier inputs.

/** lines kept per window */
export const HISTORY_LIMIT = 500;

export class CommandHistory {
  constructor(limit = HISTORY_LIMIT) { this.limit = limit; this.lines = []; this.total = 0; this.inputs = []; this.at = null; }
  /** `text` typed at `prompt` (empty prompt = idle, shown as "Command"); returns the history line */
  input(prompt, text) {
    const s = String(text ?? '').trim();
    const line = `${prompt || 'Command'}: ${s}`.trimEnd();
    this._push([line]);
    if (s && this.inputs[this.inputs.length - 1] !== s) { this.inputs.push(s); if (this.inputs.length > this.limit) this.inputs.shift(); }
    this.at = null;
    return line;
  }
  /** a message (may span several lines); returns the lines added */
  message(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    this._push(lines);
    return lines;
  }
  _push(lines) {
    this.lines.push(...lines);
    this.total += lines.length; // lines ever added: a view appends the ones it has not shown yet
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
  }
  /** the last n lines, oldest first */
  last(n) { return n > 0 ? this.lines.slice(-n) : []; }
  /** the whole history as plain text (Copy) */
  toText() { return this.lines.length ? this.lines.join('\n') + '\n' : ''; }
  /** Up arrow: the next earlier input, or null when there is none */
  older() {
    if (!this.inputs.length) return null;
    this.at = this.at === null ? this.inputs.length - 1 : Math.max(0, this.at - 1);
    return this.inputs[this.at];
  }
  /** Down arrow: the next later input; '' past the newest (back to an empty line); null when not recalling */
  newer() {
    if (this.at === null) return null;
    if (this.at >= this.inputs.length - 1) { this.at = null; return ''; }
    return this.inputs[++this.at];
  }
  /** the input being recalled ('' when none) */
  get recalled() { return this.at === null ? '' : this.inputs[this.at]; }
  /** stop recalling (the user typed) */
  resetRecall() { this.at = null; }
}

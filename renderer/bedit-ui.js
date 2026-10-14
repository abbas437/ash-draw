// ASH Draw Studio - block editor UI (BEDIT / BE, BSAVE, BCLOSE, BASE inside the editor).
// The editor shows a working copy of one block definition (src/core/bedit.js) with its own Session in the Viewport, so
// every draw / modify tool and undo work on the copy. tab.bedit holds the open editor; the Model / layout tabs are
// hidden meanwhile. BSAVE writes the copy back as one undo step of the drawing.
import { openBlockEdit, blockEditError, editableBlocks, blockEditDirty, saveBlockEdit, setBlockBase } from '../src/core/bedit.js';
import { Tool, TOOL_ALIASES } from './tools.js';
import { setSpace } from './layouts-ui.js';
import { el, modal, popMenu, toast } from './ui.js';

const editorOf = (app) => (app.active?.bedit && app.vp.session === app.active.bedit.edit.session ? app.active.bedit : null);

/** the Edit Block Definition dialog: a list of the drawing's editable blocks. Resolves with a name, or null (Cancel / Esc) */
async function pickBlock(app) {
  const names = editableBlocks(app.fileDoc);
  if (!names.length) { toast('This drawing has no blocks that can be edited.'); return null; }
  const list = el('select', { name: 'block', size: String(Math.min(12, Math.max(4, names.length))), style: 'width:100%' },
    names.map((n, i) => el('option', { value: n, text: n, selected: i === 0 })));
  list.addEventListener('dblclick', () => list.closest('dialog')?.querySelector('button.primary')?.click());
  list.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); list.closest('dialog')?.querySelector('button.primary')?.click(); } });
  const r = await modal('Edit block definition', [el('p', { text: 'Block to create or edit:' }), list],
    [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]);
  return r === 'ok' ? list.value : null;
}

/** open block `name` in the block editor of the shown drawing */
export function openBlockEditor(app, name) {
  const tab = app.active;
  if (!tab) return false;
  if (tab.bedit) { toast(`Already editing block "${tab.bedit.edit.name}". Close the block editor first (BCLOSE).`); return false; }
  const err = blockEditError(tab.doc, name);
  if (err) { toast(`BEDIT: ${err}`); return false; }
  if (app.toolId) app.setTool('select');
  const prevSpace = tab.spaces?.cur ?? 'Model';
  if (prevSpace !== 'Model') setSpace(app, 'Model'); // the editor shows block space, like model space
  const vp = app.vp;
  const edit = openBlockEdit(tab.doc, name);
  tab.bedit = { edit, prevSpace, view: { cx: vp.view.cx, cy: vp.view.cy, zoom: vp.view.zoom } };
  vp.setSession(edit.session, { fit: true });
  app.refreshPanels(); app.refreshStatus();
  return true;
}

/** BSAVE: write the working copy into the drawing (one undo step) and stay in the editor */
export function saveBlockEditor(app) {
  const be = editorOf(app);
  if (!be) { toast('BSAVE works inside the block editor (BEDIT).'); return false; }
  if (app.toolId) app.setTool('select');
  try {
    const { synced } = saveBlockEdit(app.active.session, be.edit);
    toast(`Block "${be.edit.name}" saved${synced ? `; attributes updated in ${synced} reference${synced === 1 ? '' : 's'}` : ''}.`, 2500);
  } catch (e) { toast(`BSAVE: ${e.message}`); return false; }
  app.renderTabs?.();
  return true;
}

/** leave the block editor; save: true writes the copy first, false discards it */
function leave(app, save) {
  const tab = app.active, be = editorOf(app);
  if (!be) return false;
  if (save && blockEditDirty(be.edit) && !saveBlockEditor(app)) return false;
  if (app.toolId) app.setTool('select');
  tab.bedit = null;
  app.vp.setSession(tab.session, { fit: false, view: be.view });
  app.vp.emit('structure'); // the definition may have changed while the drawing's session was not shown
  if (be.prevSpace !== 'Model') setSpace(app, be.prevSpace);
  app.refreshPanels(); app.refreshStatus(); app.renderTabs?.();
  return true;
}

/** BCLOSE: unsaved changes ask Save / Discard / Cancel */
export async function closeBlockEditor(app) {
  const be = editorOf(app);
  if (!be) { toast('BCLOSE works inside the block editor (BEDIT).'); return false; }
  if (!blockEditDirty(be.edit)) return leave(app, false);
  const r = await modal('Block editor', el('p', { text: `Save changes to ${be.edit.name}?` }),
    [{ label: 'Save', value: 'save', primary: true }, { label: 'Discard', value: 'discard' }, { label: 'Cancel', value: null }]);
  if (!r || editorOf(app) !== be) return false;
  return leave(app, r === 'save');
}

/** the editor bar above the Model / layout tabs, the base point marker, and the Model / layout tabs hidden while editing */
function syncUi(app) {
  const be = editorOf(app);
  app.beditBar.hidden = !be;
  if (app.spaceBar) app.spaceBar.hidden = !!be;
  app.vp.overlay = be ? (c) => drawBaseMarker(c, app.vp, be.edit.state.base) : null;
  if (!be) return;
  app.beditBar.replaceChildren(
    el('span', { class: 'bedit-title', text: `Block editor: ${be.edit.name}` }),
    el('button', { type: 'button', 'data-bedit': 'save', title: 'BSAVE', onclick: () => saveBlockEditor(app) }, 'Save block'),
    el('button', { type: 'button', 'data-bedit': 'base', title: 'BASE', onclick: () => app.setTool('bbase') }, 'Set base point'),
    el('button', { type: 'button', 'data-bedit': 'close', title: 'BCLOSE', onclick: () => closeBlockEditor(app) }, 'Close'),
  );
}

/** UCS-style marker at the block's base point: X and Y arms with labels */
function drawBaseMarker(c, vp, base) {
  const o = vp.toScreen(base), L = 40;
  c.lineWidth = 1.5; c.setLineDash([]);
  c.strokeStyle = '#d13a3a'; c.beginPath(); c.moveTo(o.x, o.y); c.lineTo(o.x + L, o.y); c.stroke();
  c.strokeStyle = '#2a9d3a'; c.beginPath(); c.moveTo(o.x, o.y); c.lineTo(o.x, o.y - L); c.stroke();
  c.strokeStyle = vp.inkColor; c.strokeRect(o.x - 4, o.y - 4, 8, 8);
  c.fillStyle = vp.inkColor; c.font = '11px "Segoe UI", sans-serif';
  c.fillText('X', o.x + L + 3, o.y + 4); c.fillText('Y', o.x - 3, o.y - L - 4); c.fillText('Base point', o.x + 6, o.y + 16);
}

export function initBlockEditor(app) {
  app.beditBar = el('div', { id: 'beditbar', role: 'toolbar', 'aria-label': 'Block editor', hidden: true });
  document.getElementById('docs').append(app.beditBar);
  const command = (run) => new (class extends Tool { activate() { const sel = this.vp.selectedEntities(); this.h.setTool('select'); run(sel); } })(app);
  app.tools.bedit = command(async (sel) => {
    if (editorOf(app)) { toast(`Already editing block "${app.active.bedit.edit.name}". Close the block editor first (BCLOSE).`); return; }
    if (sel.length === 1 && sel[0].type === 'INSERT') { openBlockEditor(app, sel[0].block); return; }
    const name = await pickBlock(app);
    if (name) openBlockEditor(app, name);
  });
  app.tools.bsave = command(() => saveBlockEditor(app));
  app.tools.bclose = command(() => closeBlockEditor(app));
  app.tools.bbase = new (class extends Tool {
    get prompt() { return 'BASE  specify the block base point:'; }
    activate() {
      super.activate();
      if (!editorOf(app)) { toast('BASE sets the base point of a block inside the block editor (BEDIT).'); this.h.setTool('select'); }
    }
    click(p) {
      const be = editorOf(app);
      if (be) setBlockBase(be.edit, p);
      this.h.setTool('select');
    }
  })(app);
  Object.assign(TOOL_ALIASES, { bedit: 'bedit', be: 'bedit', bsave: 'bsave', bclose: 'bclose', base: 'bbase' });
  app.vp.on('doc', () => syncUi(app));
  app.vp.on('change', () => { if (editorOf(app)) app.vp.requestRender(); });

  // right-click a selected block reference: "Edit block" (other selections keep right-click = Enter)
  const sel = app.tools.select, plain = sel.rightClick.bind(sel);
  sel.rightClick = (p, ev) => {
    const one = !sel.hot && app.vp.selection.size === 1 ? app.vp.selectedEntities()[0] : null;
    if (one?.type !== 'INSERT' || !ev) { plain(p, ev); return; }
    popMenu(ev, [['Edit block', () => openBlockEditor(app, one.block)], ['Enter', () => plain(p, ev)]]);
  };
}

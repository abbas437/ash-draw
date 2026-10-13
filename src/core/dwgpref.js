// Preference gate for the experimental DWG writer. Reviewer finding: LibreDWG R2000 files open in AutoCAD with empty layout viewports,
// so saving DWG is off unless the user turns it on in Edit > Preferences.
export const DWG_SAVE_PREF_KEY = 'dwg.allowSave';
export const DWG_SAVE_PREF_LABEL = 'Allow saving DWG (experimental — layouts may not display correctly in AutoCAD)';
/** only an explicit true enables it; anything stored or missing means off */
export const dwgSaveAllowed = (stored) => stored === true;
export const DWG_SAVE_DISABLED_TEXT = 'Saving as DWG is experimental and is turned off: layouts and viewports may appear empty when the file is opened in AutoCAD. '
  + 'To turn it on, open Edit > Preferences… and tick “Allow saving DWG (experimental)”. To exchange or submit the drawing, use File > Save as DXF… instead.';
export const dwgOriginSaveText = (name) => `This drawing was opened from DWG. It will be saved as DXF (${String(name || 'drawing').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')}.dxf) next to the original; the DWG is not changed.`;

// Reliable DWG saving through the ODA File Converter (when the user has installed it).
/** one line added to the experimental-save refusal/confirm when ODA is not installed */
export const ODA_SAVE_HINT = 'Install the free ODA File Converter for reliable DWG 2018 saving.';
/** settings key of the last DWG version chosen in Save as DWG */
export const DWG_SAVE_VERSION_KEY = 'dwg.saveVersion';
/** DWG versions offered when ODA writes the file (ids accepted by dwg:fromDxf), newest first; the first is the default */
export const DWG_SAVE_VERSIONS = Object.freeze([
  ['acad2018', 'AutoCAD 2018 DWG'], ['acad2013', 'AutoCAD 2013 DWG'], ['acad2010', 'AutoCAD 2010 DWG'],
  ['acad2007', 'AutoCAD 2007 DWG'], ['acad2004', 'AutoCAD 2004 DWG'], ['acad2000', 'AutoCAD 2000 DWG'],
].map(([id, label]) => Object.freeze({ id, label })));
export const DEFAULT_DWG_SAVE_VERSION = 'acad2018';
/** a stored choice, or the default when it is missing or not offered */
export const dwgSaveVersionFrom = (v) => (DWG_SAVE_VERSIONS.some((x) => x.id === v) ? v : DEFAULT_DWG_SAVE_VERSION);
const HEADER_VERSIONS = { AC1032: 'acad2018', AC1027: 'acad2013', AC1024: 'acad2010', AC1021: 'acad2007', AC1018: 'acad2004', AC1015: 'acad2000' };
/**
 * The save version of a DWG from its first 6 bytes ("AC1032" -> 'acad2018' ...); releases older than 2000
 * (AC1014, AC1012, AC1009 ..., and the oldest "AC1.50", "AC2.10" style headers) -> 'acad2000'.
 * Not a DWG header (or a newer, unknown one) -> null. `head` is a string or bytes.
 */
export function dwgVersionFromHeader(head) {
  const s = typeof head === 'string' ? head.slice(0, 6) : String.fromCharCode(...Array.from(head ?? [], Number).slice(0, 6));
  if (HEADER_VERSIONS[s]) return HEADER_VERSIONS[s];
  if (/^AC\d\.\d/.test(s)) return 'acad2000'; // AC1.2, AC1.40, AC1.50, AC2.10 ... (AutoCAD 1.x - 2.x)
  const m = /^AC(\d{4})$/.exec(s);
  return m && Number(m[1]) < 1015 ? 'acad2000' : null;
}

/** the ODA version to write for a version recorded by an earlier DWG write: ODA ids as they are; LibreDWG's 'r2000'
 *  and 'r14' (R14 cannot be written by this program through ODA) -> 'acad2000', keeping the file's version family */
const odaVersionOf = (v) => (DWG_SAVE_VERSIONS.some((x) => x.id === v) ? v : v === 'r2000' || v === 'r14' ? 'acad2000' : null);

/**
 * What Ctrl+S does with a drawing that has a file path, by its format:
 *  - 'dxf' -> {action: 'dxf-overwrite'}; any other non-DWG format -> {action: 'save-as'} (the Save as DXF dialog)
 *  - 'dwg' and ODA can write -> {action: 'dwg-writeback', version}: the version of the last DWG write of this tab
 *    (`tabVersion`, LibreDWG ids mapped to their ODA version), else the file's header version, else 2018
 *  - 'dwg' without ODA -> {action: 'dxf-confirm'} (saved as a DXF next to it, after a confirm)
 */
export function ctrlSaveRoute({ format, odaWrite, tabVersion = null, header = '' }) {
  if (format === 'dxf') return { action: 'dxf-overwrite' };
  if (format !== 'dwg') return { action: 'save-as' };
  if (!odaWrite) return { action: 'dxf-confirm' };
  return { action: 'dwg-writeback', version: odaVersionOf(tabVersion) ?? dwgVersionFromHeader(header ?? '') ?? DEFAULT_DWG_SAVE_VERSION };
}

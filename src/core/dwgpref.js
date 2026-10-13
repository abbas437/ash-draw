// Preference gate for the experimental DWG writer. Reviewer finding: LibreDWG R2000 files open in AutoCAD with empty layout viewports,
// so saving DWG is off unless the user turns it on in Edit > Preferences.
export const DWG_SAVE_PREF_KEY = 'dwg.allowSave';
export const DWG_SAVE_PREF_LABEL = 'Allow saving DWG (experimental — layouts may not display correctly in AutoCAD)';
/** only an explicit true enables it; anything stored or missing means off */
export const dwgSaveAllowed = (stored) => stored === true;
export const DWG_SAVE_DISABLED_TEXT = 'Saving as DWG is experimental and is turned off: layouts and viewports may appear empty when the file is opened in AutoCAD. '
  + 'To turn it on, open Edit > Preferences… and tick “Allow saving DWG (experimental)”. To exchange or submit the drawing, use File > Save as DXF… instead.';
export const dwgOriginSaveText = (name) => `This drawing was opened from DWG. It will be saved as DXF (${String(name || 'drawing').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')}.dxf) next to the original; the DWG is not changed.`;

// Layers panel: the optional read-only Linetype / Lineweight / Transparency columns (text of each value, saved choice).
export const LAYER_COLS_KEY = 'layers.columns';
/** the saved choice: extra columns only when the stored value is exactly true (compact list by default) */
export const layerColsFrom = (saved) => saved === true;
/** linetype name of a layer ('CONTINUOUS' when it has none) */
export const layerLinetypeText = (l) => String(l?.linetype || 'CONTINUOUS');
/** lineweight: -3 Default, -2 ByBlock, -1 ByLayer, >= 0 millimetres (e.g. 0.35 -> '0.35 mm'); a missing value is Default */
export const lineweightText = (w) => (w == null || w === -3 ? 'Default' : w === -2 ? 'ByBlock' : w === -1 ? 'ByLayer' : w >= 0 ? `${w.toFixed(2)} mm` : 'Default');
/** transparency percent of a layer alpha (0..255, 255 = opaque; negative or missing = 0 %), e.g. '60%' */
export const layerTransparencyText = (alpha) => `${alpha >= 0 ? Math.round((255 - alpha) * 100 / 255) : 0}%`;

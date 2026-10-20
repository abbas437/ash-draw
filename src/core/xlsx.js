// ASH Draw Studio - a minimal .xlsx (Office Open XML spreadsheet) writer, no dependencies. Pure ES module (no DOM).
//
//   xlsxBytes([{ name: 'Symbols', rows: [['Symbol', 'Count'], ['VAV', 3]], colWidths: [30, 10] }]);  // Uint8Array
//
// The first row of each sheet is bold (the header); a sheet's boldRows: [indices] overrides which rows. Strings are inline (t="inlineStr": no sharedStrings part); the
// zip is stored (no compression) with CRC-32s. Every cell is Calibri 11. A cell may be { v, style: { bold, wrap, vAlign ('top' |
// 'center' | 'bottom'), fill ('RRGGBB' solid fill) } } instead of a bare value, and a sheet's validations: [{ sqref: 'F6:F9',
// list: ['Open', 'Closed'] }] adds in-cell drop-down lists.

const enc = new TextEncoder();
/** XML-escaped text, characters XML 1.0 forbids removed */
const esc = (s) => String(s ?? '').replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** A1-style column letters of a 0-based index */
export const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
/** a sheet name Excel accepts: none of []:*?/\ , at most 31 characters, unique */
const sheetName = (n, used) => {
  let b = [...String(n ?? '').replace(/[^ -\ud7ff\ue000-\ufffd\u{10000}-\u{10FFFF}]/gu, '').replace(/[[\]:*?/\\]/g, '_').trim()
    .replace(/^'+|'+$/g, '').trim()].slice(0, 31).join('').replace(/^'+|'+$/g, '') || 'Sheet'; // no tab / line breaks; 31 code points
  if (b.toUpperCase() === 'HISTORY') b = 'History_1'; // Excel reserves the name
  let s = b;
  for (let i = 2; used.has(s.toUpperCase()); i++) s = `${[...b].slice(0, 31 - String(i).length - 1).join("")}_${i}`;
  used.add(s.toUpperCase());
  return s;
};

/** the cellXfs of a workbook: style objects -> xf index; 0 is the plain cell and 1 the bold one */
function styleTable() {
  const keyOf = (st) => JSON.stringify([!!st?.bold, !!st?.wrap, st?.vAlign ?? '', String(st?.fill ?? '').toUpperCase()]);
  const xfs = [keyOf(null), keyOf({ bold: true })], index = new Map(xfs.map((k, i) => [k, i]));
  return {
    xfs,
    id(st) {
      const k = keyOf(st);
      if (!index.has(k)) { index.set(k, xfs.length); xfs.push(k); }
      return index.get(k);
    },
  };
}

function stylesXml(xfs) {
  const parsed = xfs.map((k) => JSON.parse(k));
  const fills = [...new Set(parsed.map((p) => p[3]).filter(Boolean))];
  const xf = ([bold, wrap, vAlign, fill]) => {
    const fillId = fill ? fills.indexOf(fill) + 2 : 0, align = wrap || vAlign;
    const attrs = `numFmtId="0" fontId="${bold ? 1 : 0}" fillId="${fillId}" borderId="0" xfId="0"${bold ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${align ? ' applyAlignment="1"' : ''}`;
    return align ? `<xf ${attrs}><alignment${vAlign ? ` vertical="${vAlign}"` : ''}${wrap ? ' wrapText="1"' : ''}/></xf>` : `<xf ${attrs}/>`;
  };
  return `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + `<fills count="${fills.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
    + `${fills.map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('')}</fills>`
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${parsed.length}">${parsed.map(xf).join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

function sheetXml({ rows = [], colWidths = null, boldRows = [0], validations = [] }, styles) {
  const bold = new Set(boldRows);
  const cols = colWidths?.length ? `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(w) || 10}" customWidth="1"/>`).join('')}</cols>` : '';
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((cell, ci) => {
    const styled = cell != null && typeof cell === 'object';
    const v = styled ? cell.v : cell, xf = styles.id({ ...(bold.has(ri) ? { bold: true } : {}), ...(styled ? cell.style : {}) });
    const ref = `${colName(ci)}${ri + 1}`, s = xf ? ` s="${xf}"` : '';
    if (v == null || v === '') return xf ? `<c r="${ref}"${s}/>` : '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const dv = validations.length ? `<dataValidations count="${validations.length}">${validations.map((d) => `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${esc(d.sqref)}"><formula1>${esc(`"${d.list.join(',')}"`)}</formula1></dataValidation>`).join('')}</dataValidations>` : '';
  return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData>${dv}</worksheet>`;
}

/** the parts of a workbook: [[path, xml]] */
export function xlsxParts(sheets) {
  const used = new Set(), names = sheets.map((s) => sheetName(s.name, used));
  const styles = styleTable(), sheetParts = sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, styles)]);
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return [
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', stylesXml(styles.xfs)],
    ...sheetParts,
  ];
}

let CRC_TABLE = null;
/** CRC-32 (IEEE, as zip uses) of bytes */
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** a stored (uncompressed) zip of [[path, string | Uint8Array]] */
export function zipStored(files) {
  const local = [], central = [];
  let offset = 0;
  // DOS date/time fixed at 1980-01-01 00:00 (reproducible output)
  const TIME = 0, DATE = (0 << 9) | (1 << 5) | 1;
  for (const [path, data] of files) {
    const name = enc.encode(path), body = typeof data === 'string' ? enc.encode(data) : data, crc = crc32(body);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, TIME, true); h.setUint16(12, DATE, true); h.setUint32(14, crc, true);
    h.setUint32(18, body.length, true); h.setUint32(22, body.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, TIME, true); c.setUint16(14, DATE, true); c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true); c.setUint32(24, body.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    local.push(new Uint8Array(h.buffer), name, body);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((t, b) => t + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((t, b) => t + b.length, 0));
  let p = 0; for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

/** .xlsx bytes of sheets [{ name, rows: [[string | number…]…], colWidths?, boldRows? (default [0]) }] */
export const xlsxBytes = (sheets) => zipStored(xlsxParts(sheets));

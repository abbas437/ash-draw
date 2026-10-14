// ASH Draw Studio - a minimal .xlsx (Office Open XML spreadsheet) writer, no dependencies. Pure ES module (no DOM).
//
//   xlsxBytes([{ name: 'Symbols', rows: [['Symbol', 'Count'], ['VAV', 3]], colWidths: [30, 10] }]);  // Uint8Array
//
// The first row of each sheet is bold (the header). Strings are inline (t="inlineStr": no sharedStrings part); the
// zip is stored (no compression) with CRC-32s.

const enc = new TextEncoder();
/** XML-escaped text, characters XML 1.0 forbids removed */
const esc = (s) => String(s ?? '').replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** A1-style column letters of a 0-based index */
export const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
/** a sheet name Excel accepts: none of []:*?/\ , at most 31 characters, unique */
const sheetName = (n, used) => {
  const b = String(n ?? '').replace(/[[\]:*?/\\]/g, '_').trim().slice(0, 31) || 'Sheet';
  let s = b;
  for (let i = 2; used.has(s.toUpperCase()); i++) s = `${b.slice(0, 31 - String(i).length - 1)}_${i}`;
  used.add(s.toUpperCase());
  return s;
};

function sheetXml({ rows = [], colWidths = null }) {
  const cols = colWidths?.length ? `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(w) || 10}" customWidth="1"/>`).join('')}</cols>` : '';
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    if (v == null || v === '') return '';
    const ref = `${colName(ci)}${ri + 1}`, s = ri === 0 ? ' s="1"' : '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/** the parts of a workbook: [[path, xml]] */
export function xlsxParts(sheets) {
  const used = new Set(), names = sheets.map((s) => sheetName(s.name, used));
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return [
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
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

/** .xlsx bytes of sheets [{ name, rows: [[string | number…]…], colWidths? }] */
export const xlsxBytes = (sheets) => zipStored(xlsxParts(sheets));

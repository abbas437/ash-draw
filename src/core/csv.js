// CSV text for Excel: RFC 4180 quoting, a UTF-8 byte-order mark (without it Excel reads Arabic and other non-ASCII text
// as Windows-1252 when the file is opened by double-click), and a leading apostrophe on any cell that Excel would run
// as a formula (it begins with = + - @, a tab or a carriage return). One writer for every CSV export of the program.

/** one cell: formula-looking text gets a leading ' (a JS number never: a negative coordinate stays a number), then quoted when it holds a comma, quote or line break */
export function csvCell(v) {
  let t = String(v ?? '');
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** the file text: BOM, header line, one line per row, CRLF line ends. `header` is an array of column names. */
export function csvText(header, rows) {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// CSV export helpers (browser: window.CSV, Node: require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * One CSV cell. Text that a spreadsheet could read as a formula
   * (starting with = + - @) gets a leading apostrophe, so opening the file
   * in Excel can never run anything.
   */
  function cell(v) {
    if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
    if (typeof v === 'number') return String(v);
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** columns: [{ key, label }], rows: array of objects. */
  function toCSV(columns, rows) {
    const lines = [columns.map((c) => cell(c.label)).join(',')];
    rows.forEach((r) => lines.push(columns.map((c) => cell(r[c.key])).join(',')));
    return lines.join('\r\n') + '\r\n';
  }

  /** Seconds since 1970 -> "2026-11-06 14:30:00" (broker server time). */
  function isoTime(seconds) {
    return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
  }

  return { cell, toCSV, isoTime };
});

// The rows of the page's main data table, keyed by its column headers: HTML tables and ARIA
// grids/tables (role=row with cell, gridcell or columnheader children), the largest one that is
// shown. A header row kept in a separate table (fixed-header grids) is found nearby by its
// column count. Rows that are hidden (virtual-list spacers, measure rows) are skipped.
// No table or grid: rows drawn with divs (admin consoles), three or more siblings of one class
// with the same number of cells, headed by a sibling row of that width. selector: only there.
({ max = 5000, selector = null }) => {
  var norm = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
  var shown = function (el) {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.visibility !== 'collapse';
  };
  var cellsOf = function (row) {
    return Array.prototype.filter.call(row.children, function (c) {
      return /^(TD|TH)$/.test(c.tagName) || /^(cell|gridcell|columnheader|rowheader)$/.test(c.getAttribute('role') || '');
    });
  };
  var isHeader = function (row) {
    var cells = cellsOf(row);
    return cells.length > 0 && cells.every(function (c) { return c.tagName === 'TH' || c.getAttribute('role') === 'columnheader'; }) ||
      (row.parentElement && row.parentElement.tagName === 'THEAD');
  };
  var rowsOf = function (t) {
    var rows = t.tagName === 'TABLE' ? Array.prototype.slice.call(t.rows) : Array.prototype.slice.call(t.querySelectorAll('[role=row]'));
    // Rows of a nested table belong to that table.
    return rows.filter(function (r) { return r.closest('table,[role=grid],[role=table],[role=treegrid]') === t; });
  };
  var scope = document;
  if (selector) {
    scope = document.querySelector(selector);
    if (!scope) return { columns: [], rows: [], total: 0, truncated: false, error: 'nothing matches ' + selector };
  }
  var tables = Array.prototype.slice.call(scope.querySelectorAll('table,[role=grid],[role=table],[role=treegrid]'))
    .concat(scope !== document && scope.matches('table,[role=grid],[role=table],[role=treegrid]') ? [scope] : [])
    .filter(function (t) { return shown(t) && !t.closest('[aria-hidden=true]'); });
  var best = null;
  tables.forEach(function (t) {
    var all = rowsOf(t);
    var body = all.filter(function (r) { return !isHeader(r) && r.getAttribute('aria-hidden') !== 'true' && shown(r) && cellsOf(r).length; });
    if (!best || body.length > best.body.length) best = { t: t, all: all, body: body };
  });
  if (!best || !best.body.length) return divGrid();
  var width = Math.max.apply(null, best.body.map(function (r) { return cellsOf(r).length; }));
  var headerRow = best.all.filter(isHeader).pop();
  // A fixed header in its own table: the nearest header row, up three levels, with the same width.
  for (var up = best.t.parentElement, i = 0; !headerRow && up && i < 3; up = up.parentElement, i++) {
    var cands = Array.prototype.slice.call(up.querySelectorAll('thead tr,[role=row]')).filter(function (r) { return isHeader(r) && cellsOf(r).length === width; });
    headerRow = cands[0];
  }
  var names = [], used = {};
  var headCells = headerRow ? cellsOf(headerRow) : [];
  for (var c = 0; c < width; c++) {
    var n = headCells[c] ? norm(headCells[c].innerText || headCells[c].textContent) : '';
    if (!n) n = 'col' + (c + 1);
    if (used[n]) { used[n]++; n = n + '_' + used[n]; } else used[n] = 1;
    names.push(n);
  }
  var rows = best.body.slice(0, max).map(function (r) {
    var o = {}, col = 0;
    cellsOf(r).forEach(function (cell) {
      if (col < names.length) o[names[col]] = norm(cell.innerText || cell.textContent);
      col += Math.max(1, Number(cell.getAttribute('colspan')) || 1);
    });
    return o;
  });
  return { columns: names, rows: rows, total: best.body.length, truncated: best.body.length > max };

  function divGrid() {
    var text = function (el) { return norm(el.innerText || el.textContent); };
    var cellsOfDiv = function (row) { return Array.prototype.filter.call(row.children, function (c) { return shown(c); }); };
    var found = null;
    Array.prototype.forEach.call((scope === document ? document.body : scope).querySelectorAll('*'), function (box) {
      var kids = Array.prototype.filter.call(box.children, function (c) { return shown(c) && typeof c.className === 'string' && c.className.trim(); });
      if (kids.length < 3) return;
      // The most common class among the children, as the row class.
      var count = {};
      kids.forEach(function (c) { count[c.className] = (count[c.className] || 0) + 1; });
      var cls = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })[0];
      var rows = kids.filter(function (c) { return c.className === cls; });
      if (rows.length < 3) return;
      var w = cellsOfDiv(rows[0]).length;
      if (w < 2 || !rows.every(function (r) { return cellsOfDiv(r).length === w; })) return;
      if (!found || rows.length * w > found.rows.length * found.w) found = { box: box, rows: rows, w: w };
    });
    if (!found) return { columns: [], rows: [], total: 0, truncated: false };
    // A header: a sibling before the first row with the same number of cells, else one just
    // before the rows' container.
    var head = null;
    for (var prev = found.rows[0].previousElementSibling; prev && !head; prev = prev.previousElementSibling) if (cellsOfDiv(prev).length === found.w) head = prev;
    for (var up = found.box, k = 0; !head && up && k < 2; up = up.parentElement, k++) {
      var p = up.previousElementSibling;
      if (p && cellsOfDiv(p).length === found.w) head = p;
      else if (p && p.children.length === 1 && cellsOfDiv(p.children[0]).length === found.w) head = p.children[0];
    }
    var cols = [], seen = {};
    for (var c = 0; c < found.w; c++) {
      var n = head ? text(cellsOfDiv(head)[c]) : '';
      if (!n) n = 'col' + (c + 1);
      if (seen[n]) { seen[n]++; n = n + '_' + seen[n]; } else seen[n] = 1;
      cols.push(n);
    }
    var out = found.rows.slice(0, max).map(function (r) { var o = {}; cellsOfDiv(r).forEach(function (cell, i) { o[cols[i]] = text(cell); }); return o; });
    return { columns: cols, rows: out, total: found.rows.length, truncated: found.rows.length > max, kind: 'div rows' };
  }
}

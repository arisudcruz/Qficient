// Every console table (.table-wrap > table) scrolls inside itself, showing a few rows at a time under a header that
// stays put (css/layout.css). Rows differ in height (buttons, tags, wrapping, the phone card layout), so each table
// is measured: its height is capped at the header plus its first TABLE_VISIBLE_ROWS rows.
//
// No renderer needs to know about it. A MutationObserver sizes each table as it appears or changes, and because the
// live lists (Queue Management, the enforcer list...) are rebuilt on every update, it also puts back how far the
// table was scrolled, so a new ticket doesn't throw the list back to the top.

var TABLE_VISIBLE_ROWS = 5;

// Tables that show another number of rows; "all" means no limit (the table keeps its full length).
var TABLE_ROWS_BY_KIND = [
  { selector: ".report-table", rows: "all" },
  { selector: ".audit-table", rows: 10 }
];

var tableScrollMemory = {}; // table key -> scrollTop

function tableRowsWanted(wrap) {
  var own = wrap.getAttribute("data-rows");
  if (own) return own === "all" ? "all" : Number(own) || TABLE_VISIBLE_ROWS;
  for (var i = 0; i < TABLE_ROWS_BY_KIND.length; i++) {
    if (wrap.querySelector(TABLE_ROWS_BY_KIND[i].selector)) return TABLE_ROWS_BY_KIND[i].rows;
  }
  return TABLE_VISIBLE_ROWS;
}

// Which table this is, steady across re-renders: the nearest ancestor with an id, its place there, and its headers.
function tableScrollKey(wrap) {
  var holder = wrap.parentElement;
  while (holder && !holder.id) holder = holder.parentElement;
  var scope = holder || document.body;
  var index = Array.prototype.indexOf.call(scope.querySelectorAll(".table-wrap"), wrap);
  var head = wrap.querySelector("thead");
  return (holder ? holder.id : "") + "|" + index + "|" + (head ? head.textContent.replace(/\s+/g, " ").trim() : "");
}

function sizeTable(wrap) {
  if (wrap.offsetParent === null) return false; // hidden: measured once it shows

  var wanted = tableRowsWanted(wrap);
  var table = wrap.querySelector("table");
  var body = table && table.tBodies[0];
  var rows = body ? Array.prototype.filter.call(body.rows, function (row) { return row.offsetParent !== null; }) : [];

  if (wanted === "all" || rows.length <= wanted) {
    wrap.style.maxHeight = "";
    wrap.classList.remove("is-scrollable");
    return true;
  }

  var head = table.tHead && table.tHead.offsetParent !== null ? table.tHead.getBoundingClientRect().height : 0;
  var foot = table.tFoot && table.tFoot.offsetParent !== null ? table.tFoot.getBoundingClientRect().height : 0;
  var height = head + foot;
  for (var i = 0; i < wanted; i++) height += rows[i].getBoundingClientRect().height;
  var borders = wrap.offsetHeight - wrap.clientHeight; // top + bottom border (plus a sideways scrollbar, if any)

  wrap.style.maxHeight = Math.ceil(height + borders) + "px";
  wrap.classList.add("is-scrollable");

  var key = tableScrollKey(wrap);
  wrap.setAttribute("data-scroll-key", key);
  if (tableScrollMemory[key] && wrap.scrollTop !== tableScrollMemory[key]) wrap.scrollTop = tableScrollMemory[key];
  return true;
}

var tableSized = typeof WeakSet === "function" ? new WeakSet() : null;

function sizeTables(onlyChanged, changedNodes) {
  document.querySelectorAll(".table-wrap").forEach(function (wrap) {
    var touched = !onlyChanged || !tableSized || !tableSized.has(wrap) ||
      changedNodes.some(function (node) { return wrap.contains(node); });
    if (!touched) return;
    if (sizeTable(wrap) && tableSized) tableSized.add(wrap);
  });
}

// Remembers how far each table was scrolled (scroll events don't bubble, so this listens in the capture phase).
document.addEventListener("scroll", function (event) {
  var wrap = event.target;
  if (!wrap || !wrap.classList || !wrap.classList.contains("table-wrap")) return;
  var key = wrap.getAttribute("data-scroll-key") || tableScrollKey(wrap);
  tableScrollMemory[key] = wrap.scrollTop;
}, true);

if (typeof MutationObserver === "function") {
  new MutationObserver(function (mutations) {
    var changed = mutations.map(function (m) { return m.target; });
    // Runs before the browser paints, so a rebuilt table is never drawn scrolled back to the top.
    sizeTables(true, changed);
  }).observe(document.body, { childList: true, subtree: true });
}

// Rows wrap differently at other widths; a page switch (display only) also shows tables measured while hidden.
var tableResizeTimer = null;
window.addEventListener("resize", function () {
  clearTimeout(tableResizeTimer);
  tableResizeTimer = setTimeout(function () { sizeTables(false, []); }, 150);
});

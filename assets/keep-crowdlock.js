// Steps 4 to 6 can be tried on a test Crowdlock (?c=name in the address).
// This keeps that choice when you move between those three pages, so you do
// not land back on the real fund halfway through a test. Nothing else.
(function () {
  var c = new URLSearchParams(location.search).get("c");
  if (!c || !/^[a-z0-9-]+$/.test(c)) return;
  document.querySelectorAll("a[href]").forEach(function (a) {
    var h = a.getAttribute("href");
    if (!/^\.\.\/(lock|commit|take-home)\/(#.*)?$/.test(h)) return;
    var i = h.indexOf("#");
    a.setAttribute("href", (i < 0 ? h : h.slice(0, i)) + "?c=" + c + (i < 0 ? "" : h.slice(i)));
  });
})();

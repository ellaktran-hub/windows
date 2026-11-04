// Copy button for the one-time calendar connect page.
(function () {
  var b = document.getElementById("copy"), t = document.getElementById("tok"), ok = document.getElementById("ok");
  if (!b || !t) return;
  b.addEventListener("click", function () {
    t.select();
    var done = function () { ok.textContent = "copied"; };
    if (navigator.clipboard) navigator.clipboard.writeText(t.value).then(done, function () { document.execCommand("copy"); done(); });
    else { document.execCommand("copy"); done(); }
  });
})();

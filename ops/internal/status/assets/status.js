// SPDX-License-Identifier: Apache-2.0
// Status page behaviour: a live "Checked N s ago" from the last real probe result, and day-bar tooltips. The page is
// complete without this script (bars carry aria-labels; the server writes the first "Checked" text).
(() => {
  var ago = document.getElementById("ago");
  var last = ago ? Number(ago.getAttribute("data-last")) : 0;
  function tick() {
    var s = Math.max(0, Math.floor(Date.now() / 1000 - last));
    var t =
      s < 5
        ? "just now"
        : s < 60
          ? s + " s ago"
          : s < 3600
            ? Math.floor(s / 60) + " min ago"
            : Math.floor(s / 3600) + " h ago";
    ago.textContent = "Checked " + t;
  }
  if (last > 0) {
    tick();
    setInterval(tick, 1000);
  }

  var tip = document.getElementById("tip");
  if (!tip) return;
  function show(el) {
    tip.textContent = "";
    var d = document.createElement("span");
    d.textContent = el.getAttribute("data-d");
    var b = document.createElement("b");
    b.textContent = el.getAttribute("data-s");
    var v = document.createElement("span");
    v.textContent = el.getAttribute("data-v");
    tip.appendChild(d);
    tip.appendChild(b);
    tip.appendChild(v);
    var r = el.getBoundingClientRect(),
      w = tip.offsetWidth;
    var x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    tip.style.left = x + "px";
    tip.style.top = r.top - tip.offsetHeight - 8 + "px";
    tip.classList.add("on");
  }
  function hide() {
    tip.classList.remove("on");
  }
  function isBar(t) {
    return t && t.matches && t.matches(".days i");
  }
  document.addEventListener("mouseover", (e) => {
    if (isBar(e.target)) show(e.target);
  });
  document.addEventListener("mouseout", (e) => {
    if (isBar(e.target)) hide();
  });
  document.addEventListener("focusin", (e) => {
    if (isBar(e.target)) show(e.target);
  });
  document.addEventListener("focusout", hide);
  window.addEventListener("scroll", hide, { passive: true });
})();

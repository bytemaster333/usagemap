// SPDX-License-Identifier: Apache-2.0
// Behaviour of the landing page (usagemap.dev), served as /assets/site.<hash>.js and pinned by SRI. The page's CSP
// requires Trusted Types for scripts, so nothing here assigns HTML strings: every node is built with the DOM API.
// Everything on the page is readable without this file; it adds the hero animation, the verification sort, the
// integrations filter, the project-check inputs, the compact menu and the reading progress.

(() => {
  const reduce = (() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  })();
  const SVG = "http://www.w3.org/2000/svg";
  const svgEl = (name, attrs, text) => {
    const n = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text) n.textContent = text;
    return n;
  };

  /* Verification: 48 example events; 40 verified line up, 8 drop into reason bins. */
  const field = document.getElementById("field");
  const stage = document.getElementById("stage");
  if (field && stage) {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const kinds = Array.from({ length: 40 }, () => "v").concat([
      "bot",
      "bot",
      "bot",
      "bot",
      "bot",
      "replay",
      "replay",
      "rate",
    ]);
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }
    field.replaceChildren(
      svgEl("rect", { class: "lanev", x: 300, y: 16, width: 244, height: 168, rx: 10 }),
      svgEl("text", { x: 312, y: 36 }, "VERIFIED"),
      svgEl("rect", { class: "lane", x: 300, y: 206, width: 76, height: 78, rx: 8 }),
      svgEl("rect", { class: "lane", x: 384, y: 206, width: 76, height: 78, rx: 8 }),
      svgEl("rect", { class: "lane", x: 468, y: 206, width: 76, height: 78, rx: 8 }),
      svgEl("text", { x: 310, y: 276 }, "BOTS"),
      svgEl("text", { x: 394, y: 276 }, "REPLAYS"),
      svgEl("text", { x: 478, y: 276 }, "LIMITS"),
      svgEl("text", { x: 16, y: 36 }, "INCOMING"),
      svgEl("path", { d: "M268 150 h20", stroke: "#cbd0d6", "stroke-width": 2 }),
      svgEl("path", {
        d: "M282 144 l8 6 -8 6",
        fill: "none",
        stroke: "#cbd0d6",
        "stroke-width": 2,
      }),
    );
    const start = [];
    const end = [];
    const dots = [];
    const bins = { bot: 0, replay: 0, rate: 0 };
    const binX = { bot: 338, replay: 422, rate: 506 };
    let vi = 0;
    kinds.forEach((k, n) => {
      start.push([24 + rnd() * 236, 52 + rnd() * 228]);
      field.insertBefore(
        svgEl("circle", { r: 5, cx: start[n][0], cy: start[n][1], class: "ghost" }),
        field.firstChild,
      );
      if (k === "v") {
        end.push([318 + (vi % 10) * 22, 58 + Math.floor(vi / 10) * 28]);
        vi++;
      } else {
        const b = bins[k]++;
        end.push([binX[k] - 14 + (b % 3) * 14, 222 + Math.floor(b / 3) * 14]);
      }
      const c = svgEl("circle", { r: 6, cx: 0, cy: 0, class: `dot ${k === "v" ? "v" : "f"}` });
      c.style.transitionDelay = `${n * 14}ms`;
      field.appendChild(c);
      dots.push(c);
    });
    const place = (sorted) => {
      dots.forEach((c, n) => {
        const p = sorted ? end[n] : start[n];
        c.style.transform = `translate(${p[0]}px,${p[1]}px)`;
      });
      field.classList.toggle("sorted", sorted);
    };
    if (reduce || !("IntersectionObserver" in window)) place(true);
    else {
      place(false);
      let done = false;
      const io = new IntersectionObserver(
        (es) => {
          for (const e of es) {
            if (e.isIntersecting && !done) {
              done = true;
              setTimeout(() => place(true), 250);
            }
          }
        },
        { threshold: 0.45 },
      );
      io.observe(stage);
    }
    document.getElementById("replay")?.addEventListener("click", () => {
      if (reduce) return;
      place(false);
      setTimeout(() => place(true), 900);
    });
  }

  /* Gentle settle on scroll; everything is visible without it. */
  if (!reduce && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    for (const n of document.querySelectorAll(".rv")) {
      if (n.getBoundingClientRect().top > window.innerHeight) io.observe(n);
    }
  }

  /* Reading progress */
  const prog = document.getElementById("progress");
  if (prog) {
    const onScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      prog.style.transform = `scaleX(${max > 0 ? Math.min(1, h.scrollTop / max) : 0})`;
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* Find a project / verify a snapshot: build real links as people type. */
  const wire = (inputId, goId, build) => {
    const inp = document.getElementById(inputId);
    const go = document.getElementById(goId);
    if (!inp || !go) return;
    const upd = () => {
      const v = inp.value.trim();
      go.setAttribute("aria-disabled", v ? "false" : "true");
      go.href = build(v);
    };
    inp.addEventListener("input", upd);
    upd();
    inp.form?.addEventListener("submit", (e) => {
      e.preventDefault();
      if (go.getAttribute("aria-disabled") === "false") go.focus();
    });
  };
  wire(
    "slug",
    "slug-go",
    (v) => `https://app.usagemap.dev/p/${encodeURIComponent(v.toLowerCase().replace(/\s+/g, "-"))}`,
  );
  wire("snap", "snap-go", (v) =>
    v
      ? `https://app.usagemap.dev/verify?snapshot=${encodeURIComponent(v)}`
      : "https://app.usagemap.dev/verify",
  );

  /* Integrations: filters, inline tile detail, copy button (agent prompt). Only built integrations are listed. */
  const root = document.querySelector("#integrations .intg");
  const list = document.getElementById("igrid");
  if (root && list) {
    const fbtns = [...root.querySelectorAll(".ig-filters button")];
    const groups = [...list.querySelectorAll(".ig-group")];
    const feat = list.querySelector(".ig-feat");
    const also = list.querySelector(".ig-also");
    let card = null;
    let openTile = null;
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    };
    const closeCard = (focusBack) => {
      card?.remove();
      card = null;
      if (openTile) {
        openTile.setAttribute("aria-pressed", "false");
        if (focusBack) openTile.focus();
        openTile = null;
      }
    };
    const openCard = (t) => {
      closeCard(false);
      const g = t.closest(".ig-group");
      const name = t.querySelector(".ig-nm")?.textContent ?? "";
      card = el("div", "ig-detail");
      card.setAttribute("role", "region");
      card.setAttribute("aria-label", `${name} details`);
      const head = el("div", "idh");
      head.append(t.querySelector(".ig-lg").cloneNode(true), el("h4", "", name));
      const txt = el("div", "idt");
      txt.append(head, el("p", "", t.getAttribute("data-how") ?? ""));
      const a = el("a", "btn btn-secondary btn-sm", "Read the guide ");
      a.href = t.getAttribute("data-guide");
      a.append(el("span", "arrow", "→"));
      const x = el("button", "ig-close", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Close details");
      x.addEventListener("click", () => closeCard(true));
      card.append(txt, a, x);
      g.appendChild(card);
      t.setAttribute("aria-pressed", "true");
      openTile = t;
      if (card.getBoundingClientRect().bottom > innerHeight) {
        card.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      }
    };
    const animate = () => {
      if (reduce) return;
      list.classList.remove("anim");
      void list.offsetWidth;
      let i = 0;
      for (const n of list.querySelectorAll(".ig-group:not([hidden]) .ig-tile")) {
        n.style.setProperty("--i", String(Math.min(i++, 40)));
      }
      list.classList.add("anim");
    };
    const setFilter = (id) => {
      closeCard(false);
      for (const b of fbtns) {
        const on = b.getAttribute("data-f") === id;
        b.setAttribute("aria-pressed", String(on));
        const p = b.parentNode;
        if (on && p.scrollWidth > p.clientWidth) {
          p.scrollTo({
            left: b.offsetLeft - p.clientWidth / 2 + b.offsetWidth / 2,
            behavior: reduce ? "auto" : "smooth",
          });
        }
      }
      for (const g of groups) g.hidden = !(id === "all" || g.getAttribute("data-cat") === id);
      if (feat) feat.hidden = !(id === "all" || id === "stellar" || id === "wallets");
      if (also) also.hidden = id !== "all";
      list.classList.toggle("one", id !== "all");
      animate();
    };
    for (const b of fbtns) b.addEventListener("click", () => setFilter(b.getAttribute("data-f")));
    for (const t of list.querySelectorAll(".ig-tile")) {
      t.addEventListener("click", () => (openTile === t ? closeCard(false) : openCard(t)));
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && card) closeCard(true);
    });
    root.addEventListener("click", (e) => {
      const btn = e.target.closest?.(".cl .cp");
      if (!btn) return;
      const code = btn.previousElementSibling;
      const select = () => {
        const s = getSelection();
        const r = document.createRange();
        r.selectNodeContents(code);
        s.removeAllRanges();
        s.addRange(r);
        btn.textContent = "Ctrl+C";
      };
      try {
        navigator.clipboard.writeText(code.textContent).then(() => {
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = "Copy";
          }, 1400);
        }, select);
      } catch {
        select();
      }
    });
  }

  /* Hero: events flow from the four inputs into the magnet; real ones reach the result, fake ones the tray. */
  const INK = "#111111";
  const YEL = "#ffd43b";
  const GREY = "#8c8c84";
  const FAKE = "#b5b5ac";
  const LINE = "#dcdcd5";
  const PAPER = "#ffffff";
  const REASONS = ["bot", "replay", "bot", "scripted wallet", "bot", "replay"];
  const fmt = (n) => n.toLocaleString("en-US");
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  function Flow(root, idx) {
    const cv = root.querySelector("canvas.flow");
    const ctx = cv.getContext("2d");
    const srcEls = [...root.querySelectorAll("[data-src]")];
    const mag = root.querySelector("[data-magnet]");
    const out = root.querySelector("[data-out]");
    const tray = root.querySelector("[data-tray]");
    const guides = !!root.dataset.guides;
    let W = 0;
    let H = 0;
    const G = {};
    let parts = [];
    let frame = 0;
    let running = false;
    let flash = 0;
    let seed = 5 + idx * 17;
    let ri = idx;
    const rnd = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const rel = (el) => {
      const a = el.getBoundingClientRect();
      const c = cv.getBoundingClientRect();
      return {
        x: a.left - c.left,
        y: a.top - c.top,
        w: a.width,
        h: a.height,
        cx: a.left - c.left + a.width / 2,
        cy: a.top - c.top + a.height / 2,
      };
    };
    const anchor = (r, t) => {
      const dx = t.x - r.cx;
      const dy = t.y - r.cy;
      if (Math.abs(dx) / r.w > Math.abs(dy) / r.h) {
        return { x: dx > 0 ? r.x + r.w : r.x, y: r.cy, nx: dx > 0 ? 1 : -1, ny: 0, span: r.h };
      }
      return { x: r.cx, y: dy > 0 ? r.y + r.h : r.y, nx: 0, ny: dy > 0 ? 1 : -1, span: r.w };
    };
    const layout = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width;
      H = r.height;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const m = rel(mag);
      const dir = (getComputedStyle(mag).getPropertyValue("--dir") || "up").trim();
      const lw = dir === "left" ? 36.5 : 34;
      const lh = dir === "left" ? 34 : 36.5;
      const k = Math.min(m.w / lw, m.h / lh);
      const bw = lw * k;
      const bh = lh * k;
      G.m = { x: m.cx - bw / 2, y: m.cy - bh / 2, w: bw, h: bh, k, dir, cx: m.cx, cy: m.cy };
      if (dir === "left") {
        G.mouth = { x: G.m.x + 4 * k, y: m.cy };
        G.exit = { x: G.m.x + bw, y: m.cy };
        G.axis = { x: -1, y: 0 };
      } else {
        G.mouth = { x: m.cx, y: G.m.y + 4 * k };
        G.exit = { x: m.cx, y: G.m.y + bh };
        G.axis = { x: 0, y: -1 };
      }
      G.src = {};
      for (const e of srcEls) G.src[e.dataset.src] = anchor(rel(e), G.mouth);
      G.out = anchor(rel(out), G.exit);
      if (tray) G.tray = anchor(rel(tray), { x: G.m.cx, y: G.m.y + G.m.h });
    };
    const bez = (p0, p1, p2, p3, arr) => {
      const len = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
      const n = Math.max(6, Math.round(len / 2.6));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        arr.push({
          x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        });
      }
    };
    const startPoint = (a, spread) => {
      const j = (rnd() - 0.5) * a.span * spread;
      return { x: a.x + (a.ny ? j : 0), y: a.y + (a.nx ? j : 0) };
    };
    const legIn = (p0, a, target, arr, jit) => {
      const L = Math.max(36, dist(p0, target) * 0.45);
      bez(
        p0,
        { x: p0.x + a.nx * L, y: p0.y + a.ny * L },
        {
          x: target.x + G.axis.x * L + (jit || 0) * G.axis.y,
          y: target.y + G.axis.y * L + (jit || 0) * G.axis.x,
        },
        target,
        arr,
      );
    };
    const spawn = () => {
      const fake = rnd() < 0.27;
      const r = rnd();
      const kind = fake ? "fake" : r < 0.5 ? "visits" : r < 0.75 ? "wallet" : "api";
      const a = G.src[kind];
      if (!a) return;
      const p0 = startPoint(a, 0.5);
      const pts = [p0];
      let mark = 0;
      let reason = null;
      if (!fake) {
        legIn(p0, a, G.mouth, pts, (rnd() - 0.5) * 40);
        mark = pts.length;
        pts.push({ x: G.exit.x, y: G.exit.y, h: 1 });
        const o = G.out;
        const p3 = startPoint(o, 0.45);
        const L2 = Math.max(30, dist(G.exit, p3) * 0.45);
        bez(
          G.exit,
          { x: G.exit.x - G.axis.x * L2, y: G.exit.y - G.axis.y * L2 },
          { x: p3.x + o.nx * L2, y: p3.y + o.ny * L2 },
          p3,
          pts,
        );
      } else {
        reason = REASONS[ri++ % REASONS.length];
        const d = 46 + rnd() * 28;
        const side = (rnd() - 0.5) * 50;
        const S = {
          x: G.mouth.x + G.axis.x * d + side * Math.abs(G.axis.y),
          y: G.mouth.y + G.axis.y * d + side * Math.abs(G.axis.x),
        };
        legIn(p0, a, S, pts, 0);
        mark = pts.length;
        if (G.tray) {
          const U = {
            x: G.m.cx + (G.m.dir === "left" ? 0 : G.m.w * 0.9),
            y: G.m.y + G.m.h + 26 + rnd() * 10,
          };
          const t = G.tray;
          const E = startPoint(t, 0.5);
          bez(S, { x: S.x - G.axis.x * 10, y: S.y + 30 }, { x: U.x - 40, y: U.y }, U, pts);
          bez(U, { x: U.x + 40, y: U.y }, { x: E.x + t.nx * 50, y: E.y + t.ny * 50 }, E, pts);
        }
      }
      parts.push({ pts, i: 0, sp: 0.85 + rnd() * 0.35, kind, fake, mark, reason, ab: false });
      if (running) {
        const c = root.querySelector(`[data-src="${kind}"] [data-count]`);
        if (c) {
          const v = +c.dataset.count + 1;
          c.dataset.count = String(v);
          c.textContent = fmt(v);
        }
      }
    };
    let hitT = 0;
    const arrive = (p) => {
      if (!running) return;
      if (!p.fake) {
        out.classList.add("hit");
        clearTimeout(hitT);
        hitT = setTimeout(() => out.classList.remove("hit"), 180);
      } else if (tray) {
        const li = tray.querySelector(`[data-reason="${p.reason}"]`);
        if (li) {
          const n = li.querySelector("[data-n]");
          const v = +n.dataset.n + 1;
          n.dataset.n = String(v);
          n.textContent = fmt(v);
          li.classList.add("hit");
          setTimeout(() => li.classList.remove("hit"), 250);
        }
      }
    };
    const step = () => {
      frame++;
      if (frame % 13 === 0) spawn();
      flash *= 0.93;
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.i += p.sp;
        if (!p.fake && !p.ab && p.i >= p.mark) {
          p.ab = true;
          flash = 1;
        }
        if (p.i >= p.pts.length - 1) {
          arrive(p);
          parts.splice(i, 1);
        }
      }
    };
    const shape = (kind, x, y, r) => {
      ctx.beginPath();
      if (kind === "wallet") {
        const q = r * 0.92;
        if (ctx.roundRect) ctx.roundRect(x - q, y - q, q * 2, q * 2, 2);
        else ctx.rect(x - q, y - q, q * 2, q * 2);
      } else if (kind === "api") {
        const s = r * 1.2;
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s, y);
        ctx.lineTo(x, y + s);
        ctx.lineTo(x - s, y);
        ctx.closePath();
      } else ctx.arc(x, y, r, 0, Math.PI * 2);
    };
    const curve = (a, b, c, d) => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.bezierCurveTo(b.x, b.y, c.x, c.y, d.x, d.y);
      ctx.stroke();
    };
    const drawGuides = () => {
      ctx.save();
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 5]);
      for (const k of Object.keys(G.src)) {
        const a = G.src[k];
        const t =
          k === "fake" ? { x: G.mouth.x + G.axis.x * 50, y: G.mouth.y + G.axis.y * 50 } : G.mouth;
        const L = Math.max(36, dist(a, t) * 0.45);
        curve(
          a,
          { x: a.x + a.nx * L, y: a.y + a.ny * L },
          { x: t.x + G.axis.x * L, y: t.y + G.axis.y * L },
          t,
        );
      }
      const o = G.out;
      const L2 = Math.max(30, dist(G.exit, o) * 0.45);
      ctx.strokeStyle = "#c6c6be";
      curve(
        G.exit,
        { x: G.exit.x - G.axis.x * L2, y: G.exit.y - G.axis.y * L2 },
        { x: o.x + o.nx * L2, y: o.y + o.ny * L2 },
        o,
      );
      ctx.restore();
    };
    const drawMagnet = () => {
      const m = G.m;
      const k = m.k;
      ctx.save();
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      for (let f = 1; f <= 2; f++) {
        ctx.beginPath();
        if (m.dir === "left") {
          ctx.ellipse(
            m.x + 4 * k,
            m.cy,
            14 * k + f * 22,
            17 * k + f * 22,
            0,
            Math.PI / 2,
            Math.PI * 1.5,
          );
        } else ctx.ellipse(m.cx, m.y + 4 * k, 17 * k + f * 22, 14 * k + f * 22, 0, Math.PI, 0);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (m.dir === "left") {
        ctx.translate(m.x, m.y + m.h);
        ctx.rotate(-Math.PI / 2);
      } else ctx.translate(m.x, m.y);
      ctx.scale(k, k);
      if (flash > 0.03) {
        ctx.globalAlpha = flash * 0.35;
        ctx.fillStyle = YEL;
        ctx.beginPath();
        ctx.ellipse(17, 5, 15, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = YEL;
      for (const x of [0, 24]) {
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, 0, 10, 8, 1.2);
        else ctx.rect(x, 0, 10, 8);
        ctx.fill();
      }
      ctx.strokeStyle = INK;
      ctx.lineWidth = 10;
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.moveTo(5, 10);
      ctx.lineTo(5, 19.5);
      ctx.arc(17, 19.5, 12, Math.PI, 0, true);
      ctx.lineTo(29, 10);
      ctx.stroke();
      ctx.restore();
    };
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      if (guides) drawGuides();
      const r = Math.max(4.5, Math.min(7, W / 140));
      for (const p of parts) {
        const q = p.pts[Math.min(p.pts.length - 1, Math.floor(p.i))];
        if (q.h) continue;
        if (!p.fake) {
          if (p.i < p.mark) {
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = GREY;
            shape(p.kind, q.x, q.y, r);
            ctx.fill();
          } else {
            ctx.globalAlpha = 1;
            ctx.fillStyle = YEL;
            ctx.strokeStyle = INK;
            ctx.lineWidth = 1.6;
            shape(p.kind, q.x, q.y, r);
            ctx.fill();
            ctx.stroke();
          }
        } else {
          ctx.globalAlpha = 1;
          ctx.fillStyle = PAPER;
          ctx.strokeStyle = FAKE;
          ctx.lineWidth = 1.6;
          shape("visits", q.x, q.y, r);
          ctx.fill();
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      drawMagnet();
    };
    const init = () => {
      layout();
      parts = [];
      frame = 0;
      seed = 5 + idx * 17;
      ri = idx;
      for (let i = 0; i < 520; i++) step();
      flash = 0;
      draw();
    };
    let tok = 0;
    const loop = (id) => {
      if (!running || id !== tok) return;
      step();
      draw();
      requestAnimationFrame(() => loop(id));
    };
    let seen = false;
    this.start = () => {
      if (running || reduce) return;
      running = true;
      const id = ++tok;
      requestAnimationFrame(() => loop(id));
    };
    this.stop = () => {
      running = false;
    };
    this.restart = () => {
      const was = running;
      running = false;
      tok++;
      init();
      if (was) this.start();
    };
    init();
    if (!reduce && "IntersectionObserver" in window) {
      new IntersectionObserver(
        (es) => {
          for (const e of es) {
            seen = e.isIntersecting;
            if (seen && !document.hidden) this.start();
            else this.stop();
          }
        },
        { threshold: 0.1 },
      ).observe(root);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stop();
      else if (seen) this.start();
    });
  }
  const flows = [...document.querySelectorAll("[data-viz]")].map((el, i) => new Flow(el, i));
  const reinit = () => {
    for (const f of flows) f.restart();
  };
  let rt = 0;
  addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(reinit, 120);
  });
  document.fonts?.ready.then(reinit);

  /* Nav: bold the link of the section in view (desktop links and the compact menu). */
  const sections = ["journey", "integrations", "index", "operators"];
  const links = Object.fromEntries(
    sections.map((id) => [
      id,
      [...document.querySelectorAll(`.nav-links a[href="#${id}"], .mnav a[href="#${id}"]`)],
    ]),
  );
  let raf = 0;
  const update = () => {
    raf = 0;
    const y = 140;
    let cur = null;
    for (const id of sections) {
      const r = document.getElementById(id)?.getBoundingClientRect();
      if (r && r.top <= y && r.bottom > y) cur = id;
    }
    for (const id of sections) {
      const on = id === cur;
      for (const a of links[id]) {
        a.classList.toggle("on", on);
        if (on) a.setAttribute("aria-current", "location");
        else a.removeAttribute("aria-current");
      }
    }
  };
  addEventListener(
    "scroll",
    () => {
      if (!raf) raf = requestAnimationFrame(update);
    },
    { passive: true },
  );
  addEventListener("resize", update);
  update();

  /* Compact menu below 940px, same links as the desktop nav. */
  const btn = document.querySelector(".nav-menu");
  const menu = document.getElementById("mnav");
  if (btn && menu) {
    const set = (open) => {
      btn.setAttribute("aria-expanded", String(open));
      btn.setAttribute("aria-label", open ? "Close menu" : "Menu");
      menu.hidden = !open;
    };
    btn.addEventListener("click", () => set(menu.hidden));
    menu.addEventListener("click", (e) => {
      if (e.target.closest("a")) set(false);
    });
    addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) {
        set(false);
        btn.focus();
      }
    });
    addEventListener("resize", () => {
      if (innerWidth > 940 && !menu.hidden) set(false);
    });
  }
})();

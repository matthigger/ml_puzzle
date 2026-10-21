// PostMortem: one run, crawl by crawl. A sortable table with a row per
// crawl, and a plot of one crawl with the hidden truth revealed.
//
//   PostMortem.table(table, crawls, opts)  -> {idx: tr} of the rows drawn
//   PostMortem.mark(rows, idx)             highlight crawl idx's row
//   PostMortem.plot(host, result, idx, all) result: runner.replay()'s output;
//                                          all: every shop, or only the best
//                                          and the named (or runner-up)
//
// The plot has a strip per shop, best typical rating first: the shop's true
// bell curve (dashed at its typical rating), and every slice tasted there as
// a little pizza slice, stacked into columns by rating.
//
// Notation, the same in the table, the plot and their hover text: y is the
// best shop and y-hat the shop named; shop i has typical (expected) rating
// mu_i and spread sigma_i, the hidden truth, and x-bar_i is the average of
// the slices tasted there; mu_(2) is the second-highest mu, the runner-up.

const PostMortem = (function () {
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  // the notation, as HTML: the bar is CSS (overline). Wrapped in <i> so
  // headings' uppercase styling leaves it alone
  const XBAR = '<span class="ov">x</span>';
  const EXPECTED = "<i>μ<sub>y</sub> − μ<sub>ŷ</sub></i>";
  const OBSERVED = `<i>${XBAR}<sub>y</sub> − ${XBAR}<sub>ŷ</sub></i>`;
  const GAP = "<i>μ<sub>y</sub> − μ<sub>(2)</sub></i>";
  const fmt = v => (v <= -0.005 ? "−" : "") + Math.abs(v).toFixed(2);
  const SUB = "₀₁₂₃₄₅₆₇₈₉";
  const sub = n => String(n).replace(/\d/g, d => SUB[d]);

  // hover help that can show the notation: one floating box for the page
  let tipBox = null;
  function tip(target, html) {
    const show = () => {
      if (!tipBox) {
        tipBox = document.createElement("div");
        tipBox.className = "tip";
        document.body.appendChild(tipBox);
      }
      // html is one of this file's constant help strings
      tipBox.innerHTML = html;
      tipBox.hidden = false;
      const r = target.getBoundingClientRect();
      tipBox.style.left = Math.max(8, Math.min(r.left, innerWidth - 300)) + "px";
      tipBox.style.top = (r.bottom + 6) + "px";
    };
    const hide = () => { if (tipBox) tipBox.hidden = true; };
    target.addEventListener("mouseenter", show);
    target.addEventListener("focus", show);
    target.addEventListener("mouseleave", hide);
    target.addEventListener("blur", hide);
  }

  function badge(label, cls) {
    const b = document.createElement("span");
    b.className = "badge " + cls;
    b.textContent = label;
    return b;
  }

  // ------------------------------------------------------------- table
  // columns: heading, sort key, cell text (or node), hover help
  const COLUMNS = [
    { label: "Crawl", num: true, key: c => c.idx, text: c => c.idx },
    { label: "Result", key: c => c.correct ? 1 : 0,
      node: c => badge(c.correct ? "right" : "wrong", c.correct ? "ok" : "bad") },
    { label: "Named", html: "Named <i>(ŷ)</i>", key: c => c.guess,
      text: c => `shop ${c.guess}`,
      help: "<i>ŷ</i>: the shop your estimator named." },
    { label: "Best", html: "Best <i>(y)</i>", key: c => c.best,
      text: c => `shop ${c.best}`, help: "<i>y</i>: the true best shop." },
    { label: "Slices", num: true, key: c => c.slices, text: c => c.slices },
    { label: "Expected", html: EXPECTED, num: true, key: c => c.shortfall,
      text: c => c.correct ? "" : fmt(c.shortfall),
      help: `${EXPECTED}: how much better the best shop truly is than ` +
            "your pick. <i>μ<sub>i</sub></i>: shop <i>i</i>'s typical " +
            "rating (hidden)." },
    { label: "Observed", html: OBSERVED, num: true,
      key: c => c.observed ?? -Infinity,
      text: c => c.correct ? "" : c.observed === null ? "untasted"
                                                      : fmt(c.observed),
      help: `${OBSERVED}: the same gap in your slices. ` +
            `<i>${XBAR}<sub>i</sub></i>: your average at shop <i>i</i>. ` +
            "Negative: your pick looked better." },
    { label: "Top-two gap", html: GAP, num: true, key: c => c.gap,
      text: c => fmt(c.gap),
      help: `${GAP}: how much better the best shop truly is than the ` +
            "runner-up (<i>μ<sub>(2)</sub></i>: the second-highest " +
            "<i>μ</i>). Small: a close race." },
  ];

  // opts: {sort: {col, dir}, onSort(col), onPick(idx)}
  function table(tbl, crawls, opts) {
    const head = tbl.tHead.rows[0];
    head.replaceChildren();
    for (const c of COLUMNS) {
      const th = document.createElement("th");
      if (c.num) th.className = "num";
      const b = document.createElement("button");
      b.className = "sort";
      // c.html is one of the constant notation strings above
      if (c.html) b.innerHTML = c.html;
      else b.textContent = c.label;
      if (c.help) tip(b, c.help + " Click to sort.");
      else b.title = "Sort by " + c.label;
      b.onclick = () => opts.onSort(c.label);
      th.appendChild(b);
      if (opts.sort.col === c.label) {
        th.setAttribute("aria-sort", opts.sort.dir > 0 ? "ascending" : "descending");
      }
      head.appendChild(th);
    }

    const col = COLUMNS.find(c => c.label === opts.sort.col) || COLUMNS[0];
    const sorted = [...crawls].sort((a, b) =>
      ((col.key(a) - col.key(b)) || (a.idx - b.idx)) * opts.sort.dir);
    const frag = document.createDocumentFragment();
    const rows = {};
    for (const c of sorted) {
      const tr = document.createElement("tr");
      tr.className = "pick";
      tr.onclick = () => opts.onPick(c.idx);
      for (const k of COLUMNS) {
        const td = document.createElement("td");
        if (k.num) td.className = "num";
        if (k.node) td.appendChild(k.node(c));
        else td.textContent = k.text(c);
        tr.appendChild(td);
      }
      rows[c.idx] = tr;
      frag.appendChild(tr);
    }
    tbl.tBodies[0].replaceChildren(frag);
    return rows;
  }

  // highlights crawl idx's row, scrolling the table to it if it's out of view
  function mark(rows, idx) {
    for (const tr of Object.values(rows)) tr.classList.remove("selected");
    const tr = rows[idx];
    if (!tr) return;
    tr.classList.add("selected");
    const wrap = tr.closest(".pm-table-wrap");
    const headH = wrap.querySelector("thead").offsetHeight;
    const top = tr.offsetTop - headH;
    if (top < wrap.scrollTop ||
        tr.offsetTop + tr.offsetHeight > wrap.scrollTop + wrap.clientHeight) {
      wrap.scrollTop = Math.max(0, top - wrap.clientHeight / 3);
    }
  }

  // -------------------------------------------------------------- plot
  const W = 920, LEFT = 216, RIGHT = 16, AXIS = 30;
  const SLICE_W = 10;    // px: one column of slices per this much rating

  function svgBadge(g, x, y, label, cls) {
    const w = 7 * label.length + 12;
    el("rect", { x, y: y - 11, width: w, height: 15, rx: 7.5,
                 class: "pm-badge " + cls }, g);
    el("text", { x: x + w / 2, y, "text-anchor": "middle",
                 class: "pm-badge-text " + cls }, g).textContent = label;
    return x + w + 5;
  }

  function plot(host, res, idx, all) {
    host.replaceChildren();
    const n = res.history.length, right = res.guess === res.best;

    const obs = res.mean.map(() => []);
    res.history.forEach(([shop, x], t) => obs[shop].push([x, t]));
    const avgOf = i => obs[i].length
      ? obs[i].reduce((a, o) => a + o[0], 0) / obs[i].length : null;
    const ranked = res.mean.map((m, i) => i).sort((a, b) => res.mean[b] - res.mean[a]);
    const runnerUp = ranked[1];
    // the best shop, and the one it lost to (or, when named, its runner-up)
    const focus = new Set([res.best, right ? runnerUp : res.guess]);
    const order = all ? ranked : ranked.filter(i => focus.has(i));
    const k = order.length;

    const head = document.createElement("p");
    head.className = "replay-head";
    head.appendChild(badge(right ? "right" : "wrong", right ? "ok" : "bad"));
    head.append(` Crawl ${idx}: named shop ${res.guess} (ŷ) after ${n} ` +
      "slices." + (right ? " That is the best shop (y)."
                         : ` The best shop (y) was ${res.best}.`));
    host.appendChild(head);
    // ratings axis: the shown shops' curves out to 2.5 sd, and their slices
    let lo = Infinity, hi = -Infinity;
    for (const i of order) {
      const m = res.mean[i];
      lo = Math.min(lo, m - 2.5 * res.sd[i]);
      hi = Math.max(hi, m + 2.5 * res.sd[i]);
      for (const [x] of obs[i]) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    }
    lo = Math.floor(lo);
    hi = Math.ceil(hi);
    const plotW = W - LEFT - RIGHT;
    const sx = x => LEFT + (x - lo) / (hi - lo) * plotW;
    const binW = SLICE_W * (hi - lo) / plotW;

    // stack each shop's slices: bins[i] = [[bin, [[x, t], ...]], ...]
    let tallest = 1;
    const bins = obs.map((list, i) => {
      if (!order.includes(i)) return [];
      const m = new Map();
      for (const o of [...list].sort((a, b) => a[1] - b[1])) {
        const b = Math.floor((o[0] - lo) / binW);
        if (!m.has(b)) m.set(b, []);
        m.get(b).push(o);
      }
      for (const v of m.values()) tallest = Math.max(tallest, v.length);
      return [...m.entries()];
    });
    const sliceH = Math.max(2, Math.min(9, 120 / tallest));
    const PH = Math.max(66, tallest * sliceH + 18);
    const H = k * PH + AXIS;

    // curves share one density scale: a consistent shop is tall and narrow
    const peak = Math.max(...order.map(i => 1 / (res.sd[i] * Math.sqrt(2 * Math.PI))));
    const scaleY = (PH - 16) / peak;

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "pm-plot",
      role: "img", "aria-label": `Crawl ${idx}: each shop's tasted slices ` +
        "over its true ratings, best shop first" });

    order.forEach((i, row) => {
      const y0 = row * PH, base = y0 + PH - 6;
      const g = el("g", {}, svg);
      const picked = i === res.guess;
      el("rect", { x: 0, y: y0, width: W, height: PH,
                   class: picked ? "pm-row picked " + (right ? "ok" : "bad")
                                 : row % 2 ? "pm-row alt" : "pm-row" }, g);

      // the truth: bell curve, dashed at the typical rating
      const m = res.mean[i], s = res.sd[i];
      let d = `M${sx(lo)},${base}`;
      for (let t = 0; t <= 160; t++) {
        const x = lo + (hi - lo) * t / 160;
        const pdf = Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));
        d += ` L${sx(x).toFixed(1)},${(base - pdf * scaleY).toFixed(1)}`;
      }
      el("path", { d: d + ` L${sx(hi)},${base} Z`, class: "pm-curve" }, g);
      el("line", { x1: sx(m), x2: sx(m), y1: base, y2: y0 + 6,
                   class: "pm-mean" }, g);
      el("line", { x1: LEFT, x2: W - RIGHT, y1: base, y2: base,
                   class: "pm-base" }, g);

      // the slices tasted, stacked, plus their average
      for (const [b, list] of bins[i]) {
        const cx = sx(lo + (b + 0.5) * binW);
        list.forEach(([x, t], j) => {
          const top = base - (j + 1) * sliceH;
          const tri = el("polygon", { class: "pm-slice", points:
            `${cx - SLICE_W / 2 + 0.7},${top} ${cx + SLICE_W / 2 - 0.7},${top} ` +
            `${cx},${top + sliceH}` }, g);
          el("title", {}, tri).textContent =
            `slice ${t + 1} of the crawl: rated ${x.toFixed(2)}`;
          if (sliceH >= 6) {
            el("circle", { cx, cy: top + sliceH * 0.36, r: 1.3,
                           class: "pm-pep" }, g);
          }
        });
      }
      const xs = obs[i].map(o => o[0]);
      const avg = avgOf(i);
      if (avg !== null) {
        el("line", { x1: sx(avg), x2: sx(avg), y1: base + 4, y2: y0 + 6,
                     class: "pm-avg" }, g);
      }

      // labels: shop, badges, what was tasted, the truth
      el("text", { x: 10, y: y0 + 20, class: "pm-shop" }, g).textContent = `shop ${i}`;
      const label = i === res.best && picked ? ["BEST = YOUR PICK", "ok"]
        : i === res.best ? ["BEST y", "ok"]
        : picked ? ["YOUR PICK ŷ", "bad"]
        : i === runnerUp ? ["RUNNER-UP", "muted"] : null;
      if (label) svgBadge(g, 66, y0 + 20, ...label);
      // x-bar: x with a combining macron (SVG text has no overline)
      el("text", { x: 10, y: y0 + 38, class: "pm-note" }, g).textContent =
        `x\u0304${sub(i)} = ` + (xs.length ? `${avg.toFixed(2)} (${xs.length} ` +
          `slice${xs.length > 1 ? "s" : ""})` : "not tasted");
      el("text", { x: 10, y: y0 + 54, class: "pm-note truth" }, g).textContent =
        `μ${sub(i)} = ${m.toFixed(2)}, σ${sub(i)} = ${s.toFixed(2)}`;
    });

    // ratings axis
    const ya = k * PH;
    const step = hi - lo > 12 ? 2 : 1;
    for (let x = lo; x <= hi; x += step) {
      el("line", { x1: sx(x), x2: sx(x), y1: ya, y2: ya + 5, class: "pm-tick" }, svg);
      el("text", { x: sx(x), y: ya + 18, "text-anchor": "middle",
                   class: "pm-ticklabel" }, svg).textContent = x;
    }
    el("text", { x: LEFT - 10, y: ya + 18, "text-anchor": "end",
                 class: "pm-ticklabel" }, svg).textContent = "rating";

    const wrap = document.createElement("div");
    wrap.className = "pm-plot-wrap";
    wrap.appendChild(svg);
    host.appendChild(wrap);

    if (!all) {
      const more = document.createElement("p");
      more.className = "hint";
      more.textContent = `${res.mean.length - k} other shops hidden.`;
      host.appendChild(more);
    }
    const key = document.createElement("div");
    key.className = "key";
    key.innerHTML =
      '<span><svg width="12" height="11" viewBox="0 0 12 11"><polygon ' +
      'class="pm-slice" points="1,1 11,1 6,10"/></svg>slice tasted</span>' +
      `<span><i class="ln avg"></i>your average <span><i>(${XBAR}<sub>i</sub>)` +
      "</i></span></span>" +
      '<span><i class="ln curve"></i>true ratings</span>' +
      "<span><i class=\"ln mean\"></i>typical rating <span><i>(μ<sub>i</sub>)" +
      "</i></span></span>";
    host.appendChild(key);

    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "y: the best shop, ŷ: your pick. μᵢ and σᵢ are " +
      "shop i's typical rating and spread (the hidden truth, shown only " +
      "here); x̄ᵢ is your average there.";
    host.appendChild(note);
  }

  return { table, mark, plot };
})();

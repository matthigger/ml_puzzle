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
// Notation, the same in the table, the plot and their hover text: x, x-hat
// and x' are a slice's rating at the best shop, the shop named and the
// runner-up; E[.] is a shop's typical (expected) rating, the hidden truth;
// a bar is the average of the slices tasted there.

const PostMortem = (function () {
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  // the notation, as HTML: the bar is CSS (overline), the hat a combining
  // circumflex
  const N = {
    x: "<i>x</i>", xhat: "<i>x̂</i>", x2: "<i>x</i>′",
    xbar: '<i class="ov">x</i>', xhatbar: '<i class="ov">x̂</i>',
  };
  const EXPECTED = `E[${N.x}] − E[${N.xhat}]`;
  const OBSERVED = `${N.xbar} − ${N.xhatbar}`;
  const GAP = `E[${N.x}] − E[${N.x2}]`;
  const fmt = v => (v < 0 ? "−" : "") + Math.abs(v).toFixed(2);

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
    { label: "Named", key: c => c.guess, text: c => `shop ${c.guess}` },
    { label: "Best", key: c => c.best, text: c => `shop ${c.best}` },
    { label: "Slices", num: true, key: c => c.slices, text: c => c.slices },
    { label: "Expected", html: EXPECTED, num: true, key: c => c.shortfall,
      text: c => c.correct ? "" : fmt(c.shortfall),
      help: "Expected difference, E[x] − E[x̂]: the best shop's typical " +
            "rating minus that of the shop you named (x: a slice's " +
            "rating at the best shop, x̂: at your pick). How much better the best " +
            "shop truly is. Hidden truth; blank when you named the best " +
            "shop." },
    { label: "Observed", html: OBSERVED, num: true,
      key: c => c.observed ?? -Infinity,
      text: c => c.correct ? "" : c.observed === null ? "untasted"
                                                      : fmt(c.observed),
      help: "Observed difference, x̄ − x̂̄: your average slice at the best " +
            "shop minus your average at your pick. Negative means the " +
            "slices you tasted made your pick look better: that's what " +
            "fooled you. \"untasted\": you never tried the best shop." },
    { label: "Top-two gap", html: GAP, num: true, key: c => c.gap,
      text: c => fmt(c.gap),
      help: "Top-two gap, E[x] − E[x′]: the best shop's typical rating " +
            "minus the runner-up's (x′: a slice's rating at the second-best shop). " +
            "Small means a close race, hard to call. Hidden truth." },
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
      b.title = (c.help ? c.help + " " : "") + "Click to sort.";
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
  const W = 920, LEFT = 196, RIGHT = 16, AXIS = 30;
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
    const sym = i => i === res.best ? "x" : i === res.guess ? "x̂"
                   : i === runnerUp ? "x′" : null;

    const head = document.createElement("p");
    head.className = "replay-head";
    head.appendChild(badge(right ? "right" : "wrong", right ? "ok" : "bad"));
    head.append(` Crawl ${idx}: named shop ${res.guess} after ${n} slices.` +
      (right ? " That is the best shop." : ` The best shop was ${res.best}.`));
    host.appendChild(head);
    if (!right) {
      const d = document.createElement("p");
      d.className = "pm-diffs";
      const ob = avgOf(res.best), og = avgOf(res.guess);
      // only numbers and the constant notation go into this HTML
      d.innerHTML = `${EXPECTED} = ${fmt(res.mean[res.best] - res.mean[res.guess])}` +
        " <span class=\"muted\">(expected: how much better the best shop truly " +
        "is)</span><br>" + (ob === null || og === null
          ? `${OBSERVED}: <span class="muted">shop ${ob === null ? res.best
             : res.guess} was never tasted</span>`
          : `${OBSERVED} = ${fmt(ob - og)} <span class="muted">(observed: ` +
            (ob < og ? "your slices made your pick look better" :
                       "your slices favored the best shop, yet it wasn't named") +
            ")</span>");
      host.appendChild(d);
    }

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
      let bx = 66;
      if (i === res.best) bx = svgBadge(g, bx, y0 + 20, "BEST", "ok");
      if (picked) svgBadge(g, bx, y0 + 20, "YOUR PICK", right ? "ok" : "bad");
      // x-bar style labels: SVG has no overline, so "avg" names the bar
      const v = sym(i);
      el("text", { x: 10, y: y0 + 38, class: "pm-note" }, g).textContent =
        xs.length ? `${xs.length} slice${xs.length > 1 ? "s" : ""}, avg ` +
                    `${v ? v + " " : ""}= ${avg.toFixed(2)}` : "not tasted";
      el("text", { x: 10, y: y0 + 54, class: "pm-note truth" }, g).textContent =
        (v ? `E[${v}]` : "typical") + ` = ${m.toFixed(2)}, sd ${s.toFixed(2)}`;
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
      more.textContent = `${res.mean.length - k} other shops hidden: tick ` +
        "\"show every shop\" to see them.";
      host.appendChild(more);
    }
    const key = document.createElement("div");
    key.className = "key";
    key.innerHTML =
      '<span><svg width="12" height="11" viewBox="0 0 12 11"><polygon ' +
      'class="pm-slice" points="1,1 11,1 6,10"/></svg>a slice tasted, ' +
      "stacked by its rating (hover for when)</span>" +
      `<span><i class="ln avg"></i>your average there <span>(${N.xbar})</span></span>` +
      '<span><i class="ln curve"></i>the shop\'s true ratings</span>' +
      `<span><i class="ln mean"></i>its typical rating <span>(E[${N.x}])</span></span>`;
    host.appendChild(key);

    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "x: a slice's rating at the best shop, x̂: at " +
      "your pick, x′: at the runner-up. Curves and typical ratings E[·] are the " +
      "hidden truth, shown only here. Shops are sorted best first; curves " +
      "share one scale, so a consistent shop's is tall and narrow.";
    host.appendChild(note);
  }

  return { table, mark, plot };
})();

// PostMortem: one run, quake by quake. A sortable table with a row per
// quake, and a plot of one quake with the hidden truth revealed.
//
//   PostMortem.table(table, quakes, opts)  -> {idx: tr} of the rows drawn
//   PostMortem.mark(rows, idx)             highlight quake idx's row
//   PostMortem.plot(host, result, idx, circles)  result: runner.replay()'s
//                                          output; circles: draw each
//                                          station's arrival circle
//
// The plot has a map of the region (stations, the epicenter, your
// estimate), a close-up around the epicenter, and each station's residual
// at your estimate. Pressing or dragging on the map or close-up moves the
// estimate there, with t0-hat refit to it, and redraws the residuals.
//
// Notation, the same in the table, the plot and their hover text: p is the
// epicenter and t0 the origin time (hidden), p-hat and t0-hat your
// estimate; station i at s_i recorded t_i; v = 6 km/s; r_i = t0-hat +
// ||p-hat - s_i|| / v - t_i is its residual at your estimate; sigma the
// timing noise (hidden).

const PostMortem = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const V = 6;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  // the notation, as HTML. Wrapped in <i> so headings' uppercase styling
  // leaves it alone
  const ERR = "<i>‖p̂ − p‖</i>";
  const DT = "<i>t̂<sub>0</sub> − t<sub>0</sub></i>";
  const RMAX = "<i>max |r<sub>i</sub>|</i>";
  const fmt = (v, k = 2) => (v <= -0.5 * 10 ** -k ? "−" : "") + Math.abs(v).toFixed(k);
  const SUB = "₀₁₂₃₄₅₆₇₈₉";
  const sub = n => String(n).replace(/\d/g, d => SUB[d]);
  const name = i => i < 26 ? String.fromCharCode(65 + i) : "S" + i;

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
    { label: "Quake", num: true, key: q => q.idx, text: q => q.idx },
    { label: "Result", key: q => q.hit ? 1 : 0,
      node: q => badge(q.hit ? "hit" : "miss", q.hit ? "ok" : "bad"),
      help: "Hit: your estimate is within 5 km of the epicenter." },
    { label: "Error", html: ERR + ' <span class="unit">(km)</span>', num: true, key: q => q.error_km,
      text: q => fmt(q.error_km),
      help: `${ERR}: how far your estimate <i>p̂</i> is from the ` +
            "epicenter <i>p</i> (hidden)." },
    { label: "Start", html: DT + ' <span class="unit">(s)</span>', num: true, key: q => q.t0_error,
      text: q => fmt(q.t0_error),
      help: `${DT}: your origin time minus the true one. Positive: ` +
            "you think it started later." },
    { label: "Noise", html: '<i>σ</i> <span class="unit">(s)</span>', num: true, key: q => q.noise_sd,
      text: q => q.noise_sd.toFixed(2),
      help: "<i>σ</i>: timing noise at every station (hidden)." },
    { label: "Worst fit", html: RMAX + ' <span class="unit">(s)</span>', num: true,
      key: q => q.max_resid, text: q => q.max_resid.toFixed(2),
      help: `${RMAX}: the station your estimate fits worst. ` +
            "<i>r<sub>i</sub></i> = predicted minus recorded arrival." },
  ];

  // opts: {sort: {col, dir}, onSort(col), onPick(idx)}
  function table(tbl, quakes, opts) {
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
    const sorted = [...quakes].sort((a, b) =>
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

  // highlights quake idx's row, scrolling the table to it if it's out of view
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
  const W = 920, H = 430, SIZE = 200;
  const MAP = { x: 46, y: 22, w: 370 };                  // the region
  const ZOOM = { x: 470, y: 22, w: 190 };                // close-up
  const RES = { x: 700, y: 22, w: 205, rowH: 0 };        // residual bars

  // draws a station: a triangle
  function station(g, x, y, label) {
    el("polygon", { points: `${x},${y - 7} ${x - 6.5},${y + 5} ${x + 6.5},${y + 5}`,
                    class: "q-station" }, g);
    if (label) {
      el("text", { x: x + 8, y: y - 4, class: "q-label" }, g).textContent = label;
    }
  }

  function star(g, x, y, r) {
    let pts = "";
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r;
      pts += `${(x + rr * Math.cos(a)).toFixed(1)},${(y + rr * Math.sin(a)).toFixed(1)} `;
    }
    el("polygon", { points: pts, class: "q-true" }, g);
  }

  function cross(g, x, y, r, ok) {
    const cls = "q-est " + (ok ? "ok" : "bad");
    el("line", { x1: x - r, y1: y - r, x2: x + r, y2: y + r, class: cls }, g);
    el("line", { x1: x - r, y1: y + r, x2: x + r, y2: y - r, class: cls }, g);
  }

  // one square panel showing [x0, x0 + span] by [y0, y0 + span] km, y up;
  // km(sx, sy) maps an svg point back to km
  function panel(svg, box, x0, y0, span, id) {
    const s = box.w / span;
    const px = x => box.x + (x - x0) * s, py = y => box.y + box.w - (y - y0) * s;
    const km = (sx, sy) => [x0 + (sx - box.x) / s, y0 + (box.y + box.w - sy) / s];
    el("rect", { x: box.x, y: box.y, width: box.w, height: box.w,
                 class: "q-panel" }, svg);
    const clip = el("clipPath", { id }, svg);
    el("rect", { x: box.x, y: box.y, width: box.w, height: box.w }, clip);
    const g = el("g", { "clip-path": `url(#${id})` }, svg);
    return { g, px, py, s, km };
  }

  // r_i = t0-hat + ||p-hat - s_i|| / v - t_i at est = (x, y, t0)
  const residuals = (res, [x, y, t0]) => res.stations.map(([sx, sy], i) =>
    t0 + Math.hypot(x - sx, y - sy) / V - res.arrivals[i]);

  // the t0-hat that best fits p-hat = (x, y): least squares in t0-hat is
  // the mean of t_i - ||p-hat - s_i|| / v
  const fitT0 = (res, x, y) => res.stations.reduce((sum, [sx, sy], i) =>
    sum + res.arrivals[i] - Math.hypot(x - sx, y - sy) / V, 0) / res.arrivals.length;

  function ticks(svg, box, x0, y0, span, step) {
    const s = box.w / span;
    for (let v = Math.ceil(x0 / step) * step; v <= x0 + span + 1e-9; v += step) {
      const x = box.x + (v - x0) * s;
      el("line", { x1: x, x2: x, y1: box.y + box.w, y2: box.y + box.w + 4,
                   class: "pm-tick" }, svg);
      el("text", { x, y: box.y + box.w + 16, "text-anchor": "middle",
                   class: "pm-ticklabel" }, svg).textContent = +v.toFixed(1);
    }
    for (let v = Math.ceil(y0 / step) * step; v <= y0 + span + 1e-9; v += step) {
      const y = box.y + box.w - (v - y0) * s;
      el("line", { x1: box.x - 4, x2: box.x, y1: y, y2: y, class: "pm-tick" }, svg);
      el("text", { x: box.x - 7, y: y + 4, "text-anchor": "end",
                   class: "pm-ticklabel" }, svg).textContent = +v.toFixed(1);
    }
  }

  // res.dragged (a dragged estimate) outlives a redraw, e.g. a toggle flip
  function plot(host, res, idx, circles) {
    host.replaceChildren();
    const n = res.arrivals.length;
    const [px0, py0] = res.p;
    // during a drag the residual scale (lim) only widens, and the close-up's
    // frame (zoom) holds if the drag began in it, so the estimate stays
    // under the pointer
    let drag = null, zoom = null, lim = 1, panels = {}, frame = 0;

    const head = document.createElement("p");
    head.className = "replay-head";
    host.appendChild(head);

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "pm-plot",
      role: "img", "aria-label": `Quake ${idx}: stations, the epicenter and ` +
        "your estimate on a map, a close-up, and each station's residual" });
    const wrap = document.createElement("div");
    wrap.className = "pm-plot-wrap";
    wrap.appendChild(svg);
    host.appendChild(wrap);

    const key = document.createElement("div");
    key.className = "key";
    host.appendChild(key);

    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Press or drag on the map or close-up to move p̂: " +
      "t̂₀ refits to it (the mean of tᵢ − ‖p̂ − sᵢ‖ / v) and the residuals " +
      "follow. Arrival circle: radius v(tᵢ − t₀) around station i, using " +
      "the true start; the circles meet near p. Residual " +
      "rᵢ = t̂₀ + ‖p̂ − sᵢ‖ / v − tᵢ at the estimate.";
    host.appendChild(note);

    function draw() {
      const est = res.dragged || res.est, moved = !!res.dragged;
      const [ex, ey, et0] = est;
      const err = Math.hypot(ex - px0, ey - py0), hit = err <= 5;
      const resid = moved ? residuals(res, est) : res.resid;

      head.replaceChildren(badge(hit ? "hit" : "miss", hit ? "ok" : "bad"));
      const dt = et0 - res.t0;
      head.append(` Quake ${idx}: ${moved ? "the dragged" : "your"} ` +
        `estimate is ${err.toFixed(2)} km from the epicenter, its start ` +
        `time ${Math.abs(dt).toFixed(2)} s ${dt >= 0 ? "late" : "early"}.`);
      if (moved) {
        const back = document.createElement("button");
        back.className = "quiet";
        back.textContent = "Back to your estimate";
        back.onclick = () => { delete res.dragged; draw(); };
        head.append(" ", back);
      }

      svg.replaceChildren();
      // ---- the map
      const m = panel(svg, MAP, 0, 0, SIZE, "q-clip-map");
      ticks(svg, MAP, 0, 0, SIZE, 50);
      el("text", { x: MAP.x, y: MAP.y - 8, class: "q-title" }, svg).textContent =
        "Map (km)";
      if (circles) {
        // where each station's recording puts the quake, given the true start
        res.arrivals.forEach((t, i) => {
          const r = V * (t - res.t0);
          if (r <= 0) return;
          el("circle", { cx: m.px(res.stations[i][0]), cy: m.py(res.stations[i][1]),
                         r: r * m.s, class: "q-circle" }, m.g);
        });
      }
      el("line", { x1: m.px(px0), y1: m.py(py0), x2: m.px(ex), y2: m.py(ey),
                   class: "q-err" }, m.g);
      // stations lie inside the region: unclipped, so edge labels show
      res.stations.forEach(([x, y], i) => station(svg, m.px(x), m.py(y), name(i)));
      // on top of the stations; the estimate may fall off the map: clipped
      star(svg, m.px(px0), m.py(py0), 9);
      cross(el("g", { "clip-path": "url(#q-clip-map)" }, svg),
            m.px(ex), m.py(ey), 6, hit);

      // ---- the close-up: the epicenter and the estimate, with room around;
      // still while a drag that began in it is on
      if (drag !== "zoom") {
        zoom = { half: Math.max(6.5, 0.7 * err), cx: (px0 + ex) / 2, cy: (py0 + ey) / 2 };
      }
      const { half, cx, cy } = zoom;
      const span = 2 * half, zx0 = cx - half, zy0 = cy - half;
      const z = panel(svg, ZOOM, zx0, zy0, span, "q-clip-zoom");
      const step = [1, 2, 5, 10, 20, 50, 100].find(v => span / v <= 5);
      ticks(svg, ZOOM, zx0, zy0, span, step);
      el("text", { x: ZOOM.x, y: ZOOM.y - 8, class: "q-title" }, svg).textContent =
        "Close-up (km)";
      // the 5 km hit radius
      el("circle", { cx: z.px(px0), cy: z.py(py0), r: 5 * z.s, class: "q-hit" }, z.g);
      if (circles) {
        res.arrivals.forEach((t, i) => {
          const r = V * (t - res.t0);
          if (r <= 0) return;
          el("circle", { cx: z.px(res.stations[i][0]), cy: z.py(res.stations[i][1]),
                         r: r * z.s, class: "q-circle" }, z.g);
        });
      }
      el("line", { x1: z.px(px0), y1: z.py(py0), x2: z.px(ex), y2: z.py(ey),
                   class: "q-err" }, z.g);
      res.stations.forEach(([x, y], i) => {
        if (Math.abs(x - cx) <= half && Math.abs(y - cy) <= half) {
          station(z.g, z.px(x), z.py(y), name(i));
        }
      });
      star(z.g, z.px(px0), z.py(py0), 10);
      cross(z.g, z.px(ex), z.py(ey), 7, hit);
      const facts = [
        `p = (${px0.toFixed(1)}, ${py0.toFixed(1)}), t₀ = ${res.t0.toFixed(2)} s`,
        `p̂ = (${ex.toFixed(1)}, ${ey.toFixed(1)}), t̂₀ = ${et0.toFixed(2)} s`,
        `‖p̂ − p‖ = ${err.toFixed(2)} km`,
        `σ = ${res.noise_sd.toFixed(2)} s`,
      ];
      facts.forEach((t, k) => {
        el("text", { x: ZOOM.x, y: ZOOM.y + ZOOM.w + 42 + 19 * k,
                     class: "pm-note" + (k === 1 ? "" : " truth") }, svg).textContent = t;
      });

      // ---- residuals: r_i at the estimate; a drag only widens the scale
      const rowH = Math.min(28, (H - 70) / n);
      const need = Math.max(1, ...resid.map(Math.abs));
      lim = drag ? Math.max(lim, need) : need;
      const mid = RES.x + 22 + (RES.w - 22) / 2, half2 = (RES.w - 22) / 2 - 4;
      const bx = v => mid + v / lim * half2;
      el("text", { x: RES.x, y: RES.y - 8, class: "q-title" }, svg).textContent =
        "Residual rᵢ (s)";
      const bottom = RES.y + n * rowH;
      el("line", { x1: mid, x2: mid, y1: RES.y, y2: bottom, class: "q-zero" }, svg);
      resid.forEach((r, i) => {
        const y = RES.y + i * rowH;
        el("text", { x: RES.x, y: y + rowH / 2 + 4, class: "q-label" }, svg)
          .textContent = name(i);
        const bar = el("rect", { x: Math.min(bx(0), bx(r)), y: y + 4,
          width: Math.max(1, Math.abs(bx(r) - bx(0))), height: rowH - 8,
          class: "q-bar" }, svg);
        el("title", {}, bar).textContent = `station ${name(i)}: r = ${fmt(r)} s`;
      });
      for (const v of [-lim, 0, lim]) {
        el("text", { x: bx(v), y: bottom + 16, "text-anchor": "middle",
                     class: "pm-ticklabel" }, svg).textContent = fmt(v, 1);
      }

      // last, so they take the presses
      for (const [id, box] of [["map", MAP], ["zoom", ZOOM]]) {
        el("rect", { x: box.x, y: box.y, width: box.w, height: box.w,
                     class: "q-drag", "data-panel": id }, svg);
      }
      panels = { map: m, zoom: z };

      key.innerHTML =
        '<span><svg width="14" height="13" viewBox="0 0 14 13"><polygon ' +
        'class="q-station" points="7,1 1,12 13,12"/></svg>station</span>' +
        '<span><svg width="16" height="16" viewBox="0 0 16 16"><polygon ' +
        'class="q-true" points="8,0 10,6 16,6 11,10 13,16 8,12 3,16 5,10 0,6 ' +
        '6,6"/></svg>epicenter <i>p</i></span>' +
        '<span><svg width="14" height="14" viewBox="0 0 14 14"><path ' +
        `class="q-est ${hit ? "ok" : "bad"}" d="M2,2 L12,12 M2,12 L12,2"/></svg>` +
        `${moved ? "dragged" : "your"} estimate <i>p̂</i></span>` +
        (circles ? '<span><i class="ln q-circ"></i>arrival circle</span>' : "") +
        '<span><i class="ln q-hitln"></i>5 km</span>';
    }

    // moves the estimate to the pointer, in the panel the drag began in;
    // one redraw per animation frame
    function moveTo(e) {
      const pt = new DOMPoint(e.clientX, e.clientY)
        .matrixTransform(svg.getScreenCTM().inverse());
      const [x, y] = panels[drag].km(pt.x, pt.y);
      res.dragged = [x, y, fitT0(res, x, y)];
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); });
    }
    svg.addEventListener("pointerdown", e => {
      const id = e.target.getAttribute && e.target.getAttribute("data-panel");
      if (!id || e.button > 0) return;
      e.preventDefault();
      drag = id;
      svg.setPointerCapture(e.pointerId);
      moveTo(e);
    });
    svg.addEventListener("pointermove", e => { if (drag) moveTo(e); });
    const end = () => {
      if (!drag) return;
      drag = null;
      cancelAnimationFrame(frame);
      frame = 0;
      draw();
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);

    draw();
  }

  return { table, mark, plot };
})();

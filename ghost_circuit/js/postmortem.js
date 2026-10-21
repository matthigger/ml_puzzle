// PostMortem: one run, circuit by circuit. A sortable table with a row per
// circuit, and a plot of one circuit with the hidden truth revealed.
//
//   PostMortem.table(table, circuits, opts) -> {idx: tr} of the rows drawn
//   PostMortem.mark(rows, idx)              highlight circuit idx's row
//   PostMortem.plot(host, result, idx, all)  result: runner.replay()'s
//                                            output; all: every device, or
//                                            only those on the circuit or
//                                            named
//
// The plot has two parts: a row per device (true watts as an outlined bar,
// your estimate as a filled one inside it, biggest first), and the meter
// hour by hour with the true load and your fit.
//
// Notation, the same in the table, the plot and their hover text: w_j is
// device j's true watts (0 off the circuit), w-hat_j your estimate; a device
// is named when w-hat_j >= 1; g is the ghost, the biggest device; y_t is the
// meter in hour t.

const PostMortem = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const BIG = 100, NAMED = 1;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  // the notation, as HTML; wrapped in <i> so headings' uppercase styling
  // leaves it alone
  const WJ = "<i>w<sub>j</sub></i>", WHJ = "<i>ŵ<sub>j</sub></i>";
  const OFF = "<i>Σ<sub>j</sub> |ŵ<sub>j</sub> − w<sub>j</sub>|</i>";
  const GHOST = "<i>ŵ<sub>g</sub> − w<sub>g</sub></i>";
  const watts = v => (v <= -0.5 ? "−" : "") + Math.abs(Math.round(v));
  const dev = j => "dev_" + String(j).padStart(3, "0");

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
    { label: "Circuit", num: true, key: c => c.idx, text: c => c.idx },
    { label: "Result", key: c => c.correct ? 1 : 0,
      node: c => badge(c.correct ? "right" : "wrong", c.correct ? "ok" : "bad") },
    { label: "Missed", num: true, key: c => c.missed, text: c => c.missed || "",
      help: `Devices of ${BIG} W or more you didn't name.` },
    { label: "False alarms", num: true, key: c => c.false_alarms,
      text: c => c.false_alarms || "",
      help: `Devices you named that aren't on the circuit (${WJ} = 0).` },
    { label: "Named", num: true, key: c => c.named, text: c => c.named,
      help: `Devices you named: ${WHJ} ≥ ${NAMED}. 8 are on each circuit.` },
    { label: "Watts off", html: `Watts off ${OFF}`, num: true,
      key: c => c.watts_off, text: c => watts(c.watts_off),
      help: `${OFF}: how far your watts are from the truth, summed over ` +
            `every device. ${WJ}: device <i>j</i>'s true watts (hidden), ` +
            `${WHJ}: yours.` },
    { label: "Ghost error", html: `Ghost ${GHOST}`, num: true,
      key: c => c.ghost_err, text: c => watts(c.ghost_err),
      help: `${GHOST}: your watts minus the truth at the ghost <i>g</i>, ` +
            "the biggest device. Negative: too low." },
  ];

  // opts: {sort: {col, dir}, onSort(col), onPick(idx)}
  function table(tbl, circuits, opts) {
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
    const sorted = [...circuits].sort((a, b) =>
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

  // highlights circuit idx's row, scrolling the table to it if it's out of
  // view
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
  const W = 920, LEFT = 236, RIGHT = 24, AXIS = 30;

  function svgBadge(g, x, y, label, cls) {
    const w = 7 * label.length + 12;
    el("rect", { x, y: y - 11, width: w, height: 15, rx: 7.5,
                 class: "pm-badge " + cls }, g);
    el("text", { x: x + w / 2, y, "text-anchor": "middle",
                 class: "pm-badge-text " + cls }, g).textContent = label;
    return x + w + 5;
  }

  // round tick step giving about n ticks over span
  function step(span, n) {
    const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw);
  }

  // what device j is, for its badge and bar color: [label, class] or null
  function status(res, j) {
    const w = res.w[j], named = res.w_hat[j] >= NAMED;
    if (w >= BIG && !named) return ["MISSED", "bad"];
    if (w === 0 && named) return ["FALSE ALARM", "bad"];
    if (w > 0 && w < BIG) return [`UNDER ${BIG} W`, "muted"];
    return null;
  }

  function devices(host, res, all) {
    const n = res.w.length;
    const order = [...Array(n).keys()]
      .filter(j => all || res.w[j] > 0 || res.w_hat[j] >= NAMED)
      .sort((a, b) => (res.w[b] - res.w[a]) || (res.w_hat[b] - res.w_hat[a]));
    const compact = order.length > 30;
    const RH = compact ? 16 : 36, k = order.length;
    const H = k * RH + AXIS;

    const vals = order.flatMap(j => [res.w[j], res.w_hat[j]]);
    const lo = Math.min(0, ...vals), hi = Math.max(BIG, ...vals) * 1.04;
    const plotW = W - LEFT - RIGHT;
    const sx = v => LEFT + (v - lo) / (hi - lo) * plotW;

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "pm-plot",
      role: "img", "aria-label": "Each device's true watts and your " +
        "estimate, biggest first" });
    order.forEach((j, row) => {
      const y0 = row * RH, mid = y0 + RH / 2;
      const g = el("g", {}, svg);
      const st = status(res, j), isGhost = j === res.ghost;
      const right = res.w[j] > 0 ? res.w[j] >= BIG ? res.w_hat[j] >= NAMED
                                                   : null
                                 : res.w_hat[j] >= NAMED ? false : null;
      el("rect", { x: 0, y: y0, width: W, height: RH,
                   class: st && st[1] === "bad" ? "pm-row picked bad"
                        : row % 2 ? "pm-row alt" : "pm-row" }, g);
      el("title", {}, g).textContent = `${dev(j)}: w = ${watts(res.w[j])} W, ` +
        `ŵ = ${watts(res.w_hat[j])} W`;

      // the truth (outlined) and your estimate (filled) from 0
      const tH = compact ? 10 : 18, eH = compact ? 5 : 9;
      const x0 = sx(0);
      if (res.w[j] > 0) {
        el("rect", { x: x0, y: mid - tH / 2, width: sx(res.w[j]) - x0,
                     height: tH, class: "gc-true" }, g);
      }
      const e = res.w_hat[j];
      if (Math.abs(e) >= 0.5) {
        el("rect", { x: Math.min(x0, sx(e)), y: mid - eH / 2,
                     width: Math.abs(sx(e) - x0), height: eH,
                     class: "gc-est" + (right === false ? " bad"
                                      : right ? " ok" : "") }, g);
      }

      el("text", { x: 10, y: compact ? mid + 4 : y0 + 16,
                   class: compact ? "pm-note" : "pm-shop" }, g)
        .textContent = dev(j);
      let bx = compact ? 64 : 76;
      if (isGhost) bx = svgBadge(g, bx, compact ? mid + 4 : y0 + 16, "GHOST", "ok");
      if (st && (!compact || st[1] === "bad")) {
        svgBadge(g, bx, compact ? mid + 4 : y0 + 16, ...st);
      }
      if (!compact) {
        el("text", { x: 10, y: y0 + 31, class: "pm-note" }, g).textContent =
          `w = ${watts(res.w[j])}, ŵ = ${watts(e)}`;
      }
    });

    // the 100 W line: devices past it must be named
    el("line", { x1: sx(BIG), x2: sx(BIG), y1: 0, y2: k * RH,
                 class: "pm-mean" }, svg);
    // watts axis
    const ya = k * RH, s = step(hi - lo, 8);
    el("line", { x1: sx(0), x2: sx(0), y1: 0, y2: ya, class: "pm-base" }, svg);
    for (let v = Math.ceil(lo / s) * s; v <= hi; v += s) {
      el("line", { x1: sx(v), x2: sx(v), y1: ya, y2: ya + 5, class: "pm-tick" }, svg);
      el("text", { x: sx(v), y: ya + 18, "text-anchor": "middle",
                   class: "pm-ticklabel" }, svg).textContent = watts(v);
    }
    el("text", { x: LEFT - 10, y: ya + 18, "text-anchor": "end",
                 class: "pm-ticklabel" }, svg).textContent = "watts";

    const wrap = document.createElement("div");
    wrap.className = "pm-plot-wrap" + (compact ? " tall" : "");
    wrap.appendChild(svg);
    host.appendChild(wrap);
    if (!all) {
      const more = document.createElement("p");
      more.className = "hint";
      more.textContent = `${n - k} other devices hidden: off the circuit, ` +
        "and you gave them under 1 W.";
      host.appendChild(more);
    }
  }

  function meter(host, res) {
    const T = res.y.length, PH = 220, TOP = 10;
    const H = PH + AXIS;
    const all = [...res.y, ...res.load, ...res.fit];
    const s = step(Math.max(...all) - Math.min(0, ...all), 5);
    const lo = Math.min(0, Math.floor(Math.min(...all) / s) * s);
    const hi = Math.ceil(Math.max(...all) / s) * s;
    const plotW = W - LEFT - RIGHT;
    const sx = t => LEFT + (t + 0.5) / T * plotW;
    const sy = v => TOP + (hi - v) / (hi - lo) * (PH - TOP);

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "pm-plot",
      role: "img", "aria-label": "The meter hour by hour, the true load " +
        "and your fit" });
    // hours the ghost was on
    res.ghost_on.forEach((on, t) => {
      if (on) {
        el("rect", { x: sx(t) - plotW / T / 2, y: TOP, width: plotW / T,
                     height: PH - TOP, class: "gc-on" }, svg);
      }
    });
    for (let v = lo; v <= hi; v += s) {
      el("line", { x1: LEFT, x2: W - RIGHT, y1: sy(v), y2: sy(v),
                   class: "pm-base" }, svg);
      el("text", { x: LEFT - 8, y: sy(v) + 4, "text-anchor": "end",
                   class: "pm-ticklabel" }, svg).textContent = watts(v);
    }
    const line = (vals, cls) => el("path", { class: cls, d: vals.map((v, t) =>
      `${t ? "L" : "M"}${sx(t).toFixed(1)},${sy(v).toFixed(1)}`).join(" ") }, svg);
    line(res.load, "gc-load");
    line(res.fit, "gc-fit");
    res.y.forEach((v, t) => {
      const c = el("circle", { cx: sx(t), cy: sy(v), r: 2.6, class: "gc-y" }, svg);
      el("title", {}, c).textContent = `hour ${t}: meter ${watts(v)} W, ` +
        `true load ${watts(res.load[t])} W, your fit ${watts(res.fit[t])} W`;
    });
    for (let t = 0; t < T; t += 12) {
      el("line", { x1: sx(t), x2: sx(t), y1: PH, y2: PH + 5, class: "pm-tick" }, svg);
      el("text", { x: sx(t), y: PH + 18, "text-anchor": "middle",
                   class: "pm-ticklabel" }, svg).textContent = t;
    }
    el("text", { x: LEFT - 8, y: PH + 18, "text-anchor": "end",
                 class: "pm-ticklabel" }, svg).textContent = "hour";
    el("text", { x: 10, y: TOP + 14, class: "pm-shop" }, svg).textContent =
      "the meter, y";
    el("text", { x: 10, y: TOP + 32, class: "pm-note" }, svg).textContent =
      `always-on load: b = ${watts(res.base)}`;
    el("text", { x: 10, y: TOP + 48, class: "pm-note" }, svg).textContent =
      `your fit's: b̂ = ${watts(res.b_hat)}`;
    el("text", { x: 10, y: TOP + 64, class: "pm-note" }, svg).textContent =
      `meter noise: σ = ${watts(res.noise_sd)}`;

    const wrap = document.createElement("div");
    wrap.className = "pm-plot-wrap";
    wrap.appendChild(svg);
    host.appendChild(wrap);
  }

  function plot(host, res, idx, all) {
    host.replaceChildren();
    const head = document.createElement("p");
    head.className = "replay-head";
    head.appendChild(badge(res.correct ? "right" : "wrong",
                           res.correct ? "ok" : "bad"));
    const parts = [`named ${res.named} device${res.named === 1 ? "" : "s"}`];
    if (res.missed) parts.push(`missed ${res.missed}`);
    if (res.false_alarms) {
      parts.push(`${res.false_alarms} false alarm${res.false_alarms > 1 ? "s" : ""}`);
    }
    head.append(` Circuit ${idx}: ${parts.join(", ")}; ` +
      `${watts(res.watts_off)} W off. The ghost was ${dev(res.ghost)} ` +
      `(${watts(res.w[res.ghost])} W).`);
    host.appendChild(head);

    devices(host, res, all);
    const key = document.createElement("div");
    key.className = "key";
    key.innerHTML =
      '<span><i class="sw gc-true"></i>true watts <span><i>(w<sub>j</sub>)' +
      "</i></span></span>" +
      '<span><i class="sw gc-est ok"></i>your watts <span><i>(ŵ<sub>j</sub>)' +
      "</i></span></span>" +
      `<span><i class="ln mean"></i>${BIG} W: name every device past it</span>`;
    host.appendChild(key);

    meter(host, res);
    const key2 = document.createElement("div");
    key2.className = "key";
    key2.innerHTML =
      '<span><i class="dot gc-y"></i>meter <span><i>(y<sub>t</sub>)</i></span></span>' +
      '<span><i class="ln load"></i>true load, no noise</span>' +
      '<span><i class="ln fit"></i>your fit <span><i>(xŵ + b̂)</i></span></span>' +
      '<span><i class="sw gc-on"></i>ghost on</span>';
    host.appendChild(key2);

    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "wⱼ: device j's true watts (the hidden truth, shown " +
      "only here); ŵⱼ: yours. The ghost is the biggest device. b̂ is the " +
      "always-on load that best fits your watts.";
    host.appendChild(note);
  }

  return { table, mark, plot };
})();

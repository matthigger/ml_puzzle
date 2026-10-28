// PostMortem: one run, circuit by circuit. A sortable table with a row per
// circuit, and one circuit as an interactive stack with the hidden truth
// revealed.
//
//   PostMortem.table(table, circuits, opts) -> {idx: tr} of the rows drawn
//   PostMortem.mark(rows, idx)              highlight circuit idx's row
//   PostMortem.plot(host, result, idx)      result: runner.replay()'s output
//
// The plot lists the devices named and the devices on the circuit, each
// switched on or off (at first: on if your estimate named it). Every
// change refits least squares on the devices switched on, plus an
// always-on load, and redraws the stack: each hour's fitted watts split
// into the devices that were on, the meter's reading as a dot. "The truth"
// stacks the hidden watts instead.
//
// Notation, the same in the table, the plot and their hover text: w_j is
// device j's true watts (0 off the circuit), w-hat_j its fitted watts; TPR
// = found / 8, FPR = wrong / 142, F1 = 2 found / (named + 8); y_t is the
// meter in hour t.

const PostMortem = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const N_ON = 8, N_OFF = 142;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  const WJ = "<i>w<sub>j</sub></i>";
  const watts = v => String(Math.round(v));
  const dev = j => "dev_" + String(j).padStart(3, "0");
  const pct = (v, d = 0) => (100 * v).toFixed(d) + "%";
  const f1 = (right, named) => 2 * right / (named + N_ON);

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
    { label: "Found", num: true, key: c => c.right,
      node: c => c.right === N_ON ? badge("all 8", "ok")
                                  : document.createTextNode(`${c.right} of 8`),
      help: `Devices you named that are on the circuit, of its ${N_ON}. ` +
            `TPR = found / ${N_ON}.` },
    { label: "Wrong", num: true, key: c => c.wrong, text: c => c.wrong || "",
      help: `Devices you named that aren't on the circuit (${WJ} = 0). ` +
            `FPR = wrong / ${N_OFF}.` },
    { label: "Named", num: true, key: c => c.n_named, text: c => c.n_named,
      help: "How many devices you named." },
    { label: "F1", num: true, key: c => f1(c.right, c.n_named),
      text: c => f1(c.right, c.n_named).toFixed(2),
      help: `2 × found / (named + ${N_ON}): high only when you find ` +
            "most devices and name few wrong ones." },
    { label: "Biggest miss", num: true, key: c => c.missed_w,
      text: c => c.missed_w ? watts(c.missed_w) + " W" : "",
      help: "True watts of the biggest device on the circuit you didn't " +
            "name." },
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
  const W = 920, L = 54, R = 14, TOP = 12, PH = 260, AXIS = 26;

  // round tick step giving about n ticks over span
  function step(span, n) {
    const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  }

  // the inverse of square matrix m (Gauss-Jordan, partial pivoting), or
  // null if it is singular
  function invert(m) {
    const n = m.length;
    const a = m.map((row, i) => [...row, ...row.map((_, k) => +(i === k))]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) {
        if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      }
      if (Math.abs(a[piv][c]) < 1e-8) return null;
      [a[c], a[piv]] = [a[piv], a[c]];
      const d = a[c][c];
      for (let k = 0; k < 2 * n; k++) a[c][k] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c || !a[r][c]) continue;
        const f = a[r][c];
        for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k];
      }
    }
    return a.map(row => row.slice(n));
  }

  // least squares of the meter y on devices ids plus an always-on term:
  // {b, w: {j: [w_hat, se]}, fit, rms}, or {error}
  function ols(x, y, ids) {
    const n = y.length, p = ids.length + 1;
    if (p > n - 2) {
      return { error: `${ids.length} devices are switched on: a fit of ` +
                      `${n} hours can take at most ${n - 3}.` };
    }
    const rows = y.map((_, t) => [...ids.map(j => x[j][t]), 1]);
    const m = Array.from({ length: p }, (_, a) => Array.from({ length: p },
      (_, b) => rows.reduce((s, r) => s + r[a] * r[b], 0)));
    const inv = invert(m);
    if (!inv) {
      return { error: "Some devices switched on can't be told apart (same " +
                      "on / off log, or always on), so no fit." };
    }
    const v = Array.from({ length: p },
      (_, a) => rows.reduce((s, r, t) => s + r[a] * y[t], 0));
    const beta = inv.map(row => row.reduce((s, q, b) => s + q * v[b], 0));
    const fit = rows.map(r => r.reduce((s, q, k) => s + q * beta[k], 0));
    const rss = y.reduce((s, yt, t) => s + (yt - fit[t]) ** 2, 0);
    const s2 = rss / (n - p);
    const w = {};
    ids.forEach((j, k) => { w[j] = [beta[k], Math.sqrt(s2 * inv[k][k])]; });
    return { b: beta[p - 1], w, fit, rms: Math.sqrt(rss / n) };
  }

  // what device j is, given the devices switched on
  function status(res, on, j) {
    if (res.w[j] > 0) return on.has(j) ? "found" : "missed";
    return on.has(j) ? "wrong" : "out";
  }
  const STATUS = { found: ["FOUND", "ok"], missed: ["MISSED", "bad"],
                   wrong: ["WRONG", "bad"], out: ["LEFT OUT", "muted"] };

  function stack(host, res, x, on, fitRes, truth, focus, onFocus) {
    const T = res.y.length, plotW = W - L - R, bw = plotW / T;
    const H = TOP + PH + AXIS;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "pm-plot",
      role: "img", "aria-label": truth
        ? "The meter hour by hour, split into the devices truly on it"
        : "The meter hour by hour and the fit from the devices switched on" });
    const defs = el("defs", {}, svg);
    const hid = "gc-hatch-" + Math.random().toString(36).slice(2, 8);
    const pat = el("pattern", { id: hid, width: 4, height: 4,
      patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    el("line", { x1: 0, y1: 0, x2: 0, y2: 4, class: "gc-hatch-line" }, pat);

    // each hour: [base, segments {j, lo, hi}]
    const ids = truth ? Object.keys(res.w).map(Number).filter(j => res.w[j] > 0)
                      : [...on];
    const watt = j => truth ? res.w[j] : fitRes.w[j][0];
    ids.sort((a, b) => watt(b) - watt(a));
    const base = truth ? res.baseline : fitRes.b;
    const hours = res.y.map((_, t) => {
      let up = base, down = base;
      const segs = [];
      for (const j of ids) {
        if (!x[j][t]) continue;
        const w = watt(j);
        if (w >= 0) { segs.push({ j, lo: up, hi: up + w }); up += w; }
        else { segs.push({ j, lo: down + w, hi: down, neg: true }); down += w; }
      }
      return { segs, top: up, bottom: Math.min(0, down) };
    });
    const vals = [...res.y, ...hours.map(h => h.top), ...hours.map(h => h.bottom), 0];
    const s = step(Math.max(...vals) - Math.min(...vals), 5);
    const lo = Math.floor(Math.min(...vals) / s) * s;
    const hi = Math.ceil(Math.max(...vals) * 1.03 / s) * s;
    const sy = v => TOP + (hi - v) / (hi - lo) * PH;
    for (let v = lo; v <= hi; v += s) {
      el("line", { x1: L, x2: W - R, y1: sy(v), y2: sy(v), class: "pm-base" }, svg);
      el("text", { x: L - 8, y: sy(v) + 4, "text-anchor": "end",
                   class: "pm-ticklabel" }, svg).textContent = watts(v);
    }
    const gap = Math.min(1.2, bw * .18);
    hours.forEach((h, t) => {
      const x0 = L + t * bw + gap / 2, w0 = bw - gap;
      if (base > 0) {
        el("rect", { x: x0, y: sy(base), width: w0, height: sy(0) - sy(base),
                     class: "gc-base" }, svg);
      }
      for (const g of h.segs) {
        const st = status(res, on, g.j);
        const r = el("rect", { x: x0, y: sy(g.hi), width: w0,
          height: Math.max(.5, sy(g.lo) - sy(g.hi)),
          class: `gc-seg gc-${st}${g.neg ? " gc-neg" : ""}` +
                 (focus !== null && focus !== g.j ? " gc-fade" : "") }, svg);
        if (st === "missed") r.setAttribute("fill", `url(#${hid})`);
        el("title", {}, r).textContent = `${dev(g.j)}, hour ${t}: ` +
          `${watts(watt(g.j))} W ${truth ? "(true)" : "(fitted)"}`;
        r.addEventListener("click", () => onFocus(g.j));
      }
    });
    res.y.forEach((v, t) => {
      const c = el("circle", { cx: L + (t + .5) * bw, cy: sy(v), r: 2.4,
                               class: "gc-y" }, svg);
      el("title", {}, c).textContent = `hour ${t}: meter ${watts(v)} W` +
        (truth || !fitRes.fit ? "" : `, fit ${watts(fitRes.fit[t])} W`);
    });
    for (let t = 0; t < T; t += 12) {
      el("text", { x: L + t * bw, y: TOP + PH + 18, "text-anchor": "middle",
                   class: "pm-ticklabel" }, svg).textContent = t;
    }
    el("text", { x: W - R, y: TOP + PH + 18, "text-anchor": "end",
                 class: "pm-ticklabel" }, svg).textContent = "hour";
    const wrap = document.createElement("div");
    wrap.className = "pm-plot-wrap";
    wrap.appendChild(svg);
    host.appendChild(wrap);
  }

  function stat(label, value, sub) {
    const d = document.createElement("div");
    d.className = "gc-stat";
    d.innerHTML = `<span class="gc-stat-label">${label}</span>` +
      `<span class="gc-stat-value">${value}</span>` +
      `<span class="gc-stat-sub">${sub}</span>`;
    return d;
  }

  function plot(host, res, idx) {
    // devices listed: on the circuit (biggest first), then the others
    // named; more can be added by number
    const x = res.x.map(col => [...col].map(Number));
    const yours = new Set(res.named);
    const listed = [
      ...Object.keys(res.w).map(Number).filter(j => res.w[j] > 0)
        .sort((a, b) => res.w[b] - res.w[a]),
      ...res.named.filter(j => !(res.w[j] > 0))];
    let on = new Set(res.named), truth = false, focus = null;

    function draw() {
      host.replaceChildren();
      const ids = [...on];
      const fitRes = ols(x, res.y, ids);
      const right = ids.filter(j => res.w[j] > 0).length;
      const wrong = ids.length - right;
      const edited = on.size !== yours.size || ids.some(j => !yours.has(j));

      const head = document.createElement("div");
      head.className = "gc-head";
      const h = document.createElement("p");
      h.className = "replay-head";
      h.textContent = `Circuit ${idx}: ` + (edited
        ? `your edit names ${on.size} device${on.size === 1 ? "" : "s"}. ` +
          `Your estimate named ${yours.size} (F1 ${f1(res.right, res.n_named).toFixed(2)}).`
        : `your estimate named ${on.size} device${on.size === 1 ? "" : "s"}. ` +
          "Switch devices on or off to see how the fit and the scores change.");
      head.appendChild(h);
      if (edited) {
        const b = document.createElement("button");
        b.textContent = "Back to your estimate";
        b.onclick = () => { on = new Set(res.named); draw(); };
        head.appendChild(b);
      }
      host.appendChild(head);

      const stats = document.createElement("div");
      stats.className = "gc-stats";
      stats.append(
        stat("F1", f1(right, on.size).toFixed(2), `2 × ${right} / (${on.size} named + ${N_ON})`),
        stat("TPR", pct(right / N_ON), `${right} of ${N_ON} found`),
        stat("FPR", pct(wrong / N_OFF, 1), `${wrong} of ${N_OFF} wrong`),
        stat("Left over", fitRes.error ? "—" : `±${watts(fitRes.rms)} W`,
             `meter minus fit; noise is ±${watts(res.noise)} W`));
      host.appendChild(stats);

      const bar = document.createElement("div");
      bar.className = "gc-bar";
      const seg = document.createElement("div");
      seg.className = "seg";
      seg.setAttribute("role", "radiogroup");
      seg.setAttribute("aria-label", "What the stack shows");
      for (const [v, label] of [[false, "Fitted watts"], [true, "True watts"]]) {
        const b = document.createElement("button");
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", truth === v);
        b.textContent = label;
        b.onclick = () => { truth = v; draw(); };
        seg.appendChild(b);
      }
      bar.appendChild(seg);
      const key = document.createElement("div");
      key.className = "key";
      key.innerHTML = truth
        ? '<span><i class="sw gc-found"></i>found</span>' +
          '<span><i class="sw gc-missed"></i>missed</span>' +
          '<span><i class="sw gc-base"></i>always on</span>' +
          '<span><i class="dot gc-y"></i>meter</span>'
        : '<span><i class="sw gc-found"></i>on the circuit</span>' +
          '<span><i class="sw gc-wrong"></i>not on it (wrong)</span>' +
          '<span><i class="sw gc-base"></i>fitted always-on</span>' +
          '<span><i class="dot gc-y"></i>meter</span>';
      bar.appendChild(key);
      host.appendChild(bar);

      if (!truth && fitRes.error) {
        const msg = document.createElement("p");
        msg.className = "msg error";
        msg.textContent = fitRes.error + " Switch some off, or look at the true watts.";
        host.appendChild(msg);
      } else {
        stack(host, res, x, on, fitRes, truth, focus,
              j => { focus = focus === j ? null : j; draw(); });
      }

      devicesTable(host, fitRes);
      const add = document.createElement("form");
      add.className = "gc-add";
      add.innerHTML = '<label class="field"><span>Add a device</span>' +
        `<input type="number" min="0" max="${res.w.length - 1}" ` +
        'placeholder="0 to 149" aria-label="Device number"></label>' +
        '<button type="submit">Add and switch on</button>';
      add.onsubmit = e => {
        e.preventDefault();
        const j = parseInt(add.querySelector("input").value);
        if (!(j >= 0 && j < res.w.length)) return;
        if (!listed.includes(j)) listed.push(j);
        on.add(j);
        focus = j;
        draw();
      };
      host.appendChild(add);
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = "Fitted watts: least squares of the meter on the " +
        "devices switched on, plus an always-on load; ± is 2 standard " +
        "errors. A device whose range reaches 0 is one the meter can't " +
        "vouch for. Click a slice or a row to pick out one device.";
      host.appendChild(note);
    }

    function devicesTable(host, fitRes) {
      const wrap = document.createElement("div");
      wrap.className = "table-wrap gc-devices";
      const tbl = document.createElement("table");
      tbl.className = "runs";
      tbl.innerHTML = '<thead><tr><th>On</th><th>Device</th><th></th>' +
        '<th class="num">True watts</th><th class="num">Fitted watts</th>' +
        "</tr></thead><tbody></tbody>";
      for (const j of listed) {
        const st = status(res, on, j), [label, cls] = STATUS[st];
        const tr = tbl.tBodies[0].insertRow();
        tr.className = "pick" + (focus === j ? " selected" : "");
        tr.onclick = e => {
          if (e.target.closest("input")) return;
          focus = focus === j ? null : j;
          draw();
        };
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = on.has(j);
        box.setAttribute("aria-label", "Switch " + dev(j) + " on");
        box.onchange = () => {
          if (box.checked) on.add(j); else on.delete(j);
          draw();
        };
        tr.insertCell().appendChild(box);
        tr.insertCell().textContent = dev(j) + (yours.has(j) ? "" : " (added)");
        if (yours.has(j) || res.w[j] > 0) tr.cells[1].textContent = dev(j);
        tr.insertCell().appendChild(badge(label, cls));
        const tw = tr.insertCell();
        tw.className = "num";
        tw.textContent = `${watts(res.w[j])} W`;
        const fw = tr.insertCell();
        fw.className = "num";
        const f = !fitRes.error && fitRes.w[j];
        fw.textContent = f ? `${watts(f[0])} ± ${watts(2 * f[1])} W` : "—";
      }
      wrap.appendChild(tbl);
      host.appendChild(wrap);
    }

    draw();
  }

  return { table, mark, plot };
})();

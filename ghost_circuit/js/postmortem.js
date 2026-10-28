// PostMortem: one run, circuit by circuit. A sortable table with a row per
// circuit, and one circuit as an interactive fit with the hidden truth
// revealed.
//
//   PostMortem.table(table, circuits, opts) -> {idx: tr} of the rows drawn
//   PostMortem.mark(rows, idx)              highlight circuit idx's row
//   PostMortem.plot(host, result, idx)      result: runner.replay()'s output
//
// The plot lists the devices named as chips (at first: your estimate's),
// each with a − to remove it, and a + to add one. Every change refits
// least squares on the devices listed, plus an always-on load, and redraws
// each hour: the meter (observed) as a dot, the fit (estimated) as a bar,
// the error between them as a line; MSE = mean squared error.
//
// Notation, the same in the table, the plot and their hover text: w_j is
// device j's true watts (0 off the circuit); TPR = found / 8, FPR = wrong
// / 142, F1 = 2 found / (named + 8).

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
  // {b, w: {j: [w_hat, se]}, fit, mse}, or {error}
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
    return { b: beta[p - 1], w, fit, mse: rss / n };
  }


  function bars(host, res, fitRes) {
    const T = res.y.length, plotW = W - L - R, bw = plotW / T;
    const H = TOP + PH + AXIS;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "pm-plot",
      role: "img", "aria-label": "The meter hour by hour, the estimate " +
        "from the devices named, and the error between them" });
    const fit = fitRes.fit;
    const vals = [...res.y, ...fit, 0];
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
    res.y.forEach((v, t) => {
      const x0 = L + t * bw, cx = x0 + bw / 2;
      el("rect", { x: x0 + gap / 2, y: sy(Math.max(0, fit[t])),
        width: bw - gap, height: Math.abs(sy(0) - sy(fit[t])),
        class: "gc-est" }, svg);
      el("line", { x1: cx, x2: cx, y1: sy(fit[t]), y2: sy(v),
                   class: "gc-err" }, svg);
      el("circle", { cx, cy: sy(v), r: 2.4, class: "gc-y" }, svg);
      // a full-height strip per hour carries the hover text
      const hit = el("rect", { x: x0, y: TOP, width: bw, height: PH,
                               class: "gc-hit" }, svg);
      el("title", {}, hit).textContent = `hour ${t}: observed ` +
        `${watts(v)} W, estimated ${watts(fit[t])} W, error ` +
        `${watts(v - fit[t])} W`;
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

  function stat(label, value, sub, cls = "") {
    const d = document.createElement("div");
    d.className = "gc-stat " + cls;
    d.innerHTML = `<span class="gc-stat-label">${label}</span>` +
      `<span class="gc-stat-value">${value}</span>` +
      `<span class="gc-stat-sub">${sub}</span>`;
    return d;
  }

  function plot(host, res, idx) {
    const x = res.x.map(col => [...col].map(Number));
    const yours = new Set(res.named);
    // chips in the order named; added devices go to the end
    let on = [...res.named], adding = false;

    function draw() {
      host.replaceChildren();
      const fitRes = ols(x, res.y, on);
      const right = on.filter(j => res.w[j] > 0).length;
      const wrong = on.length - right;
      const edited = on.length !== yours.size || on.some(j => !yours.has(j));

      const head = document.createElement("div");
      head.className = "gc-head";
      const h = document.createElement("p");
      h.className = "replay-head";
      h.textContent = `Circuit ${idx}: ` + (edited
        ? `your edit names ${on.length} device${on.length === 1 ? "" : "s"}. ` +
          `Your estimate named ${yours.size} (F1 ${f1(res.right, res.n_named).toFixed(2)}).`
        : `your estimate named ${on.length} device${on.length === 1 ? "" : "s"}. ` +
          "Add or remove devices to see how the fit and the scores change.");
      head.appendChild(h);
      if (edited) {
        const b = document.createElement("button");
        b.textContent = "Back to your estimate";
        b.onclick = () => { on = [...res.named]; adding = false; draw(); };
        head.appendChild(b);
      }
      host.appendChild(head);

      const mse = fitRes.error ? null : fitRes.mse;
      const stats = document.createElement("div");
      stats.className = "gc-stats";
      stats.append(
        stat("MSE", mse === null ? "—" : `${watts(mse)} W²`,
             `mean (observed − estimated)²; noise alone ≈ ` +
             `${watts(res.noise ** 2)} W²`, "gc-mse"),
        stat("F1", f1(right, on.length).toFixed(2),
             `2 × ${right} / (${on.length} named + ${N_ON})`),
        stat("TPR", pct(right / N_ON), `${right} of ${N_ON} found`),
        stat("FPR", pct(wrong / N_OFF, 1), `${wrong} of ${N_OFF} wrong`));
      host.appendChild(stats);

      host.appendChild(chips(fitRes));

      const key = document.createElement("div");
      key.className = "key gc-key";
      key.innerHTML = '<span><i class="dot gc-y"></i>observed</span>' +
        '<span><i class="sw gc-est"></i>estimated</span>' +
        '<span><i class="ln gc-err"></i>error</span>';
      host.appendChild(key);

      if (fitRes.error) {
        const msg = document.createElement("p");
        msg.className = "msg error";
        msg.textContent = fitRes.error + " Remove some.";
        host.appendChild(msg);
      } else {
        bars(host, res, fitRes);
      }

      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = "Estimated: least squares of the meter on the " +
        "devices listed, plus an always-on load. Each chip shows its " +
        "device's fitted watts ± 2 standard errors.";
      host.appendChild(note);
    }

    // a chip per device named, each with a − to remove it, and a + to add
    function chips(fitRes) {
      const box = document.createElement("div");
      box.className = "chips gc-chips";
      for (const j of on) {
        const c = document.createElement("span");
        const hit = res.w[j] > 0;
        c.className = "chip gc-chip " + (hit ? "gc-chip-found" : "gc-chip-wrong");
        c.title = hit ? `${dev(j)} is on the circuit: ${watts(res.w[j])} W true`
                      : `${dev(j)} is not on the circuit`;
        const f = !fitRes.error && fitRes.w[j];
        c.innerHTML = `<span>${dev(j)}</span>` +
          `<span class="gc-chip-w">${f ? `${watts(f[0])} ± ${watts(2 * f[1])} W` : ""}</span>` +
          `<span class="badge ${hit ? "ok" : "bad"}">${hit ? "found" : "wrong"}</span>`;
        const minus = document.createElement("button");
        minus.className = "gc-chip-x";
        minus.textContent = "−";
        minus.setAttribute("aria-label", "Remove " + dev(j));
        minus.onclick = () => { on = on.filter(k => k !== j); draw(); };
        c.appendChild(minus);
        box.appendChild(c);
      }

      if (!adding) {
        const plus = document.createElement("button");
        plus.className = "gc-plus";
        plus.textContent = "+";
        plus.title = "Add a device";
        plus.setAttribute("aria-label", "Add a device");
        plus.onclick = () => { adding = true; draw(); };
        box.appendChild(plus);
        return box;
      }
      // devices not listed: the circuit's missed ones (biggest first), then
      // the rest by number
      const sel = document.createElement("select");
      sel.className = "gc-pick";
      sel.setAttribute("aria-label", "Device to add");
      sel.add(new Option("Add a device…", ""));
      const rest = res.w.map((_, j) => j).filter(j => !on.includes(j));
      const missed = rest.filter(j => res.w[j] > 0)
        .sort((a, b) => res.w[b] - res.w[a]);
      const groups = [["Missed (on the circuit)", missed,
                       j => `${dev(j)} (${watts(res.w[j])} W true)`],
                      ["Not on the circuit", rest.filter(j => !(res.w[j] > 0)),
                       dev]];
      for (const [label, ids, text] of groups) {
        if (!ids.length) continue;
        const g = document.createElement("optgroup");
        g.label = label;
        for (const j of ids) g.appendChild(new Option(text(j), j));
        sel.appendChild(g);
      }
      sel.onchange = () => {
        if (sel.value === "") return;
        on.push(Number(sel.value));
        adding = false;
        draw();
      };
      const cancel = document.createElement("button");
      cancel.className = "quiet";
      cancel.textContent = "Cancel";
      cancel.onclick = () => { adding = false; draw(); };
      box.append(sel, cancel);
      setTimeout(() => sel.focus());
      return box;
    }

    draw();
  }

  return { table, mark, plot };
})();

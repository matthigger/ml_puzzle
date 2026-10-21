// Chart: one dot per run, fraction of crawls right (+/- 2 sd) against
// average slices per crawl (log scale), with the 95% bar.
//
//   Chart.draw(svg, runs, latestId, tip)   tip: the hover tooltip <div>

const Chart = (function () {
  const W = 560, H = 330;
  const M = { l: 54, r: 18, t: 14, b: 44 };
  const NS = "http://www.w3.org/2000/svg";

  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function text(str, attrs, parent) {
    const e = el("text", attrs, parent);
    e.textContent = str;
    return e;
  }

  // 1, 2, 5, 10, 20, 50, ... inside [lo, hi]
  function logTicks(lo, hi) {
    const out = [];
    for (let p = Math.floor(Math.log10(lo)); p <= Math.ceil(Math.log10(hi)); p++) {
      for (const m of [1, 2, 5]) {
        const v = m * 10 ** p;
        if (v >= lo && v <= hi) out.push(v);
      }
    }
    return out;
  }

  const pct = v => (100 * v).toFixed(1) + "%";

  function draw(svg, runs, latestId, tip) {
    svg.replaceChildren();
    const pw = W - M.l - M.r, ph = H - M.t - M.b;

    if (!runs.length) {
      text("No runs on this setup yet", { x: W / 2, y: H / 2,
        "text-anchor": "middle", class: "empty" }, svg);
      return;
    }

    // domains: x spans the runs (log), y from below the lowest error bar
    // up to 100%
    const xs = runs.map(r => Math.max(r.mean_slices, 1));
    let xlo = Math.min(...xs) / 1.5, xhi = Math.max(...xs) * 1.5;
    // at least a factor of 10 wide, so there are ticks to read
    const widen = Math.sqrt(Math.max(1, 10 / (xhi / xlo)));
    xlo /= widen;
    xhi *= widen;
    const ylo0 = Math.min(0.9, ...runs.map(r => r.accuracy - 2 * r.accuracy_se));
    const step = ylo0 > 0.7 ? 0.05 : 0.1;
    const ylo = Math.max(0, Math.floor((ylo0 - 0.01) / step) * step);
    const yhi = 1;
    const X = v => M.l + pw * Math.log(v / xlo) / Math.log(xhi / xlo);
    const Y = v => M.t + ph * (yhi - v) / (yhi - ylo);

    // grid + ticks
    const g = el("g", {}, svg);
    for (let v = ylo; v <= yhi + 1e-9; v += step) {
      el("line", { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: "grid" }, g);
      text(Math.round(100 * v) + "%", { x: M.l - 6, y: Y(v) + 4,
        "text-anchor": "end", class: "tick" }, g);
    }
    for (const v of logTicks(xlo, xhi)) {
      el("line", { x1: X(v), x2: X(v), y1: M.t, y2: H - M.b, class: "grid" }, g);
      text(String(v), { x: X(v), y: H - M.b + 16, "text-anchor": "middle",
        class: "tick" }, g);
    }
    el("rect", { x: M.l, y: M.t, width: pw, height: ph, class: "frame" }, g);
    text("average slices per crawl (log scale)", { x: M.l + pw / 2,
      y: H - 8, "text-anchor": "middle", class: "axis-label" }, g);
    text("crawls right", { x: 0, y: 0, class: "axis-label",
      transform: `translate(14 ${M.t + ph / 2}) rotate(-90)`,
      "text-anchor": "middle" }, g);

    // the 95% bar
    el("line", { x1: M.l, x2: W - M.r, y1: Y(0.95), y2: Y(0.95),
      class: "bar95" }, svg);
    text("95%", { x: W - M.r - 4, y: Y(0.95) - 5, "text-anchor": "end",
      class: "bar-label" }, svg);

    // direct labels: every baseline (short), and the user's runs when few
    const mine = runs.filter(r => !r.baseline);
    const labelAll = mine.length <= 5;

    // older runs first, so the latest draws on top
    const order = [...runs].sort((a, b) => a.when - b.when);
    for (const r of order) {
      const cx = X(Math.max(r.mean_slices, 1)), cy = Y(r.accuracy);
      const lo = Y(Math.max(ylo, r.accuracy - 2 * r.accuracy_se));
      const hi = Y(Math.min(1, r.accuracy + 2 * r.accuracy_se));
      const kind = r.baseline ? "base" : "you";
      const gr = el("g", { class: "pt " + kind +
        (r.id === latestId ? " latest" : "") }, svg);
      el("line", { x1: cx, x2: cx, y1: lo, y2: hi, class: "errbar" }, gr);
      el("circle", { cx, cy, r: r.id === latestId ? 6.5 : 5, class: "dot" }, gr);
      if (r.baseline || labelAll || r.id === latestId) {
        const label = r.baseline ? r.name.replace("taste each ", "n = ")
                                 : r.name;
        text(label, { x: cx + 9, y: cy - 7, class: "clabel" }, gr);
      }
      // hit target larger than the dot
      const hit = el("circle", { cx, cy, r: 13, class: "hit" }, gr);
      hit.addEventListener("pointerenter", () => {
        tip.innerHTML = `<b>${escapeHtml(r.name)}</b><br>` +
          `${pct(r.accuracy)} right (&plusmn; ${pct(2 * r.accuracy_se)})<br>` +
          `${r.mean_slices.toFixed(1)} slices on average<br>` +
          `<span class="muted">${r.n_crawl} crawls, seed ${r.seed}</span>`;
        tip.hidden = false;
        const box = svg.getBoundingClientRect();
        const host = tip.parentElement.getBoundingClientRect();
        const sx = box.width / W, sy = box.height / H;
        const left = box.left - host.left + cx * sx + 14;
        tip.style.left = Math.min(left, host.width - 210) + "px";
        tip.style.top = (box.top - host.top + cy * sy - 10) + "px";
      });
      hit.addEventListener("pointerleave", () => { tip.hidden = true; });
    }
  }

  return { draw };
})();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;",
    ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Replay: one crawl with the hidden truth revealed. A row per shop, best
// typical rating first: the truth, what the estimator tasted there, and a
// timeline of when (which slices of the crawl) it tasted that shop.
//
//   Replay.render(host, result, idx)   result: runner.replay()'s output

const Replay = (function () {
  const NS = "http://www.w3.org/2000/svg";

  function cell(tr, content, cls) {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    if (content instanceof Node) td.appendChild(content);
    else td.textContent = content;
    tr.appendChild(td);
    return td;
  }

  function badge(label, cls) {
    const b = document.createElement("span");
    b.className = "badge " + cls;
    b.textContent = label;
    return b;
  }

  // ticks at the slices (1..n) where this shop was tasted
  function timeline(at, n) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${n} 10`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "lane");
    const bg = document.createElementNS(NS, "rect");
    Object.entries({ x: 0, y: 0, width: n, height: 10, class: "lane-bg" })
      .forEach(([k, v]) => bg.setAttribute(k, v));
    svg.appendChild(bg);
    for (const t of at) {
      const r = document.createElementNS(NS, "rect");
      Object.entries({ x: t + 0.1, y: 0, width: 0.8, height: 10,
                       class: "lane-tick" })
        .forEach(([k, v]) => r.setAttribute(k, v));
      svg.appendChild(r);
    }
    return svg;
  }

  function render(host, res, idx) {
    host.replaceChildren();
    const n = res.history.length;
    const right = res.guess === res.best;

    const head = document.createElement("p");
    head.className = "replay-head";
    head.appendChild(badge(right ? "right" : "wrong", right ? "ok" : "bad"));
    head.append(` Crawl ${idx}: named shop ${res.guess} after ${n} slices.` +
      (right ? " That is the best shop." : ` The best shop was ${res.best}.`));
    host.appendChild(head);

    const per = res.mean.map(() => ({ at: [], sum: 0 }));
    res.history.forEach(([shop, rating], t) => {
      per[shop].at.push(t);
      per[shop].sum += rating;
    });

    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "runs replay-table";
    table.innerHTML = `<thead><tr><th>Shop</th>
      <th class="num">Typical rating</th><th class="num">Spread (sd)</th>
      <th class="num">Slices</th><th class="num">Your average</th>
      <th class="lane-head"><span>slice 1</span><span>slice ${n}</span></th>
      </tr></thead>`;
    const body = document.createElement("tbody");
    const order = res.mean.map((m, i) => i).sort((a, b) => res.mean[b] - res.mean[a]);
    for (const i of order) {
      const tr = document.createElement("tr");
      if (i === res.guess) tr.className = "named";
      const name = cell(tr, `shop ${i} `);
      if (i === res.best) name.appendChild(badge("best", "ok"));
      if (i === res.guess) name.appendChild(badge("named", right ? "ok" : "bad"));
      cell(tr, res.mean[i].toFixed(2), "num");
      cell(tr, res.sd[i].toFixed(2), "num");
      cell(tr, per[i].at.length, "num");
      cell(tr, per[i].at.length ? (per[i].sum / per[i].at.length).toFixed(2)
                                : "none", "num");
      cell(tr, timeline(per[i].at, Math.max(n, 1)), "lane-cell");
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    host.appendChild(wrap);

    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Typical rating and spread are the hidden truth, " +
      "shown only here. Shops are sorted best first; each tick in a row " +
      "is a slice tasted at that shop.";
    host.appendChild(note);
  }

  return { render };
})();

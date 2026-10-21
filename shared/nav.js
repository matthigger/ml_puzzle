// The site bar: a tab per puzzle (CONFIG.puzzles), the page's own marked.
// Runs from the top of <body data-puzzle="..."> so the bar is there before
// the page paints.

(function () {
  const here = document.body.dataset.puzzle;
  const bar = document.createElement("nav");
  bar.className = "site-bar";
  bar.setAttribute("aria-label", "Puzzles");
  const inner = document.createElement("div");
  inner.className = "site-inner";
  const brand = document.createElement("a");
  brand.className = "brand";
  brand.href = "../";
  brand.textContent = "ML Puzzles";
  inner.appendChild(brand);
  for (const p of CONFIG.puzzles) {
    const a = document.createElement("a");
    a.href = `../${p.id}/`;
    a.textContent = p.title;
    if (p.id === here) a.setAttribute("aria-current", "page");
    inner.appendChild(a);
  }
  bar.appendChild(inner);
  document.body.prepend(bar);
  // on a narrow screen the bar scrolls: start with this page's tab in view
  const cur = inner.querySelector("[aria-current]");
  if (cur && inner.scrollWidth > inner.clientWidth) {
    inner.scrollLeft = cur.offsetLeft - (inner.clientWidth - cur.offsetWidth) / 2;
  }
})();

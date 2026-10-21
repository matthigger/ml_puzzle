// The page: editor and files, crawl setup, runs (table + chart), replay,
// leaderboard posting, tabs. Python work goes through Py (js/py.js).

(function () {
  const $ = id => document.getElementById(id);
  const pct = v => (100 * v).toFixed(1) + "%";
  const BASELINES = ["taste each 5", "taste each 20", "taste each 40"];
  const OFFICIAL = { n_shop: 8, family: "bell", race: "official" };
  const EXAMPLE = `from slice_crawl import SliceCrawl, evaluate


def estimate(crawl):
    """ 5 slices from every shop, best average wins """
    avg = []
    for i in range(crawl.n_shop):
        total = 0
        for _ in range(5):
            total += crawl.taste(i)
        avg.append(total / 5)
    return avg.index(max(avg))
`;

  // ------------------------------------------------- browser storage
  // per-browser conveniences only: everything works without it
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem("slice_crawl." + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("slice_crawl." + key, JSON.stringify(value)); }
      catch (e) { /* full or blocked: fine */ }
    },
  };

  // ------------------------------------------------------------ state
  const editor = $("code");
  editor.value = store.get("code", EXAMPLE);
  let helpers = store.get("helpers", {});   // {filename: source}
  let runs = store.get("runs", []);         // newest first
  let loaded = null;    // {source, helpers, names} the worker has run
  let busy = false;     // a load or run is in progress
  let latest = null;    // last run, with per-crawl correct / slices
  let mode = "practice";

  const helperKey = () => JSON.stringify(helpers);
  const dirty = () => !loaded || loaded.source !== editor.value ||
    loaded.helpers !== helperKey();

  // ------------------------------------------------------- messages
  function loadMsg(text, kind) {
    const el = $("load-msg");
    el.hidden = !text;
    el.className = "msg " + (kind || "");
    el.textContent = text || "";
  }
  const runMsg = (text, kind) => {
    $("run-msg").textContent = text || " ";
    $("run-msg").className = "msg-line " + (kind || "");
  };
  const postMsg = (text, kind) => {
    $("post-msg").textContent = text || " ";
    $("post-msg").className = "msg-line " + (kind || "");
  };

  function setBusy(b) {
    busy = b;
    const ready = Py.ready && !busy;
    $("run-btn").disabled = !ready;
    $("base-btn").disabled = !ready;
    $("post-btn").disabled = !ready || !Board.enabled;
    $("stop-btn").disabled = !busy;
    $("post-stop").disabled = !busy;
    updateReplayNav();
  }

  // ------------------------------------------------------- loading code
  // loads run one after another (adding a helper, then opening a notebook,
  // starts two); each loads whatever the editor holds when its turn comes
  let loading = Promise.resolve(true);
  function loadCode() {
    loading = loading.then(doLoad, doLoad);
    return loading;
  }

  async function doLoad() {
    if (!Py.ready) return false;
    const source = editor.value, hk = helperKey();
    setBusy(true);
    loadMsg("Running your code...");
    let res;
    try {
      res = await Py.call("load", { source, helpers });
    } catch (e) {
      setBusy(false);
      loadMsg(e.message === "stopped" ? "Stopped while loading." : e.message,
              "error");
      return false;
    }
    setBusy(false);
    loaded = { source, helpers: hk, names: res.names };

    const sel = $("estimator"), keep = sel.value;
    sel.replaceChildren();
    for (const n of res.names) sel.add(new Option(n, n));
    if (res.names.includes(keep)) sel.value = keep;
    sel.disabled = !res.names.length;
    if (!res.names.length) sel.add(new Option("no estimator found"));

    $("output").textContent = res.output;
    $("output-box").hidden = !res.output;

    if (!res.ok) loadMsg(res.error, "error");
    else if (!res.names.length) {
      loadMsg("No function that takes a crawl was found: define " +
              "estimate(crawl).", "error");
    } else if (!res.names.includes("estimate")) {
      loadMsg("Loaded. No estimate() yet: the leaderboard needs one.", "note");
    } else loadMsg("");
    return res.ok && res.names.length > 0;
  }

  async function ensureLoaded() {
    if (!dirty()) return loaded.names.length > 0;
    return loadCode();
  }

  // --------------------------------------------------------------- setup
  function preset() { return store.get("preset", "official"); }

  function formSetup() {
    let s = { ...OFFICIAL };
    if (preset() === "custom") {
      let lo = Math.max(2, parseInt($("shop-lo").value) || 2);
      let hi = Math.max(2, parseInt($("shop-hi").value) || lo);
      if (hi < lo) [lo, hi] = [hi, lo];
      s = { n_shop: lo === hi ? lo : [lo, hi], family: $("family").value,
            race: $("race").value };
    }
    s.n_crawl = Math.min(100000, Math.max(1, parseInt($("n-crawl").value) || 1));
    s.seed = Math.max(0, parseInt($("seed").value) || 0);
    return s;
  }

  function setupKey(s) {
    if (s.n_shop === 8 && s.family === "bell" && s.race === "official") {
      return "official";
    }
    const shops = Array.isArray(s.n_shop) ? s.n_shop.join(" to ") : s.n_shop;
    const fam = { bell: "bell", heavy: "heavy tails", disaster: "disasters" };
    return `${shops} shops, ${fam[s.family]}, ${s.race} race`;
  }

  function saveForm() {
    store.set("form", { lo: $("shop-lo").value, hi: $("shop-hi").value,
      family: $("family").value, race: $("race").value,
      n_crawl: $("n-crawl").value, seed: $("seed").value });
  }

  function restoreForm() {
    const f = store.get("form", null);
    if (f) {
      $("shop-lo").value = f.lo; $("shop-hi").value = f.hi;
      $("family").value = f.family; $("race").value = f.race;
      $("n-crawl").value = f.n_crawl; $("seed").value = f.seed;
    }
    showPreset();
  }

  function showPreset() {
    for (const b of $("preset").querySelectorAll("button")) {
      b.setAttribute("aria-checked", b.dataset.v === preset());
    }
    $("custom").hidden = preset() !== "custom";
  }

  // ---------------------------------------------------------------- runs
  // runs name on setup; returns the run's record (also kept in runs), or
  // null after an error or stop
  async function runOne(name, setup,
                        { baseline = false, label = name, onProgress } = {}) {
    const t0 = performance.now();
    const every = Math.max(10, Math.round(setup.n_crawl / 100));
    let res;
    try {
      res = await Py.call("run", { name, setup, every }, onProgress);
    } catch (e) {
      if (e.message !== "stopped") loadMsg(e.message, "error");
      return null;
    }
    if (!res.ok) {
      loadMsg(`${name} failed on ${res.error}`, "error");
      return null;
    }
    const rec = {
      id: Date.now() + Math.random(), name: label, estimator: name, baseline,
      key: setupKey(setup), n_shop: setup.n_shop, family: setup.family,
      race: setup.race, n_crawl: setup.n_crawl, seed: setup.seed,
      accuracy: res.accuracy, accuracy_se: res.accuracy_se,
      mean_slices: res.mean_slices, median_slices: res.median_slices,
      p90_slices: res.p90_slices,
      seconds: (performance.now() - t0) / 1000, when: Date.now(),
    };
    // a baseline replaces its older copy on the same crawls
    runs = runs.filter(r => !(baseline && r.baseline && r.name === name &&
      r.key === rec.key && r.n_crawl === rec.n_crawl && r.seed === rec.seed));
    runs.unshift(rec);
    store.set("runs", runs);
    latest = { ...rec, correct: res.correct, slices: res.slices };
    return rec;
  }

  function progressBar(done, n, right, slices) {
    $("bar").style.width = (100 * done / n) + "%";
    runMsg(`${done} of ${n} crawls: ${pct(right / done)} right, ` +
           `${(slices / done).toFixed(1)} slices on average`);
  }

  async function runClicked() {
    if (busy) return;
    const setup = formSetup();
    $("bar").style.width = "0";
    runMsg("Loading your code...");
    if (!(await ensureLoaded())) { runMsg("Fix your code first.", "error"); return; }
    const name = $("estimator").value;
    setBusy(true);
    runMsg("Running...");
    const rec = await runOne(name, setup, { onProgress: progressBar });
    setBusy(false);
    if (!rec) {
      $("bar").style.width = "0";
      runMsg(Py.ready ? "Stopped by an error (above)." : "Stopped.", "error");
      return;
    }
    $("bar").style.width = "100%";
    runMsg(`Done in ${rec.seconds.toFixed(1)} s.`);
    renderAll();
    const firstWrong = latest.correct.indexOf(false);
    replay(firstWrong >= 0 ? firstWrong : 0);
  }

  async function baselinesClicked() {
    if (busy) return;
    const setup = formSetup();
    setBusy(true);
    for (const [k, name] of BASELINES.entries()) {
      runMsg(`Baseline ${k + 1} of ${BASELINES.length}: ${name}...`);
      const rec = await runOne(name, setup, { baseline: true,
        onProgress: (d, n) => { $("bar").style.width = (100 * d / n) + "%"; } });
      if (!rec) break;
    }
    setBusy(false);
    $("bar").style.width = "0";
    runMsg(Py.ready ? "Baselines added." : "Stopped.");
    latest = null;    // replay stays on the student's last run
    renderAll();
  }

  function verdict(r) {
    const lo = r.accuracy - 2 * r.accuracy_se, hi = r.accuracy + 2 * r.accuracy_se;
    if (lo >= 0.95) return ["yes", "ok"];
    if (hi < 0.95) return ["no", "bad"];
    return ["maybe", "warn"];
  }

  function renderRuns() {
    const tbody = $("runs").tBodies[0];
    tbody.replaceChildren();
    if (!runs.length) {
      const td = tbody.insertRow().insertCell();
      td.colSpan = 10;
      td.className = "muted";
      td.textContent = "No runs yet.";
    }
    for (const r of runs) {
      const tr = tbody.insertRow();
      if (r.baseline) tr.className = "baseline";
      const add = (v, cls) => {
        const td = tr.insertCell();
        td.textContent = v;
        if (cls) td.className = cls;
        return td;
      };
      add(r.name);
      add(r.key + (r.seed ? `, seed ${r.seed}` : ""), "muted");
      add(r.n_crawl, "num");
      add(`${pct(r.accuracy)} ± ${(200 * r.accuracy_se).toFixed(1)}`, "num");
      add(r.mean_slices.toFixed(1), "num");
      add(r.median_slices, "num");
      add(r.p90_slices, "num");
      const [v, cls] = verdict(r);
      add(v).appendChild(Object.assign(document.createElement("i"),
        { className: "status-dot " + cls }));
      add(r.seconds.toFixed(1) + " s", "num");
      const del = document.createElement("button");
      del.className = "x";
      del.title = "Remove this run";
      del.textContent = "×";
      del.onclick = () => {
        runs = runs.filter(x => x.id !== r.id);
        store.set("runs", runs);
        renderAll();
      };
      tr.insertCell().appendChild(del);
    }
  }

  function renderLatest() {
    const host = $("latest");
    const r = runs.find(x => !x.baseline);
    host.replaceChildren();
    if (!r) {
      host.innerHTML = '<p class="muted">Run an estimator to see how it did.</p>';
      return;
    }
    const [v, cls] = verdict(r);
    const rows = [
      ["Estimator", r.name],
      ["Crawls", `${r.n_crawl} (${r.key}, seed ${r.seed})`],
      ["Right", `${pct(r.accuracy)} ± ${pct(2 * r.accuracy_se)}`],
      ["Average slices", r.mean_slices.toFixed(1)],
      ["Median / 90th pct", `${r.median_slices} / ${r.p90_slices}`],
    ];
    for (const [k, val] of rows) {
      const row = document.createElement("div");
      row.className = "row";
      const a = document.createElement("span"), b = document.createElement("span");
      a.textContent = k; b.textContent = val; b.className = "val";
      row.append(a, b);
      host.appendChild(row);
    }
    const p = document.createElement("p");
    p.className = "verdict " + cls;
    p.textContent = {
      yes: "Clears the 95% bar.",
      no: "Below the 95% bar.",
      maybe: "Too close to 95% to call: try more crawls.",
    }[v];
    host.appendChild(p);
  }

  function renderChart() {
    const key = setupKey(formSetup());
    const shown = runs.filter(r => r.key === key);
    $("chart-setup").textContent = `Runs on this setup: ${key}` +
      (shown.length < runs.length ? ` (${runs.length - shown.length} ` +
       "other runs are in the table)" : "");
    Chart.draw($("chart"), shown, latest && latest.id, $("chart-tip"));
  }

  function renderAll() {
    renderRuns();
    renderLatest();
    renderChart();
    updateReplayNav();
  }

  // ------------------------------------------------------------- replay
  function updateReplayNav() {
    const ok = !!latest && !busy && Py.ready;
    $("prev-wrong").disabled = !ok || !latest.correct.includes(false);
    $("next-wrong").disabled = !ok || !latest.correct.includes(false);
    $("crawl-idx").disabled = !ok;
    if (latest) $("crawl-idx").max = latest.n_crawl - 1;
  }

  async function replay(idx) {
    if (!latest || busy) return;
    idx = Math.min(Math.max(0, idx), latest.n_crawl - 1);
    $("crawl-idx").value = idx;
    if (!(await ensureLoaded())) return;
    const setup = { n_shop: latest.n_shop, family: latest.family,
                    race: latest.race, n_crawl: latest.n_crawl, seed: latest.seed };
    setBusy(true);
    let res;
    try {
      res = await Py.call("replay", { name: latest.estimator, setup, idx });
    } catch (e) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (!res.ok) {
      $("replay").textContent = res.error;
      return;
    }
    Replay.render($("replay"), res, idx);
  }

  function stepWrong(dir) {
    if (!latest) return;
    const n = latest.n_crawl;
    let i = parseInt($("crawl-idx").value) || 0;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (!latest.correct[i]) { replay(i); return; }
    }
  }

  // -------------------------------------------------------- leaderboard
  async function refreshBoard() {
    if (!Board.enabled) {
      $("board-msg").textContent = "The leaderboard isn't connected yet.";
      return;
    }
    $("board-msg").textContent = "Loading...";
    try {
      const entries = await Board.list();
      Board.render($("board").tBodies[0], entries);
      $("board-msg").textContent = entries.length ? "" : "No entries yet: be the first.";
    } catch (e) {
      $("board-msg").textContent = "Couldn't load the leaderboard: " + e.message;
    }
  }

  async function postClicked() {
    if (busy) return;
    const name = $("post-name").value.trim(), code = $("post-code").value.trim();
    store.set("post", { name, code });
    if (!name) { postMsg("Pick a name first.", "error"); return; }
    if (!code) { postMsg("Enter the class code from the assignment.", "error"); return; }
    postMsg("Loading your code...");
    if (!(await ensureLoaded()) || !loaded.names.includes("estimate")) {
      postMsg("Your code needs an estimate(crawl) that loads without " +
              "errors (see the Practice tab).", "error");
      return;
    }
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
    const setup = { ...OFFICIAL, n_crawl: 5000, seed };
    setBusy(true);
    const rec = await runOne("estimate", setup, { label: "estimate (posted)",
      onProgress: (d, n, right) =>
        postMsg(`Running: ${d} of ${n} crawls, ${pct(right / d)} right`) });
    setBusy(false);
    if (!rec) {
      postMsg(Py.ready ? "Your estimate failed: see the Practice tab." : "Stopped.",
              "error");
      return;
    }
    renderAll();
    postMsg(`${pct(rec.accuracy)} right, ${rec.mean_slices.toFixed(1)} ` +
            "slices on average. Posting...");
    try {
      await Board.post({
        code, name, accuracy: rec.accuracy, mean_slices: rec.mean_slices,
        median_slices: rec.median_slices, p90_slices: rec.p90_slices,
        n_crawl: rec.n_crawl, seed: rec.seed,
        source: { main: loaded.source, helpers,
                  build: (typeof BUILD !== "undefined" && BUILD) ? BUILD.sha : null },
      });
      postMsg(`Posted: ${pct(rec.accuracy)} right, ` +
              `${rec.mean_slices.toFixed(1)} slices on average.`, "ok");
    } catch (e) {
      postMsg("Not posted: " + e.message, "error");
    }
    refreshBoard();
  }

  async function removeClicked() {
    if (!Board.enabled) return;
    if (!confirm("Remove your leaderboard entry (the one posted from this browser)?")) return;
    try {
      await Board.remove();
      postMsg("Removed.");
    } catch (e) {
      postMsg("Couldn't remove it: " + e.message, "error");
    }
    refreshBoard();
  }

  // --------------------------------------------------------------- files
  function readText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsText(file);
    });
  }

  async function openFile(file) {
    let text = await readText(file);
    if (file.name.endsWith(".ipynb")) {
      try {
        text = await Py.call("notebook", { text }, null, true);
      } catch (e) {
        loadMsg(`Couldn't read ${file.name} as a notebook: ${e.message}`, "error");
        return;
      }
    }
    editor.value = text;
    store.set("code", text);
    await loadCode();
    if ($("load-msg").hidden) {
      loadMsg(file.name.endsWith(".ipynb")
        ? `Opened ${file.name}: its code cells are in the editor.`
        : `Opened ${file.name}.`, "note");
    }
  }

  function renderHelpers() {
    const host = $("helpers");
    host.replaceChildren();
    for (const name of Object.keys(helpers)) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = name + " ";
      const x = document.createElement("button");
      x.className = "x";
      x.title = "Remove " + name;
      x.textContent = "×";
      x.onclick = () => {
        delete helpers[name];
        store.set("helpers", helpers);
        renderHelpers();
        loadCode();
      };
      chip.appendChild(x);
      host.appendChild(chip);
    }
  }

  // --------------------------------------------------------------- wiring
  Py.onStatus = (state, text) => {
    $("py-status").textContent = text;
    $("py-status").className = "pill " + state;
    setBusy(false);
    if (state === "ready") loadCode();
    if (state === "failed") {
      loadMsg("Python couldn't start in this browser. Try reloading the " +
              "page, or a recent Chrome, Firefox, Edge or Safari.", "error");
    }
  };

  function stop() {
    Py.stop();     // restarts the worker; its ready status reloads the code
    loaded = null;
    setBusy(false);
    runMsg("Stopped.");
  }

  editor.addEventListener("input", () => store.set("code", editor.value));
  editor.addEventListener("change", () => { if (!busy) loadCode(); });
  editor.addEventListener("keydown", e => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      editor.setRangeText("    ", editor.selectionStart, editor.selectionEnd, "end");
      store.set("code", editor.value);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runClicked();
    }
  });

  $("open-btn").onclick = () => $("open-file").click();
  $("helper-btn").onclick = () => $("helper-file").click();
  $("open-file").onchange = e => {
    if (e.target.files[0]) openFile(e.target.files[0]);
    e.target.value = "";
  };
  $("helper-file").onchange = async e => {
    for (const f of e.target.files) helpers[f.name] = await readText(f);
    e.target.value = "";
    store.set("helpers", helpers);
    renderHelpers();
    loadCode();
  };
  $("reset-btn").onclick = () => {
    if (editor.value !== EXAMPLE &&
        !confirm("Replace the editor's code with the example?")) return;
    editor.value = EXAMPLE;
    store.set("code", EXAMPLE);
    loadCode();
  };

  for (const b of $("preset").querySelectorAll("button")) {
    b.onclick = () => { store.set("preset", b.dataset.v); showPreset(); renderChart(); };
  }
  for (const id of ["shop-lo", "shop-hi", "family", "race", "n-crawl", "seed"]) {
    $(id).addEventListener("change", () => { saveForm(); renderChart(); });
  }
  $("run-btn").onclick = runClicked;
  $("stop-btn").onclick = stop;
  $("post-stop").onclick = stop;
  $("base-btn").onclick = baselinesClicked;
  $("clear-btn").onclick = () => {
    if (!runs.length || !confirm("Clear every run in the table?")) return;
    runs = [];
    latest = null;
    store.set("runs", runs);
    renderAll();
  };
  $("crawl-idx").addEventListener("change", () =>
    replay(parseInt($("crawl-idx").value) || 0));
  $("prev-wrong").onclick = () => stepWrong(-1);
  $("next-wrong").onclick = () => stepWrong(1);

  const saved = store.get("post", {});
  $("post-name").value = saved.name || "";
  $("post-code").value = saved.code || "";
  $("post-btn").onclick = postClicked;
  $("remove-btn").onclick = removeClicked;
  $("refresh-btn").onclick = refreshBoard;
  if (!Board.enabled) {
    $("remove-btn").disabled = true;
    $("refresh-btn").disabled = true;
  }

  // ----------------------------------------------------------------- tabs
  const HASH = { practice: "#practice", board: "#leaderboard" };
  function setMode(m) {
    mode = m;
    history.replaceState(null, "", HASH[m]);
    for (const t of document.querySelectorAll(".tab")) {
      t.setAttribute("aria-selected", t.dataset.mode === m);
    }
    for (const el of document.querySelectorAll("[data-show]")) {
      el.hidden = el.dataset.show !== m;
    }
    if (m === "board") refreshBoard();
  }
  for (const t of document.querySelectorAll(".tab")) {
    t.onclick = () => { if (t.dataset.mode !== mode) setMode(t.dataset.mode); };
  }

  // footer build stamp: the deployed commit (linked) and build time
  const build = $("build");
  const repo = "https://github.com/matthigger/slice_crawl";
  if (typeof BUILD === "undefined" || !BUILD) {
    build.textContent = "local copy";
  } else {
    const when = new Date(BUILD.time).toLocaleString("en-US", {
      dateStyle: "medium", timeStyle: "short" });
    build.innerHTML = `build <a href="${repo}/commit/${BUILD.sha}">${
      BUILD.sha.slice(0, 7)}</a>, ${when}`;
  }

  restoreForm();
  renderHelpers();
  renderAll();
  setMode(Object.keys(HASH).find(m => HASH[m] === location.hash) || "practice");
  Py.start();
})();

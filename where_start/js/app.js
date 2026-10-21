// The page: your code (typed, or dropped files), runs (each keeps its code;
// click one for its post-mortem, code and results CSV), leaderboard
// posting, tabs. Python work goes through Py (shared/py.js).

(function () {
  const $ = id => document.getElementById(id);
  const pct = v => (100 * v).toFixed(1) + "%";
  const BASELINES = ["first to hear it", "first three"];
  const OFFICIAL = { n_station: 12, max_bad: 3 };
  // a hit: within HIT_KM of the epicenter; the bar: hits in HIT_BAR of
  // quakes (py/where_start.py)
  const HIT_KM = 5, HIT_BAR = 0.9;
  const EXAMPLE = `import numpy as np
from where_start import evaluate


def estimate(stations, arrivals):
    """ the station that heard it first, at the moment it heard it """
    i = np.argmin(arrivals)
    return stations[i, 0], stations[i, 1], arrivals[i]
`;

  // the baselines' code (py/runner.py), shown like a run's own
  const BASELINE_CODE = {
    "first to hear it": `import numpy as np


def estimate(stations, arrivals):
    """ the station that heard it first, at the moment it heard it """
    i = np.argmin(arrivals)
    return stations[i, 0], stations[i, 1], arrivals[i]
`,
    "first three": `import numpy as np


def estimate(stations, arrivals):
    """ the middle of the three stations that heard it first """
    idx = np.argsort(arrivals)[:3]
    x, y = stations[idx].mean(axis=0)
    return x, y, arrivals[idx[0]]
`,
  };
  const baselineCode = name => ({ main: BASELINE_CODE[name], helpers: {} });

  // ------------------------------------------------- browser storage
  // per-browser conveniences only: everything works without it
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem("where_start." + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("where_start." + key, JSON.stringify(value)); }
      catch (e) { /* full or blocked: fine */ }
    },
  };

  // ------------------------------------------------------------ state
  const editor = $("code");
  editor.value = store.get("code", EXAMPLE);
  // where the program comes from: "type" (the editor) or "files" (dropped
  // .py / .ipynb files, notebooks kept as their code cells)
  let srcMode = store.get("srcMode", "type");
  let files = store.get("files", {});       // {path: source}
  let mainFile = store.get("mainFile", null);
  let shownUpload = null;                   // the file shown in files mode
  // run records: {id, name, estimator, baseline, code: {main, helpers,
  // mainName?} | null, n_station, max_bad, n_quake, seed, hit_rate, hit_se,
  // mean_km, median_km, p90_km, seconds, when}
  let runs = store.get("runs", []);
  let selectedId = store.get("selected", null);
  let sort = store.get("sort", { col: "When", dir: -1 });
  let pmSort = store.get("pmSort", { col: "Quake", dir: 1 });
  let loaded = null;    // {source, helpers, names} the worker has run
  let busy = false;     // a load or run is in progress
  let mode = "practice";

  // the file that defines estimate: the one picked, the only notebook, or
  // the first file that defines estimate
  function pickMain() {
    const names = Object.keys(files).sort();
    if (mainFile && files[mainFile] !== undefined) return mainFile;
    const nbs = names.filter(f => f.endsWith(".ipynb"));
    if (nbs.length === 1) return nbs[0];
    return names.find(f => /^(def estimate\b|estimate\s*=)/m.test(files[f])) ||
      nbs[0] || names[0] || null;
  }

  // the program to load and run: {main, helpers, mainName?}; helpers are
  // the other .py files, paths relative to the main file's folder
  function program() {
    if (srcMode === "type") return { main: editor.value, helpers: {} };
    const main = pickMain();
    if (!main) return { main: "", helpers: {} };
    const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
    const helpers = {};
    for (const [f, text] of Object.entries(files)) {
      if (f === main || !f.endsWith(".py")) continue;
      helpers[dir && f.startsWith(dir) ? f.slice(dir.length) : f] = text;
    }
    return { main: files[main], helpers, mainName: main };
  }

  const dirty = () => {
    const p = program();
    return !loaded || loaded.source !== p.main ||
      loaded.helpers !== JSON.stringify(p.helpers);
  };
  const selected = () => runs.find(r => r.id === selectedId) || null;
  const codeOf = r => r.baseline ? baselineCode(r.name) : r.code;

  // ------------------------------------------------------- messages
  // the code's status, not Python's: green only when the program loaded
  // as it stands now
  function codeStatus(kind, text) {
    $("py-status").textContent = text;
    $("py-status").className = "pill " + kind;
  }

  function loadMsg(text, kind) {
    const el = $("load-msg");
    el.hidden = !text;
    el.className = "msg " + (kind || "");
    el.textContent = text || "";
  }
  const runMsg = (text, kind) => {
    $("run-msg").textContent = text || " ";
    $("run-msg").className = "msg-line " + (kind || "");
  };
  const postMsg = (text, kind) => {
    $("post-msg").textContent = text || " ";
    $("post-msg").className = "msg-line " + (kind || "");
  };

  function setBusy(b) {
    busy = b;
    const ready = Py.ready && !busy;
    $("run-btn").disabled = !ready;
    $("base-btn").disabled = !ready;
    $("stop-btn").disabled = !busy;
    if (!busy) queueMicrotask(pumpPostMortem);
  }

  // ------------------------------------------------------- loading code
  // the worker holds one program at a time: the editor's, or that of a run
  // being replayed. Loads run one after another.
  let queue = Promise.resolve();
  function serial(fn) {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  }

  async function loadInWorker(source, helperFiles) {
    setBusy(true);
    try {
      const res = await Py.call("load", { source, helpers: helperFiles });
      loaded = { source, helpers: JSON.stringify(helperFiles), names: res.names };
      return res;
    } finally {
      setBusy(false);
    }
  }

  // loads the editor's code (whatever it holds when its turn comes) and
  // refreshes the Estimator menu
  const loadCode = () => serial(loadEditor);

  async function loadEditor() {
    if (!Py.ready) return false;
    const p = program();
    if (!p.main.trim()) {
      codeStatus("", "No code yet");
      loadMsg(srcMode === "files" ? "Drop your files first." : "", "note");
      return false;
    }
    loadMsg("");
    codeStatus("", "Checking your code...");
    let res;
    try {
      res = await loadInWorker(p.main, p.helpers);
    } catch (e) {
      codeStatus("failed", "Not loaded");
      loadMsg(e.message === "stopped" ? "Stopped while loading." : e.message,
              "error");
      return false;
    }
    const sel = $("estimator"), keep = sel.value;
    sel.replaceChildren();
    for (const n of res.names) sel.add(new Option(n, n));
    if (res.names.includes(keep)) sel.value = keep;
    sel.disabled = !res.names.length;
    if (!res.names.length) sel.add(new Option("no estimator found"));

    $("output").textContent = res.output;
    $("output-box").hidden = !res.output;

    if (!res.ok) {
      codeStatus("failed", "Error");
      loadMsg(res.error, "error");
    } else if (!res.names.length) {
      codeStatus("failed", "No estimator");
      loadMsg("No function that takes (stations, arrivals) was found: " +
              "define estimate(stations, arrivals).", "error");
    } else {
      const k = res.names.length;
      codeStatus("ready", `Loaded: ${k} estimator${k > 1 ? "s" : ""}`);
      loadMsg("");
    }
    if (dirty()) codeStatus("", "Edited");
    return res.ok && res.names.length > 0;
  }

  async function ensureLoaded() {
    if (!dirty()) return loaded.names.length > 0;
    return loadCode();
  }

  // puts run r's program in the worker, leaving the editor alone; false if
  // it no longer loads
  async function ensureRunLoaded(r) {
    if (r.baseline) return true;
    const key = JSON.stringify(r.code.helpers);
    if (loaded && loaded.source === r.code.main && loaded.helpers === key) {
      return loaded.names.includes(r.estimator);
    }
    try {
      const res = await serial(() => loadInWorker(r.code.main, r.code.helpers));
      return res.ok && res.names.includes(r.estimator);
    } catch (e) {
      return false;
    }
  }

  // --------------------------------------------------------------- setup
  function formSetup() {
    return { ...OFFICIAL,
      n_quake: Math.min(20000, Math.max(1, parseInt($("n-quake").value) || 1)),
      seed: Math.max(0, parseInt($("seed").value) || 0) };
  }

  function saveForm() {
    store.set("form", { n_quake: $("n-quake").value, seed: $("seed").value });
  }

  function restoreForm() {
    const f = store.get("form", null);
    if (f) { $("n-quake").value = f.n_quake; $("seed").value = f.seed; }
  }

  // ---------------------------------------------------------------- runs
  // runs name on setup; returns the run's record (also kept in runs), or
  // null after an error or stop
  async function runOne(name, setup, { baseline = false, label = name,
                                       code = null, onProgress } = {}) {
    const t0 = performance.now();
    const every = Math.max(1, Math.round(setup.n_quake / 100));
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
      code, n_station: setup.n_station, max_bad: setup.max_bad,
      n_quake: setup.n_quake, seed: setup.seed,
      hit_rate: res.hit_rate, hit_se: res.hit_se, mean_km: res.mean_km,
      median_km: res.median_km, p90_km: res.p90_km,
      seconds: (performance.now() - t0) / 1000, when: Date.now(),
    };
    saveDetail(rec.id, detailOf(res));
    // a baseline replaces its older copy on the same quakes
    for (const r of runs) {
      if (baseline && r.baseline && r.name === name &&
          r.n_quake === rec.n_quake && r.seed === rec.seed) removeDetail(r.id);
    }
    runs = runs.filter(r => !(baseline && r.baseline && r.name === name &&
      r.n_quake === rec.n_quake && r.seed === rec.seed));
    runs.unshift(rec);
    store.set("runs", runs);
    return rec;
  }

  function progressBar(done, n, hits, km) {
    $("bar").style.width = (100 * done / n) + "%";
    runMsg(`${done} of ${n} quakes: ${pct(hits / done)} within ${HIT_KM} km, ` +
           `${(km / done).toFixed(2)} km off on average`);
  }

  async function runClicked() {
    if (busy) return;
    const setup = formSetup();
    $("bar").style.width = "0";
    runMsg("Loading your code...");
    if (!(await ensureLoaded())) { runMsg("Fix your code first.", "error"); return; }
    const name = $("estimator").value;
    const label = $("run-name").value.trim() || name;
    const p = program();
    const code = { main: loaded.source, helpers: JSON.parse(loaded.helpers) };
    if (p.mainName) code.mainName = p.mainName;
    setBusy(true);
    runMsg("Running...");
    const rec = await runOne(name, setup,
                             { label, code, onProgress: progressBar });
    setBusy(false);
    if (!rec) {
      $("bar").style.width = "0";
      runMsg(Py.ready ? "Stopped by an error (above)." : "Stopped.", "error");
      return;
    }
    $("bar").style.width = "100%";
    $("run-name").value = "";
    const [v] = verdict(rec);
    runMsg(`Done in ${rec.seconds.toFixed(1)} s: ${pct(rec.hit_rate)} within ` +
           `${HIT_KM} km, ${rec.mean_km.toFixed(2)} km off on average` +
           { yes: " (clears 90%).", no: " (below 90%).",
             maybe: " (too close to 90% to call)." }[v],
           v === "yes" ? "ok" : "");
    select(rec, false);
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
    renderRuns();
  }

  function verdict(r) {
    const lo = r.hit_rate - 2 * r.hit_se, hi = r.hit_rate + 2 * r.hit_se;
    if (lo >= HIT_BAR) return ["yes", "ok"];
    if (hi < HIT_BAR) return ["no", "bad"];
    return ["maybe", "warn"];
  }

  function stamp(t) {
    const d = new Date(t);
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return time;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      ", " + time;
  }

  // the runs table's columns: heading, sort key, and whether a first click
  // sorts high to low
  const COLUMNS = [
    { label: "Run", key: r => r.name.toLowerCase() },
    { label: "Quakes", num: true, key: r => r.n_quake },
    { label: "Seed", num: true, key: r => r.seed },
    { label: "Within 5 km", num: true, key: r => r.hit_rate, desc: true },
    { label: "Avg km", num: true, key: r => r.mean_km },
    { label: "Median", num: true, key: r => r.median_km },
    { label: "90th pct", num: true, key: r => r.p90_km },
    { label: "90%?", key: r => ({ yes: 2, maybe: 1, no: 0 })[verdict(r)[0]],
      desc: true },
    { label: "Time", num: true, key: r => r.seconds },
    { label: "When", key: r => r.when, desc: true },
    { label: "" },
  ];

  function renderHead() {
    const row = $("runs").tHead.rows[0];
    row.replaceChildren();
    for (const c of COLUMNS) {
      const th = document.createElement("th");
      if (c.num) th.className = "num";
      row.appendChild(th);
      if (!c.key) continue;
      const b = button(c.label, "Sort by " + c.label, () => {
        sort = sort.col === c.label ? { col: c.label, dir: -sort.dir }
                                    : { col: c.label, dir: c.desc ? -1 : 1 };
        store.set("sort", sort);
        renderHead();
        renderRuns();
      });
      b.className = "sort";
      th.appendChild(b);
      if (sort.col === c.label) {
        th.setAttribute("aria-sort", sort.dir > 0 ? "ascending" : "descending");
      }
    }
  }

  function sortedRuns() {
    const col = COLUMNS.find(c => c.key && c.label === sort.col) ||
      COLUMNS.find(c => c.label === "When");
    return [...runs].sort((a, b) => {
      const x = col.key(a), y = col.key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }

  function renderRuns() {
    const tbody = $("runs").tBodies[0];
    tbody.replaceChildren();
    if (!runs.length) {
      const td = tbody.insertRow().insertCell();
      td.colSpan = COLUMNS.length;
      td.className = "muted";
      td.textContent = "No runs yet.";
    }
    for (const r of sortedRuns()) {
      const tr = tbody.insertRow();
      tr.className = "pick" + (r.baseline ? " baseline" : "") +
        (r.id === selectedId ? " selected" : "");
      tr.title = "Show this run's post-mortem and code";
      tr.onclick = e => { if (!e.target.closest("input, button")) select(r); };
      const add = (v, cls) => {
        const td = tr.insertCell();
        td.textContent = v;
        if (cls) td.className = cls;
        return td;
      };
      if (r.baseline) add(r.name);
      else tr.insertCell().appendChild(nameInput(r));
      add(r.n_quake, "num");
      add(r.seed, "num");
      add(`${pct(r.hit_rate)} ± ${(200 * r.hit_se).toFixed(1)}`, "num");
      add(r.mean_km.toFixed(2), "num");
      add(r.median_km.toFixed(2), "num");
      add(r.p90_km.toFixed(2), "num");
      const [v, cls] = verdict(r);
      add(v).appendChild(Object.assign(document.createElement("i"),
        { className: "status-dot " + cls }));
      add(r.seconds.toFixed(1) + " s", "num");
      add(stamp(r.when), "muted").title = new Date(r.when).toLocaleString();

      const acts = document.createElement("div");
      acts.className = "acts";
      tr.insertCell().appendChild(acts);
      if (!r.baseline) {
        const post = button("Add to leaderboard",
          r.code ? "Re-run this code on our end and post its score"
                 : "Run it again first: this run was saved before runs " +
                   "kept their code", () => openPost(r));
        post.disabled = !r.code;
        acts.appendChild(post);
      }
      const del = button("×", "Remove this run", () => {
        runs = runs.filter(x => x.id !== r.id);
        removeDetail(r.id);
        store.set("runs", runs);
        if (r.id === selectedId) select(null);
        else renderRuns();
      });
      del.className = "x";
      acts.appendChild(del);
    }
  }

  function button(text, title, onclick) {
    const b = document.createElement("button");
    b.textContent = text;
    b.title = title;
    b.onclick = onclick;
    return b;
  }

  // a run's name, renamed in place
  function nameInput(r) {
    const inp = document.createElement("input");
    inp.className = "name-edit";
    inp.maxLength = 60;
    inp.value = r.name;
    inp.title = `Rename (estimator: ${r.estimator})`;
    inp.setAttribute("aria-label", "Run name");
    inp.onchange = () => {
      r.name = inp.value.trim() || r.estimator;
      inp.value = r.name;
      store.set("runs", runs);
    };
    inp.onkeydown = e => { if (e.key === "Enter") inp.blur(); };
    return inp;
  }

  // ------------------------------------------------- per-quake details
  // a run's per-quake results, for its post-mortem and its CSV: one list
  // per key of QUAKE_KEYS (py/runner.py, run), one entry per quake. Kept in
  // memory and, space allowing, in localStorage; when missing, rebuilt by
  // re-running the run.
  const QUAKE_KEYS = ["x", "y", "t0", "x_hat", "y_hat", "t0_hat", "error_km",
                      "t0_error", "n_bad", "noise_sd", "max_resid"];
  const details = new Map();
  const detailKey = id => "where_start.detail." + id;
  const round3 = v => Math.round(v * 1000) / 1000;

  function detailOf(res) {
    const d = {};
    for (const k of QUAKE_KEYS) d[k] = res[k];
    return d;
  }

  function saveDetail(id, d) {
    details.set(id, d);
    const packed = {};
    for (const k of QUAKE_KEYS) packed[k] = d[k].map(round3);
    const text = JSON.stringify(packed);
    // full: drop the oldest runs' details (they rebuild when opened)
    const old = [...runs].sort((a, b) => a.when - b.when).map(r => r.id)
      .filter(x => x !== id);
    for (;;) {
      try { localStorage.setItem(detailKey(id), text); return; }
      catch (e) {
        const x = old.shift();
        if (x === undefined) return;
        try { localStorage.removeItem(detailKey(x)); } catch (e2) { return; }
      }
    }
  }

  function getDetail(id) {
    if (details.has(id)) return details.get(id);
    try {
      const d = JSON.parse(localStorage.getItem(detailKey(id)));
      if (!d || !QUAKE_KEYS.every(k => Array.isArray(d[k]))) return null;
      details.set(id, d);
      return d;
    } catch (e) { return null; }
  }

  function removeDetail(id) {
    details.delete(id);
    try { localStorage.removeItem(detailKey(id)); } catch (e) { /* fine */ }
  }

  // ------------------------------------------------- the selected run
  // selects run r (or none): highlights its row, shows its code and its
  // post-mortem, opening on its first miss
  function select(r, scroll = true) {
    selectedId = r ? r.id : null;
    store.set("selected", selectedId);
    renderRuns();
    renderCode();
    pmRows = {};
    pmFor = null;
    pmShown = null;
    $("pm-table-wrap").hidden = true;
    $("csv-btn").hidden = true;
    $("miss-only-box").hidden = true;
    $("circles-box").hidden = true;
    $("pm-plot").replaceChildren();
    if (!r) {
      pmMsg("Click a run above to go through its quakes one by one, with " +
            "the hidden truth revealed.");
      return;
    }
    if (!codeOf(r)) {
      pmMsg("This run was saved before runs kept their code, so it has no " +
            "post-mortem: run it again.");
      return;
    }
    pmMsg("Loading...");
    showQuake(null);
    if (scroll) $("pm-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderCode() {
    const r = selected(), code = r && codeOf(r);
    $("run-code").hidden = !code;
    if (code) showCodeFile("main");
  }

  // the code panel: one file at a time (the main code, then its helpers)
  let shownFile = "main";
  function showCodeFile(file) {
    const code = codeOf(selected());
    shownFile = file;
    const list = [["main", code.mainName || "main code"],
                  ...Object.keys(code.helpers).map(f => [f, f])];
    const chips = $("code-files");
    chips.replaceChildren();
    chips.hidden = list.length < 2;
    for (const [f, label] of list) {
      const c = button(label, "Show " + label, () => showCodeFile(f));
      c.className = "chip file" + (f === file ? " on" : "");
      chips.appendChild(c);
    }
    $("code-view").textContent = shownText();
  }

  function shownText() {
    const code = codeOf(selected());
    return shownFile === "main" ? code.main : code.helpers[shownFile];
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(shownText());
      $("copy-code").textContent = "Copied";
      setTimeout(() => { $("copy-code").textContent = "Copy"; }, 1500);
    } catch (e) {
      const range = document.createRange();
      range.selectNodeContents($("code-view"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  }

  function downloadCode() {
    const r = selected();
    const slug = r.name.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([shownText()], { type: "text/x-python" }));
    const code = codeOf(r);
    a.download = shownFile !== "main" ? shownFile.split("/").pop()
      : code.mainName ? code.mainName.split("/").pop().replace(/\.ipynb$/, ".py")
      : (slug || "estimate") + ".py";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // makes run r's code yours: in the editor if it's one file, else as files
  async function openInEditor() {
    const r = selected(), code = codeOf(r);
    if (busy) return;
    const asFiles = !!code.mainName || Object.keys(code.helpers).length > 0;
    const cur = program();
    const same = cur.main === code.main &&
      JSON.stringify(cur.helpers) === JSON.stringify(code.helpers);
    if (!same && !confirm(`Replace your ${srcMode === "files" ? "files" : "code"}` +
                          ` with the code of "${r.name}"?`)) return;
    if (asFiles) {
      const main = code.mainName || "main.py";
      const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
      files = { [main]: code.main };
      for (const [f, text] of Object.entries(code.helpers)) files[dir + f] = text;
      mainFile = main;
      shownUpload = main;
      saveFiles();
    } else {
      editor.value = code.main;
      store.set("code", editor.value);
    }
    setSrcMode(asFiles ? "files" : "type", false);
    $("run-name").value = r.baseline || r.name === r.estimator ? "" : r.name;
    await loadCode();
    const sel = $("estimator");
    if ([...sel.options].some(o => o.value === r.estimator)) {
      sel.value = r.estimator;
    }
    $("code-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // --------------------------------------------------------- post-mortem
  const pmMsg = text => { $("pm-msg").textContent = text; };
  let pmRows = {};      // quake idx -> its row in the quakes table
  let pmFor = null;     // what the quakes table shows: "id|sort|filter"
  let pmQuake = null;   // the quake plotted
  let pmShown = null;   // {res, idx} of the plot, redrawn when a toggle flips

  const setupOf = r => ({ n_station: r.n_station, max_bad: r.max_bad,
                          n_quake: r.n_quake, seed: r.seed });

  // the quakes table for run r: rebuilt only when the run, sort or filter
  // changes
  function renderQuakes(r, d) {
    const missOnly = $("miss-only").checked;
    const key = `${r.id}|${pmSort.col}|${pmSort.dir}|${missOnly}`;
    const nMiss = d.error_km.filter(e => e > HIT_KM).length;
    pmMsg(`${nMiss} of ${r.n_quake} quakes missed by more than ${HIT_KM} km. ` +
          "Click one to see it.");
    $("csv-btn").hidden = false;
    if (key === pmFor) return;
    pmFor = key;
    const quakes = [];
    for (let i = 0; i < r.n_quake; i++) {
      if (missOnly && d.error_km[i] <= HIT_KM) continue;
      const q = { idx: i, hit: d.error_km[i] <= HIT_KM };
      for (const k of QUAKE_KEYS) q[k] = d[k][i];
      quakes.push(q);
    }
    $("pm-table-wrap").hidden = false;
    $("miss-only-box").hidden = false;
    pmRows = PostMortem.table($("quakes"), quakes, {
      sort: pmSort,
      onSort: col => {
        pmSort = pmSort.col === col ? { col, dir: -pmSort.dir } : { col, dir: 1 };
        store.set("pmSort", pmSort);
        renderQuakes(r, d);
        PostMortem.mark(pmRows, pmQuake);
      },
      onPick: idx => { PostMortem.mark(pmRows, idx); showQuake(idx); },
    });
  }

  // the selected run's results as a tidy CSV, a row per quake: the run's
  // name, estimator and seed repeated on every row, so runs concatenate
  function downloadResults() {
    const r = selected(), d = r && getDetail(r.id);
    if (!d) return;
    const quote = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const cols = ["run", "estimator", "seed", "quake", ...QUAKE_KEYS, "hit"];
    const lines = [cols.join(",")];
    for (let i = 0; i < r.n_quake; i++) {
      lines.push([quote(r.name), quote(r.estimator), r.seed, i,
                  ...QUAKE_KEYS.map(k => round3(d[k][i])),
                  d.error_km[i] <= HIT_KM ? 1 : 0].join(","));
    }
    const slug = s => s.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"],
                                          { type: "text/csv" }));
    a.download = `where_start_${slug(r.name) || "run"}_seed${r.seed}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // what the post-mortem should show once the worker is free: the selected
  // run, and a quake of it (null: its first miss). Older asks are dropped.
  let wanted = null, pumping = false;
  function showQuake(idx) {
    const r = selected();
    if (!r || !codeOf(r)) return;
    wanted = { r, idx };
    pumpPostMortem();
  }

  async function pumpPostMortem() {
    if (pumping) return;
    pumping = true;
    try {
      while (wanted && Py.ready && !busy) {
        const { r, idx } = wanted;
        wanted = null;
        await postMortemNow(r, idx);
      }
    } finally {
      pumping = false;
    }
  }

  const stale = r => selected() !== r || wanted !== null;

  async function postMortemNow(r, idx) {
    if (!(await ensureRunLoaded(r))) {
      pmMsg("This run's code no longer loads here.");
      return;
    }
    let d = getDetail(r.id);
    if (!d) {
      setBusy(true);
      let res;
      try {
        res = await Py.call("run", { name: r.estimator, setup: setupOf(r),
          every: Math.max(1, Math.round(r.n_quake / 100)) },
          (done, n) => pmMsg(`Rebuilding this run's quakes: ${done} of ${n}...`));
      } catch (e) {
        setBusy(false);
        return;
      }
      setBusy(false);
      if (!res.ok) { pmMsg(res.error); return; }
      d = detailOf(res);
      saveDetail(r.id, d);
    }
    if (selected() !== r) return;
    if (idx === null) {
      const m = d.error_km.findIndex(e => e > HIT_KM);
      idx = m >= 0 ? m : 0;
    }
    renderQuakes(r, d);
    pmQuake = idx;
    PostMortem.mark(pmRows, idx);
    if (stale(r)) return;

    setBusy(true);
    let res;
    try {
      res = await Py.call("replay", { name: r.estimator, setup: setupOf(r), idx });
    } catch (e) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (stale(r)) return;
    if (!res.ok) { $("pm-plot").textContent = res.error; return; }
    pmShown = { res, idx };
    $("circles-box").hidden = false;
    PostMortem.plot($("pm-plot"), res, idx, $("circles").checked);
  }

  // -------------------------------------------------------- leaderboard
  // the board shown: its code is remembered in this browser
  async function refreshBoard() {
    const code = store.get("boardCode", "");
    $("board-code").value = code;
    if (!Board.enabled) {
      $("board-msg").textContent = "The leaderboard isn't connected yet.";
      return;
    }
    $("board-wrap").hidden = true;
    $("board-title").hidden = true;
    if (!code) {
      $("board-msg").textContent = "Enter your class's code to see its " +
        "leaderboard.";
      return;
    }
    $("board-msg").textContent = "Loading...";
    try {
      const board = await Board.list(code);
      $("board-title").textContent = board.title +
        (board.open ? "" : " (closed: no new entries)");
      $("board-title").hidden = false;
      $("board-wrap").hidden = false;
      Board.render($("board").tBodies[0], board.entries);
      $("board-msg").textContent = board.entries.length ? ""
        : "No entries yet: be the first.";
    } catch (e) {
      $("board-msg").textContent = e.message;
    }
  }

  // the post dialog: the run being posted, while it's open
  let posting = null;

  function openPost(r) {
    posting = r;
    $("post-run").textContent = r.name;
    const saved = store.get("post", {});
    $("post-name").value = saved.name || "";
    $("post-code").value = store.get("boardCode", "") || saved.code || "";
    postMsg(Board.enabled ? "" : "The leaderboard isn't connected yet.",
            Board.enabled ? "" : "error");
    $("post-submit").disabled = !Board.enabled;
    $("post-dialog").showModal();
  }

  async function submitPost(e) {
    e.preventDefault();
    const r = posting;
    const name = $("post-name").value.trim(), code = $("post-code").value.trim();
    if (!r || !name || !code) return;
    store.set("post", { name, code });
    $("post-submit").disabled = true;
    postMsg("Adding...");
    try {
      await Board.post({
        code, name, method: r.name, entry_point: r.estimator,
        source: { ...r.code,
                  build: (typeof BUILD !== "undefined" && BUILD) ? BUILD.sha : null },
      });
    } catch (err) {
      postMsg("Not added: " + err.message, "error");
      $("post-submit").disabled = false;
      return;
    }
    store.set("boardCode", code);
    $("post-dialog").close();
    runMsg(`Added "${r.name}" to the leaderboard: its score shows up ` +
           "there once we've re-run it.", "ok");
  }

  async function removeClicked() {
    if (!Board.enabled) return;
    if (!confirm("Remove your leaderboard entry (the one posted from this browser)?")) return;
    try {
      await Board.remove(store.get("boardCode", ""));
      $("board-msg").textContent = "Removed.";
    } catch (e) {
      $("board-msg").textContent = "Couldn't remove it: " + e.message;
      return;
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

  function readBytes(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(new Uint8Array(r.result));
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }

  // ----------------------------------------------------- where code comes
  function setSrcMode(m, reload = true) {
    srcMode = m;
    store.set("srcMode", m);
    for (const b of $("src-mode").querySelectorAll("button")) {
      b.setAttribute("aria-checked", b.dataset.v === m);
    }
    $("type-pane").hidden = m !== "type";
    $("files-pane").hidden = m !== "files";
    renderFiles();
    if (reload) loadCode();
  }

  function saveFiles() {
    store.set("files", files);
    store.set("mainFile", mainFile);
  }

  // adds dropped / chosen files: .py as they are, .ipynb as their code
  // cells, a .zip's code files; same paths replace the old ones
  async function addFiles(list) {
    const added = [], skipped = [];
    loadMsg("Reading your files...", "note");
    for (const f of list) {
      try {
        if (f.name.endsWith(".zip")) {
          const res = await Py.call("unzip", { bytes: await readBytes(f) });
          Object.assign(files, res.files);
          added.push(...Object.keys(res.files));
          skipped.push(...res.skipped.map(x => `${x} (in ${f.name})`));
        } else if (f.name.endsWith(".ipynb")) {
          files[f.name] = await Py.call("notebook", { text: await readText(f) },
                                        null, true);
          added.push(f.name);
        } else if (f.name.endsWith(".py")) {
          files[f.name] = await readText(f);
          added.push(f.name);
        } else {
          skipped.push(f.name);
        }
      } catch (e) {
        skipped.push(`${f.name} (couldn't read it: ${e.message})`);
      }
    }
    if (added.length) shownUpload = pickMain();
    saveFiles();
    renderFiles();
    const ok = await loadCode();
    if (skipped.length && (ok || $("load-msg").hidden)) {
      loadMsg("Only .py and .ipynb files are used; skipped: " +
              skipped.join(", "), "note");
    }
  }

  function renderFiles() {
    const names = Object.keys(files).sort();
    $("files-box").hidden = !names.length;
    $("drop").classList.toggle("small", names.length > 0);
    if (!names.length) return;
    const main = pickMain();
    if (!files[shownUpload]) shownUpload = main;
    const tabs = $("file-tabs");
    tabs.replaceChildren();
    for (const f of names) {
      const b = button(f + (f === main ? "  (main)" : ""), "Show " + f, () => {
        shownUpload = f;
        renderFiles();
      });
      b.className = "chip file" + (f === shownUpload ? " on" : "");
      tabs.appendChild(b);
    }
    $("file-view").textContent = files[shownUpload];
    const sel = $("main-file");
    sel.replaceChildren();
    for (const f of names) sel.add(new Option(f, f));
    sel.value = main;
    $("main-field").hidden = names.length < 2;
  }

  // --------------------------------------------------------------- wiring
  Py.onStatus = (state, text) => {
    if (state !== "ready") codeStatus(state === "failed" ? "failed" : "", text);
    setBusy(false);
    if (state === "ready") {
      loadCode().then(() => { if (selected()) showQuake(pmQuake); });
    }
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

  editor.addEventListener("input", () => {
    store.set("code", editor.value);
    if (Py.ready) codeStatus("", "Edited: checks when you click away or run");
  });
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

  for (const b of $("src-mode").querySelectorAll("button")) {
    b.onclick = () => { if (b.dataset.v !== srcMode) setSrcMode(b.dataset.v); };
  }
  $("files-input").onchange = e => {
    if (e.target.files.length) addFiles([...e.target.files]);
    e.target.value = "";
  };
  $("main-file").onchange = () => {
    mainFile = $("main-file").value;
    shownUpload = mainFile;
    saveFiles();
    renderFiles();
    loadCode();
  };
  $("clear-files").onclick = () => {
    if (!confirm("Remove all your files from this page? (Your own copies " +
                 "are untouched.)")) return;
    files = {};
    mainFile = null;
    saveFiles();
    renderFiles();
    loadCode();
  };
  // drop anywhere on the code card: switches to files
  const card = $("code-card");
  card.addEventListener("dragover", e => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    card.classList.add("dragging");
  });
  card.addEventListener("dragleave", e => {
    if (!card.contains(e.relatedTarget)) card.classList.remove("dragging");
  });
  card.addEventListener("drop", e => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    card.classList.remove("dragging");
    if (srcMode !== "files") setSrcMode("files", false);
    addFiles([...e.dataTransfer.files]);
  });
  $("reset-btn").onclick = () => {
    if (editor.value !== EXAMPLE &&
        !confirm("Replace the editor's code with the example?")) return;
    editor.value = EXAMPLE;
    store.set("code", EXAMPLE);
    if (Py.ready) codeStatus("", "Edited");
    loadCode();
  };

  for (const id of ["n-quake", "seed"]) $(id).addEventListener("change", saveForm);
  $("run-btn").onclick = runClicked;
  $("stop-btn").onclick = stop;
  $("base-btn").onclick = baselinesClicked;
  $("clear-btn").onclick = () => {
    if (!runs.length || !confirm("Clear every run in the table?")) return;
    for (const r of runs) removeDetail(r.id);
    runs = [];
    store.set("runs", runs);
    select(null);
  };
  $("circles").checked = store.get("circles", true);
  $("circles").onchange = () => {
    store.set("circles", $("circles").checked);
    if (pmShown && $("pm-plot").firstChild) {
      PostMortem.plot($("pm-plot"), pmShown.res, pmShown.idx, $("circles").checked);
    }
  };
  $("miss-only").checked = store.get("missOnly", false);
  $("miss-only").onchange = () => {
    store.set("missOnly", $("miss-only").checked);
    const r = selected(), d = r && getDetail(r.id);
    if (!d) return;
    renderQuakes(r, d);
    PostMortem.mark(pmRows, pmQuake);
  };
  $("csv-btn").onclick = downloadResults;
  $("copy-code").onclick = copyCode;
  $("download-code").onclick = downloadCode;
  $("open-code").onclick = openInEditor;

  $("post-form").onsubmit = submitPost;
  $("post-cancel").onclick = () => $("post-dialog").close();
  $("remove-btn").onclick = removeClicked;
  $("refresh-btn").onclick = refreshBoard;
  $("board-form").onsubmit = e => {
    e.preventDefault();
    store.set("boardCode", $("board-code").value.trim());
    refreshBoard();
  };
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
  const repo = CONFIG.repo;
  if (typeof BUILD === "undefined" || !BUILD) {
    build.textContent = "local copy";
  } else {
    const when = new Date(BUILD.time).toLocaleString("en-US", {
      dateStyle: "medium", timeStyle: "short" });
    build.innerHTML = `build <a href="${repo}/commit/${BUILD.sha}">${
      BUILD.sha.slice(0, 7)}</a>, ${when}`;
  }

  restoreForm();
  setSrcMode(srcMode, false);
  renderHead();
  renderRuns();
  select(selected(), false);
  setMode(Object.keys(HASH).find(m => HASH[m] === location.hash) || "practice");
  Py.start();
})();

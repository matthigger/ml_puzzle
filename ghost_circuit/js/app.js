// The page: your code (typed, or dropped files), runs (each keeps its code;
// click one for its post-mortem, code and results CSV), leaderboard
// posting, tabs. Python work goes through Py (shared/py.js).

(function () {
  const $ = id => document.getElementById(id);
  const pct = (v, d = 1) => (100 * v).toFixed(d) + "%";
  const BASELINES = ["correlation > 0.2", "on minus off, top 8",
                     "least squares, top 8", "every device"];
  const EXAMPLE = `import numpy as np


def estimate(x, y):
    """ every device whose on / off pattern correlates with the meter """
    r = np.array([np.corrcoef(x[:, i], y)[0, 1] for i in range(x.shape[1])])
    return np.flatnonzero(r > .2)
`;

  // the baselines' code (py/runner.py), shown like a run's own
  const BASELINE_CODE = {
    "correlation > 0.2": EXAMPLE,
    "on minus off, top 8": `import numpy as np


def estimate(x, y):
    """ the 8 devices with the biggest gap between the average meter when
    on and when off """
    gap = np.zeros(x.shape[1])
    for j in range(x.shape[1]):
        on = x[:, j] == 1
        if on.any() and (~on).any():
            gap[j] = y[on].mean() - y[~on].mean()
    return np.argsort(gap)[-8:]
`,
    "least squares, top 8": `import numpy as np


def estimate(x, y):
    """ the 8 devices given the most watts by least squares (with an
    always-on term); with more devices than hours, the smallest of its many
    perfect fits """
    a = np.column_stack([x, np.ones(len(y))])
    return np.argsort(np.linalg.lstsq(a, y, rcond=None)[0][:-1])[-8:]
`,
    "every device": `import numpy as np


def estimate(x, y):
    """ name all of them (TPR 100%, and FPR 100%) """
    return np.arange(x.shape[1])
`,
  };
  const baselineCode = name => ({ main: BASELINE_CODE[name], helpers: {} });

  // ------------------------------------------------- browser storage
  // per-browser conveniences only: everything works without it. Keys are
  // prefixed: every puzzle site on this origin shares localStorage
  const PREFIX = "ghost_circuit.";
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(PREFIX + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); }
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
  // mainName?} | null (baselines), n_circuit, seed, f1, f1_se, tpr,
  // tpr_se, fpr, fpr_se, mean_right, mean_wrong, seconds, when}; runs
  // scored some other way (no f1) are dropped
  let runs = store.get("runs", []).filter(r => r.f1 !== undefined);
  let selectedId = store.get("selected", null);
  let sort = store.get("sort", { col: "When", dir: -1 });
  let pmSort = store.get("pmSort", { col: "Circuit", dir: 1 });
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
    $("results-btn").disabled = !ready;
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
      loadMsg("No function that takes (x, y) was found: define " +
              "estimate(x, y).", "error");
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
    return {
      n_circuit: Math.min(20000, Math.max(1, parseInt($("n-circuit").value) || 1)),
      seed: Math.max(0, parseInt($("seed").value) || 0) };
  }

  function saveForm() {
    store.set("form", { n_circuit: $("n-circuit").value, seed: $("seed").value });
  }

  function restoreForm() {
    const f = store.get("form", null);
    if (f) { $("n-circuit").value = f.n_circuit; $("seed").value = f.seed; }
  }

  const setupOf = r => ({ n_circuit: r.n_circuit, seed: r.seed });
  const every = n => Math.max(1, Math.round(n / 100));

  // ---------------------------------------------------------------- runs
  // runs name on setup; returns the run's record (also kept in runs), or
  // null after an error or stop
  async function runOne(name, setup, { baseline = false, label = name,
                                       code = null, onProgress } = {}) {
    const t0 = performance.now();
    let res;
    try {
      res = await Py.call("run", { name, setup, every: every(setup.n_circuit) },
                          onProgress);
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
      code, ...setup,
      f1: res.f1, f1_se: res.f1_se,
      tpr: res.tpr, tpr_se: res.tpr_se, fpr: res.fpr, fpr_se: res.fpr_se,
      mean_right: res.mean_right, mean_wrong: res.mean_wrong,
      seconds: (performance.now() - t0) / 1000, when: Date.now(),
    };
    saveDetail(rec.id, detailOf(res));
    // a baseline replaces its older copy on the same circuits
    const same = r => baseline && r.baseline && r.name === name &&
      r.n_circuit === rec.n_circuit && r.seed === rec.seed;
    for (const r of runs) if (same(r)) removeDetail(r.id);
    runs = runs.filter(r => !same(r));
    runs.unshift(rec);
    store.set("runs", runs);
    return rec;
  }

  function progressBar(done, n, right, wrong) {
    $("bar").style.width = (100 * done / n) + "%";
    runMsg(`${done} of ${n} circuits: found ${(right / done).toFixed(1)} ` +
           `of 8, ${(wrong / done).toFixed(1)} wrong on average`);
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
    runMsg(`Done in ${rec.seconds.toFixed(1)} s: F1 ${rec.f1.toFixed(3)} ` +
           `(TPR ${pct(rec.tpr)}, FPR ${pct(rec.fpr, 2)}).`, "ok");
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
    { label: "Circuits", num: true, key: r => r.n_circuit },
    { label: "Seed", num: true, key: r => r.seed },
    { label: "F1", num: true, key: r => r.f1, desc: true },
    { label: "TPR", num: true, key: r => r.tpr, desc: true },
    { label: "FPR", num: true, key: r => r.fpr },
    { label: "Found of 8", num: true, key: r => r.mean_right, desc: true },
    { label: "Wrong", num: true, key: r => r.mean_wrong },
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
      add(r.n_circuit, "num");
      add(r.seed, "num");
      add(`${r.f1.toFixed(3)} ± ${(2 * r.f1_se).toFixed(3)}`, "num");
      add(`${pct(r.tpr)} ± ${(200 * r.tpr_se).toFixed(1)}`, "num");
      add(`${pct(r.fpr, 2)} ± ${(200 * r.fpr_se).toFixed(2)}`, "num");
      add(r.mean_right.toFixed(1), "num");
      add(r.mean_wrong.toFixed(1), "num");
      add(r.seconds.toFixed(1) + " s", "num");
      add(stamp(r.when), "muted").title = new Date(r.when).toLocaleString();

      const acts = document.createElement("div");
      acts.className = "acts";
      tr.insertCell().appendChild(acts);
      if (!r.baseline) {
        acts.appendChild(button("Add to leaderboard",
          "Re-run this code on our end and post its score", () => openPost(r)));
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

  // ----------------------------------------------- per-circuit details
  // a run's per-circuit results, for its post-mortem: {right, wrong,
  // n_named, missed_w}, one entry per circuit (py/runner.py score). Kept
  // in memory and, space allowing, in localStorage; when missing, rebuilt by
  // re-running the run.
  const details = new Map();
  const detailKey = id => PREFIX + "detail." + id;
  const DETAIL = ["right", "wrong", "n_named", "missed_w"];
  const round1 = v => Math.round(v * 10) / 10;

  function detailOf(res) {
    return Object.fromEntries(DETAIL.map(k => [k, res[k]]));
  }

  function saveDetail(id, d) {
    details.set(id, d);
    // right is 0..8: one digit per circuit
    const packed = JSON.stringify({ r: d.right.join(""), w: d.wrong,
      n: d.n_named, m: d.missed_w.map(round1) });
    // full: drop the oldest runs' details (they rebuild when opened)
    const old = [...runs].sort((a, b) => a.when - b.when).map(r => r.id)
      .filter(x => x !== id);
    for (;;) {
      try { localStorage.setItem(detailKey(id), packed); return; }
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
      const p = JSON.parse(localStorage.getItem(detailKey(id)));
      if (!p) return null;
      const d = { right: [...p.r].map(Number), wrong: p.w, n_named: p.n,
                  missed_w: p.m };
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
  // post-mortem, opening on its first circuit with a wrong device
  function select(r, scroll = true) {
    selectedId = r ? r.id : null;
    store.set("selected", selectedId);
    renderRuns();
    renderCode();
    pmRows = {};
    pmFor = null;
    $("pm-table-wrap").hidden = true;
    $("wrong-only-box").hidden = true;
    $("results-btn").hidden = true;
    $("pm-plot").replaceChildren();
    if (!r) {
      pmMsg("Click a run above to go through its circuits one by one, with " +
            "the hidden truth revealed.");
      return;
    }
    pmMsg("Loading...");
    showCircuit(null);
    if (scroll) $("pm-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderCode() {
    const r = selected();
    $("run-code").hidden = !r;
    if (r) showCodeFile("main");
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

  const slug = s => s.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");

  function saveFile(text, type, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function downloadCode() {
    const r = selected(), code = codeOf(r);
    saveFile(shownText(), "text/x-python", shownFile !== "main"
      ? shownFile.split("/").pop()
      : code.mainName ? code.mainName.split("/").pop().replace(/\.ipynb$/, ".py")
      : (slug(r.name) || "estimate") + ".py");
  }

  // every circuit of the selected run as a CSV, rebuilt by re-running it
  // (one row per device on the circuit or named)
  async function downloadResults() {
    const r = selected();
    if (!r || busy) return;
    if (!(await ensureRunLoaded(r))) {
      pmMsg("This run's code no longer loads here.");
      return;
    }
    setBusy(true);
    let res;
    try {
      res = await Py.call("results", { name: r.estimator, setup: setupOf(r),
        run: r.name, every: every(r.n_circuit) },
        (done, n) => pmMsg(`Building the results: ${done} of ${n} circuits...`));
    } catch (e) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (!res.ok) { pmMsg(res.error); return; }
    saveFile(res.csv, "text/csv",
             `ghost_circuit_${slug(r.name) || "run"}_seed${r.seed}.csv`);
    const d = getDetail(r.id);
    if (d) renderCircuits(r, d, true);
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
  let pmRows = {};      // circuit idx -> its row in the circuits table
  let pmFor = null;     // what the circuits table shows: "id|sort|filter"
  let pmCircuit = null; // the circuit plotted

  // the circuits table for run r: rebuilt only when the run, sort or filter
  // changes (or force)
  function renderCircuits(r, d, force = false) {
    const wrongOnly = $("wrong-only").checked;
    const key = `${r.id}|${pmSort.col}|${pmSort.dir}|${wrongOnly}`;
    const nAll = d.right.filter(k => k === 8).length;
    const nWrong = d.wrong.filter(k => k > 0).length;
    pmMsg(`Of ${r.n_circuit} circuits: all 8 found on ${nAll}, a wrong ` +
          `device named on ${nWrong}. Click one to see it.`);
    if (key === pmFor && !force) return;
    pmFor = key;
    const circuits = [];
    for (let i = 0; i < r.n_circuit; i++) {
      if (wrongOnly && !d.wrong[i]) continue;
      circuits.push({ idx: i, ...Object.fromEntries(DETAIL.map(k => [k, d[k][i]])) });
    }
    $("pm-table-wrap").hidden = false;
    $("wrong-only-box").hidden = false;
    $("results-btn").hidden = false;
    pmRows = PostMortem.table($("crawls"), circuits, {
      sort: pmSort,
      onSort: col => {
        pmSort = pmSort.col === col ? { col, dir: -pmSort.dir } : { col, dir: 1 };
        store.set("pmSort", pmSort);
        renderCircuits(r, d);
        PostMortem.mark(pmRows, pmCircuit);
      },
      onPick: idx => { PostMortem.mark(pmRows, idx); showCircuit(idx); },
    });
    PostMortem.mark(pmRows, pmCircuit);
  }

  // what the post-mortem should show once the worker is free: the selected
  // run, and a circuit of it (null: its first with a wrong device, else
  // its first with a device missed). Older asks are
  // dropped.
  let wanted = null, pumping = false;
  function showCircuit(idx) {
    const r = selected();
    if (!r) return;
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
          every: every(r.n_circuit) },
          (done, n) => pmMsg(`Rebuilding this run's circuits: ${done} of ${n}...`));
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
      idx = d.wrong.findIndex(k => k > 0);
      if (idx < 0) idx = Math.max(0, d.right.findIndex(k => k < 8));
    }
    pmCircuit = idx;
    renderCircuits(r, d);
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
    PostMortem.plot($("pm-plot"), res, idx);
  }

  // -------------------------------------------------------- leaderboard
  // the board shown: its code is remembered in this browser. While this
  // browser's entry waits for its re-run, the board reloads itself quietly
  let boardTimer = null;
  async function refreshBoard(quiet = false) {
    clearTimeout(boardTimer);
    const code = store.get("boardCode", "");
    $("board-code").value = code;
    if (!Board.enabled) {
      $("board-msg").textContent = "The leaderboard isn't connected yet.";
      return;
    }
    if (!quiet) {
      $("board-wrap").hidden = true;
      $("board-title").hidden = true;
    }
    if (!code) {
      $("board-msg").textContent = "Enter your class's code to see its " +
        "leaderboard.";
      return;
    }
    if (!quiet) $("board-msg").textContent = "Loading...";
    try {
      const board = await Board.list(code);
      $("board-title").textContent = board.title +
        (board.open ? "" : " (closed: no new entries)");
      $("board-title").hidden = false;
      $("board-wrap").hidden = false;
      const waiting = Board.render($("board").tBodies[0], board.entries);
      $("board-msg").textContent = board.entries.length ? ""
        : "No entries yet: be the first.";
      if (waiting && mode === "board") {
        boardTimer = setTimeout(() => {
          if (mode === "board") refreshBoard(true);
        }, 15000);
      }
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
    // to the board, where the entry waits for its re-run (and the board
    // reloads itself until it's scored)
    setMode("board");
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
      loadCode().then(() => { if (selected()) showCircuit(pmCircuit); });
    }
    if (state === "failed") {
      loadMsg("Python couldn't start in this browser. Try reloading the " +
              "page, or a recent Chrome, Firefox, Edge or Safari.", "error");
    }
  };

  function stop() {
    // restarts the worker; its ready status reloads the code
    Py.stop();
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

  for (const id of ["n-circuit", "seed"]) $(id).addEventListener("change", saveForm);
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
  $("wrong-only").checked = store.get("wrongOnly", false);
  $("wrong-only").onchange = () => {
    store.set("wrongOnly", $("wrong-only").checked);
    const r = selected(), d = r && getDetail(r.id);
    if (!d) return;
    renderCircuits(r, d);
  };
  $("copy-code").onclick = copyCode;
  $("download-code").onclick = downloadCode;
  $("open-code").onclick = openInEditor;
  $("results-btn").onclick = downloadResults;

  $("post-form").onsubmit = submitPost;
  $("post-cancel").onclick = () => $("post-dialog").close();
  $("remove-btn").onclick = removeClicked;
  $("refresh-btn").onclick = () => refreshBoard();
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

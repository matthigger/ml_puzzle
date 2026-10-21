// The page: editor and files, runs (each keeps its code; click one to replay
// it and read its code), leaderboard posting, tabs. Python work goes
// through Py (js/py.js).

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

  // the baselines' code (py/runner.py, taste_each), shown like a run's own
  function baselineCode(name) {
    const n = name.split(" ").pop();
    return { main: `def estimate(crawl):
    """ ${n} slices from every shop, best average wins """
    avg = []
    for i in range(crawl.n_shop):
        total = 0
        for _ in range(${n}):
            total += crawl.taste(i)
        avg.append(total / ${n})
    return avg.index(max(avg))
`, helpers: {} };
  }

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
  // run records: {id, name, estimator, baseline, code: {main, helpers} |
  // null, n_shop, family, race, n_crawl, seed, accuracy, accuracy_se,
  // mean_slices, median_slices, p90_slices, seconds, when, wrong: [idx]}
  let runs = store.get("runs", []);
  let selectedId = store.get("selected", null);
  let sort = store.get("sort", { col: "When", dir: -1 });
  let loaded = null;    // {source, helpers, names} the worker has run
  let busy = false;     // a load or run is in progress
  let mode = "practice";

  const helperKey = () => JSON.stringify(helpers);
  const dirty = () => !loaded || loaded.source !== editor.value ||
    loaded.helpers !== helperKey();
  const selected = () => runs.find(r => r.id === selectedId) || null;
  const codeOf = r => r.baseline ? baselineCode(r.name) : r.code;

  // ------------------------------------------------------- messages
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
    updateReplayNav();
    if (!busy) queueMicrotask(pumpReplay);
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
    loadMsg("Running your code...");
    let res;
    try {
      res = await loadInWorker(editor.value, { ...helpers });
    } catch (e) {
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

    if (!res.ok) loadMsg(res.error, "error");
    else if (!res.names.length) {
      loadMsg("No function that takes a crawl was found: define " +
              "estimate(crawl).", "error");
    } else loadMsg("");
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
      n_crawl: Math.min(100000, Math.max(1, parseInt($("n-crawl").value) || 1)),
      seed: Math.max(0, parseInt($("seed").value) || 0) };
  }

  function saveForm() {
    store.set("form.v2", { n_crawl: $("n-crawl").value, seed: $("seed").value });
  }

  function restoreForm() {
    const f = store.get("form.v2", null);
    if (f) { $("n-crawl").value = f.n_crawl; $("seed").value = f.seed; }
  }

  // ---------------------------------------------------------------- runs
  // runs name on setup; returns the run's record (also kept in runs), or
  // null after an error or stop
  async function runOne(name, setup, { baseline = false, label = name,
                                       code = null, onProgress } = {}) {
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
      code, n_shop: setup.n_shop, family: setup.family, race: setup.race,
      n_crawl: setup.n_crawl, seed: setup.seed,
      accuracy: res.accuracy, accuracy_se: res.accuracy_se,
      mean_slices: res.mean_slices, median_slices: res.median_slices,
      p90_slices: res.p90_slices,
      seconds: (performance.now() - t0) / 1000, when: Date.now(),
      wrong: res.correct.flatMap((c, i) => c ? [] : [i]),
    };
    // a baseline replaces its older copy on the same crawls
    runs = runs.filter(r => !(baseline && r.baseline && r.name === name &&
      r.n_crawl === rec.n_crawl && r.seed === rec.seed));
    runs.unshift(rec);
    store.set("runs", runs);
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
    const label = $("run-name").value.trim() || name;
    const code = { main: loaded.source, helpers: JSON.parse(loaded.helpers) };
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
    runMsg(`Done in ${rec.seconds.toFixed(1)} s: ${pct(rec.accuracy)} right, ` +
           `${rec.mean_slices.toFixed(1)} slices on average` +
           { yes: " (clears 95%).", no: " (below 95%).",
             maybe: " (too close to 95% to call)." }[v],
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
    const lo = r.accuracy - 2 * r.accuracy_se, hi = r.accuracy + 2 * r.accuracy_se;
    if (lo >= 0.95) return ["yes", "ok"];
    if (hi < 0.95) return ["no", "bad"];
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
    { label: "Crawls", num: true, key: r => r.n_crawl },
    { label: "Seed", num: true, key: r => r.seed },
    { label: "Right", num: true, key: r => r.accuracy, desc: true },
    { label: "Avg slices", num: true, key: r => r.mean_slices },
    { label: "Median", num: true, key: r => r.median_slices },
    { label: "90th pct", num: true, key: r => r.p90_slices },
    { label: "95%?", key: r => ({ yes: 2, maybe: 1, no: 0 })[verdict(r)[0]],
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
      tr.title = "Replay this run and see its code";
      tr.onclick = e => { if (!e.target.closest("input, button")) select(r); };
      const add = (v, cls) => {
        const td = tr.insertCell();
        td.textContent = v;
        if (cls) td.className = cls;
        return td;
      };
      if (r.baseline) add(r.name);
      else tr.insertCell().appendChild(nameInput(r));
      add(r.n_crawl, "num");
      add(r.seed, "num");
      add(`${pct(r.accuracy)} ± ${(200 * r.accuracy_se).toFixed(1)}`, "num");
      add(r.mean_slices.toFixed(1), "num");
      add(r.median_slices, "num");
      add(r.p90_slices, "num");
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
      if (r.id === selectedId) renderRunInfo();
    };
    inp.onkeydown = e => { if (e.key === "Enter") inp.blur(); };
    return inp;
  }

  // ------------------------------------------------- the selected run
  // selects run r (or none): highlights its row, describes it and shows its
  // code above the replay, replays its first wrong crawl
  function select(r, scroll = true) {
    selectedId = r ? r.id : null;
    store.set("selected", selectedId);
    renderRuns();
    renderRunInfo();
    if (!r) {
      $("replay").innerHTML = '<p class="muted">Click a run above to replay ' +
        "its crawls with the hidden truth revealed.</p>";
      return;
    }
    replay(r.wrong && r.wrong.length ? r.wrong[0] : 0);
    if (scroll) $("replay-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderRunInfo() {
    const r = selected(), code = r && codeOf(r);
    $("run-info").hidden = !r;
    $("run-code").hidden = !code;
    updateReplayNav();
    if (!r) return;

    const host = $("run-info");
    host.replaceChildren();
    const title = document.createElement("div");
    title.className = "run-title";
    title.appendChild(Object.assign(document.createElement("b"),
      { textContent: r.name }));
    if (r.baseline) title.append(" (built-in baseline)");
    else if (r.name !== r.estimator) {
      title.append(" runs ");
      title.appendChild(Object.assign(document.createElement("code"),
        { textContent: r.estimator + "(crawl)" }));
    }
    const [v, cls] = verdict(r);
    title.append(" ", Object.assign(document.createElement("span"), {
      className: "badge " + cls,
      textContent: { yes: "clears 95%", no: "below 95%", maybe: "maybe 95%" }[v],
    }));
    const stats = document.createElement("div");
    stats.className = "muted";
    stats.textContent = `${r.n_crawl} crawls, seed ${r.seed}: ` +
      `${pct(r.accuracy)} ± ${(200 * r.accuracy_se).toFixed(1)} right, ` +
      `${r.mean_slices.toFixed(1)} slices on average (median ` +
      `${r.median_slices}, 90th pct ${r.p90_slices}). Ran ${stamp(r.when)}.`;
    host.append(title, stats);
    if (!code) {
      host.appendChild(Object.assign(document.createElement("div"), {
        className: "muted",
        textContent: "This run was saved before runs kept their code, so " +
          "it can't be replayed: run it again." }));
      $("replay").replaceChildren();
      return;
    }
    showCodeFile("main");
  }

  // the code panel: one file at a time (the main code, then its helpers)
  let shownFile = "main";
  function showCodeFile(file) {
    const code = codeOf(selected());
    shownFile = file;
    const files = [["main", "main code"],
                   ...Object.keys(code.helpers).map(f => [f, f])];
    const chips = $("code-files");
    chips.replaceChildren();
    chips.hidden = files.length < 2;
    for (const [f, label] of files) {
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
    a.download = shownFile === "main" ? (slug || "estimate") + ".py" : shownFile;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function openInEditor() {
    const r = selected(), code = codeOf(r);
    if (busy) return;
    const same = editor.value === code.main &&
      helperKey() === JSON.stringify(code.helpers);
    if (!same && !confirm(`Replace the editor's code and helper files with ` +
                          `the code of "${r.name}"?`)) return;
    editor.value = code.main;
    helpers = { ...code.helpers };
    store.set("code", editor.value);
    store.set("helpers", helpers);
    renderHelpers();
    $("run-name").value = r.baseline || r.name === r.estimator ? "" : r.name;
    await loadCode();
    const sel = $("estimator");
    if ([...sel.options].some(o => o.value === r.estimator)) {
      sel.value = r.estimator;
    }
    editor.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ------------------------------------------------------------- replay
  function updateReplayNav() {
    const r = selected();
    const ok = !!r && !!codeOf(r) && !busy && Py.ready;
    const anyWrong = ok && !!(r.wrong && r.wrong.length);
    $("prev-wrong").disabled = !anyWrong;
    $("next-wrong").disabled = !anyWrong;
    $("crawl-idx").disabled = !ok;
    if (r) $("crawl-idx").max = r.n_crawl - 1;
  }

  // the latest replay asked for runs once the worker is free; older asks
  // are dropped
  let wanted = null, pumping = false;
  function replay(idx) {
    const r = selected();
    if (!r || !codeOf(r)) return;
    idx = Math.min(Math.max(0, idx), r.n_crawl - 1);
    $("crawl-idx").value = idx;
    wanted = { r, idx };
    pumpReplay();
  }

  async function pumpReplay() {
    if (pumping) return;
    pumping = true;
    try {
      while (wanted && Py.ready && !busy) {
        const { r, idx } = wanted;
        wanted = null;
        await replayNow(r, idx);
      }
    } finally {
      pumping = false;
    }
  }

  async function replayNow(r, idx) {
    if (!(await ensureRunLoaded(r))) {
      $("replay").textContent = "This run's code no longer loads here.";
      return;
    }
    const setup = { n_shop: r.n_shop, family: r.family, race: r.race,
                    n_crawl: r.n_crawl, seed: r.seed };
    setBusy(true);
    let res;
    try {
      res = await Py.call("replay", { name: r.estimator, setup, idx });
    } catch (e) {
      setBusy(false);
      return;
    }
    setBusy(false);
    // another run was picked meanwhile: its own replay is on the way
    if (selected() !== r) return;
    if (!res.ok) {
      $("replay").textContent = res.error;
      return;
    }
    Replay.render($("replay"), res, idx);
  }

  function stepWrong(dir) {
    const r = selected();
    if (!r || !r.wrong || !r.wrong.length) return;
    const i = parseInt($("crawl-idx").value) || 0, w = r.wrong;
    replay(dir > 0 ? (w.find(k => k > i) ?? w[0])
                   : (w.findLast(k => k < i) ?? w[w.length - 1]));
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

  // the post dialog: the run being posted, while it's open
  let posting = null;

  function openPost(r) {
    posting = r;
    $("post-run").textContent = r.name;
    const saved = store.get("post", {});
    $("post-name").value = saved.name || "";
    $("post-code").value = saved.code || "";
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
        code, name, method: r.name, estimator: r.estimator,
        source: { ...r.code,
                  build: (typeof BUILD !== "undefined" && BUILD) ? BUILD.sha : null },
      });
    } catch (err) {
      postMsg("Not added: " + err.message, "error");
      $("post-submit").disabled = false;
      return;
    }
    $("post-dialog").close();
    runMsg(`Added "${r.name}" to the leaderboard: its score shows up ` +
           "there once we've re-run it.", "ok");
  }

  async function removeClicked() {
    if (!Board.enabled) return;
    if (!confirm("Remove your leaderboard entry (the one posted from this browser)?")) return;
    try {
      await Board.remove();
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
      const x = button("×", "Remove " + name, () => {
        delete helpers[name];
        store.set("helpers", helpers);
        renderHelpers();
        loadCode();
      });
      x.className = "x";
      chip.appendChild(x);
      host.appendChild(chip);
    }
  }

  // --------------------------------------------------------------- wiring
  Py.onStatus = (state, text) => {
    $("py-status").textContent = text;
    $("py-status").className = "pill " + state;
    setBusy(false);
    if (state === "ready") {
      loadCode().then(() => {
        if (selected()) replay(parseInt($("crawl-idx").value) || 0);
      });
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

  for (const id of ["n-crawl", "seed"]) $(id).addEventListener("change", saveForm);
  $("run-btn").onclick = runClicked;
  $("stop-btn").onclick = stop;
  $("base-btn").onclick = baselinesClicked;
  $("clear-btn").onclick = () => {
    if (!runs.length || !confirm("Clear every run in the table?")) return;
    runs = [];
    store.set("runs", runs);
    select(null);
  };
  $("crawl-idx").addEventListener("change", () =>
    replay(parseInt($("crawl-idx").value) || 0));
  $("prev-wrong").onclick = () => stepWrong(-1);
  $("next-wrong").onclick = () => stepWrong(1);
  $("copy-code").onclick = copyCode;
  $("download-code").onclick = downloadCode;
  $("open-code").onclick = openInEditor;

  $("post-form").onsubmit = submitPost;
  $("post-cancel").onclick = () => $("post-dialog").close();
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

  // runs saved before runs kept their setup were all official
  for (const r of runs) {
    r.n_shop = r.n_shop ?? 8;
    r.family = r.family ?? "bell";
    r.race = r.race ?? "official";
  }
  restoreForm();
  renderHelpers();
  renderHead();
  renderRuns();
  renderRunInfo();
  setMode(Object.keys(HASH).find(m => HASH[m] === location.hash) || "practice");
  Py.start();
})();

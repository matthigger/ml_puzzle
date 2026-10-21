// Board: the class leaderboard, stored in Supabase (see supabase/schema.sql),
// a database shared by every puzzle: this page's entries are CONFIG.project.
// The page calls three database functions over plain fetch, with the
// project's publishable key (safe to publish: it can only call those).
//
//   Board.enabled            false until js/config.js has a project
//   Board.list()             -> entries, best first
//   Board.post(entry)        add or replace this browser's entry
//   Board.remove()           delete this browser's entry
//   Board.render(tbody, entries)
//
// An entry belongs to a random token kept in this browser's localStorage;
// the database stores only its hash.

const Board = (function () {
  const enabled = !!(CONFIG.supabaseUrl && CONFIG.supabaseKey);
  const TOKEN_KEY = "slice_crawl.token";

  function token() {
    let t = null;
    try { t = localStorage.getItem(TOKEN_KEY); } catch (e) { /* private mode */ }
    if (!t) {
      const b = crypto.getRandomValues(new Uint8Array(32));
      t = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
      try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ }
    }
    return t;
  }

  async function rpc(fn, body) {
    const headers = { "Content-Type": "application/json",
                      apikey: CONFIG.supabaseKey };
    // a legacy anon key is a JWT and also goes in Authorization; a
    // publishable key (sb_publishable_...) must not
    if (CONFIG.supabaseKey.startsWith("eyJ")) {
      headers.Authorization = "Bearer " + CONFIG.supabaseKey;
    }
    const resp = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST", headers, body: JSON.stringify(body) });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : null;
    if (!resp.ok) throw new Error((data && data.message) || resp.statusText);
    return data;
  }

  const project = CONFIG.project;
  const list = () => rpc("leaderboard", { project, token: token() });
  const remove = () => rpc("delete_entry", { project, token: token() });
  const post = e => rpc("post_entry", { ...e, project, token: token() });

  const pct = v => (100 * v).toFixed(1) + "%";

  // entries arrive re-run scores first (best first), then the ones still
  // waiting; a failed re-run comes back only to its owner, with the reason
  function render(tbody, entries) {
    tbody.replaceChildren();
    let rank = 0, section = null;
    for (const e of entries) {
      const done = e.status === "done", clears = done && e.qualifies;
      const m = e.metrics || {};
      const sec = clears ? "top" : done ? "below" : "waiting";
      if (sec !== section && sec !== "top") {
        const tr = tbody.insertRow();
        tr.className = "gap";
        const td = tr.insertCell();
        td.colSpan = 8;
        td.textContent = sec === "below" ? "Not at 95% yet" : "Waiting for re-run";
      }
      section = sec;
      const tr = tbody.insertRow();
      if (e.mine) tr.className = "mine";
      const add = (v, cls) => {
        const td = tr.insertCell();
        td.textContent = v;
        if (cls) td.className = cls;
        return td;
      };
      add(clears ? ++rank : "", "num");
      add(e.name + (e.mine ? " (you)" : ""));
      add(e.method);
      if (done) {
        add(pct(m.accuracy), "num");
        add(m.mean_slices.toFixed(1), "num");
        add(m.median_slices, "num");
        add(m.p90_slices, "num");
      } else {
        const td = add(e.status === "failed"
          ? "Your re-run failed: " + (e.error || "").trim().split("\n").pop()
          : "re-running soon", "muted");
        td.colSpan = 4;
        if (e.error) td.title = e.error;
      }
      add(new Date(e.updated_at).toLocaleDateString("en-US",
        { month: "short", day: "numeric" }));
    }
  }

  return { enabled, list, post, remove, render };
})();

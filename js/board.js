// Board: the class leaderboard, stored in Supabase (see supabase/schema.sql).
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

  const list = () => rpc("leaderboard", { token: token() });
  const remove = () => rpc("delete_entry", { token: token() });
  const post = e => rpc("post_entry", { ...e, token: token() });

  const pct = v => (100 * v).toFixed(1) + "%";

  function render(tbody, entries) {
    tbody.replaceChildren();
    let rank = 0, shownGap = false;
    for (const e of entries) {
      const clears = e.accuracy >= 0.95;
      if (!clears && !shownGap) {
        shownGap = true;
        const tr = tbody.insertRow();
        tr.className = "gap";
        const td = tr.insertCell();
        td.colSpan = 8;
        td.textContent = "Not at 95% yet";
      }
      const tr = tbody.insertRow();
      if (e.mine) tr.className = "mine";
      const add = (v, cls) => {
        const td = tr.insertCell();
        td.textContent = v;
        if (cls) td.className = cls;
      };
      add(clears ? ++rank : "", "num");
      add(e.name + (e.mine ? " (you)" : ""));
      add(pct(e.accuracy), "num");
      add(e.mean_slices.toFixed(1), "num");
      add(e.median_slices, "num");
      add(e.p90_slices, "num");
      add(e.verified ? "✓ re-run" : "");
      add(new Date(e.updated_at).toLocaleDateString("en-US",
        { month: "short", day: "numeric" }));
    }
  }

  return { enabled, list, post, remove, render };
})();

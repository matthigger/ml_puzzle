// Board: the class leaderboard, stored in Supabase (see supabase/schema.sql),
// a database shared by every puzzle: this page's entries are those of
// PUZZLE.project (the puzzle's js/puzzle.js). The page calls three database
// functions over plain fetch, with the publishable key (safe to publish: it
// can only call those).
//
//   Board.enabled            false until shared/config.js has the keys
//   Board.list(code)         -> {title, open, entries}, entries best first
//   Board.post(entry)        add or replace this browser's entry (entry.code
//                            names the board)
//   Board.remove(code)       delete this browser's entry on that board
//   Board.render(tbody, entries)  -> true while this browser's entry
//                                 waits for (or is in) its re-run
//
// An entry belongs to a random token kept in this browser's localStorage;
// the database stores only its hash.

const Board = (function () {
  const enabled = !!(CONFIG.supabaseUrl && CONFIG.supabaseKey);
  const TOKEN_KEY = PUZZLE.project + ".token";

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

  const project = PUZZLE.project;
  // every board has its own code, needed to see it and to post to it
  const list = code => rpc("leaderboard", { project, code, token: token() });
  const remove = code => rpc("delete_entry", { project, code, token: token() });
  const post = e => rpc("post_entry", { ...e, project, token: token() });

  // a time in the viewer's own zone, the day only if it isn't today
  function when(t) {
    const d = new Date(t);
    const time = d.toLocaleTimeString("en-US",
      { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return time;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      ", " + time;
  }

  // an entry's status and when it got there, then (for the hover) every
  // step so far
  function progress(e) {
    const steps = ["posted " + when(e.updated_at)];
    if (e.started_at) steps.push("started " + when(e.started_at));
    const ended = { done: "scored", failed: "failed", overtime: "stopped" };
    if (ended[e.status]) {
      steps.push(ended[e.status] + " " + when(e.rerun_at || e.updated_at));
      return [steps[steps.length - 1], steps.join("\n")];
    }
    if (e.started_at) return ["running since " + when(e.started_at),
                              steps.join("\n")];
    return [steps[0], steps[0]];
  }

  // entries arrive re-run scores first (best first), then the ones still
  // waiting; a failed (or overtime) re-run comes back only to its owner,
  // with the reason
  function render(tbody, entries) {
    tbody.replaceChildren();
    // the board's width: #, Name, Method, the scores, Updated
    const nCol = tbody.parentNode.tHead.rows[0].cells.length;
    let rank = 0, section = null, mineWaiting = false;
    for (const e of entries) {
      const done = e.status === "done", clears = done && e.qualifies;
      const m = e.metrics || {};
      const sec = clears ? "top" : done ? "below" : "waiting";
      if (sec !== section && sec !== "top") {
        const tr = tbody.insertRow();
        tr.className = "gap";
        const td = tr.insertCell();
        td.colSpan = nCol;
        td.textContent = sec === "below" ? `Not at ${PUZZLE.bar} yet`
                                         : "Waiting for re-run";
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
        for (const v of PUZZLE.scores(m)) add(v, "num");
      } else {
        const why = (e.error || "").trim().split("\n").pop();
        const td = add(e.status === "failed" ? "Your re-run failed: " + why
          : e.status === "overtime" ? "Your re-run " + why
          : e.started_at ? "Re-running now" : "Waiting for a re-run", "muted");
        td.colSpan = nCol - 4;
        if (e.error) td.title = e.error;
      }
      const [now, steps] = progress(e);
      add(now, "when").title = steps;
      if (e.mine && e.status === "pending") mineWaiting = true;
    }
    return mineWaiting;
  }

  return { enabled, list, post, remove, render };
})();

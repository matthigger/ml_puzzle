// This puzzle's project in the shared database, and how its leaderboard
// reads (shared/board.js).
const PUZZLE = {
  project: "where_start",
  // every entry is ranked (by mean MSE), so the bar never shows
  bar: "MSE",
  // the board's score columns, from a re-run's metrics: the seed replays
  // it on the Practice tab. A column an entry's metrics lack shows blank,
  // so entries scored by an earlier version of the puzzle still show
  scores: m => {
    const f = (v, k) => typeof v === "number" ? v.toFixed(k) : "";
    return [f(m.mean_mse, 2), f(m.median_km, 2), f(m.p90_km, 2),
            m.n_bad ?? "", m.seed ?? ""];
  },
};

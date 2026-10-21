// This puzzle's project in the shared database, and how its leaderboard
// reads (shared/board.js).
const PUZZLE = {
  project: "where_start",
  // the bar an entry must clear to be ranked
  bar: "90%",
  // the board's four score columns, from a re-run's metrics
  scores: m => [(100 * m.hit_rate).toFixed(1) + "%", m.mean_km.toFixed(2),
                m.median_km.toFixed(2), m.p90_km.toFixed(2)],
};

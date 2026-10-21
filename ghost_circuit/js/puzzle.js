// This puzzle's project in the shared database, and how its leaderboard
// reads (shared/board.js).
const PUZZLE = {
  project: "ghost_circuit",
  // the bar an entry must clear to be ranked
  bar: "95%",
  // the board's four score columns, from a re-run's metrics
  scores: m => [(100 * m.accuracy).toFixed(1) + "%", Math.round(m.mean_off),
                Math.round(m.median_off), Math.round(m.p90_off)],
};

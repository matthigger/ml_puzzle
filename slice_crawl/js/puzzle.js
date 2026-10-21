// This puzzle's project in the shared database, and how its leaderboard
// reads (shared/board.js).
const PUZZLE = {
  project: "slice_crawl",
  // the bar an entry must clear to be ranked
  bar: "95%",
  // the board's four score columns, from a re-run's metrics
  scores: m => [(100 * m.accuracy).toFixed(1) + "%", m.mean_slices.toFixed(1),
                m.median_slices, m.p90_slices],
};

// This puzzle's project in the shared database, and how its leaderboard
// reads (shared/board.js).
const PUZZLE = {
  project: "ghost_circuit",
  // every entry is ranked (by F1), so the bar never shows
  bar: "F1",
  // the board's score columns, from a re-run's metrics: the seed replays
  // it on the Practice tab (older re-runs have none)
  scores: m => [m.f1.toFixed(3), (100 * m.tpr).toFixed(1) + "%",
                (100 * m.fpr).toFixed(2) + "%", m.mean_wrong.toFixed(1),
                m.seed ?? ""],
};

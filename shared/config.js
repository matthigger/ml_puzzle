// The site's puzzles, one tab each (shared/nav.js), and the leaderboard
// database they share (supabase/schema.sql). Both keys are meant to be
// public: the publishable key can only call the page's three functions.
// Leave them null to hide posting.
const CONFIG = {
  supabaseUrl: "https://cetqwosdemkmlmdrukoz.supabase.co",
  supabaseKey: "sb_publishable_E2U4Uu3G1chmV7b6UBcIzQ_7T4o9if6",
  repo: "https://github.com/matthigger/ml_puzzle",
  // id: the puzzle's folder, and its project in the database
  puzzles: [
    { id: "slice_crawl", title: "Slice Crawl" },
    { id: "where_start", title: "Where Did It Start?" },
    { id: "ghost_circuit", title: "Ghost on the Circuit" },
  ],
};

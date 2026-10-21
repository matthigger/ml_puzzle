// The leaderboard's database: shared by every puzzle site of this kind
// (slice_crawl's supabase/schema.sql); the publishable key can only call
// the page's three functions.
const CONFIG = {
  supabaseUrl: "https://cetqwosdemkmlmdrukoz.supabase.co",
  supabaseKey: "sb_publishable_E2U4Uu3G1chmV7b6UBcIzQ_7T4o9if6",
  // this puzzle's id in the shared database (private.projects)
  project: "ghost_circuit",
};

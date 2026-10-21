# slice_crawl

Practice site for the DS4400 **Slice Crawl** puzzle. Students paste their
code or open their `.py` / `.ipynb` (plus helper `.py` files), and the page
runs their `estimate(crawl)` on as many random crawls as they like:

- **Practice tab.** Pick an estimator (every top-level function that takes
  a crawl is listed), the official setup or a stress test (number of shops,
  rating shape, how close the race is), the number of crawls and a seed.
  Run shows a live progress bar, then a summary, a chart of fraction right
  (+/- 2 sd) against average slices with the 95% bar, and a table of every
  run (kept in the browser's localStorage). "Add baselines" runs taste each
  shop 5 / 20 / 40 times on the same crawls. Replay shows one crawl with the
  hidden truth revealed: each shop's typical rating and spread, how many
  slices the estimator tasted there, and when.
- **Leaderboard tab.** Run and post: the page runs `estimate` on 5000 fresh
  crawls of the official setup (random seed) and posts the score under a
  name the student picks. Posting needs the class code from the assignment.
  Posting again from the same browser replaces that entry.

Python runs in the browser with [Pyodide](https://pyodide.org) 314.0.7
(Python 3.14) in a module web worker, so a slow or endless estimator never
freezes the page: Stop terminates the worker and starts a fresh one.
numpy, scipy, matplotlib, ... load on first import. Plain HTML/CSS/JS
otherwise: no build step.

## The puzzle's code

`py/slice_crawl.py` is a copy of
`DS4400/problem_repo/puzz/puzz_slice_crawl/slice_crawl.py`, the file the
students get. After changing that one, copy it here so both run the same
crawls:

```sh
cp ~/Dropbox/teach/DS4400/problem_repo/puzz/puzz_slice_crawl/slice_crawl.py py/
```

`py/runner.py` is the site's side: load the student's code, list its
estimators, run them (same crawls as `evaluate()` for a given seed), replay
one crawl. Test it outside the browser with plain Python by importing it.

## Leaderboard setup (once)

The leaderboard is a free [Supabase](https://supabase.com) project; the page
calls three database functions and never touches a table.

1. Create a project. In the SQL editor, run `supabase/schema.sql`.
2. Set the class code (keep it out of this repo; put it in the assignment):

   ```sql
   insert into private.config (key, value) values ('class_code', '...')
   on conflict (key) do update set value = excluded.value;
   ```

3. Put the project URL and its **publishable** key (Project Settings, API
   Keys; `sb_publishable_...`) in `js/config.js`. Both are public by
   design: the key can only call the three functions. Never put the secret
   or service_role key here.

Moderating, in the Table Editor (schema `private`, table `entries`):
`hidden = true` takes an entry down; `verified = true` shows a check mark
once you've re-run its saved `source` (the student's code) yourself.
Changing the class code stops new posts with the old one; existing entries
stay.

What the class code does and doesn't do: it keeps strangers from posting,
not students from cheating. The score is computed in the student's browser,
so a determined student could post a made-up number or peek at the hidden
truth; that is why each entry keeps its code and seed for re-running, and
why the real competition re-runs everyone's `estimate()` on fresh crawls.

## Run locally

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

(Opening `index.html` as a file won't work: the worker needs http.)
`#practice` and `#leaderboard` link straight to a tab.

## Publish on GitHub Pages

Pages is built by `.github/workflows/pages.yml` on every push to `main`. It
stamps `js/version.js` with the commit and build time, which the footer
shows ("local copy" when run locally). One-time setup:

```sh
gh repo create matthigger/slice_crawl --public --source . --push
gh api -X POST repos/matthigger/slice_crawl/pages -f build_type=workflow
```

The site then lives at <https://matthigger.github.io/slice_crawl/>.

## Layout

| file | role |
|------|------|
| `index.html` | page, help text, controls |
| `style.css` | layout and chart styles (same look as the other demos) |
| `js/app.js` | editor and files, setup, runs table, replay and posting flow, tabs |
| `js/py.js` | the page's handle on the Python worker (call, stop) |
| `js/worker.js` | module web worker: Pyodide, runs `py/runner.py` |
| `js/chart.js` | fraction right against average slices |
| `js/replay.js` | one crawl, hidden truth revealed |
| `js/board.js` | leaderboard calls (Supabase RPC) and table |
| `js/config.js` | Supabase project URL and publishable key |
| `js/version.js` | build stamp, overwritten at deploy |
| `py/runner.py` | load / run / replay the student's code |
| `py/slice_crawl.py` | the puzzle's crawl simulator (copy, see above) |
| `supabase/schema.sql` | leaderboard tables and functions |
| `.github/workflows/pages.yml` | Pages deploy |

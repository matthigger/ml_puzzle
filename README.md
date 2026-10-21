# slice_crawl

Practice site for the DS4400 **Slice Crawl** puzzle. Students paste their
code or open their `.py` / `.ipynb` (plus helper `.py` files), and the page
runs their `estimate(crawl)` on as many random crawls as they like:

- **Practice tab.** Pick an estimator (every top-level function that takes
  a crawl is listed), optionally name the run, set the number of crawls
  (default 1000) and a seed; crawls are always the official setup. Run
  shows a live progress bar, then adds a row to the runs table (kept in the
  browser's localStorage, sortable by any column, timestamped). Each row
  keeps the code it ran. Clicking a row opens its post-mortem: its code
  read only (Copy, Download, or an explicit "Open in editor"), a sortable
  table with a row per crawl (right or wrong, shop named, best shop,
  slices, top-two gap, shortfall; "wrong crawls only" filters it), and,
  for the crawl clicked, a strip per shop, best first: the shop's true bell
  curve and typical rating with every slice tasted there stacked as a
  pizza slice, the estimator's average, and which shop it named. Per-crawl
  results are kept in localStorage, rebuilt by re-running when missing;
  replaying loads that run's code into Python without touching the
  editor. "Add to leaderboard" on a row posts its code (a
  popup asks for a name and the class code, and warns about the re-run).
  "Add baselines" runs taste each shop 5 / 20 / 40 times on the same
  crawls. No chart: plotting their runs is the students' job.
- **Leaderboard tab.** Read only. Every score on it is our own re-run
  (below), never a number the browser sent. Adding again from the same
  browser replaces that entry.

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

The page posts code, never a score. `verify/verify.py` re-runs each waiting
entry on 5000 crawls of the official setup with a seed drawn there and
never shown, and writes back the score the board displays. The student's
code runs in a Docker container (`verify/Dockerfile`) with no network, a
read-only disk, no secrets, 1 GB / 1 CPU and a 15 minute limit; the crawls
stay outside it and answer one taste at a time (`verify/child.py`), so the
hidden truth is out of reach. A GitHub Action (`verify.yml`) runs it every
10 minutes.

1. Create a free [Supabase](https://supabase.com) project. In the SQL
   editor, run `supabase/schema.sql`.
2. Set the class code (keep it out of this repo; put it in the assignment):

   ```sql
   insert into private.config (key, value) values ('class_code', '...')
   on conflict (key) do update set value = excluded.value;
   ```

3. Put the project URL and its **publishable** key (Project Settings, API
   Keys; `sb_publishable_...`) in `js/config.js`. Both are public by
   design: the key can only call the page's three functions.
4. Add repo secrets `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (a secret
   key, `sb_secret_...`, which can also call the re-run's two functions):

   ```sh
   gh secret set SUPABASE_URL
   gh secret set SUPABASE_SECRET_KEY
   ```

   Never put the secret key in `js/`. Without these secrets the Action does
   nothing.

Try the re-run on one file, no database (build the image first):

```sh
docker build -f verify/Dockerfile -t slice-crawl-verify .
python3 verify/verify.py --local my_code.py --helper helpers.py
```

The container has numpy, scipy, pandas, scikit-learn and matplotlib; code
that imports anything else Pyodide offers fails its re-run (the owner sees
why on the board). GitHub disables scheduled Actions after 60 days without
a push; "Run workflow" on the Actions tab re-runs by hand.

Moderating, in the Table Editor (schema `private`, table `entries`):
`hidden = true` takes an entry down; `status = 'pending'` re-runs it. Each
entry keeps its code (`source`) and the seed it was re-run on. Changing the
class code stops new posts with the old one; existing entries stay.

What's left to trust: a student can still post under someone else's name,
or post code they didn't write; the class code only keeps strangers out.

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
| `style.css` | layout, table and dialog styles (same look as the other demos) |
| `js/app.js` | editor and files, setup, runs table, replay and posting flow, tabs |
| `js/py.js` | the page's handle on the Python worker (call, stop) |
| `js/worker.js` | module web worker: Pyodide, runs `py/runner.py` |
| `js/postmortem.js` | a run's crawls table, and one crawl's plot with the hidden truth |
| `js/board.js` | leaderboard calls (Supabase RPC) and table |
| `js/config.js` | Supabase project URL and publishable key |
| `js/version.js` | build stamp, overwritten at deploy |
| `py/runner.py` | load / run / replay the student's code |
| `py/slice_crawl.py` | the puzzle's crawl simulator (copy, see above) |
| `supabase/schema.sql` | leaderboard tables and functions |
| `verify/verify.py` | re-run waiting entries, write back their scores |
| `verify/child.py` | the student's side of a re-run, in the container |
| `verify/Dockerfile` | the re-run container |
| `.github/workflows/pages.yml` | Pages deploy |
| `.github/workflows/verify.yml` | re-run every 10 minutes |

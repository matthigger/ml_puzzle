# Slice Crawl

A tab of [ML Puzzles](../README.md): `slice_crawl/` on the site.

Practice site for the DS4400 **Slice Crawl** puzzle. Students either type
their code in the page ("Type it here") or drop the `.py` / `.ipynb` files
they work on elsewhere, or a `.zip` of them ("Use my files": read-only
tabs, the main file is the one defining `estimate`, it can import the
others, same names replace on a re-drop), and the page
runs their `estimate(crawl)` on as many random crawls as they like:

- **Practice tab.** Pick an estimator (every top-level function that takes
  a crawl is listed), optionally name the run, set the number of crawls
  (default 1000) and a seed; crawls are always the official setup. Run
  shows a live progress bar, then adds a row to the runs table (kept in the
  browser's localStorage, sortable by any column, timestamped). Each row
  keeps the code it ran. Clicking a row opens its post-mortem: its code
  read only (Copy, Download, or an explicit "Open in editor"), a sortable
  table with a row per crawl (right or wrong, shop named, best shop,
  slices, top-two gap, shortfall; "wrong crawls only" filters it;
  "Download CSV" saves every crawl of the run, one row each), and,
  for the crawl clicked, a strip per shop, best first: the shop's true bell
  curve and typical rating with every slice tasted there stacked as a
  pizza slice, the estimator's average, and which shop it named. Per-crawl
  results are kept in localStorage, rebuilt by re-running when missing;
  replaying loads that run's code into Python without touching the
  editor. "Add to leaderboard" on a row posts its code (a
  popup asks for a name and the leaderboard code, and warns about the re-run).
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

## Leaderboard re-run

`verify/verify.py` re-runs each waiting entry on 2000 crawls of the official
setup with a fresh 53-bit seed, split over 4 Docker containers
(`verify/Dockerfile`: no network, read-only disk, no secrets, 1 GB / 1 CPU
each, 15 minutes in all). The board shows the seed once scored: the
Practice tab with that seed and 2000 crawls replays the re-run exactly. The
crawls stay outside them and answer one taste at a time (`verify/child.py`),
so the hidden truth is out of reach. Board: project `slice_crawl`, ranked
when at least 95% right, by fewest average slices.

Try it on one file, no database (from this folder):

```sh
docker build -f verify/Dockerfile -t slice-crawl-verify .
python3 verify/verify.py --local my_code.py --helper helpers.py
```

## Layout

| file | role |
|------|------|
| `index.html` | page, help text, controls |
| `puzzle.css` | its post-mortem plot styles |
| `js/puzzle.js` | its project id, bar and board columns |
| `js/app.js` | editor and files, runs table, post-mortem flow, CSV, posting, tabs |
| `js/worker.js` | module web worker: Pyodide, runs `py/runner.py` |
| `js/postmortem.js` | a run's crawls table, one crawl's plot with the hidden truth |
| `py/runner.py` | load / run / replay the student's code |
| `py/slice_crawl.py` | the crawl simulator (copy, see above) |
| `verify/verify.py` | re-run waiting entries, write back their scores |
| `verify/child.py` | the student's side of a re-run, in the container |
| `verify/Dockerfile` | the re-run container |

Shared with the other puzzles: `../shared/` (styles, Python worker handle,
leaderboard, config, site bar) and `../supabase/schema.sql`.

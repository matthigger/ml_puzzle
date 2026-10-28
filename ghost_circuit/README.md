# Ghost on the Circuit

A tab of [ML Puzzles](../README.md): `ghost_circuit/` on the site.

Practice site for the DS4400 **Ghost on the Circuit** puzzle
(`DS4400/problem_repo/puzz/puzz1/ghost_circuit`), built on the same frame as
`../slice_crawl`. Students type their code or drop their `.py` / `.ipynb`
files (or a `.zip`), and the page runs their `estimate(x, y)` on as many
random circuits as they like.

Each circuit (`GhostCircuit.sample`, the notebook's own generator): 150
devices logged on / off for 72 hours (`x`, (72, 150) int), 8 of them wired
to the metered circuit (20 to 1500 W), the meter's hourly watts (`y`,
(72,)) with 50 W of noise. The estimator returns the devices it names
(columns of `x`).

- **Per circuit:** found (named and on it, of 8) and wrong (named, not on
  it, of 142). TPR = found / 8, FPR = wrong / 142, F1 = 2 found / (named
  + 8), each averaged over circuits.
- **Leaderboard:** every entry ranked, by highest F1.

- **Practice tab.** Pick an estimator (every top-level function that takes
  `(x, y)` is listed), name the run, set the number of circuits (default
  200) and a seed (the same circuits as the notebook's
  `evaluate(estimate, seed=...)`). The runs table (localStorage, sortable,
  timestamped) keeps each run's code. Clicking a row opens its
  post-mortem: the code (Copy, Download, Use this code), a sortable table
  with a row per circuit (found, wrong, named, F1, biggest miss; "circuits
  with a wrong device" filters it), "Download results" (a CSV, below),
  and, for the circuit clicked, an interactive stack: the devices on the
  circuit or named, each switched on or off (at first as the estimate
  named them; more added by number). Every change refits least squares
  on the devices switched on plus an always-on load, in the page, and
  redraws F1 / TPR / FPR, the leftover (meter minus fit), each device's
  fitted watts ± 2 SE, and the stack: each hour's fitted watts split into
  the devices that were on, the meter as dots. "True watts" stacks the
  hidden watts instead (missed devices hatched). "Add baselines" runs the notebook's
  correlation guess, two top-8 rules (on minus off, least squares) and
  "every device". The baselines are naive on purpose: puzzle prompts name
  no tools.
- **Leaderboard tab.** Read only; every score is our own re-run.

**Download results** re-runs the run in the browser and saves
`ghost_circuit_<run>_seed<seed>.csv`, one row per circuit and device that
is on the circuit or named, the run's and circuit's columns repeated on
each row so runs concatenate: `puzzle, run, estimator, seed, circuit,
device, w, on_circuit, named, circuit_right, circuit_wrong,
circuit_named, circuit_f1`.

Python runs in the browser with [Pyodide](https://pyodide.org) 314.0.7
(Python 3.14, numpy, scikit-learn 1.8, scipy, pandas, ...) in a module web
worker; Stop kills a runaway estimator. No build step.

## The puzzle's code

`py/ghost_circuit.py` is a copy of the puzzle notebook's
`ghost_circuit.py`: keep the two identical. `py/runner.py` loads the
student's code, lists its estimators, checks and scores their answers
(TPR / FPR / F1), runs them, replays one circuit (with every device's
log, for the page's own fits) and builds the results CSV; it
imports outside the browser too.

## Leaderboard re-run

`verify/verify.py` re-runs each waiting entry on 2000 circuits with a secret
63-bit seed, in a Docker container (`verify/Dockerfile`: no network,
read-only disk, 1 GB / 1 CPU, 30 minutes). The container gets each
circuit's `x` and `y` only (`verify/child.py`), never which devices are on
it, and every reply is untrusted (bounded line, at most 150 device
numbers). Board: project `ghost_circuit`, every entry ranked, by highest
F1.

Try it on one file, no database (from this folder):

```sh
docker build -f verify/Dockerfile -t ghost-circuit-verify .
python3 verify/verify.py --local my_code.py --helper helpers.py
```

## Layout

| file | role |
|------|------|
| `index.html` | page, help text, controls |
| `puzzle.css` | its post-mortem stack styles |
| `js/puzzle.js` | its project id, bar and board columns |
| `js/app.js` | editor and files, runs table, post-mortem flow, CSV, posting, tabs |
| `js/worker.js` | module web worker: Pyodide, runs `py/runner.py` |
| `js/postmortem.js` | a run's circuits table, one circuit's interactive stack (least squares in JS) |
| `py/runner.py` | load / run / replay / results for the student's code; TPR / FPR / F1 |
| `py/ghost_circuit.py` | the notebook's circuit generator, `score()`, `evaluate()` |
| `verify/verify.py` | re-run waiting entries, write back their scores |
| `verify/child.py` | the student's side of a re-run, in the container |
| `verify/Dockerfile` | the re-run container |

Shared with the other puzzles: `../shared/` (styles, Python worker handle,
leaderboard, config, site bar) and `../supabase/schema.sql`.

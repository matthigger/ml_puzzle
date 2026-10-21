# Ghost on the Circuit

A tab of [ML Puzzles](../README.md): `ghost_circuit/` on the site.

Practice site for the DS4400 **Ghost on the Circuit** puzzle
(`DS4400/problem_repo/puzz/puzz_ghost_circuit`), built on the same frame as
`../slice_crawl`. Students type their code or drop their `.py` / `.ipynb`
files (or a `.zip`), and the page runs their `estimate(x, y)` on as many
random circuits as they like.

Each circuit: 150 devices logged on / off for 72 hours (`x`, (72, 150) int),
8 of them wired to the metered circuit, the meter's hourly watts (`y`,
(72,)) with about 50 W of noise. The estimator returns (150,) watts, 0 (or
under 1) for devices not on the circuit.

- **Right** (per circuit): every device drawing 100 W or more is named
  (estimate of at least 1 W) and no device off the circuit is. Smaller
  devices are lost in the noise: naming them is optional.
- **Watts off** (per circuit): the sum over all 150 devices of
  |estimate - truth|.
- **Leaderboard:** right on at least 95% of circuits, then fewest watts
  off on average.

- **Practice tab.** Pick an estimator (every top-level function that takes
  `(x, y)` is listed), name the run, set the number of circuits (default
  1000) and a seed. The runs table (localStorage, sortable, timestamped)
  keeps each run's code. Clicking a row opens its post-mortem: the code
  (Copy, Download, Use this code), a sortable table with a row per circuit
  (right or wrong, missed, false alarms, named, watts off, ghost error;
  "wrong circuits only" filters it), "Download results" (a CSV, below),
  and, for the circuit clicked, a row per device (true watts outlined, the
  estimate filled inside it; MISSED / FALSE ALARM / GHOST badges; "show
  every device" shows all 150) above the meter hour by hour with the true
  load, the estimate's fit and the hours the ghost was on. "Add baselines"
  runs least squares and two on-minus-off rules (all devices, top 8). The
  baselines and the example are naive on purpose: puzzle prompts name no
  tools.
- **Leaderboard tab.** Read only; every score is our own re-run.

**Download results** re-runs the run in the browser and saves
`ghost_circuit_<run>_seed<seed>.csv`, one row per circuit and device that
is on the circuit or got a nonzero estimate (every other device has w =
w_hat = 0), the run's columns repeated on each row so runs concatenate:
`puzzle, run, estimator, seed, circuit, device, w, w_hat, on_circuit, big,
named, ghost, circuit_right, missed, false_alarms, watts_off, base,
noise_sd`.

Python runs in the browser with [Pyodide](https://pyodide.org) 314.0.7
(Python 3.14, numpy, scikit-learn 1.8, scipy, pandas, ...) in a module web
worker; Stop kills a runaway estimator. No build step.

## The puzzle's code

`py/ghost_circuit.py` is the site's own circuit generator and scoring (the
puzzle notebook ships one fixed circuit as `meter.csv` / `devices.csv`);
`evaluate(estimate)` also works in a notebook. `py/runner.py` loads the
student's code, lists its estimators, runs them, replays one circuit and
builds the results CSV; it imports outside the browser too.

## Leaderboard re-run

`verify/verify.py` re-runs each waiting entry on 2000 circuits with a secret
63-bit seed, in a Docker container (`verify/Dockerfile`: no network,
read-only disk, 1 GB / 1 CPU, 30 minutes). The container gets each
circuit's `x` and `y` only (`verify/child.py`), never its watts, and every
reply is untrusted (bounded line, 150 finite numbers). Board: project
`ghost_circuit`, ranked when at least 95% right, by fewest average watts
off.

Try it on one file, no database (from this folder):

```sh
docker build -f verify/Dockerfile -t ghost-circuit-verify .
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
| `js/postmortem.js` | a run's circuits table, one circuit's plot |
| `py/runner.py` | load / run / replay / results for the student's code |
| `py/ghost_circuit.py` | circuit generator, scoring, `evaluate()` |
| `verify/verify.py` | re-run waiting entries, write back their scores |
| `verify/child.py` | the student's side of a re-run, in the container |
| `verify/Dockerfile` | the re-run container |

Shared with the other puzzles: `../shared/` (styles, Python worker handle,
leaderboard, config, site bar) and `../supabase/schema.sql`.

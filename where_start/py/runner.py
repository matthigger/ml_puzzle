"""Run a student's estimate() for the Earthquake practice site.

The page's web worker (js/worker.js) loads this module into Pyodide next to
earthquake.py (a verbatim copy of the puzzle's), then calls:

    load(source, helpers)       run the student's code, list its estimators
    unzip(data)                 the code files in an uploaded .zip
    run(name, setup, progress)  try one estimator on many quakes
    replay(name, setup, idx)    one quake in detail, hidden truth revealed

Each returns a JSON string, so the page gets plain objects back.

An estimator is estimate(x, t, speed) or estimate(x, t) -> (x, y): x (n, 2)
station positions (km), t (n,) delays since the quake started (s), speed
(km/s). A quake is scored by Earthquake.evaluate: the mean over both
coordinates of the squared error, km^2, half the squared miss distance.
"""
import ast
import contextlib
import inspect
import io
import json
import linecache
import math
import numbers
import os
import shutil
import sys
import time
import traceback
import types
import zipfile

import numpy as np

from earthquake import Earthquake

# folder holding the student's helper .py files (importable by name)
USER_DIR = '/home/pyodide/user'

# the graded setup: Earthquake's defaults, the ones the notebook names
OFFICIAL = dict(n=10, spacing=50.0, noise_sd=0.2)

# a miss this far off (km) counts as gone badly wrong
BAD_KM = 10.0

# printed output kept from loading the student's code
MAX_OUTPUT = 20_000

namespace = {}


def first_station(x, t, speed):
    """Guess the station that felt the quake first (the solution's
    baseline)."""
    return x[np.argmin(t)]


def stations_average(x, t, speed):
    """Guess the stations' average position (the notebook's starter)."""
    return x.mean(axis=0)


# built in, so they run with or without the student's code; names with
# spaces can't clash with the student's
BASELINES = {'first station': first_station,
             "stations' average": stations_average}


def sample(seed, idx, **setup):
    """Return quake idx of a seed.

    Seeded with [seed, idx], so every bit of seed counts (the re-run's
    secret seed has 53). The same quake in the notebook:
    Earthquake(seed=[seed, idx], **setup).

    Args:
        seed (int): which run of quakes
        idx (int): which quake of it
        **setup: Earthquake's n, spacing, noise_sd (OFFICIAL if omitted)
    """
    return Earthquake(**{**OFFICIAL, **setup}, seed=[seed, idx])


def check_estimate(est):
    """Return est as two floats (x, y), or raise if it isn't.

    Accepts shape (2,) or (1, 2), as Earthquake.evaluate does.

    Raises:
        TypeError: est isn't two numbers
        ValueError: one of them isn't finite
    """
    try:
        vals = [v.item() if hasattr(v, 'item') else v
                for v in np.asarray(est, dtype=object).ravel()]
    except Exception:
        vals = None
    if (vals is not None and len(vals) == 3
            and all(isinstance(v, numbers.Real) for v in vals)):
        raise TypeError(f'estimate returned {est!r:.80}: three numbers, but '
                        'the delays t count from the quake\'s start, so '
                        'return just the epicenter (x, y)')
    if (vals is None or len(vals) != 2
            or not all(isinstance(v, numbers.Real) for v in vals)):
        raise TypeError(f'estimate returned {est!r:.80}, not two numbers '
                        f'(x, y)')
    vals = [float(v) for v in vals]
    if not all(math.isfinite(v) for v in vals):
        raise ValueError(f'estimate returned {vals}: not all finite')
    return tuple(vals)


def score(est, quake):
    """Return (mse, miss_km) of an estimate on a quake.

    mse is quake.evaluate(est), km^2; the guess missed by sqrt(2 mse) km.
    """
    mse = quake.evaluate(est)
    return mse, math.sqrt(2 * mse)


def summarize(mse, miss):
    """Summarize a run's per-quake errors.

    Args:
        mse (np.array): (n_quake,) Earthquake.evaluate per quake, km^2
        miss (np.array): (n_quake,) miss distance per quake, km

    Returns:
        summary (dict): {mean_mse, mse_se, median_km, p90_km, n_bad}; mse_se
            is the standard error of mean_mse, n_bad the quakes missed by
            more than BAD_KM
    """
    se = float(mse.std(ddof=1) / math.sqrt(len(mse))) if len(mse) > 1 else 0.0
    return dict(mean_mse=float(mse.mean()), mse_se=se,
                median_km=float(np.median(miss)),
                p90_km=float(np.percentile(miss, 90)),
                n_bad=int(np.sum(miss > BAD_KM)))


def lookup(name):
    """Return the estimator called name: the student's, or a baseline."""
    return namespace[name] if name in namespace else BASELINES[name]


def notebook_source(text):
    """Return a .ipynb's code cells as text, minus shell (!) and magic (%)
    lines, which only work in Jupyter."""
    source = []
    for cell in json.loads(text)['cells']:
        if cell['cell_type'] != 'code':
            continue
        lines = ''.join(cell['source']).splitlines()
        if lines and lines[0].startswith('%%'):
            continue
        source += [line for line in lines
                   if not line.lstrip().startswith(('!', '%'))]
        source.append('')
    return '\n'.join(source)


def unzip(data):
    """Return the code files of an uploaded .zip.

    Args:
        data (bytes, or a JS Uint8Array in the browser): the .zip

    Returns:
        JSON {files, skipped}: files is {path: source} of its .py files and
            .ipynb files (as their code cells), paths relative to the zip's
            single top folder when it has one; skipped lists everything else
    """
    if hasattr(data, 'to_py'):
        data = data.to_py()
    junk = ('__MACOSX', '__pycache__', '.ipynb_checkpoints')
    with zipfile.ZipFile(io.BytesIO(bytes(data))) as zf:
        names = [n for n in zf.namelist() if not n.endswith('/')
                 and not any(j in n.split('/') for j in junk)
                 and not os.path.basename(n).startswith('.')]
        top = {n.split('/')[0] for n in names}
        strip = len(top) == 1 and all('/' in n for n in names)
        files, skipped = {}, []
        for n in names:
            rel = n.split('/', 1)[1] if strip else n
            text = zf.read(n).decode('utf-8', 'replace')
            if rel.endswith('.py'):
                files[rel] = text
            elif rel.endswith('.ipynb'):
                files[rel] = notebook_source(text)
            else:
                skipped.append(rel)
    return json.dumps(dict(files=files, skipped=skipped))


def user_error(exc, filename):
    """Return the error message, with traceback lines from the student's
    code only (not this file's or the site's)."""
    frames = [f for f in traceback.extract_tb(exc.__traceback__)
              if f.filename == filename or f.filename.startswith(USER_DIR)]
    lines = traceback.format_list(frames)
    return ''.join(lines) + ''.join(
        traceback.format_exception_only(type(exc), exc))


def not_estimators(source):
    """Return top-level names that aren't the student's estimators: those
    bound by imports, and loop variables (left holding their last value)."""
    names = set()
    for node in ast.parse(source).body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add((alias.asname or alias.name).split('.')[0])
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            names |= {n.id for n in ast.walk(node.target)
                      if isinstance(n, ast.Name)}
    return names


def binds(obj, n_arg):
    """Return True if obj can be called with n_arg positional arguments."""
    try:
        inspect.signature(obj).bind(*[None] * n_arg)
    except (TypeError, ValueError):
        return False
    return True


def takes_quake(obj):
    """Return True if obj can be called as obj(x, t, speed) or obj(x, t)."""
    if isinstance(obj, (type, types.ModuleType)) or not callable(obj):
        return False
    return binds(obj, 3) or binds(obj, 2)


def load(source, helpers):
    """Run the student's code in a fresh namespace.

    Args:
        source (str): the main code (a .py, or a .ipynb's code cells)
        helpers (str): JSON {path: source} of the other files, paths
            relative to the main file's folder (e.g. utils.py, lib/race.py)

    Returns:
        JSON {ok, names, output, error}: names are the estimators found,
            'estimate' first if there is one
    """
    global namespace
    helpers = json.loads(helpers)

    # forget the last load's helper modules, write this load's
    for name, mod in list(sys.modules.items()):
        if (getattr(mod, '__file__', None) or '').startswith(USER_DIR):
            del sys.modules[name]
    os.chdir(os.path.dirname(USER_DIR))  # can't remove the cwd
    shutil.rmtree(USER_DIR, ignore_errors=True)
    os.makedirs(USER_DIR)
    for name, text in helpers.items():
        rel = os.path.normpath(name)
        if os.path.isabs(rel) or rel.startswith('..'):
            continue
        path = os.path.join(USER_DIR, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(text)
    if USER_DIR not in sys.path:
        sys.path.insert(0, USER_DIR)
    os.chdir(USER_DIR)
    os.environ['MPLBACKEND'] = 'Agg'

    namespace = {'__name__': '__main__', 'display': print}
    out = io.StringIO()
    error = None
    # lets tracebacks quote the line of the student's code that failed
    linecache.cache['your code'] = (len(source), None,
                                    source.splitlines(True), 'your code')
    try:
        code = compile(source, 'your code', 'exec')
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(code, namespace)
    except BaseException as exc:  # SyntaxError, SystemExit, ... all shown
        error = user_error(exc, 'your code')
        if isinstance(exc, SyntaxError):
            error = ''.join(traceback.format_exception_only(type(exc), exc))

    try:
        skip = not_estimators(source)
    except SyntaxError:
        skip = set()
    skip.add('display')
    names = [name for name, obj in namespace.items()
             if not name.startswith('_') and name not in skip
             and takes_quake(obj)]
    if 'estimate' in names:
        names.remove('estimate')
        names.insert(0, 'estimate')

    output = out.getvalue()
    if len(output) > MAX_OUTPUT:
        output = output[:MAX_OUTPUT] + '\n... (output cut short)'
    return json.dumps(dict(ok=error is None, names=names, output=output,
                           error=error))


def setup_of(setup):
    """Return the quake setup's sample() keywords from the page's setup."""
    return {k: setup[k] for k in OFFICIAL if k in setup}


def call(estimate, quake, idx):
    """Run estimate on one quake; return its (x, y).

    Called as estimate(x, t, speed) when it takes three arguments, else
    estimate(x, t). The estimator gets copies, so editing them in place
    changes nothing.

    Raises:
        RuntimeError: says which quake went wrong and how
    """
    args = [quake.x.copy(), quake.t.copy()]
    if binds(estimate, 3):
        args.append(quake.speed)
    try:
        return check_estimate(estimate(*args))
    except Exception as exc:
        raise RuntimeError(f'quake {idx}: ' + user_error(exc, 'your code'))


def residual(quake, est):
    """Return predicted minus recorded delay at each station, s.

    Returns:
        r (np.array): (n,) ||est - x_i|| / speed - t_i
    """
    dist = np.linalg.norm(quake.x - np.asarray(est), axis=1)
    return dist / quake.speed - quake.t


def run(name, setup, progress=None, every=100):
    """Run estimator name on setup['n_quake'] quakes.

    Args:
        name (str): an estimator listed by load(), or a key of BASELINES
        setup (str): JSON {n_quake, seed, n?, spacing?, noise_sd?}
        progress (Callable): progress(done, n_quake, total_mse, n_bad), if
            given, is called every few quakes
        every (int): quakes between progress calls

    Returns:
        JSON {ok, error} plus, when ok: summarize()'s keys, seconds, and per
            quake (n_quake,) lists: true_x, true_y (epicenter), est_x, est_y
            (estimate), miss_km, mse (km^2), max_resid (largest |predicted
            - recorded delay| at the estimate, s)
    """
    setup = json.loads(setup)
    estimate = lookup(name)
    n_quake, seed = setup['n_quake'], setup['seed']
    keys = ('true_x', 'true_y', 'est_x', 'est_y', 'miss_km', 'mse',
            'max_resid')
    out = {k: [] for k in keys}
    total, n_bad = 0.0, 0
    start = time.perf_counter()
    try:
        for idx in range(n_quake):
            q = sample(seed, idx, **setup_of(setup))
            est = call(estimate, q, idx)
            mse, miss = score(est, q)
            vals = (*q._y[0], *est, miss, mse,
                    float(np.abs(residual(q, est)).max()))
            for k, v in zip(keys, vals):
                out[k].append(float(v))
            total += mse
            n_bad += miss > BAD_KM
            if progress is not None and (idx + 1) % every == 0:
                progress(idx + 1, n_quake, total, n_bad)
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))

    return json.dumps(dict(
        ok=True, error=None,
        **summarize(np.array(out['mse']), np.array(out['miss_km'])),
        seconds=time.perf_counter() - start, **out))


def replay(name, setup, idx):
    """Return quake idx of a setup in detail, hidden truth revealed.

    Returns:
        JSON {ok, error} plus, when ok: x (n, 2) stations, t (n,) delays,
            speed, noise_sd, y (2,) epicenter (truth), est (2,), resid (n,)
            predicted minus recorded delay at est, s
    """
    setup = json.loads(setup)
    q = sample(setup['seed'], idx, **setup_of(setup))
    try:
        est = call(lookup(name), q, idx)
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))
    return json.dumps(dict(
        ok=True, error=None, x=q.x.tolist(), t=q.t.tolist(), speed=q.speed,
        noise_sd=q.noise_sd, y=q._y[0].tolist(), est=est,
        resid=residual(q, est).tolist()))

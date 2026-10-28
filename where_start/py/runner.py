"""Run a student's estimate() for the Where Did It Start practice site.

The page's web worker (js/worker.js) loads this module into Pyodide next to
where_start.py, then calls:

    load(source, helpers)       run the student's code, list its estimators
    unzip(data)                 the code files in an uploaded .zip
    run(name, setup, progress)  try one estimator on many quakes
    replay(name, setup, idx)    one quake in detail, hidden truth revealed

Each returns a JSON string, so the page gets plain objects back.
"""
import ast
import contextlib
import inspect
import io
import json
import linecache
import math
import os
import shutil
import sys
import time
import traceback
import types
import zipfile

import numpy as np

import where_start
from where_start import HIT_KM, check_estimate, sample

# folder holding the student's helper .py files (importable by name)
USER_DIR = '/home/pyodide/user'

# while the student's code loads, its own evaluate() calls run only this
# many quakes (the page runs the real test)
LOAD_QUAKES = 20

# printed output kept from loading the student's code
MAX_OUTPUT = 20_000

namespace = {}


def first_to_hear(stations, arrivals):
    """Guess the station that heard the quake first, at its arrival time."""
    i = int(np.argmin(arrivals))
    return stations[i, 0], stations[i, 1], arrivals[i]


def first_three(stations, arrivals):
    """Guess the middle of the three stations that heard it first."""
    idx = np.argsort(arrivals)[:3]
    x, y = stations[idx].mean(axis=0)
    return x, y, arrivals[idx[0]]


# built in, so they run with or without the student's code; names with
# spaces can't clash with the student's
BASELINES = {'first to hear it': first_to_hear, 'first three': first_three}


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


def takes_quake(obj):
    """Return True if obj can be called as obj(stations, arrivals)."""
    if isinstance(obj, (type, types.ModuleType)) or not callable(obj):
        return False
    try:
        inspect.signature(obj).bind(None, None)
    except (TypeError, ValueError):
        return False
    return True


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

    def quick_evaluate(estimate, n_quake=1000, *args, **kwargs):
        return evaluate(estimate, min(n_quake, LOAD_QUAKES), *args, **kwargs)

    evaluate = where_start.evaluate
    namespace = {'__name__': '__main__', 'display': print}
    out = io.StringIO()
    error = None
    where_start.evaluate = quick_evaluate
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
    finally:
        where_start.evaluate = evaluate

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
    return dict(n_station=setup.get('n_station', 12))


def call(estimate, quake, idx):
    """Run estimate on one quake; return its (x, y, t0).

    The estimator gets copies, so editing them in place changes nothing.

    Raises:
        RuntimeError: says which quake went wrong and how
    """
    try:
        return check_estimate(estimate(quake.stations.copy(),
                                       quake.arrivals.copy()))
    except Exception as exc:
        raise RuntimeError(f'quake {idx}: ' + user_error(exc, 'your code'))


def run(name, setup, progress=None, every=100):
    """Run estimator name on setup['n_quake'] quakes.

    Args:
        name (str): an estimator listed by load(), or a key of BASELINES
        setup (str): JSON {n_quake, seed, n_station?}
        progress (Callable): progress(done, n_quake, n_hit, total_km), if
            given, is called every few quakes
        every (int): quakes between progress calls

    Returns:
        JSON {ok, error} plus, when ok: hit_rate, hit_se, mean_km,
            median_km, p90_km, seconds, and per quake (n_quake,) lists:
            x, y, t0 (truth), x_hat, y_hat, t0_hat (estimate), error_km
            (||p_hat - p||), t0_error (t0_hat - t0), noise_sd (timing
            noise sd, s), max_resid (largest |predicted - recorded
            arrival| at the estimate, s)
    """
    setup = json.loads(setup)
    estimate = lookup(name)
    n_quake, seed = setup['n_quake'], setup['seed']
    keys = ('x', 'y', 't0', 'x_hat', 'y_hat', 't0_hat', 'error_km',
            't0_error', 'noise_sd', 'max_resid')
    out = {k: [] for k in keys}
    n_hit, total = 0, 0.0
    start = time.perf_counter()
    try:
        for idx in range(n_quake):
            q = sample(seed, idx, **setup_of(setup))
            est = call(estimate, q, idx)
            err = math.dist(est[:2], q._p)
            vals = (*q._p, q._t0, *est, err, est[2] - q._t0, q._noise_sd,
                    float(np.abs(q.residual(est)).max()))
            for k, v in zip(keys, vals):
                out[k].append(float(v))
            n_hit += err <= HIT_KM
            total += err
            if progress is not None and (idx + 1) % every == 0:
                progress(idx + 1, n_quake, n_hit, total)
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))

    err = np.array(out['error_km'])
    hit = n_hit / n_quake
    return json.dumps(dict(
        ok=True, error=None, hit_rate=hit,
        hit_se=math.sqrt(hit * (1 - hit) / n_quake),
        mean_km=float(err.mean()), median_km=float(np.median(err)),
        p90_km=float(np.percentile(err, 90)),
        seconds=time.perf_counter() - start, **out))


def replay(name, setup, idx):
    """Return quake idx of a setup in detail, hidden truth revealed.

    Returns:
        JSON {ok, error} plus, when ok: stations (n_station, 2), arrivals
            (n_station,), p (2,) and t0 (truth), noise_sd, est (x, y, t0),
            resid (n_station,) predicted minus recorded arrival at est, s
    """
    setup = json.loads(setup)
    q = sample(setup['seed'], idx, **setup_of(setup))
    try:
        est = call(lookup(name), q, idx)
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))
    return json.dumps(dict(
        ok=True, error=None, stations=q.stations.tolist(),
        arrivals=q.arrivals.tolist(), p=q._p.tolist(), t0=q._t0,
        noise_sd=q._noise_sd, est=est,
        resid=q.residual(est).tolist()))

""" Run a student's estimate() for the Ghost on the Circuit practice site.

The page's web worker (js/worker.js) loads this module into Pyodide next to
ghost_circuit.py, then calls:

    load(source, helpers)       run the student's code, list its estimators
    unzip(data)                 the code files in an uploaded .zip
    run(name, setup, progress)  try one estimator on many circuits
    replay(name, setup, idx)    one circuit in detail, hidden truth revealed
    results(name, setup, run)   every circuit's devices, as CSV

Each returns a JSON string, so the page gets plain objects back.
"""
import ast
import contextlib
import csv
import inspect
import io
import json
import linecache
import os
import shutil
import sys
import time
import traceback
import types
import zipfile

import numpy as np

import ghost_circuit
from ghost_circuit import NAMED_W, Circuit, check_watts, score, summarize

# folder holding the student's helper .py files (importable by name)
USER_DIR = '/home/pyodide/user'

# while the student's code loads, its own evaluate() calls run only this
# many circuits (the page runs the real test)
LOAD_CIRCUITS = 20

# printed output kept from loading the student's code
MAX_OUTPUT = 20_000

namespace = {}


def least_squares(x, y):
    """ Baseline: the least-squares fit (with an always-on term) of the
    meter on every device; with more devices than hours, the smallest of
    the many perfect fits. """
    a = np.column_stack([x, np.ones(len(y))])
    return np.linalg.lstsq(a, y, rcond=None)[0][:-1]


def on_minus_off(top=None):
    """ Baseline: each device's average meter when on minus when off; with
    top, only the top biggest gaps are kept (the rest are 0). """
    def estimate(x, y):
        gap = np.zeros(x.shape[1])
        for j in range(x.shape[1]):
            on = x[:, j] == 1
            if on.any() and (~on).any():
                gap[j] = y[on].mean() - y[~on].mean()
        if top is not None:
            gap[np.argsort(gap)[:-top]] = 0
        return gap

    return estimate


# built in, so they run with or without the student's code; names with
# spaces can't clash with the student's
BASELINES = {'least squares': least_squares,
             'on minus off': on_minus_off(),
             'on minus off, top 8': on_minus_off(8)}


def lookup(name):
    """ Return the estimator called name: the student's, or a baseline. """
    return namespace[name] if name in namespace else BASELINES[name]


def notebook_source(text):
    """ Return the code cells of a .ipynb (as text), minus shell (!) and
    magic (%) lines, which only work in Jupyter. """
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
    """ Return the code files of an uploaded .zip.

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
    """ Return the error message, with traceback lines from the student's
    code only (not this file's or the site's). """
    frames = [f for f in traceback.extract_tb(exc.__traceback__)
              if f.filename == filename or f.filename.startswith(USER_DIR)]
    lines = traceback.format_list(frames)
    return ''.join(lines) + ''.join(
        traceback.format_exception_only(type(exc), exc))


def not_estimators(source):
    """ Return top-level names that aren't the student's estimators: those
    bound by import statements, and loop variables (left holding their last
    value). """
    names = set()
    for node in ast.parse(source).body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add((alias.asname or alias.name).split('.')[0])
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            names |= {n.id for n in ast.walk(node.target)
                      if isinstance(n, ast.Name)}
    return names


def takes_data(obj):
    """ Return True if obj can be called with two arguments (x, y). """
    if isinstance(obj, (type, types.ModuleType)) or not callable(obj):
        return False
    try:
        inspect.signature(obj).bind(None, None)
    except (TypeError, ValueError):
        return False
    return True


def load(source, helpers):
    """ Run the student's code in a fresh namespace.

    Args:
        source (str): the main code (a .py, or a .ipynb's code cells)
        helpers (str): JSON {path: source} of the other files, paths
            relative to the main file's folder (e.g. utils.py, lib/fit.py)

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
    # can't remove the cwd
    os.chdir(os.path.dirname(USER_DIR))
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

    def quick_evaluate(estimate, n_circuit=1000, *args, **kwargs):
        return evaluate(estimate, min(n_circuit, LOAD_CIRCUITS), *args,
                        **kwargs)

    evaluate = ghost_circuit.evaluate
    namespace = {'__name__': '__main__', 'display': print}
    out = io.StringIO()
    error = None
    ghost_circuit.evaluate = quick_evaluate
    # lets tracebacks quote the line of the student's code that failed
    linecache.cache['your code'] = (len(source), None,
                                    source.splitlines(True), 'your code')
    try:
        code = compile(source, 'your code', 'exec')
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(code, namespace)
    # SyntaxError, SystemExit, ...: all shown
    except BaseException as exc:
        error = user_error(exc, 'your code')
        if isinstance(exc, SyntaxError):
            error = ''.join(traceback.format_exception_only(type(exc), exc))
    finally:
        ghost_circuit.evaluate = evaluate

    try:
        skip = not_estimators(source)
    except SyntaxError:
        skip = set()
    skip.add('display')
    names = [name for name, obj in namespace.items()
             if not name.startswith('_') and name not in skip
             and takes_data(obj)]
    if 'estimate' in names:
        names.remove('estimate')
        names.insert(0, 'estimate')

    output = out.getvalue()
    if len(output) > MAX_OUTPUT:
        output = output[:MAX_OUTPUT] + '\n... (output cut short)'
    return json.dumps(dict(ok=error is None, names=names, output=output,
                           error=error))


def sample(setup, seed, idx):
    """ Return circuit idx of a setup: the same circuits evaluate() uses. """
    keys = ('n_hour', 'n_device', 'n_on', 'noise_sd')
    return Circuit.sample(**{k: setup[k] for k in keys},
                          seed=seed * 1_000_003 + idx)


def call(estimate, circuit, idx):
    """ Run estimate on one circuit (on copies of its data).

    Returns:
        w_hat (np.array): (n_device,) estimated watts

    Raises:
        RuntimeError: says which circuit went wrong and how
    """
    try:
        return check_watts(estimate(circuit.x.copy(), circuit.y.copy()),
                           circuit.n_device)
    except Exception as exc:
        raise RuntimeError(f'circuit {idx}: ' + user_error(exc, 'your code'))


def run(name, setup, progress=None, every=10):
    """ Run estimator name on setup['n_circuit'] circuits.

    Args:
        name (str): an estimator listed by load(), or a key of BASELINES
        setup (str): JSON {n_hour, n_device, n_on, noise_sd, n_circuit,
            seed}
        progress (callable): progress(done, n_circuit, n_right, watts_off),
            if given, is called every few circuits
        every (int): circuits between progress calls

    Returns:
        JSON {ok, error} plus, when ok: accuracy, accuracy_se, mean_off,
            median_off, p90_off, seconds, and one entry per circuit in each
            of the lists correct, missed, false_alarms, named, watts_off,
            ghost_err (see ghost_circuit.score)
    """
    setup = json.loads(setup)
    estimate = lookup(name)
    n_circuit, seed = setup['n_circuit'], setup['seed']
    keys = ('correct', 'missed', 'false_alarms', 'named', 'watts_off',
            'ghost_err')
    out = {k: [] for k in keys}
    start = time.perf_counter()
    try:
        for idx in range(n_circuit):
            circuit = sample(setup, seed, idx)
            s = score(call(estimate, circuit, idx), circuit)
            for k in keys:
                out[k].append(s[k])
            if progress is not None and (idx + 1) % every == 0:
                progress(idx + 1, n_circuit, sum(out['correct']),
                         sum(out['watts_off']))
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))

    return json.dumps(dict(ok=True, error=None,
                           seconds=time.perf_counter() - start,
                           **summarize(out['correct'], out['watts_off']),
                           **out))


def replay(name, setup, idx):
    """ Return circuit idx of a setup, with the hidden truth revealed.

    Returns:
        JSON {ok, error} plus, when ok: w, w_hat ((n_device,) true and
            estimated watts), y ((n_hour,) the meter), load ((n_hour,) the
            meter without its noise), fit ((n_hour,) x @ w_hat + b_hat),
            b_hat (the best always-on load for w_hat), base, noise_sd,
            ghost, ghost_on ((n_hour,) 0 / 1), and score()'s fields
    """
    setup = json.loads(setup)
    circuit = sample(setup, setup['seed'], idx)
    try:
        w_hat = call(lookup(name), circuit, idx)
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))
    x, y, w = circuit.x, circuit.y, circuit._watts
    b_hat = float(np.mean(y - x @ w_hat))
    g = circuit._ghost
    return json.dumps(dict(
        ok=True, error=None, w=w.tolist(), w_hat=w_hat.tolist(),
        y=y.tolist(), load=(x @ w + circuit._base).tolist(),
        fit=(x @ w_hat + b_hat).tolist(), b_hat=b_hat, base=circuit._base,
        noise_sd=circuit._noise_sd, ghost_on=x[:, g].tolist(),
        **score(w_hat, circuit)))


def results(name, setup, run_name, progress=None, every=10):
    """ Return every circuit of a run as CSV, one row per device that is
    on the circuit or got a nonzero estimate (the rest have w = w_hat = 0),
    the run's columns repeated on each row.

    CSV columns: puzzle, run, estimator, seed, circuit, device, w, w_hat,
    on_circuit, big, named, ghost, circuit_right, missed, false_alarms,
    watts_off, base, noise_sd.

    Args:
        name (str): the estimator, as for run()
        setup (str): JSON, as for run()
        run_name (str): the run's name in the page's table
        progress (callable): progress(done, n_circuit), every few circuits

    Returns:
        JSON {ok, error, csv}
    """
    setup = json.loads(setup)
    estimate = lookup(name)
    n_circuit, seed = setup['n_circuit'], setup['seed']
    out = io.StringIO()
    rows = csv.writer(out, lineterminator='\n')
    rows.writerow(['puzzle', 'run', 'estimator', 'seed', 'circuit',
                   'device', 'w', 'w_hat', 'on_circuit', 'big', 'named',
                   'ghost', 'circuit_right', 'missed', 'false_alarms',
                   'watts_off', 'base', 'noise_sd'])
    try:
        for idx in range(n_circuit):
            circuit = sample(setup, seed, idx)
            w_hat = call(estimate, circuit, idx)
            s, w = score(w_hat, circuit), circuit._watts
            for j in np.flatnonzero((w != 0) | (w_hat != 0)):
                rows.writerow([
                    'ghost_circuit', run_name, name, seed, idx, int(j),
                    round(float(w[j]), 2), round(float(w_hat[j]), 2),
                    int(w[j] > 0), int(w[j] >= ghost_circuit.BIG_W),
                    int(w_hat[j] >= NAMED_W), int(j == s['ghost']),
                    int(s['correct']), s['missed'], s['false_alarms'],
                    round(s['watts_off'], 2), round(circuit._base, 2),
                    circuit._noise_sd])
            if progress is not None and (idx + 1) % every == 0:
                progress(idx + 1, n_circuit)
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))
    return json.dumps(dict(ok=True, error=None, csv=out.getvalue()))

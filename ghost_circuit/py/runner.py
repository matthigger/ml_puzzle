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

import math

import numpy as np

import ghost_circuit
from ghost_circuit import OFFICIAL, GhostCircuit

# folder holding the student's helper .py files (importable by name)
USER_DIR = '/home/pyodide/user'

# while the student's code loads, its own evaluate() calls run only this
# many circuits (the page runs the real test)
LOAD_CIRCUITS = 20

# printed output kept from loading the student's code
MAX_OUTPUT = 20_000

# devices on each circuit and off it: the denominators of TPR and FPR
N_ON = OFFICIAL['n_on']
N_OFF = OFFICIAL['n_dev'] - N_ON

namespace = {}


def correlated(x, y):
    """ Baseline (the puzzle notebook's): every device whose on / off
    pattern correlates with the meter. """
    r = np.array([np.corrcoef(x[:, i], y)[0, 1] for i in range(x.shape[1])])
    return np.flatnonzero(r > .2)


def on_minus_off_top8(x, y):
    """ Baseline: the 8 devices with the biggest gap between the average
    meter when on and when off. """
    gap = np.zeros(x.shape[1])
    for j in range(x.shape[1]):
        on = x[:, j] == 1
        if on.any() and (~on).any():
            gap[j] = y[on].mean() - y[~on].mean()
    return np.argsort(gap)[-8:]


def least_squares_top8(x, y):
    """ Baseline: the 8 devices given the most watts by least squares
    (with an always-on term); with more devices than hours, the smallest of
    its many perfect fits. """
    a = np.column_stack([x, np.ones(len(y))])
    return np.argsort(np.linalg.lstsq(a, y, rcond=None)[0][:-1])[-8:]


def every_device(x, y):
    """ Baseline: name all of them (TPR 100%, and FPR 100%). """
    return np.arange(x.shape[1])


# built in, so they run with or without the student's code; names with
# spaces can't clash with the student's
BASELINES = {'correlation > 0.2': correlated,
             'on minus off, top 8': on_minus_off_top8,
             'least squares, top 8': least_squares_top8,
             'every device': every_device}


def check_guess(guess, n_dev):
    """ Return the devices an estimate names, or raise if it isn't a list
    of device numbers.

    Args:
        guess: what estimate returned
        n_dev (int): devices on the circuit's log, numbered 0 .. n_dev - 1

    Returns:
        named (np.array): (n_named,) int, sorted, each device once
    """
    if isinstance(guess, (set, frozenset, dict)):
        guess = sorted(guess)
    try:
        g = np.asarray(guess).ravel()
    except (TypeError, ValueError):
        g = np.array([None])
    if g.dtype == bool or (g.size == n_dev and np.isin(g, (0, 1)).all()):
        raise ValueError(f'estimate returned {g.size} True / False (or 0 / '
                         '1) values: return the column numbers of the '
                         'devices you name instead, e.g. '
                         'np.flatnonzero(keep)')
    if g.size and g.dtype.kind not in 'iuf':
        raise TypeError(f'estimate returned {type(guess).__name__}, not a '
                        'list of device numbers (columns of x)')
    if g.dtype.kind == 'f' and not np.all(np.isfinite(g)
                                          & (g == np.round(g))):
        raise ValueError('estimate returned numbers that are not whole: '
                         'return device numbers (columns of x), not watts')
    bad = g[(g < 0) | (g >= n_dev)]
    if bad.size:
        raise ValueError(f'estimate named device {int(bad[0])}: devices '
                         f'are 0 to {n_dev - 1}')
    return np.unique(g.astype(int))


def score(named, circuit):
    """ How one estimate did on one circuit.

    Args:
        named (np.array): (n_named,) int, from check_guess
        circuit (GhostCircuit): hidden truth included

    Returns:
        result (dict): right / wrong / missed / exact (GhostCircuit.score),
            n_named, f1 (2 right / (n_named + n_on)), missed_w (watts of
            the biggest device missed, 0 if none)
    """
    s = circuit.score(named)
    w = circuit._watts.copy()
    w[named] = 0
    return dict(s, n_named=len(named), f1=f1(s['right'], s['wrong']),
                missed_w=float(w.max()))


def f1(right, wrong):
    """ Return F1 on one circuit: 2 right / (named + N_ON), the harmonic
    mean of precision and TPR (0 when nothing right is named). """
    return 2 * right / (right + wrong + N_ON)


def summarize(right, wrong):
    """ The run's summary: F1, TPR and FPR averaged over its circuits.

    Args:
        right (list): int per circuit, devices named that are on it
        wrong (list): int per circuit, devices named that aren't

    Returns:
        result (dict): f1, tpr, fpr, their standard errors f1_se, tpr_se,
            fpr_se, and mean_right, mean_wrong (devices per circuit)
    """
    tpr = np.asarray(right) / N_ON
    fpr = np.asarray(wrong) / N_OFF
    f = f1(np.asarray(right), np.asarray(wrong))
    n = len(tpr)

    def se(v):
        return float(v.std(ddof=1) / math.sqrt(n)) if n > 1 else 0.

    return dict(f1=float(f.mean()), f1_se=se(f),
                tpr=float(tpr.mean()), tpr_se=se(tpr), fpr=float(fpr.mean()),
                fpr_se=se(fpr), mean_right=float(np.mean(right)),
                mean_wrong=float(np.mean(wrong)))


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

    def quick_evaluate(estimate, n_circuit=20, *args, **kwargs):
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


def sample(seed, idx):
    """ Return circuit idx of a seed: the same circuits evaluate() uses. """
    return GhostCircuit.sample(**OFFICIAL, seed=seed * 1_000_003 + idx)


def call(estimate, circuit, idx):
    """ Run estimate on one circuit (on copies of its data).

    Returns:
        named (np.array): (n_named,) int, the devices it names

    Raises:
        RuntimeError: says which circuit went wrong and how
    """
    try:
        return check_guess(estimate(circuit.x.copy(), circuit.y.copy()),
                           circuit.n_dev)
    except Exception as exc:
        raise RuntimeError(f'circuit {idx}: ' + user_error(exc, 'your code'))


def run(name, setup, progress=None, every=10):
    """ Run estimator name on setup['n_circuit'] circuits.

    Args:
        name (str): an estimator listed by load(), or a key of BASELINES
        setup (str): JSON {n_circuit, seed}
        progress (callable): progress(done, n_circuit, n_right, n_wrong),
            if given, is called every few circuits
        every (int): circuits between progress calls

    Returns:
        JSON {ok, error} plus, when ok: summarize()'s fields, seconds, and
            one entry per circuit in each of the lists right, wrong,
            n_named, missed_w (see score)
    """
    setup = json.loads(setup)
    estimate = lookup(name)
    n_circuit, seed = setup['n_circuit'], setup['seed']
    keys = ('right', 'wrong', 'n_named', 'missed_w')
    out = {k: [] for k in keys}
    start = time.perf_counter()
    try:
        for idx in range(n_circuit):
            circuit = sample(seed, idx)
            s = score(call(estimate, circuit, idx), circuit)
            for k in keys:
                out[k].append(s[k])
            if progress is not None and (idx + 1) % every == 0:
                progress(idx + 1, n_circuit, sum(out['right']),
                         sum(out['wrong']))
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))

    return json.dumps(dict(ok=True, error=None,
                           seconds=time.perf_counter() - start,
                           **summarize(out['right'], out['wrong']), **out))


def replay(name, setup, idx):
    """ Return circuit idx of a setup, with the hidden truth revealed.

    Returns:
        JSON {ok, error} plus, when ok: w ((n_dev,) true watts, 0 off the
            circuit), named (the devices named), y ((n_hour,) the meter),
            x ((n_dev,) str, each device's log as n_hour '0' / '1'
            characters, for the page's own fits), baseline, noise, and
            score()'s fields
    """
    setup = json.loads(setup)
    circuit = sample(setup['seed'], idx)
    try:
        named = call(lookup(name), circuit, idx)
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))
    return json.dumps(dict(
        ok=True, error=None, w=circuit._watts.tolist(),
        named=named.tolist(), y=circuit.y.tolist(),
        x=[''.join(map(str, col)) for col in circuit.x.T],
        baseline=OFFICIAL['baseline'], noise=OFFICIAL['noise'],
        **score(named, circuit)))


def results(name, setup, run_name, progress=None, every=10):
    """ Return every circuit of a run as CSV, one row per device that is
    on the circuit or named (every other device has w = 0, named = 0), the
    run's and circuit's columns repeated on each row.

    CSV columns: puzzle, run, estimator, seed, circuit, device, w,
    on_circuit, named, circuit_right, circuit_wrong, circuit_named,
    circuit_f1.

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
                   'device', 'w', 'on_circuit', 'named', 'circuit_right',
                   'circuit_wrong', 'circuit_named', 'circuit_f1'])
    try:
        for idx in range(n_circuit):
            circuit = sample(seed, idx)
            named = call(estimate, circuit, idx)
            s, w = score(named, circuit), circuit._watts
            is_named = np.isin(np.arange(circuit.n_dev), named)
            for j in np.flatnonzero((w > 0) | is_named):
                rows.writerow([
                    'ghost_circuit', run_name, name, seed, idx, int(j),
                    round(float(w[j]), 2), int(w[j] > 0), int(is_named[j]),
                    s['right'], s['wrong'], s['n_named'],
                    round(s['f1'], 4)])
            if progress is not None and (idx + 1) % every == 0:
                progress(idx + 1, n_circuit)
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))
    return json.dumps(dict(ok=True, error=None, csv=out.getvalue()))

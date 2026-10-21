""" Runs a student's estimate() for the Slice Crawl practice site

The page's web worker (js/worker.js) loads this module into Pyodide next to
slice_crawl.py, then calls:

    load(source, helpers)       run the student's code, list its estimators
    run(name, setup, progress)  try one estimator on many crawls
    replay(name, setup, idx)    one crawl in detail, hidden truth revealed

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

import slice_crawl
from slice_crawl import SliceCrawl, TooManySlices, check_guess

# folder holding the student's helper .py files (importable by name)
USER_DIR = '/home/pyodide/user'

# while the student's code loads, its own evaluate() calls run only this
# many crawls (the page runs the real test)
LOAD_CRAWLS = 50

# printed output kept from loading the student's code
MAX_OUTPUT = 20_000

namespace = {}


def taste_each(n):
    """ the simple baseline: n slices from every shop, best average wins """
    def estimate(crawl):
        avg = []
        for i in range(crawl.n_shop):
            total = 0
            for _ in range(n):
                total += crawl.taste(i)
            avg.append(total / n)
        return avg.index(max(avg))

    return estimate


# built in, so they run with or without the student's code; names with
# spaces can't clash with the student's
BASELINES = {f'taste each {n}': taste_each(n) for n in (5, 20, 40)}


def lookup(name):
    """ the estimator called name: the student's, or a baseline """
    return namespace[name] if name in namespace else BASELINES[name]


def notebook_source(text):
    """ the code cells of a .ipynb (as text), minus shell (!) and magic (%)
    lines, which only work in Jupyter """
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


def user_error(exc, filename):
    """ the error message, with traceback lines from the student's code only
    (not this file's or the site's) """
    frames = [f for f in traceback.extract_tb(exc.__traceback__)
              if f.filename == filename or f.filename.startswith(USER_DIR)]
    lines = traceback.format_list(frames)
    return ''.join(lines) + ''.join(
        traceback.format_exception_only(type(exc), exc))


def not_estimators(source):
    """ top-level names that aren't the student's estimators: those bound by
    import statements, and loop variables (left holding their last value) """
    names = set()
    for node in ast.parse(source).body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add((alias.asname or alias.name).split('.')[0])
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            names |= {n.id for n in ast.walk(node.target)
                      if isinstance(n, ast.Name)}
    return names


def takes_crawl(obj):
    """ True if obj can be called with one argument (the crawl) """
    if isinstance(obj, (type, types.ModuleType)) or not callable(obj):
        return False
    try:
        inspect.signature(obj).bind(None)
    except (TypeError, ValueError):
        return False
    return True


def load(source, helpers):
    """ runs the student's code in a fresh namespace

    Args:
        source (str): the main code (a .py, or a .ipynb's code cells)
        helpers (str): JSON {filename: source} of helper .py files

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
        with open(os.path.join(USER_DIR, os.path.basename(name)), 'w') as f:
            f.write(text)
    if USER_DIR not in sys.path:
        sys.path.insert(0, USER_DIR)
    os.chdir(USER_DIR)
    os.environ['MPLBACKEND'] = 'Agg'

    def quick_evaluate(estimate, n_crawl=5000, *args, **kwargs):
        return evaluate(estimate, min(n_crawl, LOAD_CRAWLS), *args, **kwargs)

    evaluate = slice_crawl.evaluate
    namespace = {'__name__': '__main__', 'display': print}
    out = io.StringIO()
    error = None
    slice_crawl.evaluate = quick_evaluate
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
        slice_crawl.evaluate = evaluate

    try:
        skip = not_estimators(source)
    except SyntaxError:
        skip = set()
    skip.add('display')
    names = [name for name, obj in namespace.items()
             if not name.startswith('_') and name not in skip
             and takes_crawl(obj)]
    if 'estimate' in names:
        names.remove('estimate')
        names.insert(0, 'estimate')

    output = out.getvalue()
    if len(output) > MAX_OUTPUT:
        output = output[:MAX_OUTPUT] + '\n... (output cut short)'
    return json.dumps(dict(ok=error is None, names=names, output=output,
                           error=error))


def sample(setup, seed, idx):
    """ crawl idx of a setup: the same crawls evaluate() uses """
    n_shop = setup['n_shop']
    if isinstance(n_shop, list):
        n_shop = tuple(n_shop)
    return SliceCrawl.sample(n_shop=n_shop, family=setup['family'],
                             race=setup['race'],
                             seed=seed * 1_000_003 + idx)


def call(estimate, crawl, idx):
    """ runs estimate on one crawl, returns its guess

    Raises:
        RuntimeError: says which crawl went wrong and how
    """
    try:
        return check_guess(estimate(crawl), crawl.n_shop)
    except TooManySlices:
        raise RuntimeError(
            f'crawl {idx}: tasted {slice_crawl.MAX_TASTE:,} slices without '
            f'naming a shop (an endless loop?)') from None
    except Exception as exc:
        raise RuntimeError(f'crawl {idx}: ' + user_error(exc, 'your code'))


def observed_diff(history, best, guess):
    """ average rating tasted at shop best minus that at shop guess, or
    None if either went untasted """
    avg = {}
    for shop in (best, guess):
        x = [r for i, r in history if i == shop]
        if not x:
            return None
        avg[shop] = sum(x) / len(x)
    return avg[best] - avg[guess]


def run(name, setup, progress=None, every=100):
    """ runs estimator name on setup['n_crawl'] crawls

    Args:
        name (str): an estimator listed by load(), or a key of BASELINES
        setup (str): JSON {n_shop (int or [low, high]), family, race,
            n_crawl, seed}
        progress (callable): progress(done, n_crawl, n_right, n_slice), if
            given, is called every few crawls
        every (int): crawls between progress calls

    Returns:
        JSON {ok, error} plus, when ok: accuracy, accuracy_se, mean_slices,
            median_slices, p90_slices, seconds, and one entry per crawl in
            each of: slices, correct, guess (shop named), best (true best
            shop), gap (best minus second-best typical rating), shortfall
            (best minus the named shop's typical rating), observed (the
            average slice tasted at the best shop minus that at the named
            one; None if either went untasted)
    """
    setup = json.loads(setup)
    estimate = lookup(name)
    n_crawl, seed = setup['n_crawl'], setup['seed']
    slices, correct, guesses, bests, gaps, shortfalls, observed = (
        [], [], [], [], [], [], [])
    start = time.perf_counter()
    try:
        for idx in range(n_crawl):
            crawl = sample(setup, seed, idx)
            guess = call(estimate, crawl, idx)
            top = sorted(crawl._mean, reverse=True)
            slices.append(crawl.n_taste)
            correct.append(guess == crawl._best)
            guesses.append(guess)
            bests.append(crawl._best)
            gaps.append(top[0] - top[1])
            shortfalls.append(top[0] - crawl._mean[guess])
            observed.append(observed_diff(crawl.history, crawl._best, guess))
            if progress is not None and (idx + 1) % every == 0:
                progress(idx + 1, n_crawl, sum(correct), sum(slices))
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))

    acc = sum(correct) / n_crawl
    srt = sorted(slices)
    return json.dumps(dict(
        ok=True, error=None, accuracy=acc,
        accuracy_se=math.sqrt(acc * (1 - acc) / n_crawl),
        mean_slices=sum(slices) / n_crawl,
        median_slices=srt[n_crawl // 2],
        p90_slices=srt[min(n_crawl - 1, int(.9 * n_crawl))],
        seconds=time.perf_counter() - start,
        slices=slices, correct=correct, guess=guesses, best=bests, gap=gaps,
        shortfall=shortfalls, observed=observed))


def replay(name, setup, idx):
    """ crawl idx of a setup, with the hidden truth revealed

    Returns:
        JSON {ok, error} plus, when ok: guess, best, mean and sd (per
            shop), history ([shop, rating] per slice, in order)
    """
    setup = json.loads(setup)
    crawl = sample(setup, setup['seed'], idx)
    try:
        guess = call(lookup(name), crawl, idx)
    except RuntimeError as exc:
        return json.dumps(dict(ok=False, error=str(exc)))
    return json.dumps(dict(ok=True, error=None, guess=guess,
                           best=crawl._best, mean=crawl._mean,
                           sd=crawl._sd, history=crawl.history))

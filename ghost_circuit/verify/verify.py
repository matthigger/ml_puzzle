""" Re-run Ghost on the Circuit leaderboard entries, so every score is ours.

The page posts code, never a score. This script takes each ghost_circuit
entry still waiting, runs its estimator on N_CIRCUIT circuits of the
official setup with a seed drawn here (and never shown), and writes back the
score the board displays. The database is shared by every puzzle (see
slice_crawl's supabase/schema.sql); a puzzle's re-run script handles its own
PROJECT and scores it its own way (score()).

The student's code runs in a container with no network, a read-only disk,
no secrets and limited memory / time (child.py). The circuits stay out here:
the container gets each circuit's x and y only, never its watts.

    python3 verify/verify.py                      re-run every waiting entry
    python3 verify/verify.py --local my_code.py   try one file, no database
    python3 verify/verify.py --count              how many are waiting

Needs the image (from the repo root):

    docker build -f verify/Dockerfile -t ghost-circuit-verify .

and, for the database, SUPABASE_URL and SUPABASE_SECRET_KEY in the
environment (a secret / service_role key: never in the page).
"""
import argparse
import json
import math
import os
import pathlib
import secrets
import subprocess
import sys
import threading
import time
import urllib.request

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'py'))

import ghost_circuit
from ghost_circuit import OFFICIAL, Circuit

PROJECT = 'ghost_circuit'
IMAGE = 'ghost-circuit-verify'
N_CIRCUIT = 2000

# wall-clock limit for one entry's whole re-run
TIMEOUT_SEC = 30 * 60

# the workflow's job is killed at 120 minutes: an entry starts only if
# it can finish inside this, so none is cut off and left waiting (first
# in line again, every run)
BUDGET_SEC = 100 * 60

# longest protocol line accepted: an estimate is 150 numbers (a few KB),
# the load reply carries at most an error message
MAX_LINE = 1 << 16

DOCKER = ['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
          '--tmpfs', '/tmp:size=64m', '--memory', '1g', '--cpus', '1',
          '--pids-limit', '64', '--cap-drop', 'ALL']


class Failed(Exception):
    """ The entry's code couldn't be scored; the message is shown to its
    owner. """


def no_constants(name):
    """ Refuse JSON's NaN / Infinity: watts must be finite numbers. """
    raise ValueError(f'{name} is not a number')


def rerun(main, helpers, estimator, n_circuit=N_CIRCUIT, seed=None,
          image=IMAGE, timeout=TIMEOUT_SEC):
    """ Run one estimator on n_circuit fresh official circuits, in a
    container.

    Args:
        main (str): the student's code
        helpers (dict): {filename: source} of helper .py files
        estimator (str): name of the estimator in that code
        seed (int | None): None draws a secret one, 63 bits, too many to
            search for from the meter data

    Returns:
        result (dict): {accuracy, accuracy_se, mean_off, median_off,
            p90_off, n_circuit, seed, seconds}

    Raises:
        Failed: the code didn't load, raised, returned a bad estimate or
            timed out
    """
    if seed is None:
        seed = secrets.randbits(63)
    start = time.monotonic()
    name = 'verify-' + secrets.token_hex(8)
    proc = subprocess.Popen(DOCKER + ['--name', name, image],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    # killing the docker client leaves its container running: kill that
    # by name
    def kill():
        subprocess.run(['docker', 'kill', name], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        proc.kill()

    timer = threading.Timer(timeout, kill)
    timer.start()

    def send(obj):
        proc.stdin.write(json.dumps(obj) + '\n')
        proc.stdin.flush()

    # the student's code can reach the protocol, so every message is
    # untrusted: anything malformed fails the entry, never this script
    def recv():
        line = proc.stdout.readline(MAX_LINE)
        if line and not line.endswith('\n'):
            raise Failed('the code printed too much')
        if not line:
            if not timer.is_alive():
                raise Failed(f'took over {timeout // 60} minutes for '
                             f'{n_circuit} circuits')
            raise Failed('the code stopped Python (out of memory?)')
        msg = json.loads(line, parse_constant=no_constants)
        if not isinstance(msg, dict):
            raise ValueError('not an object')
        return msg

    def error(msg, default):
        err = msg.get('error')
        return err if isinstance(err, str) and err.strip() else default

    correct, watts_off = [], []
    try:
        send(dict(main=main, helpers=helpers, estimator=estimator))
        msg = recv()
        if msg.get('ok') is not True:
            raise Failed(error(msg, 'the code did not load'))
        for idx in range(n_circuit):
            # every bit of the secret seeds each circuit
            circuit = Circuit.sample(**OFFICIAL, seed=[seed, idx])
            send(dict(x=[''.join(map(str, row)) for row in circuit.x],
                      y=circuit.y.tolist()))
            msg = recv()
            w = msg.get('w')
            if 'w' not in msg:
                raise Failed(error(msg, f'circuit {idx}: no estimate'))
            if (type(w) is not list or len(w) != circuit.n_device
                    or not all(type(v) in (int, float) and math.isfinite(v)
                               for v in w)):
                raise Failed(f'circuit {idx}: the estimate is not '
                             f'{circuit.n_device} finite watts')
            s = ghost_circuit.score(np.array(w, dtype=float), circuit)
            correct.append(s['correct'])
            watts_off.append(s['watts_off'])
    except Failed:
        raise
    except Exception as exc:
        raise Failed(f'the re-run broke down ({type(exc).__name__})')
    finally:
        timer.cancel()
        kill()
        proc.wait()

    return dict(ghost_circuit.summarize(correct, watts_off),
                n_circuit=n_circuit, seed=seed,
                seconds=time.monotonic() - start)


def score(res):
    """ Return the board's view of a re-run: (metrics, qualifies, rank),
    rank lower is better among entries that qualify. """
    metrics = {k: res[k] for k in ('accuracy', 'mean_off', 'median_off',
                                   'p90_off', 'n_circuit')}
    return metrics, res['accuracy'] >= 0.95, res['mean_off']


def rpc(fn, body):
    """ Call a database function with the secret key; return its result. """
    key = os.environ['SUPABASE_SECRET_KEY']
    headers = {'Content-Type': 'application/json', 'apikey': key}
    # a legacy service_role key is a JWT and also goes in Authorization;
    # a secret key (sb_secret_...) must not
    if key.startswith('eyJ'):
        headers['Authorization'] = 'Bearer ' + key
    req = urllib.request.Request(
        f'{os.environ["SUPABASE_URL"]}/rest/v1/rpc/{fn}',
        data=json.dumps(body).encode(), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode()
    return json.loads(text) if text else None


def rerun_waiting():
    """ Re-run every entry waiting in the database, writing back each
    score (or why it failed). """
    entries = rpc('pending_entries', {'project': PROJECT})
    print(f'{len(entries)} waiting')
    start = time.monotonic()
    for e in entries:
        if time.monotonic() - start + TIMEOUT_SEC > BUDGET_SEC:
            print('out of time: the rest wait for the next run')
            break
        # any failure marks this entry failed, so a bad one can't stay
        # pending and stop every later run
        try:
            src = e['source']
            res = rerun(src['main'], src.get('helpers', {}), e['entry_point'])
            metrics, qualifies, rank = score(res)
            body = dict(status='done', error=None, metrics=metrics,
                        qualifies=qualifies, rank=rank, seed=res['seed'])
            note = (f'{res["accuracy"]:.1%} right, {res["mean_off"]:.0f}'
                    f' watts off ({res["seconds"]:.0f} s)')
        except Exception as exc:
            msg = (str(exc) if isinstance(exc, Failed)
                   else f'the re-run broke down ({type(exc).__name__})')
            body = dict(status='failed', error=msg[:2000], metrics=None,
                        qualifies=None, rank=None, seed=None)
            note = 'failed: ' + (msg.strip().splitlines() or [''])[-1][:100]
        rpc('set_result', dict(entry_id=e['id'], entry_version=e['version'],
                               **body))
        print(f'entry {e["id"]}: {note}')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--local', metavar='FILE',
                        help='re-run this .py instead of the database')
    parser.add_argument('--helper', action='append', default=[],
                        metavar='FILE', help='helper .py beside it')
    parser.add_argument('--estimator', default='estimate')
    parser.add_argument('--n-circuit', type=int, default=N_CIRCUIT)
    parser.add_argument('--count', action='store_true',
                        help='print how many entries are waiting, and stop')
    args = parser.parse_args()

    if args.count:
        print(len(rpc('pending_entries', {'project': PROJECT})))
        return
    if not args.local:
        rerun_waiting()
        return
    helpers = {pathlib.Path(h).name: pathlib.Path(h).read_text()
               for h in args.helper}
    try:
        res = rerun(pathlib.Path(args.local).read_text(), helpers,
                    args.estimator, n_circuit=args.n_circuit)
    except Failed as exc:
        print('failed:', exc)
        sys.exit(1)
    print(f'{res["n_circuit"]} circuits: {res["accuracy"]:.1%} right, '
          f'{res["mean_off"]:.0f} watts off on average '
          f'(median {res["median_off"]:.0f}, 90th pct '
          f'{res["p90_off"]:.0f}), {res["seconds"]:.0f} s')


if __name__ == '__main__':
    main()

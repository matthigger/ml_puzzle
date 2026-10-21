"""Re-run Where Did It Start leaderboard entries, so every score is ours.

The page posts code, never a score. This script takes each where_start
entry still waiting, runs its estimator on N_QUAKE quakes of the official
setup with a seed drawn here (and never shown), and writes back the score
the board displays. The database is shared by every puzzle (see the
slice_crawl repo's supabase/schema.sql); a puzzle's re-run script handles
its own PROJECT and scores it its own way (score()).

The student's code runs in a container with no network, a read-only disk,
no secrets and limited memory / time (child.py). The quakes stay out here:
the container gets each quake's stations and arrival times, never its
epicenter, origin time or clock errors.

    python3 verify/verify.py                      re-run every waiting entry
    python3 verify/verify.py --local my_code.py   try one file, no database
    python3 verify/verify.py --count              how many are waiting

Needs the image (from the repo root):

    docker build -f verify/Dockerfile -t where-start-verify .

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

from where_start import HIT_BAR, HIT_KM, OFFICIAL, sample

PROJECT = 'where_start'
IMAGE = 'where-start-verify'
N_QUAKE = 2000

# wall-clock limit for one entry's whole re-run
TIMEOUT_SEC = 15 * 60

DOCKER = ['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
          '--tmpfs', '/tmp:size=64m', '--memory', '1g', '--cpus', '1',
          '--pids-limit', '64', '--cap-drop', 'ALL']


class Failed(Exception):
    """The entry's code couldn't be scored; the message is shown to its
    owner."""


def rerun(main, helpers, estimator, n_quake=N_QUAKE, seed=None,
          image=IMAGE, timeout=TIMEOUT_SEC):
    """Run one estimator on n_quake fresh official quakes, in a container.

    Args:
        main (str): the student's code
        helpers (dict): {filename: source} of helper .py files
        estimator (str): name of the estimator in that code
        n_quake (int): quakes to run
        seed (int | None): None draws a secret one

    Returns:
        result (dict): {hit_rate, mean_km, median_km, p90_km,
            mean_abs_t0_error, n_quake, seed, seconds}

    Raises:
        Failed: the code didn't load, raised, returned junk or timed out
    """
    if seed is None:
        seed = secrets.randbits(31)
    start = time.monotonic()
    proc = subprocess.Popen(DOCKER + [image], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    timer = threading.Timer(timeout, proc.kill)
    timer.start()

    def send(obj):
        proc.stdin.write(json.dumps(obj) + '\n')
        proc.stdin.flush()

    # the student's code can reach the protocol, so every message is
    # untrusted: anything malformed fails the entry, never this script
    def recv():
        line = proc.stdout.readline()
        if not line:
            if not timer.is_alive():
                raise Failed(f'took over {timeout // 60} minutes for '
                             f'{n_quake} quakes')
            raise Failed('the code stopped Python (out of memory?)')
        msg = json.loads(line)
        if not isinstance(msg, dict):
            raise ValueError('not an object')
        return msg

    def error(msg, default):
        err = msg.get('error')
        return err if isinstance(err, str) and err.strip() else default

    err_km, err_t0 = [], []
    try:
        send(dict(main=main, helpers=helpers, estimator=estimator))
        msg = recv()
        if msg.get('ok') is not True:
            raise Failed(error(msg, 'the code did not load'))
        for idx in range(n_quake):
            q = sample(seed, idx, **OFFICIAL)
            send({'stations': q.stations.tolist(),
                  'arrivals': q.arrivals.tolist()})
            msg = recv()
            if 'est' not in msg:
                raise Failed(error(msg, f'quake {idx}: no estimate'))
            est = msg['est']
            if (not isinstance(est, list) or len(est) != 3
                    or not all(type(v) in (int, float) and math.isfinite(v)
                               for v in est)):
                raise Failed(f'quake {idx}: estimate {est!r:.80} is not '
                             'three numbers')
            err_km.append(math.dist(est[:2], q._p))
            err_t0.append(abs(est[2] - q._t0))
    except Failed:
        raise
    except Exception as exc:
        raise Failed(f'the re-run broke down ({type(exc).__name__})')
    finally:
        timer.cancel()
        proc.kill()
        proc.wait()

    err = np.array(err_km)
    return dict(hit_rate=float(np.mean(err <= HIT_KM)),
                mean_km=float(err.mean()), median_km=float(np.median(err)),
                p90_km=float(np.percentile(err, 90)),
                mean_abs_t0_error=float(np.mean(err_t0)),
                n_quake=n_quake, seed=seed,
                seconds=time.monotonic() - start)


def score(res):
    """Return the board's view of a re-run: (metrics, qualifies, rank).

    Qualifies: within HIT_KM in at least HIT_BAR of quakes; rank (lower is
    better among those) is the mean error, km.
    """
    metrics = {k: res[k] for k in ('hit_rate', 'mean_km', 'median_km',
                                   'p90_km', 'mean_abs_t0_error',
                                   'n_quake')}
    return metrics, res['hit_rate'] >= HIT_BAR, res['mean_km']


def rpc(fn, body):
    """Call a database function with the secret key; return its result."""
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
    """Re-run every entry waiting in the database, writing back each
    score (or why it failed)."""
    entries = rpc('pending_entries', {'project': PROJECT})
    print(f'{len(entries)} waiting')
    for e in entries:
        # any failure marks this entry failed, so a bad one can't stay
        # pending and stop every later run
        try:
            src = e['source']
            res = rerun(src['main'], src.get('helpers', {}), e['entry_point'])
            metrics, qualifies, rank = score(res)
            body = dict(status='done', error=None, metrics=metrics,
                        qualifies=qualifies, rank=rank, seed=res['seed'])
            note = (f'{res["hit_rate"]:.1%} hits, {res["mean_km"]:.2f} km'
                    f' ({res["seconds"]:.0f} s)')
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
    parser.add_argument('--n-quake', type=int, default=N_QUAKE)
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
                    args.estimator, n_quake=args.n_quake)
    except Failed as exc:
        print('failed:', exc)
        sys.exit(1)
    print(f'{res["n_quake"]} quakes: within {HIT_KM:g} km '
          f'{res["hit_rate"]:.1%} of the time, {res["mean_km"]:.2f} km off '
          f'on average (median {res["median_km"]:.2f}, 90th pct '
          f'{res["p90_km"]:.2f}), {res["seconds"]:.0f} s')


if __name__ == '__main__':
    main()

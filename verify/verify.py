""" Re-run Slice Crawl leaderboard entries, so every score is our own

The page posts code, never a score. This script takes each slice_crawl
entry still waiting, runs its estimator on N_CRAWL crawls of the official
setup with a seed drawn here (and never shown), and writes back the score
the board displays. The database is shared by every puzzle (see
supabase/schema.sql); a puzzle's re-run script handles its own PROJECT and
scores it its own way (score()).

The student's code runs in a container with no network, a read-only disk,
no secrets and limited memory / time (child.py). The crawls stay out here:
each taste is a round trip, so the hidden truth is never in reach.

    python3 verify/verify.py                      re-run every waiting entry
    python3 verify/verify.py --local my_code.py   try one file, no database
    python3 verify/verify.py --count              how many are waiting

Needs the image (from the repo root):

    docker build -f verify/Dockerfile -t slice-crawl-verify .

and, for the database, SUPABASE_URL and SUPABASE_SECRET_KEY in the
environment (a secret / service_role key: never in the page).
"""
import argparse
import json
import os
import pathlib
import random
import secrets
import subprocess
import sys
import threading
import time
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'py'))

from slice_crawl import MAX_TASTE, OFFICIAL, SliceCrawl, TooManySlices

PROJECT = 'slice_crawl'
IMAGE = 'slice-crawl-verify'
N_CRAWL = 5000

# wall-clock limit for one entry's whole re-run
TIMEOUT_SEC = 15 * 60

# longest protocol line accepted: a taste or a guess is a few bytes, the
# load reply carries at most an error message
MAX_LINE = 1 << 16

DOCKER = ['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
          '--tmpfs', '/tmp:size=64m', '--memory', '1g', '--cpus', '1',
          '--pids-limit', '64', '--cap-drop', 'ALL']


class Failed(Exception):
    """ the entry's code couldn't be scored; the message is shown to its
    owner """


def rerun(main, helpers, estimator, n_crawl=N_CRAWL, seed=None,
          image=IMAGE, timeout=TIMEOUT_SEC):
    """ Run one estimator on n_crawl fresh official crawls, in a container.

    Args:
        main (str): the student's code
        helpers (dict): {filename: source} of helper .py files
        estimator (str): name of the estimator in that code
        seed (int | None): None draws a secret one, 63 bits, too many to
            search for from the slices tasted

    Returns:
        result (dict): {accuracy, mean_slices, median_slices, p90_slices,
            n_crawl, seed, seconds}

    Raises:
        Failed: the code didn't load, raised, looped or timed out
    """
    if seed is None:
        seed = secrets.randbits(63)
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
        line = proc.stdout.readline(MAX_LINE)
        if line and not line.endswith('\n'):
            raise Failed('the code printed too much')
        if not line:
            if not timer.is_alive():
                raise Failed(f'took over {timeout // 60} minutes for '
                             f'{n_crawl} crawls')
            raise Failed('the code stopped Python (out of memory?)')
        msg = json.loads(line)
        if not isinstance(msg, dict):
            raise ValueError('not an object')
        return msg

    def error(msg, default):
        err = msg.get('error')
        return err if isinstance(err, str) and err.strip() else default

    slices, correct = [], []
    try:
        send(dict(main=main, helpers=helpers, estimator=estimator))
        msg = recv()
        if msg.get('ok') is not True:
            raise Failed(error(msg, 'the code did not load'))
        for idx in range(n_crawl):
            crawl = SliceCrawl.sample(**OFFICIAL, seed=seed * 1_000_003 + idx)
            # sample() seeds the slices with 32 bits, few enough to recover
            # from a few tastes (and with them every shop's mean): reseed
            # from the whole secret
            crawl._rng = random.Random(f'{seed}:{idx}')
            send({'n_shop': crawl.n_shop})
            while 't' in (msg := recv()):
                try:
                    send({'r': crawl.taste(msg['t'])})
                except (TooManySlices, IndexError):
                    send({'stop': True})
            guess = msg.get('guess')
            if 'guess' not in msg:
                raise Failed(error(msg, f'crawl {idx}: no guess'))
            if (type(guess) is not int
                    or not 0 <= guess < crawl.n_shop):
                raise Failed(f'crawl {idx}: guess {guess!r} is not a shop')
            if crawl.n_taste >= MAX_TASTE:
                raise Failed(f'crawl {idx}: tasted too many slices without '
                             'naming a shop (an endless loop?)')
            slices.append(crawl.n_taste)
            correct.append(guess == crawl._best)
    except Failed:
        raise
    except Exception as exc:
        raise Failed(f'the re-run broke down ({type(exc).__name__})')
    finally:
        timer.cancel()
        proc.kill()
        proc.wait()

    srt = sorted(slices)
    return dict(accuracy=sum(correct) / n_crawl,
                mean_slices=sum(slices) / n_crawl,
                median_slices=srt[n_crawl // 2],
                p90_slices=srt[min(n_crawl - 1, int(.9 * n_crawl))],
                n_crawl=n_crawl, seed=seed,
                seconds=time.monotonic() - start)


def score(res):
    """ The board's view of a re-run: (metrics, qualifies, rank), rank lower
    is better among entries that qualify. """
    metrics = {k: res[k] for k in ('accuracy', 'mean_slices', 'median_slices',
                                   'p90_slices', 'n_crawl')}
    return metrics, res['accuracy'] >= 0.95, res['mean_slices']


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
    for e in entries:
        # any failure marks this entry failed, so a bad one can't stay
        # pending and stop every later run
        try:
            src = e['source']
            res = rerun(src['main'], src.get('helpers', {}), e['entry_point'])
            metrics, qualifies, rank = score(res)
            body = dict(status='done', error=None, metrics=metrics,
                        qualifies=qualifies, rank=rank, seed=res['seed'])
            note = (f'{res["accuracy"]:.1%} right, {res["mean_slices"]:.1f}'
                    f' slices ({res["seconds"]:.0f} s)')
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
    parser.add_argument('--n-crawl', type=int, default=N_CRAWL)
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
                    args.estimator, n_crawl=args.n_crawl)
    except Failed as exc:
        print('failed:', exc)
        sys.exit(1)
    print(f'{res["n_crawl"]} crawls: {res["accuracy"]:.1%} right, '
          f'{res["mean_slices"]:.1f} slices on average '
          f'(median {res["median_slices"]}, 90th pct {res["p90_slices"]}), '
          f'{res["seconds"]:.0f} s')


if __name__ == '__main__':
    main()

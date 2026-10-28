""" Re-run Slice Crawl leaderboard entries, so every score is our own

The page posts code, never a score. This script takes each slice_crawl
entry still waiting, runs its estimator on N_CRAWL crawls of the official
setup with a seed drawn here, and writes back the score the board displays,
seed included: the Practice tab (or slice_crawl.evaluate) with that seed
and N_CRAWL crawls replays the re-run exactly. The database is shared by every puzzle (see
../supabase/schema.sql); a puzzle's re-run script handles its own
PROJECT and scores it its own way (score()).

The student's code runs in a container with no network, a read-only disk,
no secrets and limited memory / time (child.py); N_WORKER of them share
the crawls. The crawls stay out here: each taste is a round trip, so the
hidden truth is never in reach.

    python3 verify/verify.py                      re-run every waiting entry
    python3 verify/verify.py --local my_code.py   try one file, no database
    python3 verify/verify.py --count              how many are waiting

Needs the image (from this puzzle's folder):

    docker build -f verify/Dockerfile -t slice-crawl-verify .

and, for the database, SUPABASE_URL and SUPABASE_SECRET_KEY in the
environment (a secret / service_role key: never in the page).
"""
import argparse
import json
import os
import pathlib
import secrets
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ProcessPoolExecutor, as_completed
from multiprocessing import get_context

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'py'))

from slice_crawl import MAX_TASTE, OFFICIAL, SliceCrawl, TooManySlices

PROJECT = 'slice_crawl'
IMAGE = 'slice-crawl-verify'
N_CRAWL = 2000

# containers per re-run, each playing every N_WORKER-th crawl: a GitHub
# runner has 4 CPUs
N_WORKER = 4

# the secret seed: too many bits to search for from the slices tasted, and
# few enough for a JavaScript number, so the Practice tab can replay it
SEED_BITS = 53

# wall-clock limit for one entry's whole re-run
TIMEOUT_SEC = 15 * 60

# the workflow's job is killed at 120 minutes: an entry starts only if
# it can finish inside this, so none is cut off and left waiting (first
# in line again, every run)
BUDGET_SEC = 100 * 60

# longest protocol line accepted: a taste or a guess is a few bytes, the
# load reply carries at most an error message
MAX_LINE = 1 << 16

DOCKER = ['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
          '--tmpfs', '/tmp:size=64m', '--memory', '1g', '--cpus', '1',
          '--pids-limit', '64', '--cap-drop', 'ALL']


class Failed(Exception):
    """ the entry's code couldn't be scored; the message is shown to its
    owner """


class Overtime(Failed):
    """ the re-run went over its time limit (TIMEOUT_SEC) """


def rerun(main, helpers, estimator, n_crawl=N_CRAWL, seed=None,
          image=IMAGE, timeout=TIMEOUT_SEC, n_worker=N_WORKER):
    """ Run one estimator on n_crawl fresh official crawls, in containers.

    Each of n_worker processes plays every n_worker-th crawl through its own
    container. Crawl idx is slice_crawl.evaluate()'s crawl idx for the same
    seed, so the score doesn't depend on n_worker and the Practice tab
    replays it.

    Args:
        main (str): the student's code
        helpers (dict): {filename: source} of helper .py files
        estimator (str): name of the estimator in that code
        seed (int | None): None draws a secret one (see SEED_BITS)
        n_worker (int): containers run at once

    Returns:
        result (dict): {accuracy, mean_slices, median_slices, p90_slices,
            n_crawl, seed, seconds}

    Raises:
        Failed: the code didn't load, raised, looped or timed out
    """
    if seed is None:
        seed = secrets.randbits(SEED_BITS)
    start = time.monotonic()
    names = ['verify-' + secrets.token_hex(8) for _ in range(n_worker)]
    timed_out = threading.Event()

    # a container outlives its docker client: kill them by name
    def kill():
        subprocess.run(['docker', 'kill', *names], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)

    def expire():
        timed_out.set()
        kill()

    timer = threading.Timer(timeout, expire)
    timer.start()
    # a process per container, not a thread: the round trips are Python
    # work, and threads would take turns at it
    pool = ProcessPoolExecutor(n_worker, mp_context=get_context('spawn'))
    try:
        jobs = [pool.submit(play, name, image, main, helpers, estimator,
                            range(w, n_crawl, n_worker), seed)
                for w, name in enumerate(names)]
        out = {}
        # the first failure kills every container; the others' errors are
        # only fallout
        error = None
        for job in as_completed(jobs):
            try:
                out.update(job.result())
            except Exception as exc:
                if error is None:
                    error = exc
                    kill()
    finally:
        timer.cancel()
        pool.shutdown(cancel_futures=True)
        kill()

    # the kill at the time limit can cut any message short
    if timed_out.is_set():
        raise Overtime(f'took over {timeout // 60} minutes for {n_crawl} '
                       'crawls')
    if isinstance(error, Failed):
        raise error
    if error is not None:
        raise Failed(f'the re-run broke down ({type(error).__name__})')

    slices = [out[idx][0] for idx in range(n_crawl)]
    srt = sorted(slices)
    return dict(accuracy=sum(right for _, right in out.values()) / n_crawl,
                mean_slices=sum(slices) / n_crawl,
                median_slices=srt[n_crawl // 2],
                p90_slices=srt[min(n_crawl - 1, int(.9 * n_crawl))],
                n_crawl=n_crawl, seed=seed,
                seconds=time.monotonic() - start)


def play(name, image, main, helpers, estimator, idxs, seed):
    """ Start container name, load the code in it, play crawls idxs.

    Args:
        name (str): the container's name, for rerun() to kill it by
        idxs (range): crawl indices to play
        seed (int): the re-run's seed

    Returns:
        out (dict): {idx: (n_taste, right)} for each idx played

    Raises:
        Failed: the code didn't load, raised or misbehaved
    """
    proc = subprocess.Popen(DOCKER + ['--name', name, image],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)

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
            raise Failed('the code stopped Python (out of memory?)')
        msg = json.loads(line)
        if not isinstance(msg, dict):
            raise ValueError('not an object')
        return msg

    def error(msg, default):
        err = msg.get('error')
        return err if isinstance(err, str) and err.strip() else default

    out = {}
    try:
        send(dict(main=main, helpers=helpers, estimator=estimator))
        msg = recv()
        if msg.get('ok') is not True:
            raise Failed(error(msg, 'the code did not load'))
        for idx in idxs:
            crawl = SliceCrawl.sample(**OFFICIAL, seed=seed * 1_000_003 + idx)
            send({'n_shop': crawl.n_shop})
            while 't' in (msg := recv()):
                try:
                    send({'r': crawl.taste(msg['t'])})
                except (TooManySlices, IndexError):
                    send({'stop': True})
            guess = msg.get('guess')
            if 'guess' not in msg:
                raise Failed(error(msg, f'crawl {idx}: no guess'))
            if type(guess) is not int or not 0 <= guess < crawl.n_shop:
                raise Failed(f'crawl {idx}: guess {guess!r} is not a shop')
            if crawl.n_taste >= MAX_TASTE:
                raise Failed(f'crawl {idx}: tasted too many slices without '
                             'naming a shop (an endless loop?)')
            out[idx] = (crawl.n_taste, guess == crawl._best)
    finally:
        proc.kill()
        proc.wait()
    return out


def score(res):
    """ The board's view of a re-run: (metrics, qualifies, rank), rank lower
    is better among entries that qualify. """
    metrics = {k: res[k] for k in ('accuracy', 'mean_slices', 'median_slices',
                                   'p90_slices', 'n_crawl', 'seed')}
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
    """ Re-run every entry waiting in the database, until none is
    left: entries posted mid-run are re-run too. """
    start = time.monotonic()
    # (id, version) already re-run here: one whose result didn't save stays
    # pending, and is left to the next run rather than retried forever
    tried = set()
    while True:
        entries = [e for e in rpc('pending_entries', {'project': PROJECT})
                   if (e['id'], e['version']) not in tried]
        if not entries:
            return
        print(f'{len(entries)} waiting')
        for e in entries:
            if time.monotonic() - start + TIMEOUT_SEC > BUDGET_SEC:
                print('out of time: the rest wait for the next run')
                return
            tried.add((e['id'], e['version']))
            rerun_entry(e)


def rerun_entry(e):
    """ Re-run one waiting entry, writing back its score (or why it
    failed). """
    # marks it running on the board; false if it was re-posted since, and
    # the next pass runs the new version
    if not rpc('start_entry', dict(entry_id=e['id'],
                                   entry_version=e['version'])):
        return
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
        status = 'overtime' if isinstance(exc, Overtime) else 'failed'
        body = dict(status=status, error=msg[:2000], metrics=None,
                    qualifies=None, rank=None, seed=None)
        note = (status + ': '
                + (msg.strip().splitlines() or [''])[-1][:100])
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

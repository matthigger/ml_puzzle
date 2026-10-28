""" Re-run Ghost on the Circuit leaderboard entries, so every score is ours.

The page posts code, never a score. This script takes each ghost_circuit
entry still waiting, runs its estimator on N_CIRCUIT circuits of the
official setup with a seed drawn here, and writes back the score the board
displays, seed included: the Practice tab (or ghost_circuit.evaluate) with
that seed and N_CIRCUIT circuits replays the re-run exactly. The database
is shared by every puzzle (see ../supabase/schema.sql); a puzzle's re-run
script handles its own PROJECT and scores it its own way (score()).

The student's code runs in a sandbox (../../shared/sandbox.py: no network,
no secrets, a read-only system, limited memory and processes) under a time
limit, through child.py. The circuits stay out here: the sandbox gets each
circuit's x and y only, never which devices are on it. Every entry is
ranked, by highest F1 (runner.summarize).

    python3 verify/verify.py                      re-run every waiting entry
    python3 verify/verify.py --local my_code.py   try one file, no database
    python3 verify/verify.py --count              how many are waiting

Needs bubblewrap (see sandbox.py) and, for the database, SUPABASE_URL and
SUPABASE_SECRET_KEY in the environment (a secret / service_role key: never
in the page).
"""
import argparse
import json
import os
import pathlib
import secrets
import sys
import threading
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'py'))
sys.path.insert(0, str(HERE.parent.parent / 'shared'))

import runner
import sandbox

PROJECT = 'ghost_circuit'
N_CIRCUIT = 2000

# the secret seed: too many bits to search for from what the code sees, and
# few enough for a JavaScript number, so the Practice tab can replay it
SEED_BITS = 53

# wall-clock limit for one entry's whole re-run
TIMEOUT_SEC = 30 * 60

# the workflow's job is killed at 120 minutes: an entry starts only if
# it can finish inside this, so none is cut off and left waiting (first
# in line again, every run)
BUDGET_SEC = 100 * 60

# longest protocol line accepted: an estimate is at most 150 device
# numbers (under 1 KB), the load reply carries at most an error message
MAX_LINE = 1 << 16

# the sandbox's /verify: the child, and the puzzle code it imports
FILES = {'child.py': HERE / 'child.py',
         'runner.py': HERE.parent / 'py' / 'runner.py',
         'ghost_circuit.py': HERE.parent / 'py' / 'ghost_circuit.py'}


class Failed(Exception):
    """ The entry's code couldn't be scored; the message is shown to its
    owner. """


class Overtime(Failed):
    """ the re-run went over its time limit (TIMEOUT_SEC) """


def no_constants(name):
    """ Refuse JSON's NaN / Infinity: devices are whole numbers. """
    raise ValueError(f'{name} is not a number')


def rerun(main, helpers, estimator, n_circuit=N_CIRCUIT, seed=None,
          timeout=TIMEOUT_SEC):
    """ Run one estimator on n_circuit fresh official circuits, in a
    sandbox.

    Args:
        main (str): the student's code
        helpers (dict): {filename: source} of helper .py files
        estimator (str): name of the estimator in that code
        seed (int | None): None draws a secret one (see SEED_BITS)

    Returns:
        result (dict): runner.summarize()'s fields, n_circuit, seed,
            seconds

    Raises:
        Failed: the code didn't load, raised, returned a bad estimate or
            timed out
    """
    if seed is None:
        seed = secrets.randbits(SEED_BITS)
    start = time.monotonic()
    proc = sandbox.start(FILES)
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
                raise Overtime(f'took over {timeout // 60} minutes for '
                               f'{n_circuit} circuits')
            raise Failed('the code stopped Python (out of memory?)')
        msg = json.loads(line, parse_constant=no_constants)
        if not isinstance(msg, dict):
            raise ValueError('not an object')
        return msg

    def error(msg, default):
        err = msg.get('error')
        return err if isinstance(err, str) and err.strip() else default

    right, wrong = [], []
    try:
        send(dict(main=main, helpers=helpers, estimator=estimator))
        msg = recv()
        if msg.get('ok') is not True:
            raise Failed(error(msg, 'the code did not load'))
        for idx in range(n_circuit):
            # the Practice tab's circuit idx, so the seed replays there
            circuit = runner.sample(seed, idx)
            send(dict(x=[''.join(map(str, row)) for row in circuit.x],
                      y=circuit.y.tolist()))
            msg = recv()
            d = msg.get('d')
            if 'd' not in msg:
                raise Failed(error(msg, f'circuit {idx}: no estimate'))
            if (type(d) is not list or len(d) > circuit.n_dev
                    or not all(type(v) is int for v in d)):
                raise Failed(f'circuit {idx}: the estimate is not a list '
                             'of device numbers')
            try:
                named = runner.check_guess(d, circuit.n_dev)
            except ValueError as exc:
                raise Failed(f'circuit {idx}: {exc}') from None
            s = circuit.score(named)
            right.append(s['right'])
            wrong.append(s['wrong'])
    except Failed:
        raise
    except Exception as exc:
        # the kill at the time limit can cut a message short
        if not timer.is_alive():
            raise Overtime(f'took over {timeout // 60} minutes')
        raise Failed(f'the re-run broke down ({type(exc).__name__})')
    finally:
        timer.cancel()
        proc.kill()
        proc.wait()

    return dict(runner.summarize(right, wrong), n_circuit=n_circuit,
                seed=seed,
                seconds=time.monotonic() - start)


def score(res):
    """ Return the board's view of a re-run: (metrics, qualifies, rank),
    rank lower is better among entries that qualify. """
    metrics = {k: res[k] for k in ('f1', 'tpr', 'fpr', 'mean_wrong',
                                   'n_circuit', 'seed')}
    return metrics, True, -res['f1']


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
    # no sandbox, no re-run: the entries wait for one that has it
    sandbox.check()
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
        note = (f'F1 {res["f1"]:.3f}, TPR {res["tpr"]:.1%}, '
                f'FPR {res["fpr"]:.2%}'
                f' ({res["seconds"]:.0f} s)')
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
    print(f'{res["n_circuit"]} circuits: F1 {res["f1"]:.3f}, '
          f'TPR {res["tpr"]:.1%} '
          f'({res["mean_right"]:.1f} of {runner.N_ON} found), FPR '
          f'{res["fpr"]:.2%} ({res["mean_wrong"]:.1f} wrong), '
          f'{res["seconds"]:.0f} s')


if __name__ == '__main__':
    main()

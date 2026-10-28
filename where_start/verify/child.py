"""Run inside the re-run sandbox: the student's code, quake by quake.

Talks to verify.py over stdin / stdout, one JSON object per line. The quakes
(and their hidden truth) live in verify.py; this side only ever sees each
quake's stations and arrival times, so there is nothing here to peek at.

    in:  {main, helpers, estimator}    load the student's code
    out: {ok, error}
    in:  {stations, arrivals}          run the estimator on one quake
    out: {est: [x, y, t0]} or {error}
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import runner

# the protocol keeps private copies of stdin / stdout; the student's code
# gets /dev/null for all three, so its prints and input() can't touch it
proto_in = os.fdopen(os.dup(0), 'r')
proto_out = os.fdopen(os.dup(1), 'w')
devnull = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2):
    os.dup2(devnull, fd)
sys.stdin = open(os.devnull)
sys.stdout = sys.stderr = open(os.devnull, 'w')

runner.USER_DIR = '/tmp/user'


def send(obj):
    """Write one protocol message."""
    proto_out.write(json.dumps(obj) + '\n')
    proto_out.flush()


def recv():
    """Read one protocol message; exit when verify.py hangs up."""
    line = proto_in.readline()
    if not line:
        os._exit(0)
    return json.loads(line)


class Quake:
    """One quake as the student sees it: no hidden attributes.

    Attributes:
        stations (np.array): (n_station, 2) station positions, km
        arrivals (np.array): (n_station,) recorded arrival times, s
    """

    def __init__(self, stations, arrivals):
        self.stations = np.array(stations, dtype=float)
        self.arrivals = np.array(arrivals, dtype=float)
        self.n_station = len(self.arrivals)


def main():
    """Load the student's code, then answer quakes until hung up on."""
    msg = recv()
    res = json.loads(runner.load(msg['main'], json.dumps(msg['helpers'])))
    if res['ok'] and msg['estimator'] not in res['names']:
        res = dict(ok=False, error=f'no estimator {msg["estimator"]!r} '
                                   'in the code')
    send(dict(ok=res['ok'], error=res['error']))
    if not res['ok']:
        return
    estimate = runner.namespace[msg['estimator']]

    idx = 0
    while True:
        msg = recv()
        quake = Quake(msg['stations'], msg['arrivals'])
        try:
            send({'est': list(runner.call(estimate, quake, idx))})
        except RuntimeError as exc:
            send({'error': str(exc)})
            return
        idx += 1


if __name__ == '__main__':
    main()

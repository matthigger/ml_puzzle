""" Run inside the re-run container: the student's code, circuit by circuit.

Talks to verify.py over stdin / stdout, one JSON object per line. The
circuits (and their hidden watts) live in verify.py; this side only ever
sees each circuit's log and meter, so there is nothing here to peek at.

    in:  {main, helpers, estimator}    load the student's code
    out: {ok, error}
    in:  {x, y}                        one circuit: x as one '0'/'1' string
                                       per hour, y the meter
    out: {w} or {error}                the estimate, (n_device,) watts
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
    """ Write one protocol message. """
    proto_out.write(json.dumps(obj) + '\n')
    proto_out.flush()


def recv():
    """ Read one protocol message; exit when verify.py is done. """
    line = proto_in.readline()
    if not line:
        os._exit(0)
    return json.loads(line)


class Circuit:
    """ One circuit, as the student sees it: no hidden watts.

    Attributes:
        x (np.array): (n_hour, n_device) int on / off log
        y (np.array): (n_hour,) the meter
    """

    def __init__(self, rows, y):
        self.x = np.array([[int(c) for c in row] for row in rows])
        self.y = np.array(y, dtype=float)
        self.n_hour, self.n_device = self.x.shape


def main():
    """ Load the code, then answer one circuit at a time. """
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
        circuit = Circuit(msg['x'], msg['y'])
        try:
            send({'w': runner.call(estimate, circuit, idx).tolist()})
        except RuntimeError as exc:
            send({'error': str(exc)})
            return
        idx += 1


if __name__ == '__main__':
    main()

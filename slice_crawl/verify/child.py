""" Runs inside the re-run container: the student's code, crawl by crawl

Talks to verify.py over stdin / stdout, one JSON object per line. The crawls
(and their hidden truth) live in verify.py; this side only ever sees the
ratings it tastes, so there is nothing here to peek at.

    in:  {main, helpers, estimator}    load the student's code
    out: {ok, error}
    in:  {n_shop}                      run the estimator on one crawl
    out: {t: shop}, in: {r: rating}    once per slice tasted ({stop} after
                                       MAX_TASTE slices)
    out: {guess} or {error}
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import runner
import slice_crawl

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
    proto_out.write(json.dumps(obj) + '\n')
    proto_out.flush()


def recv():
    line = proto_in.readline()
    if not line:
        os._exit(0)
    return json.loads(line)


class Crawl:
    """ one crawl, as the student sees it: each taste asks verify.py

    Same public attributes as slice_crawl.SliceCrawl (n_shop, n_taste,
    history, taste), and none of its hidden ones.
    """

    def __init__(self, n_shop):
        self.n_shop = n_shop
        self.n_taste = 0
        self.history = []

    def taste(self, shop_idx):
        """ buys one slice from shop shop_idx, returns its rating (float) """
        if not (isinstance(shop_idx, int) and 0 <= shop_idx < self.n_shop):
            raise IndexError(f'no shop {shop_idx!r}: shops are 0 to '
                             f'{self.n_shop - 1}')
        send({'t': shop_idx})
        msg = recv()
        if 'r' not in msg:
            raise slice_crawl.TooManySlices(
                f'stopped after {slice_crawl.MAX_TASTE} slices')
        self.n_taste += 1
        self.history.append((shop_idx, msg['r']))
        return msg['r']


def main():
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
        crawl = Crawl(recv()['n_shop'])
        try:
            send({'guess': runner.call(estimate, crawl, idx)})
        except RuntimeError as exc:
            send({'error': str(exc)})
            return
        idx += 1


if __name__ == '__main__':
    main()

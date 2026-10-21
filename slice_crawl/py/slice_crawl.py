""" Slice Crawl: find the best pizza shop in as few slices as possible

A crawl hides n_shop pizza shops. Each shop has its own typical rating and
its own consistency; every slice you taste returns one noisy rating. Your
estimator tastes as many slices as it likes, then names the shop it believes
has the highest typical rating.

    from slice_crawl import SliceCrawl, evaluate

    def estimate(crawl):
        for i in range(crawl.n_shop):
            crawl.taste(i)
        ...
        return best_shop_idx

    evaluate(estimate)          # 5000 crawls of the official setup

Only the standard library is used, so this file can run unchanged in a
notebook and in the browser (Pyodide), for the planned practice site.
"""
import math
import operator
import random

# the graded setup
OFFICIAL = dict(n_shop=8, family='bell', race='official')

FAMILY = {
    'bell': 'bell curve around each shop\'s typical rating',
    'heavy': 'mostly a bell curve, but now and then a wildly off slice',
    'disaster': 'usually fine, sometimes a disaster (burnt, cold, dropped)',
}

# (low, high) of the gap between the best and second-best typical rating;
# the gap is log-uniform between these
RACE = {
    'easy': (1.0, 3.0),
    'official': (0.3, 1.5),
    'close': (0.1, 0.4),
}

# a crawl that tastes this many slices is stopped (likely an endless loop)
MAX_TASTE = 20_000


class TooManySlices(RuntimeError):
    pass


class SliceCrawl:
    """ one crawl through n_shop pizza shops

    Attributes you may use:
        n_shop (int): shops are numbered 0, 1, ..., n_shop - 1
        n_taste (int): slices tasted so far
        history (list): (shop_idx, rating) of every slice so far, in order

    Everything starting with an underscore is the hidden truth: peeking at
    it is cheating (and the competition uses a fresh copy without it).
    """

    def __init__(self, mean, sd, family='bell', seed=None):
        assert len(mean) == len(sd)
        self._mean = list(mean)
        self._sd = list(sd)
        self._family = family
        self._rng = random.Random(seed)
        self.n_shop = len(mean)
        self.n_taste = 0
        self.history = []

    @classmethod
    def sample(cls, n_shop=8, family='bell', race='official', seed=None):
        """ builds a random crawl

        Args:
            n_shop (int or tuple): number of shops, or (low, high) to draw
                it uniformly (inclusive) for each crawl
            family (str): shape of each shop's ratings, a key of FAMILY
            race (str): how close the best two shops are, a key of RACE
            seed (int): seeds both the shops and the slices
        """
        rng = random.Random(seed)
        if not isinstance(n_shop, int):
            n_shop = rng.randint(*n_shop)
        assert n_shop >= 2, 'need at least 2 shops'

        # typical ratings: best, then second best a gap below it, then the
        # rest spread out below the second best
        lo, hi = RACE[race]
        best = rng.uniform(6.5, 8.5)
        second = best - math.exp(rng.uniform(math.log(lo), math.log(hi)))
        mean = [best, second] + [second - rng.uniform(0, 3)
                                 for _ in range(n_shop - 2)]

        # consistency: some shops are much more consistent than others
        sd = [math.exp(rng.uniform(math.log(.5), math.log(2.5)))
              for _ in range(n_shop)]

        # shuffle so shop 0 isn't always best
        order = list(range(n_shop))
        rng.shuffle(order)
        mean = [mean[i] for i in order]
        sd = [sd[i] for i in order]

        return cls(mean, sd, family=family, seed=rng.getrandbits(32))

    def taste(self, shop_idx):
        """ buys one slice from shop shop_idx, returns its rating (float) """
        if not (isinstance(shop_idx, int) and 0 <= shop_idx < self.n_shop):
            raise IndexError(f'no shop {shop_idx!r}: shops are 0 to '
                             f'{self.n_shop - 1}')
        if self.n_taste >= MAX_TASTE:
            raise TooManySlices(f'stopped after {MAX_TASTE} slices')

        m, s, rng = self._mean[shop_idx], self._sd[shop_idx], self._rng
        if self._family == 'bell':
            x = rng.gauss(m, s)
        elif self._family == 'heavy':
            # student t (3 degrees of freedom), scaled to the same sd
            df = 3
            t = rng.gauss(0, 1) / math.sqrt(rng.gammavariate(df / 2, 2) / df)
            x = m + s * t / math.sqrt(df / (df - 2))
        elif self._family == 'disaster':
            # 1 in 10 slices is a disaster, 4 points low; the typical rating
            # (mean) is unchanged
            x = rng.gauss(m, s) + (-4 if rng.random() < .1 else 0) + .4
        else:
            raise ValueError(f'unknown family {self._family!r}')

        self.n_taste += 1
        self.history.append((shop_idx, x))
        return x

    @property
    def _best(self):
        """ the true best shop (hidden truth, for scoring) """
        return max(range(self.n_shop), key=self._mean.__getitem__)


def check_guess(guess, n_shop):
    """ returns guess as an int, or raises if it isn't a shop number """
    try:
        idx = operator.index(guess)  # an int (numpy ints too), not a float
    except TypeError:
        raise TypeError(f'estimate returned {guess!r}, not a shop number '
                        f'0 to {n_shop - 1}') from None
    if not 0 <= idx < n_shop:
        raise ValueError(f'estimate returned {idx}: shops are 0 to '
                         f'{n_shop - 1}')
    return idx


def evaluate(estimate, n_crawl=5000, seed=0, n_shop=8, family='bell',
             race='official', verbose=True):
    """ runs estimate on n_crawl random crawls, summarizes how it did

    Every call with the same seed (and setup) uses the same crawls, so two
    estimators evaluated with the same seed face identical shops.

    Returns:
        result (dict): accuracy, mean / median / p90 slices, and per crawl
            lists: slices, correct
    """
    slices, correct = [], []
    for idx in range(n_crawl):
        crawl = SliceCrawl.sample(n_shop=n_shop, family=family, race=race,
                                  seed=seed * 1_000_003 + idx)
        guess = check_guess(estimate(crawl), crawl.n_shop)
        slices.append(crawl.n_taste)
        correct.append(guess == crawl._best)

    acc = sum(correct) / n_crawl
    srt = sorted(slices)
    result = dict(accuracy=acc,
                  accuracy_se=math.sqrt(acc * (1 - acc) / n_crawl),
                  mean_slices=sum(slices) / n_crawl,
                  median_slices=srt[n_crawl // 2],
                  p90_slices=srt[min(n_crawl - 1, int(.9 * n_crawl))],
                  slices=slices, correct=correct)
    if verbose:
        print(f'{n_crawl} crawls: right {acc:.1%} of the time '
              f'(need 95%), {result["mean_slices"]:.1f} slices on average')
    return result

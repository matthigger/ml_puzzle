""" Ghost on the Circuit: which devices are wired to the metered circuit?

A circuit's power meter logs average watts each hour; smart plugs log whether
each of n_dev devices was on (1) or off (0) that hour. Only n_on of the
devices are wired to the metered circuit. Your estimator sees the plugs (x)
and the meter (y) and names the devices it believes are on the circuit.

    from ghost_circuit import GhostCircuit, evaluate

    circuit = GhostCircuit.sample(seed=0)   # official setup
    circuit.x                               # (n_hour, n_dev) on / off, 0 or 1
    circuit.y                               # (n_hour,) metered watts
    circuit.score([3, 17, 42])              # how many named devices were right

    def estimate(x, y):
        ...
        return device_idx                   # columns of x on the circuit

    evaluate(estimate)                      # 20 fresh circuits
"""
import numpy as np

# the graded setup
OFFICIAL = dict(n_hour=72, n_dev=150, n_on=8, watts=(20, 1500),
                duty=(.1, .6), baseline=200, noise=50)


class GhostCircuit:
    """ one metered circuit, plus every smart plug in the building

    Attributes you may use:
        x (np.array): (n_hour, n_dev), x[t, i] = 1 if device i was on in hour t
        y (np.array): (n_hour,), metered watts in each hour
        n_hour (int): hours of data
        n_dev (int): devices are numbered 0, 1, ..., n_dev - 1 (columns of x)

    Everything starting with an underscore is the hidden truth: peeking at
    it is cheating.
    """

    def __init__(self, x, y, on_circuit, watts):
        self.x = np.asarray(x)
        self.y = np.asarray(y)
        self.n_hour, self.n_dev = self.x.shape
        self._on_circuit = np.sort(on_circuit)
        self._watts = np.asarray(watts)

    @classmethod
    def sample(cls, n_hour=72, n_dev=150, n_on=8, watts=(20, 1500),
               duty=(.1, .6), baseline=200, noise=50, seed=None):
        """ builds a random circuit

        Args:
            n_hour (int): hours of data (rows of x)
            n_dev (int): devices with a smart plug (columns of x)
            n_on (int): how many of those devices are on the metered circuit
            watts: how to draw the watts of the n_on devices on the circuit,
                either
                    (low, high): log-uniform, stratified so the n_on devices
                        span the whole range (e.g. 20, 60, 160, ..., 1500 W
                        rather than 8 similar values), or
                    callable: watts(rng, n_on) returns n_on positive watts
            duty (tuple): (low, high), each device is on a fraction of the
                hours drawn uniformly from this range
            baseline (float): watts the circuit draws with every device off
            noise (float): standard deviation of the meter's hourly noise
            seed (int): same seed (and setup), same circuit
        """
        assert 0 < n_on <= n_dev, 'need 0 < n_on <= n_dev'
        rng = np.random.default_rng(seed)

        p_on = rng.uniform(*duty, n_dev)
        x = (rng.random((n_hour, n_dev)) < p_on).astype(int)

        if callable(watts):
            w_on = np.asarray(watts(rng, n_on), dtype=float)
            assert w_on.shape == (n_on,) and (w_on > 0).all(), \
                'watts(rng, n_on) must return n_on positive values'
        else:
            # one draw from each of n_on equal slices of [log low, log high]
            edge = np.linspace(np.log(watts[0]), np.log(watts[1]), n_on + 1)
            w_on = np.exp(rng.uniform(edge[:-1], edge[1:]))

        on_circuit = rng.choice(n_dev, n_on, replace=False)
        w = np.zeros(n_dev)
        w[on_circuit] = w_on
        y = baseline + x @ w + rng.normal(0, noise, n_hour)

        return cls(x, y, on_circuit, w)

    def score(self, guess):
        """ counts how many devices in guess are (or aren't) on the circuit

        Watts don't matter, only which devices were named.

        Args:
            guess: device indices (columns of x) named as on the circuit

        Returns:
            score (dict):
                right (int): named, and on the circuit
                wrong (int): named, but not on the circuit
                missed (int): on the circuit, but not named
                exact (bool): named exactly the devices on the circuit
        """
        guess = set(int(i) for i in np.asarray(guess).ravel())
        assert all(0 <= i < self.n_dev for i in guess), \
            f'devices are 0 to {self.n_dev - 1}'
        truth = set(self._on_circuit.tolist())
        return dict(right=len(guess & truth),
                    wrong=len(guess - truth),
                    missed=len(truth - guess),
                    exact=guess == truth)


def evaluate(estimate, n_circuit=20, seed=0, verbose=True, **setup):
    """ runs estimate(x, y) on n_circuit random circuits, summarizes how it did

    Every call with the same seed (and setup) uses the same circuits, so two
    estimators evaluated with the same seed face identical circuits.

    Args:
        estimate (callable): estimate(x, y) returns the device indices it
            names as on the circuit
        n_circuit (int): how many circuits to draw
        seed (int): which circuits
        verbose (bool): print a one line summary
        **setup: passed to GhostCircuit.sample (default: OFFICIAL)

    Returns:
        result (dict): mean right / wrong / missed per circuit, fraction of
            circuits named exactly, and a list of every circuit's score
    """
    setup = {**OFFICIAL, **setup}
    scores = []
    for idx in range(n_circuit):
        circuit = GhostCircuit.sample(**setup, seed=seed * 1_000_003 + idx)
        scores.append(circuit.score(estimate(circuit.x, circuit.y)))

    result = {k: np.mean([s[k] for s in scores])
              for k in ['right', 'wrong', 'missed', 'exact']}
    result['scores'] = scores
    if verbose:
        print(f'{n_circuit} circuits: {result["right"]:.1f} of '
              f'{setup["n_on"]} devices found, {result["wrong"]:.1f} wrongly '
              f'named, exactly right {result["exact"]:.0%} of the time')
    return result

""" Ghost on the Circuit: which devices are wired to the metered circuit?

A circuit hides which of n_device smart-plug devices are wired to it and how
many watts each draws. You see every device's hourly on / off log (x) and
the circuit's hourly meter (y); your estimator returns the watts it believes
each device draws on this circuit, 0 for devices not on it.

    from ghost_circuit import Circuit, evaluate

    def estimate(x, y):
        ...
        return watts            # (n_device,): 0 means "not on this circuit"

    evaluate(estimate)          # 1000 circuits of the official setup

A circuit is right when every device drawing BIG_W or more is named and no
device off the circuit is; smaller devices are lost in the meter's noise,
so naming them is optional. Among estimators right on 95% of circuits, the
one with the fewest watts off on average (sum over devices of
|estimate - truth|) wins.
"""
import math

import numpy as np

# the graded setup
OFFICIAL = dict(n_hour=72, n_device=150, n_on=8, noise_sd=50.0)

# an estimate of at least this many watts names its device
NAMED_W = 1.0

# every device drawing at least this many watts must be named
BIG_W = 100.0


class Circuit:
    """ One metered circuit and the devices wired to it.

    Attributes you may use:
        x (np.array): (n_hour, n_device) int, 1 where device j was on in
            hour t
        y (np.array): (n_hour,) the meter: average watts in each hour
        n_hour (int): hours logged
        n_device (int): devices logged, numbered 0 .. n_device - 1

    Everything starting with an underscore is the hidden truth: peeking at
    it is cheating (and the competition's copy doesn't have it).
        _watts (np.array): (n_device,) watts each device draws on this
            circuit, 0 for devices not on it
        _base (float): always-on load, watts
        _noise_sd (float): the meter's noise, watts
    """

    def __init__(self, x, y, watts, base, noise_sd):
        self.x = x
        self.y = y
        self.n_hour, self.n_device = x.shape
        self._watts = watts
        self._base = base
        self._noise_sd = noise_sd

    @classmethod
    def sample(cls, n_hour=72, n_device=150, n_on=8, noise_sd=50.0,
               seed=None):
        """ Build a random circuit.

        Each device is on in an hour with its own probability (its duty
        cycle, 0.1 to 0.6), independently of the others. The ghost (the
        biggest device) draws 1200 to 2000 W; the other n_on - 1 devices on
        the circuit draw 20 to 1200 W, log-uniform.

        Args:
            n_hour (int): hours logged
            n_device (int): devices logged
            n_on (int): devices wired to this circuit
            noise_sd (float): the meter's noise, watts
            seed (int | list): seeds everything (as numpy's SeedSequence
                does: every bit counts)
        """
        # the log (seen) and the circuit (hidden) come from independent
        # streams, so x says nothing about the watts
        seen, rng = (np.random.default_rng(s)
                     for s in np.random.SeedSequence(seed).spawn(2))
        duty = seen.uniform(.1, .6, n_device)
        x = (seen.random((n_hour, n_device)) < duty).astype(int)

        on = rng.choice(n_device, n_on, replace=False)
        watts = np.zeros(n_device)
        watts[on[0]] = rng.uniform(1200, 2000)
        watts[on[1:]] = np.exp(rng.uniform(math.log(20), math.log(1200),
                                           n_on - 1))
        base = rng.uniform(150, 250)
        y = x @ watts + base + rng.normal(0, noise_sd, n_hour)
        return cls(x, np.round(y, 1), watts, base, noise_sd)

    @property
    def _ghost(self):
        """ The biggest device on the circuit (hidden truth). """
        return int(np.argmax(self._watts))


def check_watts(watts, n_device):
    """ Return the estimate as a float array, or raise if it isn't one.

    Returns:
        watts (np.array): (n_device,) float
    """
    try:
        w = np.asarray(watts, dtype=float)
    except (TypeError, ValueError):
        raise TypeError(f'estimate returned {type(watts).__name__}, not '
                        f'{n_device} watts (one per device)') from None
    if w.size != n_device:
        raise ValueError(f'estimate returned {w.size} '
                         f'number{"" if w.size == 1 else "s"}: need '
                         f'{n_device}, one per device')
    w = w.ravel()
    if not np.all(np.isfinite(w)):
        raise ValueError('estimate returned nan or inf watts')
    return w


def score(w_hat, circuit):
    """ How one estimate did on one circuit.

    Args:
        w_hat (np.array): (n_device,) estimated watts
        circuit (Circuit): the circuit, hidden truth included

    Returns:
        result (dict): correct (bool), missed (devices of BIG_W or more not
            named), false_alarms (devices named but not on the circuit),
            named, watts_off (sum of |w_hat - truth|), ghost (its device),
            ghost_err (w_hat - truth, at the ghost)
    """
    w = circuit._watts
    named = w_hat >= NAMED_W
    missed = int(np.sum((w >= BIG_W) & ~named))
    false_alarms = int(np.sum(named & (w == 0)))
    g = circuit._ghost
    return dict(correct=missed == 0 and false_alarms == 0, missed=missed,
                false_alarms=false_alarms, named=int(named.sum()),
                watts_off=float(np.abs(w_hat - w).sum()), ghost=g,
                ghost_err=float(w_hat[g] - w[g]))


def summarize(correct, watts_off):
    """ The run's summary: accuracy (with its standard error) and watts off.

    Args:
        correct (list): bool per circuit
        watts_off (list): float per circuit
    """
    n = len(correct)
    acc = sum(correct) / n
    srt = sorted(watts_off)
    return dict(accuracy=acc, accuracy_se=math.sqrt(acc * (1 - acc) / n),
                mean_off=sum(watts_off) / n, median_off=srt[n // 2],
                p90_off=srt[min(n - 1, int(.9 * n))])


def evaluate(estimate, n_circuit=1000, seed=0, verbose=True, **setup):
    """ Run estimate on n_circuit random circuits, summarize how it did.

    Every call with the same seed (and setup) uses the same circuits, so two
    estimators evaluated with the same seed face identical data.

    Args:
        estimate (callable): estimate(x, y) -> (n_device,) watts
        setup: overrides of OFFICIAL (n_hour, n_device, n_on, noise_sd)

    Returns:
        result (dict): accuracy, accuracy_se, mean / median / p90 watts off,
            and per circuit lists: correct, watts_off
    """
    setup = {**OFFICIAL, **setup}
    correct, watts_off = [], []
    for idx in range(n_circuit):
        circuit = Circuit.sample(**setup, seed=seed * 1_000_003 + idx)
        w_hat = check_watts(estimate(circuit.x.copy(), circuit.y.copy()),
                            circuit.n_device)
        s = score(w_hat, circuit)
        correct.append(s['correct'])
        watts_off.append(s['watts_off'])

    result = dict(summarize(correct, watts_off), correct=correct,
                  watts_off=watts_off)
    if verbose:
        print(f'{n_circuit} circuits: right {result["accuracy"]:.1%} of the '
              f'time (need 95%), {result["mean_off"]:.0f} watts off on '
              'average')
    return result

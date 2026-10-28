"""Where Did It Start: locate an earthquake from seismograph arrival times.

Each quake hides an epicenter p = (x, y) (km) and an origin time t0 (s) in a
200 km by 200 km region. Its shock wave travels at V km/s, so station i at
s_i hears it at t0 + ||p - s_i|| / V, plus timing noise. An estimator sees
only the stations and their arrival times, and returns (x, y, t0).

    from where_start import evaluate

    def estimate(stations, arrivals):
        i = arrivals.argmin()
        return stations[i, 0], stations[i, 1], arrivals[i]

    evaluate(estimate)          # 1000 quakes of the official setup

Seeded: the same seed gives the same quakes, whatever the estimator.
"""
import math
import numbers

import numpy as np

# wave speed, km/s
V = 6.0

# side of the square region, km
SIZE = 200.0

# the graded setup: stations per quake
OFFICIAL = dict(n_station=12)

# an estimate within this many km of the epicenter is a hit
HIT_KM = 5.0

# hits needed (fraction of quakes) to qualify for the leaderboard
HIT_BAR = 0.9


class Quake:
    """One earthquake, recorded by n_station seismographs.

    Attributes you may use:
        stations (np.array): (n_station, 2) station positions, km
        arrivals (np.array): (n_station,) recorded arrival times, s
        n_station (int): number of stations

    Everything starting with an underscore is the hidden truth: peeking at
    it is cheating (an estimator only ever sees stations and arrivals).

    Hidden truth:
        _p (np.array): (2,) epicenter, km
        _t0 (float): origin time, s
        _noise_sd (float): timing noise sd at every station, s
    """

    def __init__(self, stations, p, t0, noise_sd, seed=None):
        """Record the quake at every station.

        Args:
            seed (int | list | np.random.Generator | None): seeds the
                timing noise; a Generator is used as is
        """
        rng = np.random.default_rng(seed)
        self.stations = np.asarray(stations, dtype=float)
        self.n_station = len(self.stations)
        self._p = np.asarray(p, dtype=float)
        self._t0 = float(t0)
        self._noise_sd = float(noise_sd)
        dist = np.linalg.norm(self.stations - self._p, axis=1)
        self.arrivals = (self._t0 + dist / V
                         + rng.normal(0, self._noise_sd, self.n_station))

    @classmethod
    def sample(cls, seed=None, n_station=12):
        """Draw a random quake.

        Stations and epicenter are uniform over the region, t0 uniform in
        0..10 s, timing noise sd log-uniform in 0.1..0.4 s.

        Args:
            seed (int | list | None): seeds the quake and its recordings
            n_station (int): stations recording it
        """
        rng = np.random.default_rng(seed)
        stations = rng.uniform(0, SIZE, (n_station, 2))
        p = rng.uniform(0, SIZE, 2)
        t0 = rng.uniform(0, 10)
        noise_sd = math.exp(rng.uniform(math.log(.1), math.log(.4)))
        # the noise continues this stream: a small sub-seed could be
        # searched for from the arrivals, revealing the truth
        return cls(stations, p, t0, noise_sd, seed=rng)

    def residual(self, theta):
        """Return predicted minus recorded arrival at each station.

        Args:
            theta (tuple): (x, y, t0) in (km, km, s)

        Returns:
            r (np.array): (n_station,) residual, s
        """
        dist = np.linalg.norm(self.stations - np.asarray(theta[:2]), axis=1)
        return theta[2] + dist / V - self.arrivals


def check_estimate(est):
    """Return est as three floats (x, y, t0), or raise if it isn't.

    Raises:
        TypeError: est isn't three numbers
        ValueError: one of them isn't finite
    """
    try:
        vals = [v.item() if hasattr(v, 'item') else v
                for v in np.asarray(est, dtype=object).ravel()]
    except Exception:
        vals = None
    if (vals is None or len(vals) != 3
            or not all(isinstance(v, numbers.Real) for v in vals)):
        raise TypeError(f'estimate returned {est!r:.80}, not three numbers '
                        f'(x, y, t0)')
    vals = [float(v) for v in vals]
    if not all(math.isfinite(v) for v in vals):
        raise ValueError(f'estimate returned {vals}: not all finite')
    return tuple(vals)


def sample(seed, idx, n_station=12):
    """Return quake idx of a seed: the same quakes evaluate() uses.

    Seeded with [seed, idx], every bit of seed counts (the re-run's secret
    seed has 63).
    """
    return Quake.sample([seed, idx], n_station)


def evaluate(estimate, n_quake=1000, seed=0, n_station=12, verbose=True):
    """Run estimate on n_quake random quakes; summarize its errors.

    Args:
        estimate (Callable): estimate(stations, arrivals) -> (x, y, t0)
        n_quake (int): quakes to try
        seed (int): same seed, same quakes

    Returns:
        result (dict): {hit_rate, mean_km, median_km, p90_km, error_km,
            t0_error}; error_km (n_quake,) is ||p_hat - p|| per quake,
            t0_error (n_quake,) is t0_hat - t0
    """
    err, dt = [], []
    for idx in range(n_quake):
        q = sample(seed, idx, n_station)
        x, y, t0 = check_estimate(estimate(q.stations.copy(),
                                           q.arrivals.copy()))
        err.append(math.dist((x, y), q._p))
        dt.append(t0 - q._t0)
    err = np.array(err)
    result = dict(hit_rate=float(np.mean(err <= HIT_KM)),
                  mean_km=float(err.mean()),
                  median_km=float(np.median(err)),
                  p90_km=float(np.percentile(err, 90)),
                  error_km=err, t0_error=np.array(dt))
    if verbose:
        print(f'{n_quake} quakes: within {HIT_KM:g} km '
              f'{result["hit_rate"]:.1%} of the time (need '
              f'{HIT_BAR:.0%}), {result["mean_km"]:.2f} km off on average')
    return result

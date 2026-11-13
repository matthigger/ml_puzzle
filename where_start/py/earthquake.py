""" Earthquake: find the epicenter from when each station felt the shaking

An earthquake starts at a hidden epicenter y and its shock wave spreads out
through the ground at a constant speed. Each of n stations at known
positions x[i] records how long after the quake started it felt the
shaking, t[i] (seconds), plus a little timing noise.

    from earthquake import Earthquake

    quake = Earthquake(seed=0)    # 10 stations, defaults below
    quake.x                       # (n, 2) station positions, km
    quake.t                       # (n,) delay before each station felt it, s
    quake.speed                   # wave speed, km/s
    quake.evaluate([3.1, -7.2])   # mean squared error of a guess, km^2
"""
import numpy as np

# P (first arriving) waves travel about 5 to 7 km/s through the upper crust
SPEED = 6.0


class Earthquake:
    """ one earthquake recorded by n stations

    Stations and epicenter are n + 1 independent draws from the same bell
    curve, centered at (0, 0), so the epicenter is "just another location".
    The bell curve is scaled so that two random locations are, on average,
    spacing km apart.

    Attributes you may use:
        x (np.array): (n, 2) station positions, km
        t (np.array): (n,) seconds from the quake's start until each station
            felt it: distance / speed, plus timing noise (never below 0)
        n, speed, spacing, noise_sd: the parameters below

    Everything starting with an underscore is the hidden truth: peeking at
    it is cheating.
    """

    def __init__(self, n=10, speed=SPEED, spacing=50, noise_sd=.2, seed=None):
        """
        Args:
            n (int): number of stations
            speed (float): wave speed through the ground, km/s
            spacing (float): average distance between two locations, km
            noise_sd (float): standard deviation of each station's timing
                error, s
            seed (int): seeds the locations and the noise
        """
        assert n >= 1, 'need at least 1 station'
        rng = np.random.default_rng(seed)

        # the distance between two draws with per-axis sd s averages
        # s * sqrt(pi), so this sd gives an average spacing of spacing
        loc = rng.normal(0, spacing / np.sqrt(np.pi), size=(n + 1, 2))
        self._y = loc[:1]
        self.x = loc[1:]

        dist = np.linalg.norm(self.x - self._y, axis=1)
        self.t = np.maximum(dist / speed + rng.normal(0, noise_sd, n), 0)

        self.n = n
        self.speed = speed
        self.spacing = spacing
        self.noise_sd = noise_sd

    def evaluate(self, y_hat):
        """ mean squared error of a guess at the epicenter

        Args:
            y_hat (array-like): (x, y) guess, km, shape (2,) or (1, 2)

        Returns:
            mse (float): mean over both coordinates of the squared error,
                km^2. This is half the squared distance between y_hat and
                the epicenter: the guess missed by sqrt(2 * mse) km
        """
        y_hat = np.asarray(y_hat, dtype=float).reshape(1, 2)
        return float(np.mean((y_hat - self._y) ** 2))

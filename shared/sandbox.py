"""Run a leaderboard entry's code in a bubblewrap sandbox.

Each puzzle's verify/verify.py re-runs an entry by starting its
verify/child.py here and talking to it over stdin / stdout. Inside, the code
sees the files passed in (at /verify), the Python running verify.py with its
packages, and the read-only system: not the network, the environment (so not
the database key), any home directory or another process. It runs as
nobody, with at most MAX_AS of memory, MAX_PROC processes, MAX_FILE per file
and a TMP_SIZE /tmp.

Needs bubblewrap (apt install bubblewrap) and unprivileged user namespaces
(on Ubuntu, bubblewrap's AppArmor profile or
kernel.apparmor_restrict_unprivileged_userns=0); check() says whether they
work here.
"""
import functools
import subprocess
import sys

# address space (the libraries and a LassoCV fit peak near 0.5 GB),
# processes and threads, bytes per file, and /tmp
MAX_AS = 2 << 30
MAX_PROC = 64
MAX_FILE = 64 << 20
TMP_SIZE = 64 << 20

ENV = {
    'PATH': '/usr/bin:/bin',
    'HOME': '/tmp',
    'MPLBACKEND': 'Agg',
    'MPLCONFIGDIR': '/tmp/mpl',
    # one core each: parallel re-runs share the machine
    'OMP_NUM_THREADS': '1',
    'OPENBLAS_NUM_THREADS': '1',
    'MKL_NUM_THREADS': '1',
}


@functools.cache
def _caps_tmpfs() -> bool:
    """Return whether this bwrap can cap a tmpfs (--size, bubblewrap 0.10)."""
    out = subprocess.run(['bwrap', '--help'], capture_output=True, text=True)
    return '--size' in out.stdout + out.stderr


def command(files: dict) -> list:
    """Return the argv that runs /verify/child.py in a sandbox.

    Args:
        files (dict): {name: host path} of files bound read-only at
            /verify/name; child.py among them

    Returns:
        argv (list): bwrap, then the limits (prlimit), then python
    """
    if not _caps_tmpfs():
        raise RuntimeError('this bwrap cannot cap /tmp (no --size)')
    argv = ['bwrap', '--unshare-all', '--die-with-parent', '--new-session',
            '--clearenv', '--uid', '65534', '--gid', '65534',
            '--cap-drop', 'ALL',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
            '--ro-bind-try', '/etc/fonts', '/etc/fonts',
            '--proc', '/proc', '--dev', '/dev',
            '--size', str(TMP_SIZE), '--tmpfs', '/tmp', '--chdir', '/tmp']
    for d in sorted({sys.prefix, sys.base_prefix} - {'/usr'}):
        argv += ['--ro-bind', d, d]
    for name, path in files.items():
        argv += ['--ro-bind', str(path), f'/verify/{name}']
    # bwrap's own root is a tmpfs: read-only, so /tmp is all it can write
    argv += ['--remount-ro', '/']
    for k, v in ENV.items():
        argv += ['--setenv', k, v]
    # set inside: outside, the process count would include every process of
    # the account running verify.py
    argv += ['/usr/bin/prlimit', f'--as={MAX_AS}', f'--nproc={MAX_PROC}',
             f'--fsize={MAX_FILE}', '--']
    return argv + [sys.executable, '-I', '-B', '/verify/child.py']


def check() -> None:
    """Raise unless a sandbox runs here, so a re-run stops before it
    touches an entry.

    Raises:
        RuntimeError: says why (no bwrap, no user namespaces, ...)
    """
    try:
        argv = command({})[:-4] + [sys.executable, '-I', '-c', 'print("ok")']
        out = subprocess.run(argv, capture_output=True, text=True,
                             timeout=60)
    except OSError as exc:
        raise RuntimeError(f'no sandbox: {exc}') from exc
    if out.stdout.strip() != 'ok':
        raise RuntimeError('no sandbox: ' + out.stderr.strip()[-500:])


def start(files: dict) -> subprocess.Popen:
    """Start /verify/child.py in a sandbox, talking over text pipes.

    Killing the returned process kills everything in the sandbox.

    Args:
        files (dict): see command()
    """
    return subprocess.Popen(command(files), stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)

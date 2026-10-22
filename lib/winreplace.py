"""os.replace for state files another process reads (the reporter, the reconciler, the runtime).

Windows: the replace fails with PermissionError (WinError 5) while a reader holds the target
open without FILE_SHARE_DELETE (CPython's open, Defender scanning it); those reads last
milliseconds, so wait them out, about 1.25 s in all. POSIX replace never conflicts with readers.
Stdlib only: the bare-script workers (president_worker, capital_worker) import it with lib/ as
sys.path[0]. runtime/atomic_file.replace_retry is the runtime's copy (separate update channel).

The reader's side of the same window: opening the target while another process's replace swaps
it (or Defender scans it) raises PermissionError (Errno 13) on Windows — read_retry / load_json
wait it out with the same delays. Only PermissionError: a missing file stays FileNotFoundError.
"""
import json
import os
import time

REPLACE_RETRY_DELAYS = (0.05, 0.1, 0.2, 0.4, 0.5) if os.name == "nt" else ()


def atomic_replace(src, dst):
    for delay in REPLACE_RETRY_DELAYS:
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            time.sleep(delay)
    os.replace(src, dst)


def read_retry(read, *args, **kwargs):
    for delay in REPLACE_RETRY_DELAYS:
        try:
            return read(*args, **kwargs)
        except PermissionError:
            time.sleep(delay)
    return read(*args, **kwargs)


def _load_json(path, open_kw):
    with open(path, **open_kw) as f:
        return json.load(f)


def load_json(path, **open_kw):
    """json.load(open(path, **open_kw)), the open inside the retry."""
    return read_retry(_load_json, path, open_kw)

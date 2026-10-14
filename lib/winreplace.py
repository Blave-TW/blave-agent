"""os.replace for state files another process reads (the reporter, the reconciler, the runtime).

Windows: the replace fails with PermissionError (WinError 5) while a reader holds the target
open without FILE_SHARE_DELETE (CPython's open, Defender scanning it); those reads last
milliseconds, so wait them out, about 1.25 s in all. POSIX replace never conflicts with readers.
Stdlib only: the bare-script workers (president_worker, capital_worker) import it with lib/ as
sys.path[0]. runtime/atomic_file.replace_retry is the runtime's copy (separate update channel).
"""
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

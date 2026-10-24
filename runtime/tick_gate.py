"""How many Type A/C live ticks (manager/wait_for_bar.py children) the scheduler runs at once.

Stdlib plus runtime/refresh_capacity only. Decides only WHEN a tick's subprocess starts — what
the tick computes and which bar it judges stay entirely in the workspace's wait_for_bar.py.

Why (bench 10-11, 2 GB / 2 vCPU box): five 1m strategies started in the same second cost
7.4 CPU-s per tick against 4.0–4.5 s run alone — five 400–600 MB interpreters in 1.9 GB swap,
sys time triples, and wall time runs past the minute. A cap turns that into a short queue.

Rules:
- Limit = min(cores, total RAM // TICK_MB), at least 1. BLAVE_TICK_CONCURRENCY=<n> overrides;
  0 / off = no gate at all (the scheduler spawns every tick at once, exactly as before).
- Shorter INTERVAL first (a 1m strategy's bar is gone in a minute, a 1h one waits an hour),
  then queue order; the order within a cycle rotates so no strategy is always last.
- A name already queued or running is not queued again: its next tick would only hit
  wait_for_bar's own lock or fast path.
- A slot is held until the tick exits or LEASE_SECONDS pass, whichever is first: one slow
  fetch (up to the 1800 s tick timeout) must not stall every other strategy — the uid 21894
  starvation the parallel scheduler exists to prevent.
- A waiter is let through after MAX_WAIT_SECONDS whatever the count, and a <5m one at its
  caller's `release_at` (the scheduler passes :45 of the minute): a 1m bar is gone in 60 s, so
  waiting longer only trades CPU for a bar never computed.
"""
import itertools
import os
import threading
import time

import refresh_capacity

ENV = "BLAVE_TICK_CONCURRENCY"
TICK_MB = 768            # bench: one tick's interpreters peak at 400–600 MB RSS
LEASE_SECONDS = 20       # a healthy tick takes 4–7 s alone; ~19 s is the slowest 1% seen
MAX_WAIT_SECONDS = 300
POLL_SECONDS = 0.2       # lease expiry has no notify; waiters re-check this often
OFF_VALUES = ("0", "off")


def default_limit(mem_mb=None, cpus=None):
    cpus = os.cpu_count() if cpus is None else cpus
    by_cpu = max(1, cpus or 1)
    if not mem_mb:
        return by_cpu
    return max(1, min(by_cpu, int(mem_mb) // TICK_MB))


def configured_limit(value, mem_mb=None, cpus=None):
    """(limit, note): limit None = gate off. `note` explains an ignored value, else None."""
    v = (value or "").strip().lower()
    if v in OFF_VALUES:
        return None, None
    if v and v != "auto":
        try:
            n = int(v)
        except ValueError:
            n = 0
        if n > 0:
            return n, None
        note = f"{ENV}={value!r} not understood — using the default"
    else:
        note = None
    if mem_mb is None:
        mem_mb = refresh_capacity.total_memory_mb()
    return default_limit(mem_mb, cpus), note


class TickGate:
    def __init__(self, limit, lease=LEASE_SECONDS, max_wait=MAX_WAIT_SECONDS,
                 clock=time.monotonic, poll=POLL_SECONDS, wall=time.time):
        self.limit = limit
        self._lease, self._max_wait, self._clock, self._poll = lease, max_wait, clock, poll
        self._wall = wall
        self._cond = threading.Condition()
        self._seq = itertools.count()
        self._cycle = 0
        self._waiting = {}   # name -> (priority, seq)
        self._running = {}   # name -> start time on self._clock

    def enqueue(self, items):
        """items: [(name, priority)] for one scheduler cycle, lower priority first. Returns the
        names queued, in queue order, leaving out names already queued or running."""
        groups = {}
        for name, prio in sorted(items):
            groups.setdefault(prio, []).append(name)
        out = []
        with self._cond:
            k = self._cycle
            self._cycle += 1
            order = []
            for prio in sorted(groups):
                g = groups[prio]
                r = k % len(g)
                order += [(n, prio) for n in g[r:] + g[:r]]
            for name, prio in order:
                if name in self._waiting or name in self._running:
                    continue
                self._waiting[name] = (prio, next(self._seq))
                out.append(name)
        return out

    def cancel(self, name):
        with self._cond:
            self._waiting.pop(name, None)
            self._cond.notify_all()

    def _busy(self, now):
        return sum(1 for t in self._running.values() if now - t < self._lease)

    def run(self, name, fn, release_at=None):
        """Wait for `name`'s turn (or until wall-clock `release_at`), run fn(), free the slot.
        Returns seconds waited."""
        start = self._clock()
        with self._cond:
            while True:
                if name not in self._waiting:
                    raise KeyError(name)
                now = self._clock()
                head = min(self._waiting.values()) == self._waiting[name]
                if ((head and self._busy(now) < self.limit) or now - start >= self._max_wait
                        or (release_at is not None and self._wall() >= release_at)):
                    break
                self._cond.wait(self._poll)
            del self._waiting[name]
            self._running[name] = now
            self._cond.notify_all()
        try:
            fn()
        finally:
            with self._cond:
                self._running.pop(name, None)
                self._cond.notify_all()
        return now - start

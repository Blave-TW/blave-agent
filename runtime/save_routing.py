"""Which venue each portfolio member routes to after the next 下單設定 save.

One rule for the save itself (command_listener._cmd_amounts) and for the report
(portfolio_reporter `save_routing`), so the pages' save dialog lists exactly
the orders the saved config makes the reconciler send — they read the report,
they do not re-derive the bound set (their venues() view also asks for order /
account libs, the save does not; it asks for the bind manifest instead).

Stdlib + atomic_file + venue_traits only: the reporter imports this and must not import
command_listener (tests/check_sched_bash_guard.py ③)."""
import os
import re

import atomic_file
import venue_traits

_CRED_ENV_RE = re.compile(
    r"^([A-Za-z0-9_]+)_(API_KEY|SECRET_KEY|PASSWORD|PASSPHRASE)$", re.IGNORECASE
)
# Only the platform's own data-API keys survive a venue bind. TW brokers are
# in the eviction pool like any exchange — one bound trading venue per
# machine, TW included (2026-08-07 拍板). ADMIN added defensively after the
# B6 PASSWORD-suffix fix made `admin_password` (RDP recovery cred on older
# machines) match _CRED_ENV_RE for the first time: harmless today (no
# admin_api_key sibling exists anywhere), but one future admin_api_key write
# away from being read as a "bound venue" and silently evicted by an unrelated
# rebind — see the RDP Password Incident this fleet already had.
_CRED_KEEP_IDS = {"BLAVE", "ADMIN"}
# Data-source credentials are named DATA_<SOURCE>_<FIELD> (BYO Data). A
# DATA_POLYGON_API_KEY + DATA_POLYGON_SECRET_KEY pair has the exact shape of a
# bound venue, and read as one it gets evicted by the next exchange bind — with
# a HALT for a venue that never existed. A prefix, not a _CRED_KEEP_IDS entry:
# the source list is open-ended and that set is an exact match.
_DATA_CRED_PREFIX = "DATA_"


def _cred_match(name):
    """(ID, SUFFIX) of a credential env name, or None. A venue's own names
    (venue_traits cred_env — 統一's president_account is its API_KEY-role key)
    are read first: through the pair regex alone 統一 never looks bound, and
    president_ca_password reads as a phantom PRESIDENT_CA venue."""
    own = venue_traits.cred_env(name)
    if own:
        return own
    m = _CRED_ENV_RE.match(name)
    return (m.group(1).upper(), m.group(2).upper()) if m else None


def _is_data_cred_id(cred_id):
    return cred_id.upper().startswith(_DATA_CRED_PREFIX)


def _venue_cred_ids(lines, skip_ids=frozenset()):
    """IDs holding a complete credential pair ({ID}_API_KEY + one of
    {ID}_SECRET_KEY / {ID}_PASSWORD / {ID}_PASSPHRASE) in these .env lines —
    the pair IS a bound venue, TW brokers same pool; a lone key with no
    secret-shaped sibling is a service key (OPENAI_API_KEY), not a venue.
    Single source for both the eviction sweep and bound/unbound checks — so
    DATA_* ids (data sources, never a venue) are dropped here, once, for the
    eviction sweep, the bind manifest, routing inheritance and the scheduler's
    bound check alike.
    Capital's shape is {ID}_API_KEY + {ID}_PASSWORD (canonical env names
    decided 2026-08-14, references/capital-broker.md) — PASSWORD joined the
    accepted secret suffixes for this (fixes audit B6: capital never read as
    bound, so every 下單設定 save wiped its `exchanges` routing)."""
    suffixes = {}
    for l in lines:
        m = _cred_match(l.split("=", 1)[0].strip())
        if m and m[0] not in _CRED_KEEP_IDS | skip_ids and not _is_data_cred_id(m[0]):
            suffixes.setdefault(m[0], set()).add(m[1])
    return {
        i for i, s in suffixes.items()
        if "API_KEY" in s and s & {"SECRET_KEY", "PASSWORD", "PASSPHRASE"}
    }


def manifest_ids(workspace):
    """Lowercased ids from manager/credentials.ui.json, or None when
    absent/invalid — mirrors lib/venue_wiring's fail-open reader."""
    try:
        ids = atomic_file.load_json(os.path.join(workspace, "manager", "credentials.ui.json")).get("ids")
        if not isinstance(ids, list):
            return None
        return {str(i).lower() for i in ids}
    except (OSError, ValueError, AttributeError):
        return None


def bound_ids(workspace):
    """Venues a save may route to: a complete .env pair, and — when the UI bind
    manifest exists — bound through the UI too (P2-4: keys an agent hand-wrote
    into .env don't route; lib/venue_wiring filters them). Unreadable .env = none."""
    bound = set()
    try:
        # the reporter reads this too, while command_listener may be replacing .env: retried read
        text = atomic_file.read_bytes(os.path.join(workspace, ".env")).decode("utf-8", "replace")
        # pair rule (_venue_cred_ids): a lone OPENAI_API_KEY must not get
        # inferred as a venue and written into exchanges as a routing target
        bound = {i.lower() for i in _venue_cred_ids(text.splitlines())}
    except OSError:
        pass
    manifest = manifest_ids(workspace)
    if manifest is not None:
        bound &= manifest
    return bound


def plan(old_exchanges, bound):
    """(kept, default): the config's routes that still point at a bound venue
    ("" for the rest — after 解除綁定 + 重連別家 the old routing would otherwise
    zombie back in), and the venue every other member inherits: the one venue
    those kept routes use, else the machine's one bound venue, else ""."""
    old = old_exchanges if isinstance(old_exchanges, dict) else {}
    # a hand-edited route that is not a string (list / dict) is no venue: treat it as "" instead
    # of raising (unhashable) — the report must not go dark over one bad value
    kept = {k: (v if isinstance(v, str) and v in bound else "") for k, v in old.items()}
    venues = {v for v in kept.values() if v}
    default = venues.pop() if len(venues) == 1 else ""
    if not default and len(bound) == 1:
        default = next(iter(bound))
    return kept, default


def report(cfg, workspace):
    """The report's `save_routing`: {bound, default, routes} — a member in
    `routes` saves to routes[name], any other (a draft) to `default`; "" = no
    route (the reconciler leaves it alone). None when the config is unreadable."""
    if not isinstance(cfg, dict):
        return None
    bound = bound_ids(workspace)
    kept, default = plan(cfg.get("exchanges") or {}, bound)
    return {"bound": sorted(bound), "default": default,
            "routes": {str(k): (v or default) for k, v in kept.items()}}

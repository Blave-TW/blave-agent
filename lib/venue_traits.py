"""Which venues break the crypto auto-wire contract, and how.

Every branch in manager/, lib/ and runtime/ that behaves differently for a
Taiwan broker asks this table instead of comparing a venue id string, so
wiring in another broker is one row here plus its own libs — not a hunt
through the reconciler, flatten and the runtime for `== "capital"`.
tests/check_venue_traits.py fails on a bare venue-id literal outside this
file, the venue's own libs, and runtime/venue_traits.py (a verbatim copy:
the runtime ships on its own channel and may sit on an older workspace).

A missing trait means the crypto default (auto-wired, perp, sized in
account currency). Trait meanings:
  auto_wire          False: lib.venue_wiring never routes it (signed-diff
                     contract; the reconciler or nothing handles it)
  hand_wired         manager/reconciler.py routes get_positions/place_order
                     to this venue's own block when a strategy is bound to it
  native_units       rows are diffed in lots, not account currency
  perp               False: manager/close_symbol.py refuses it
  windows_identity   only a password-logon Windows Administrator can log in
                     to it: flatten skips it under any other identity, the
                     report's can_flatten says so, the reconciler service
                     runs as Administrator
  resolved_contracts positions come back as root+YYMM contract codes
                     (TM2610) that flatten maps to the book key (TMF)
  lots_close_partial flatten closes its lots through close_position_partial
                     (not place_contract_market_order)
  close_needs_fill   flatten books a close as done only on a confirmed fill
  reference          the onboarding doc chat binding points to
"""

CAPITAL = "capital"

TRAITS = {
    CAPITAL: {
        "auto_wire": False,
        "hand_wired": True,
        "native_units": True,
        "perp": False,
        "windows_identity": True,
        "resolved_contracts": True,
        "lots_close_partial": True,
        "close_needs_fill": True,
        "reference": "references/capital-broker.md",
    },
    "sinopac": {
        "auto_wire": False,
        "perp": False,
        "reference": "references/sinopac-broker.md",
    },
    "president": {
        "auto_wire": False,
        "perp": False,
        "reference": "references/president-broker.md",
    },
}

_DEFAULTS = {"auto_wire": True, "perp": True}


def get(venue, trait):
    # exact id match, no case folding: the branches this replaced compared == "capital"
    row = TRAITS.get(venue, {}) if isinstance(venue, str) else {}
    return row.get(trait, _DEFAULTS.get(trait, False))


def has(venue, trait):
    return bool(get(venue, trait))


def venues(trait, value=True):
    """Venue ids whose `trait` equals `value` (defaults applied)."""
    return frozenset(v for v in TRAITS if get(v, trait) == value)


def hand_wired_routed(exchanges):
    """The first hand-wired venue among `exchanges` (portfolio_config's
    strategy -> venue values), or None."""
    for v in exchanges or ():
        if has(v, "hand_wired"):
            return v
    return None

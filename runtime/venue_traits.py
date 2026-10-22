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
  label              the broker's name in user-facing messages
  verified_modes     the account types whose real-account run passed (Bitget:
                     "uta" / "classic"). Declared only by a venue whose libs ship
                     ahead of that run (venue-onboarding §3). Empty = unverified:
                     never auto-wired, never read by runtime/account_reader, not
                     bindable from chat, and the venue's own libs sign nothing.
                     Non-empty: the venue wires, and its libs refuse a key whose
                     account is of a type not listed (bind and every read say
                     so). The libs read the raw cell (verified_modes()), so a
                     deleted row or cell stays closed. Filled in by the backend in
                     the commit that merges the verified libs.
"""

CAPITAL = "capital"
PRESIDENT = "president"

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
        "label": "群益",
    },
    "sinopac": {
        "auto_wire": False,
        "perp": False,
        "reference": "references/sinopac-broker.md",
        "label": "永豐金",
    },
    # libs shipped, real-account run pending (.claude/output/backend/bitget-real-verify-0.1.29.md):
    # a machine with BITGET_* in .env (the web's old Bitget row) must not start trading on an update
    "bitget": {
        "verified_modes": (),
        "reference": "references/exchange-connect.md",
        "label": "Bitget",
    },
    PRESIDENT: {
        "auto_wire": False,
        "hand_wired": True,
        "native_units": True,
        "perp": False,
        "close_needs_fill": True,
        "reference": "references/president-broker.md",
        "label": "統一期貨",
        # the five names bound machines already use are locked; the last two
        # switch to production
        "cred_env": {
            "president_account": "API_KEY",
            "president_password": "PASSWORD",
            "president_test_url": "EXTRA",
            "president_ca_path": "EXTRA",
            "president_ca_password": "EXTRA",
            "president_url": "EXTRA",
            "president_live": "EXTRA",
        },
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


def verified_modes(venue):
    """The account types a venue's own libs may trade (raw cell: a venue whose row has no
    verified_modes gets () here — its libs stay shut). Only those libs ask this."""
    row = TRAITS.get(venue, {}) if isinstance(venue, str) else {}
    return tuple(row.get("verified_modes") or ())


def unverified():
    """Venue ids that declare verified_modes and have none yet: kept off every surface. A
    venue without the cell (every venue that shipped verified, an agent-written lib)
    is not in it."""
    return frozenset(v for v, t in TRAITS.items() if "verified_modes" in t and not t["verified_modes"])


def cred_env(name):
    """(VENUE_ID, role) when `name` is one of a venue's own cred_env names
    (case-insensitive), else None."""
    n = str(name or "").strip().casefold()
    for v, t in TRAITS.items():
        role = (t.get("cred_env") or {}).get(n)
        if role:
            return v.upper(), role
    return None


def hand_wired_routed(exchanges):
    """The first hand-wired venue among `exchanges` (portfolio_config's
    strategy -> venue values), or None."""
    for v in exchanges or ():
        if has(v, "hand_wired"):
            return v
    return None

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
  snapshot_settle_wait  the worker's position snapshot lags an order sent on
                     this machine: flatten reads it only once a read started
                     lib.<venue>_vault.ORDER_SETTLE_S after the last send
                     (last_order_at on the vault, else on lib.order_<venue>)
  bound_marker       a workspace-relative file only this venue's own bind leaves, never
                     removed: without it the venue's keys are left over from before
                     (dormant()) — never read by runtime/account_reader, never flattened
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

Crypto cells, read by lib.venue_wiring.instrument_gate / kline_venue. Every crypto
venue with a lib/order_<id>.py declares the two gate cells explicitly
(tests/check_crypto_venue_traits.py), so a venue left out of a check says why here:
  instrument_class   which classes its get_contract_rules "category" reports, compared
                     with Binance's underlyingType before an entry on Binance bars:
                     "coin_stock_commodity" (all three), "stock" (only a stock is
                     citable; anything else falls back to the coin-vs-US-stock mirror
                     on "equity"), None (not compared)
  binance_name_gate  an entry on Binance bars into a ticker Binance does not list is
                     refused: this venue names multiplied coins per coin (PEPEUSDT)
                     where Binance's bars are per 1000 (1000PEPEUSDT)
  native_kline       the lib.data fetcher that reads this venue's own contract (a
                     strategy only on it is not compared with Binance)
"""

import os

CAPITAL = "capital"
PRESIDENT = "president"
SINOPAC = "sinopac"

# Futures only: the odd-lot stock path was removed (Wei 2026-11-17; Blave orders no TW stock).
# lib/sinopac_worker, lib/order_sinopac and the reconciler's _sinopac_* block stay shut until
# their real-account run passes; the commit that merges it sets ("futures",) here and renames
# lib/sinopac_futures_account.py to lib/account_sinopac.py. Empty = unverified(): account_reader,
# flatten and chat binding leave 永豐 alone, so a machine still holding the odd-lot era's
# sinopac_* keys shows no read failure; hand_wired / native_units follow it.
_SINOPAC_MODES = ()
_SINOPAC_FUTURES = "futures" in _SINOPAC_MODES

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
        "snapshot_settle_wait": True,
        "reference": "references/capital-broker.md",
        "label": "群益",
    },
    SINOPAC: {
        "auto_wire": False,
        "hand_wired": _SINOPAC_FUTURES,
        "native_units": _SINOPAC_FUTURES,
        "perp": False,
        "close_needs_fill": True,
        # M0-b 2026-11-16: list_positions right after a Filled order still read []; the wait
        # (lib/sinopac_vault.ORDER_SETTLE_S, 20 s) is borrowed, the lag itself was not timed
        "snapshot_settle_wait": True,
        "verified_modes": _SINOPAC_MODES,
        # lib/sinopac_worker.ENABLED_PATH, written by its first start (only a futures bind starts it)
        # and never removed: keys from the odd-lot era alone are never read or flattened; a machine
        # that has had futures reads a lost snapshot as an error and close-all reports 永豐 failed
        "bound_marker": "state/sinopac_futures_enabled.json",
        "reference": "references/sinopac-broker.md",
        "label": "永豐金",
        # the lowercase names odd-lot machines were bound with (web CX_VENUES) are locked; an
        # unbind drops all six, the CA password (often the national id) included
        "cred_env": {
            "sinopac_api_key": "API_KEY",
            "sinopac_secret_key": "SECRET_KEY",
            "sinopac_ca_path": "EXTRA",
            "sinopac_ca_passwd": "EXTRA",
            "sinopac_person_id": "EXTRA",
            "sinopac_live": "EXTRA",
        },
    },
    # real-account runs passed on a classic account (2026-10-22, both position modes) and a UTA
    # (T1–T12; T11c's stop-loss re-run 2026-10-26)
    "bitget": {
        "verified_modes": ("classic", "uta"),
        "reference": "references/exchange-connect.md",
        "label": "Bitget",
        # v3 symbolType / instrumentType stock|etf (lib/stock_perps.bitget_is_stock). Its
        # metal class covers PAXGUSDT / XAUTUSDT, which Binance lists as coins (2026-10-28)
        "instrument_class": "stock",
        # multiplied-coin names not in references/lib.md's table: unverified, not gated
        "binance_name_gate": False,
    },
    # instCategory 1 crypto / 3 stocks / 4 commodities (measured 2026-11-14); PEPE-USDT-SWAP
    # is per coin where Binance has 1000PEPEUSDT (references/lib.md, multiplied contracts)
    "okx": {"label": "OKX", "native_kline": "fetch_okx_kline",
            "instrument_class": "coin_stock_commodity", "binance_name_gate": True},
    # contract_type "stocks" (lib/order_gateio). Its "metals" covers PAXG_USDT, a coin on
    # Binance (2026-10-19). Name gate off until Gate.io has its own kline in lib.data: PEPE_USDT
    # is per coin (references/lib.md), but refusing it — and every Gate-only coin or stock perp
    # Binance does not list — would leave no bars to move to
    "gateio": {"label": "Gate.io", "instrument_class": "stock", "binance_name_gate": False},
    # symbolType stock / ETF (references/stock-perps.md); no commodity value verified.
    # Name gate off: SHIB1000USDT is Binance's 1000SHIBUSDT spelled otherwise (a name check
    # would refuse a matching contract); 10000SATSUSDT vs Binance 1000SATSUSDT is a real
    # 10x gap this leaves ungated (references/lib.md, multiplied contracts)
    "bybit": {"label": "Bybit", "instrument_class": "stock", "binance_name_gate": False},
    # stock swaps are NCSK… names only lib/stock_perps maps to, never a coin's; own bars
    "bingx": {"label": "BingX", "native_kline": "fetch_bingx_kline",
              "instrument_class": None, "binance_name_gate": False},
    # no class field read by its libs or documented (references/stockcoin-skill.md):
    # unverified, not compared
    "stockcoin": {"label": "StockCoin", "instrument_class": None, "binance_name_gate": False},
    # the data source itself
    "binance": {"label": "Binance", "instrument_class": None, "binance_name_gate": False},
    # the simulator: no venue contract to compare with
    "paper": {"instrument_class": None, "binance_name_gate": False},
    PRESIDENT: {
        "auto_wire": False,
        "hand_wired": True,
        "native_units": True,
        "perp": False,
        "close_needs_fill": True,
        "snapshot_settle_wait": True,
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


def dormant(workspace):
    """Venue ids nothing reads or flattens in `workspace`: unverified() ones, and a venue whose
    bound_marker file is not there."""
    return unverified() | frozenset(
        v for v, t in TRAITS.items()
        if t.get("bound_marker") and not os.path.exists(os.path.join(workspace, t["bound_marker"])))


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

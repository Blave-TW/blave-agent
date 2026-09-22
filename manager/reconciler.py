import hashlib, importlib, json, logging, os, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from lib import events, guard, venue_errors
from lib.portfolio import (reconcile, load_portfolio_config, strategy_amounts,
                           aggregate_portfolio)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

POLL_INTERVAL  = 5    # seconds between polls
THRESHOLD = 10   # minimum diff (in account currency) to place an order
                 # (lib/portfolio.spot_scope's threshold default tracks this)
MIN_ORDER_TTL_S = 60  # how long a symbol's venue minimum stays cached: the LOT
                      # is static for the session, its account-currency VALUE
                      # is not (it is the lot valued at mark). Shorter than the
                      # heartbeat on purpose — this dedupes the lookups WITHIN
                      # a round, it is not a cross-round cache
DISCONNECT_HALT_AFTER = 3  # 連續 N 次「認不得」的讀持倉失敗 → 自動 HALT
                           # (暫時性錯誤不計、金鑰被拒立刻 HALT,見 _on_read_failure)
UNREACHABLE_EVENT_AFTER_S = 1800  # 暫時性錯誤連續這麼久 → exchange_unreachable 事件
ACCOUNT_GUARD_PATH = 'state/venue_account.json'  # 帳戶守門:交易所帳號 id + 待確認
ACCOUNT_ID_READ_PATH = 'state/account_id_read.json'  # 最近一次帳號 id 讀取的結果,給平台看
OUTAGE_PATH = 'state/reconciler_outage.json'  # 進行中的暫時性斷線(重啟後接續計時)
OUTAGE_STALE_S = 3600  # 存檔的最後一次失敗比這還舊 → 載入時丟掉(daemon 停過一陣子)
ERROR_NOTIFY_COOLDOWN_S = 3600  # 對帳失敗通知最多每小時一則。計時是 per-process、
                               # 不分錯誤種類(一小時內換一種失敗也一樣被壓下,
                               # log 與 workspace 的 order_errors 照記):失敗會
                               # 持續到有人處理為止,每 5 分鐘一則只是洗到不看
RECONCILE_EVERY_S = 300  # 定期心跳對帳:就算沒有任何 mtime 變動也要每 5 分鐘
                         # 對一次帳——斷鏈、金鑰失效、倉位漂移不能等下一次訊號
                         # 變動(可能一小時後)才被發現


_min_order_gate = {}  # symbol -> (expires_at, entry-side gate, reduce-side gate)


def _symbol_threshold(symbol, reduce_only=False):
    """The reconcile gate for ONE symbol on ONE side.

    ENTRY legs: THRESHOLD, or the venue's own minimum order size when larger.
    venue_wiring._entry_qty rounds an entry half-up to a whole lot, so a gap
    under one lot buys a WHOLE lot and lands the position over target; the
    reduce leg that follows ceils to a whole lot and sells it back — on a
    coarse instrument (one BTC perp lot ≈ $78, against a flat gate of 10) that
    is a real buy/sell round trip every 300s, fees included. Gating entries at
    the venue's own minimum converges the leftover instead. Deliberately the
    ONE-LOT scale and not the half-lot rounding boundary: the boundary is not
    stable under a moving mark (a leftover of 0.53 lots would pass a half-lot
    gate and restart the churn).

    The 1.05 inside that minimum (lib.execute._venue_min_slice_usd) is there
    for THIS cache: the gate carries a mark up to MIN_ORDER_TTL_S old while the
    gap it judges is priced now. After a ceil-sell leaves the position 0.99
    lots short, a 2% rise inside the cache window would put the gap over a 1.0x
    gate — _entry_qty rounds it up to a whole lot, the next reduce ceils it
    back off, and the churn is back. Do not "simplify" it to 1.0 (pinned in
    tests/check_reconcile_threshold.py).

    REDUCE legs that leave part of the position (a shrink): THRESHOLD, or
    HALF a lot when larger. A leg that takes the WHOLE position off — target
    flat, or the close leg of a flip — never asks this function: lib.portfolio
    gates it at the flat THRESHOLD (`.flat` below, _close_threshold), see the
    end of this paragraph. The entry gate alone only shuts one direction of
    the churn — measured 2026-09-09 (uid 32321, 3 lots vs a $227 target): the
    mark drifted the position $10 over target, _reduce_qty ceiled that to a
    whole $79 lot, the flat gate let it through, and the resulting $69 gap was
    bought straight back. 442 real fills. Half a lot is the one value that
    converges on its own: an over-target under 0.5 lot is left alone; over it
    the ceil-sell leaves a gap of ceil(x) − x, i.e. < 1 lot, which is under the
    1.05-lot entry gate, so nothing buys it back. Anything ≥ one lot is fatal here: a
    position of exactly one lot could then not be closed or flipped AT ALL
    (the flat-10 rule this replaces was itself the fix for that P0), and any
    stale-mark buffer on top pushes toward that line — so none. 0.5 leaves a
    50% margin on a 60s-old mark. Under self_ledger a reduce leg is sized from
    the bot's own book and rounded to a lot (venue_wiring._book_reduce_qty), and
    the diff it is gated on is in the book's cost, not the mark — the gate is
    the same half lot, valued at the mark. That mismatch is why a whole-position
    close is NOT gated here: a one-lot book that more than doubled costs less
    than half a lot at the mark, so the signal said flat and no order went out,
    every round (N lots: mark/entry > 2N). Exempting it cannot bring the churn
    back — a full close leaves no ceil remainder, target 0 has no entry leg to
    buy it back, and a flip's entry leg is still gated at 1.05 lots. On an
    account-read book it changes nothing: a swap position is whole lots, always
    over half of one. Dust under the flat THRESHOLD is left alone either way.
    Spot and a failed lookup stay on the flat THRESHOLD.

    Native-unit rows (asset_spec.type futures_contracts / shares, capital) never
    reach here — lib.portfolio skips the account-currency threshold for them
    entirely. In account-read mode lib.portfolio also lays its drift band
    (max(5%, 2σ) of the target, same-side adjustments only) over both gates.
    """
    now = time.time()
    cached = _min_order_gate.get(symbol)
    if not (cached and cached[0] > now):
        try:
            from lib.execute import _venue_sizes_usd
            entry, lot_usd = _venue_sizes_usd(symbol, THRESHOLD)
        except Exception as e:
            # _venue_sizes_usd already degrades to the floor internally; this
            # only catches the import. Either way the fallback is the flat gate =
            # the behaviour before this function existed.
            logging.warning(f"[reconciler] venue minimum unavailable for {symbol} ({e})")
            entry, lot_usd = THRESHOLD, 0.0
        cached = (now + MIN_ORDER_TTL_S, entry, max(THRESHOLD, 0.5 * lot_usd))
        _min_order_gate[symbol] = cached
    return cached[2] if reduce_only else cached[1]


# lib.portfolio.compute_diff records a gate for the workspace only when it is
# above the flat one; with both sides venue-scaled now, neither side IS the
# flat value any more, so the callable carries it. It is also the gate
# lib.portfolio applies to a whole-position close (_close_threshold).
_symbol_threshold.flat = THRESHOLD


# ── 該不該對帳 ───────────────────────────────────────────────────────────────
# 這支 daemon 每輪先確認自己的前提,而不是靠外面把它停掉(level-triggered:
# 每輪重讀現況,不依賴收到某個事件)。實例 2026-09-09 uid 29026:web 解綁了
# 交易所,平台端 _stop_reconciler() 沒能確認停掉這支 daemon,於是它連續 16 小時
# 每 5 分鐘 raise 一次 "no officially-supported venue bound" 並各送一則 Telegram
# (190 則),而用戶正是刻意解綁的——那些通知沒有任何可採取的行動。
#
# 沒綁交易所 = 沒有可對帳的對象:跳過整輪(不讀持倉、不下單、不送通知),心跳照
# 打,重新綁定後下一輪自己恢復。這讓「daemon 還活著」從一天 288 則通知降級成
# 一支閒置 process,平台端停不停得掉不再是正確性問題。
#
# 刻意「只」擋沒綁 venue,不擋「amounts 全空」:把 下單設定 的金額設成 0 正是
# references/manager.md 教的平倉手法(「set the strategies' amounts to 0 from
# the web 下單設定 and let the reconciler close them」),擋掉會讓部位永遠關不掉。
_idle_logged = False


def _venue_bound():
    """這台機器現在有沒有綁著任何交易所/券商。

    讀的是綁定 manifest(manager/credentials.ui.json),不是 detect_venue()。
    detect_venue 走 official_venues(),而那支會跳過 venue_wiring._NON_AUTO
    ({sinopac, president, capital} —— 台灣券商走 signed-diff 契約、由本檔自己的
    capital 區塊接手,刻意不進自動接線),所以一台只綁群益期貨的機器 detect_venue
    會回 None —— 拿它當閘門會把整批台灣券商機器永遠鎖成閒置。manifest 沒有這個
    問題:它是平台在每次綁定/解綁時寫的 credential pair 清單,台灣券商與 paper
    都在裡面(_venue_cred_ids「TW brokers same pool」)。

    順帶:detect_venue 在綁了多個 venue 時每次呼叫都會 log 一則 WARNING,而這裡
    是每 5 秒一輪 —— 拿它當閘門等於一天多印一萬七千行。

    manifest 不存在或壞掉 → _ui_bound_ids() 回 None → 當成有綁(fail-open,與
    venue_wiring 自己的 routing 同一個方向):寧可多跑一輪對帳,也不要因為讀不到
    一個檔案就悄悄停掉一台真的在下單的機器。"""
    try:
        from lib.venue_wiring import _ui_bound_ids
        ids = _ui_bound_ids()
        return ids is None or bool(ids)
    except Exception as e:
        logging.warning(f"[reconciler] venue check failed ({e}) — assuming bound")
        return True


def _active_state_mtimes():
    """{strategy: state.json mtime} for funded strategies, plus the config
    itself — a reconcile is due when a SIGNAL moved or when the user changed
    the AMOUNTS (下單設定儲存); watching only state.json would leave a new
    allocation sitting unapplied until the next strategy tick."""
    mtimes = {}
    cfg_path = 'manager/portfolio_config.json'
    if os.path.exists(cfg_path):
        mtimes['__config__'] = os.path.getmtime(cfg_path)
    # HALT tripping/clearing must also trigger a round: 啟動下單 clears the
    # flag and the user expects orders within seconds, not at the next tick.
    halt_path = 'state/HALT'
    mtimes['__halt__'] = os.path.getmtime(halt_path) if os.path.exists(halt_path) else 0
    # an async execution (TWAP/custom, lib.execute) touches this on completion
    # so the residual gap converges within one poll, not the 5-min heartbeat
    kick_path = 'state/execution/kick'
    mtimes['__execution__'] = os.path.getmtime(kick_path) if os.path.exists(kick_path) else 0
    for name, amt in strategy_amounts().items():
        if amt <= 0:
            continue
        path = f'strategies/{name}/state.json'
        if os.path.exists(path):
            mtimes[name] = os.path.getmtime(path)
    return mtimes


# ── Capital (群益) hand-wired path ───────────────────────────────────────────
# TW brokers are excluded from lib.venue_wiring's auto-wire (_NON_AUTO) because
# the data shape differs from every crypto venue: LOTS not account-currency
# notional, buy/sell not long/short, and the resolved contract code (TM2608)
# differs from the order alias (TM0000) sent on the wire. This block converts
# between the two and activates ONLY when a strategy in portfolio_config
# routes to "capital" (get_positions) / the order carries exchange="capital"
# (place_order) — every other machine (crypto exchanges, the overwhelming
# majority of the fleet) falls straight through to the auto-wire calls below,
# completely untouched.
#
# capital_symbol / resolved_prefix derive MECHANICALLY from the strategy's
# SYMBOL (references/capital-broker.md Step 8) — not user config, so this
# table is read-only fact, not a per-deployment setting. Only TM0000 ->
# TM2608 is LIVE-VERIFIED (2026-08-14); TX00/MTX00's resolved-code prefix is
# inferred from the same alias-stripping convention and unverified — confirm
# on the first live TXF/MXF capital order and update this comment.
# contract_value is kept for reference/parity with the asset_specs table
# (capital-broker.md Step 8) — no longer read by this module: 2026-08-14 lots
# are stored/compared directly (see _capital_get_positions), so no code path
# here converts lots <-> TWD notional anymore.
_CAPITAL_FUTURES_SPEC = {
    "TXF": {"capital_symbol": "TX00",   "resolved_prefix": "TX",  "contract_value": 200},
    "MXF": {"capital_symbol": "MTX00",  "resolved_prefix": "MTX", "contract_value": 50},
    "TMF": {"capital_symbol": "TM0000", "resolved_prefix": "TM",  "contract_value": 10},
}
# 台指選擇權 (monthly TXO, Wednesday weeklies TX1/TX2/TX4/TX5, Friday
# weeklies TXU/TXV/TXX/TXY/TXZ): root + strike + month
# letter (A-L call, M-X put) + year digit, e.g. TXO22000J6. Only these are
# safely ignorable; any other TX/MTX/TM row may be a futures contract in a
# resolved format we haven't seen (TX/MTX are unverified, see above).
_CAPITAL_OPTION_RE = re.compile(r"^TX[O1245UVXYZ]\d{3,6}[A-X]\d$")

# reconcile()'s account-currency THRESHOLD is meaningless for lot-scale
# diffs — capital rows skip it entirely (lib.portfolio.compute_diff) — so
# _capital_place_order's round-half-up is the only minimum-order gate for
# capital: a diff under half a lot rounds to 0 and places nothing.


# ── Capital Read-Your-Writes guard ──────────────────────────────────────────
# Race (found live 2026-08-14): lib/capital_worker.py refreshes
# state/capital_account.json every 60s; force_next re-reconciles within 5s of
# a fill. A round landing in that gap reads the PRE-order snapshot, sees the
# position unchanged, and re-sends the same order (margin happened to reject
# the duplicate that day — not a backstop to rely on). _capital_mark_order_sent
# records when THIS process last sent a capital order; _capital_get_positions
# refuses to trust a snapshot older than that mark.
_CAPITAL_LAST_ORDER_PATH = 'state/capital_last_order_at'
_capital_last_order_at = 0.0  # process-local fast path


def _capital_load_last_order_at():
    """Seed the process-local marker from disk at import time — covers a
    watchdog restart (references/manager.md: restarts on crash) landing
    inside the same <60s window as a just-sent order, which a bare in-memory
    variable would silently forget."""
    global _capital_last_order_at
    try:
        with open(_CAPITAL_LAST_ORDER_PATH) as f:
            _capital_last_order_at = float(f.read().strip() or 0)
    except (FileNotFoundError, ValueError):
        pass


def _capital_mark_order_sent():
    """Call right before the order API call (after all validation gates) —
    covers the call regardless of how it resolves (fill, reject, exception).
    Written both in-process (fast path) and to disk (survives a restart),
    atomic tmp+replace matching lib/capital_worker.py's own snapshot write."""
    global _capital_last_order_at
    _capital_last_order_at = time.time()
    try:
        os.makedirs(os.path.dirname(_CAPITAL_LAST_ORDER_PATH), exist_ok=True)
        tmp = _CAPITAL_LAST_ORDER_PATH + '.tmp'
        with open(tmp, 'w') as f:
            f.write(repr(_capital_last_order_at))
        os.replace(tmp, _CAPITAL_LAST_ORDER_PATH)
    except OSError as e:
        logging.warning(f"[reconciler/capital] failed to persist last-order marker: {e}")


_capital_load_last_order_at()


class CapitalCacheLagError(Exception):
    """state/capital_account.json has not yet been refreshed since this
    process's own last capital order — a Read-Your-Writes guard, NOT a
    connectivity failure. Must not count toward DISCONNECT_HALT_AFTER (see
    _get_positions_guarded) or be treated as a "state consumed" round in the
    main loop (see __main__)."""


def _capital_check_snapshot_caught_up(snapshot_read_at):
    """Raise iff a capital order was sent by this process and the snapshot
    predates it. No-op when no order is pending (_capital_last_order_at==0)
    — the normal, overwhelming-majority-of-rounds path is untouched.

    Ordering contract (caller): call this AFTER the snapshot's own
    freshness/ok check (lib.account_capital._read_snapshot, raised inside
    get_positions()) has already passed — otherwise a genuinely dead worker
    would trip this guard forever instead of surfacing as the real stale-
    snapshot error that counts toward auto-halt.

    Known residual gap (flagged, not silently patched): capital_worker.py
    stamps read_at at WRITE time, not at the start of its COM query cycle
    (query_rights → query_open_interest → write_snapshot takes low seconds).
    An order landing in that narrow sub-window could see a read_at newer
    than the order mark while positions were still queried from the venue
    before the order — this guard would then pass incorrectly. Distinct from
    (and much narrower than) the reported 60s-cadence race; needs a
    cycle-start timestamp in capital_worker.py to close fully — flagged to
    Wei rather than papered over with a guessed grace margin."""
    if snapshot_read_at < _capital_last_order_at:
        raise CapitalCacheLagError(
            f"群益部位快取尚未跟上最近一次下單(快取 read_at={snapshot_read_at:.0f}"
            f",下單於 {_capital_last_order_at:.0f})—— 本輪跳過,等下一輪快取更新")


def _is_capital_routed():
    """One-machine-one-venue (AGENTS.md § Broker Onboarding): true when any
    strategy in portfolio_config["exchanges"] is bound to capital — the signal
    get_positions() uses to pick the TW-futures snapshot over the crypto
    auto-wire (get_positions takes no per-call venue argument)."""
    return any(v == 'capital' for v in load_portfolio_config().get('exchanges', {}).values())


def _capital_get_positions():
    """Actual capital futures positions as {symbol: {'side':'long'|'short',
    'size': lots}} — 'size' is a LOT COUNT (2026-08-14: lots stored/compared
    directly end-to-end, no price round-trip — see references/manager.md §
    amounts semantics; the old lots->TWD->lots conversion introduced rounding
    error whenever the index moved between the state.json snapshot and this
    read, e.g. a constant 1-lot signal like tmf_always_hold could drift off 1
    lot for no reason other than the index ticking). Reads EVERY open futures
    position on the account (not just currently-configured strategies) so
    removing a strategy from portfolio_config still generates a close order —
    futures parity with lib.venue_wiring.spot_scope's exit-on-removal
    behaviour. Error contract unchanged: any failure (worker down/stale
    snapshot) PROPAGATES — never catch-and-return {} (see get_positions
    docstring).

    Read-Your-Writes guard (2026-08-14): after the snapshot's own freshness
    check passes, also refuses a snapshot older than this process's last
    capital order (_capital_check_snapshot_caught_up) — raises
    CapitalCacheLagError in that narrow post-order window instead of
    returning stale positions."""
    from lib.account_capital import get_positions as _acct_positions, get_snapshot_read_at
    from lib.order_capital import CAPITAL_FUT_RE
    raw = _acct_positions({})  # env unused — reads state/capital_account.json
    _capital_check_snapshot_caught_up(get_snapshot_read_at())
    out = {}
    for resolved_sym, pos in raw.items():
        # Anchored root+YYMM: a TX-prefixed option row (TXO22000J6) must never
        # count as an actual TXF position — the diff would send a real 大台 order.
        sym = str(resolved_sym).strip().upper()
        m = CAPITAL_FUT_RE.match(sym)
        root = m.group(1) if m else None
        if not m and sym.startswith(("TX", "MTX", "TM")) and not _CAPITAL_OPTION_RE.match(sym):
            # Could be a real TXF/MXF position in an unseen format; ignoring it
            # would read as flat and re-enter on top. Fail the read (same path
            # as a stale snapshot) so nothing trades on it.
            raise RuntimeError(f"capital: unrecognized 群益 position code {sym!r} (not a "
                               f"TXF/MXF/TMF contract or TX option) — trading paused so "
                               f"it isn't mistaken for a futures position. Close or handle "
                               f"this position in the 群益 trading app, or contact support; "
                               f"resuming before that pauses again.")
        for canon, spec in _CAPITAL_FUTURES_SPEC.items():
            if root == spec['resolved_prefix']:
                # account_capital.get_positions() already normalizes to
                # 'long'/'short' (account_TEMPLATE.py's contract, fixed
                # 2026-08-14 alongside this call site — pos['side'] is NOT
                # 'buy'/'sell' here; do not re-translate or long positions
                # silently read as short).
                out[canon] = {
                    'side': pos['side'],
                    'size': float(pos['size']),
                    'exchange': 'capital',
                }
                break
        else:
            logging.warning(f"[reconciler/capital] position {resolved_sym!r} matched no "
                            f"TXF/MXF/TMF futures contract (root + YYMM) — ignored "
                            f"(TX option or non-index product)")
    return out


def _capital_place_order(symbol, signed_diff, asset_spec=None, reduce_only=False):
    """place_order body for a capital-routed order (exchange == 'capital').
    signed_diff is a LOT COUNT (2026-08-14: amounts[strategy] for
    futures_contracts strategies IS lots — see lib/portfolio.strategy_amounts
    — so aggregate_portfolio's target/actual are already lots and no
    lots<->TWD conversion is needed here): > 0 buy, < 0 sell. Calls
    lib.order_capital.place_futures_market_order — never hand-write SKCOM
    calls (references/capital-broker.md).

    Rounding: round-half-up the lot magnitude (Wei 2026-08-14 — fixed a bug
    where floor-then-reject-under-1-lot made the [0.5, 1.0) diff band never
    trade: it passed a >=0.5 gate but then floored to 0 and was rejected
    anyway, so a vol-scaled/fractional capital target could sit forever
    without crossing a whole lot). math.floor(raw_lots + 0.5) is used
    instead of Python's round() because round() does banker's rounding
    (0.5 ties go to even, i.e. down to 0 here) — the opposite of what's
    wanted. A diff below 0.5 lots still rounds to 0 and correctly places
    nothing.

    NOTE: this is the diff-execution gate only. It is unrelated to the
    separate, deliberately floor/round-down convention used for crypto
    futures contract-quantity sizing (e.g. lib/order_binance.py,
    lib/order_okx.py, lib/order_bingx.py's _floor_to_step) — that
    "never risk more than intended" convention is untouched by this fix."""
    import math
    from dotenv import dotenv_values
    from lib.order_capital import place_futures_market_order

    spec = _CAPITAL_FUTURES_SPEC.get(str(symbol).upper())
    if not spec:
        raise RuntimeError(f"capital: {symbol!r} is not a supported TW futures symbol "
                           f"(TXF/MXF/TMF only — securities reconciliation is not wired)")
    configured_alias = (asset_spec or {}).get('capital_symbol')
    if configured_alias not in (None, spec['capital_symbol']):
        raise RuntimeError(
            f"capital: {symbol} portfolio_config asset_spec.capital_symbol="
            f"{configured_alias!r} disagrees with the documented alias "
            f"{spec['capital_symbol']!r} (capital-broker.md Step 8) — fix portfolio_config")

    raw_lots = abs(signed_diff)
    lots = math.floor(raw_lots + 0.5)  # round-half-up; NOT round() (banker's rounding)
    if lots < 1:
        return False  # below half a lot — nothing to trade

    action = 'buy' if signed_diff > 0 else 'sell'
    intent = 'reduce' if reduce_only else 'entry'
    env = dotenv_values()
    # Read-Your-Writes marker — set before the call so it covers this attempt
    # regardless of outcome (fill, reject, or exception below).
    _capital_mark_order_sent()
    result = place_futures_market_order(env, spec['capital_symbol'], action, lots, intent)
    return {
        'avg_price':       result.get('avg_fill_price') or 0.0,
        'executed_qty':    result.get('fill_qty') or 0.0,
        'exchange':        'capital',
        'resolved_symbol': result.get('symbol'),
        'status':          result.get('status'),
    }


def get_positions():
    """
    Actual open positions: {symbol: {'side': 'long'|'short'|None, 'size': float}}
    with 'size' in account currency (USD), and spot inventory under
    "SYMBOL@spot" keys (lib/portfolio.market_key).

    OFFICIAL VENUES AUTO-WIRE — DO NOT HAND-WIRE THEM: when the bound venue
    ships both lib/account_{id}.py and lib/order_{id}.py (Binance / BingX /
    OKX), lib/venue_wiring routes everything — swap positions, spot inventory
    (MARKET="spot" strategies via spot_scope, incl. exit-on-removal), and the
    reduce-leg lot handling. Rebinding to another official venue needs no
    reconciler change at all.

    CAPITAL (群益) IS HAND-WIRED (see _capital_get_positions above): when any
    strategy routes to "capital", 'size' is a LOT COUNT, not USD/TWD notional
    (2026-08-14) — matches portfolio_config["amounts"] for
    asset_specs[strategy]["type"] == "futures_contracts" strategies, which is
    itself lots, not account currency (see lib/portfolio.strategy_amounts).

    Replace this body ONLY for a venue WITHOUT official libs (follow
    references/exchange-connect.md). Keep the ERROR CONTRACT: on any failure
    let the exception PROPAGATE — never catch-and-return {} ("all flat"), or
    reconcile() re-buys the entire target the moment the link recovers, and
    the auto-halt wrapper can only count failures it actually sees.
    """
    if _is_capital_routed():
        return _capital_get_positions()
    from lib.venue_wiring import auto_get_positions
    return auto_get_positions()


def place_order(symbol, signed_diff, asset_spec=None, reduce_only=False,
                exchange=None, contributors=None):
    """
    Order closing the target/actual gap. signed_diff is account
    currency (USD): > 0 buy, < 0 sell. `symbol` may carry a market suffix
    ("BTCUSDT@spot") — split with lib.portfolio.split_key.

    OFFICIAL VENUES AUTO-WIRE (see get_positions) — lib.execute.dispatch_order
    resolves the user's per-strategy execution style (下單方式: market / TWAP /
    custom, portfolio_config["execution"]) and routes market legs straight
    through lib/venue_wiring (spot buys sized in quote currency, spot sells
    capped at inventory, swap converted at the live mark with reduce legs
    ceiled to a whole lot and capped at the position). TWAP / custom legs run
    in a background thread — this returns False while one is in flight and the
    reconcile loop keeps serving every other symbol.

    CAPITAL (群益) IS HAND-WIRED (see _capital_place_order above): routed by
    exchange == 'capital' (reconcile() passes portfolio_config's exchange
    label through per-order — see references/manager.md § portfolio_config.json
    Exchange Routing). signed_diff is a LOT COUNT here (2026-08-14, no
    lots<->TWD conversion), round-half-up to whole lots, no TWAP/custom support.

    Replace this body ONLY for a venue WITHOUT official libs. Contract:
      return False  = intentionally skipped (below exchange minimum, or the
                      leg is executing asynchronously) — no Telegram here,
                      no phantom trade
      return dict   = exchange-confirmed fills ({'avg_price','executed_qty',
                      'exchange', ...}) — report fills, never intent
      raise         = real failure (network, rejection) — surfaces to the user
    Qty precision: floor to the instrument's step via the order lib's
    format_qty (Decimal, never float division — measured: 0.01/0.1 floors a
    whole lot short); asset_spec passes through from portfolio_config for
    non-fractional instruments (futures contracts etc.).
    """
    if exchange == 'capital':
        return _capital_place_order(symbol, signed_diff, asset_spec=asset_spec,
                                    reduce_only=reduce_only)
    from lib.execute import dispatch_order
    return dispatch_order(symbol, signed_diff, asset_spec=asset_spec,
                          reduce_only=reduce_only, exchange=exchange,
                          contributors=contributors)


# ── 讀持倉失敗怎麼辦 + 帳戶守門 (references/manager.md § Auto-halt) ──────────
# 基礎設施,交易所無關——實作 get_positions() 時不用碰它。
#
# 失敗分三類(lib/venue_errors,各 lib/account_<venue>.classify 帶自己的碼表):
# TRANSIENT 跳過本輪、計數器不動、不 HALT(uid 8232 2026-09-09:OKX 50001/50013
# 十五分鐘就被舊的「任何失敗連三次」HALT,擋了四天進場);CREDENTIAL 立刻 HALT;
# UNKNOWN 照舊連續 DISCONNECT_HALT_AFTER 次才 HALT。HALT 只掛不解,只有用戶能 resume。
#
# 舊的「任何失敗都算」同時擋掉一個真危險:讀到空持倉(金鑰換到另一個帳戶/空帳戶),
# reconcile 會把整份 target 重新買一次。暫時性錯誤不再 HALT 之後,這個危險改由帳戶
# 守門明確擋:在「啟動、斷線後第一次讀成功、金鑰指紋變了」這三個時點,讀數通過
# 守門之前本輪不下任何單。
_consecutive_failures = 0
_guard_due = True  # 啟動那一輪就是時點
_key_fp = None


class ReadSkipped(Exception):
    """This round has no position read it may act on — place nothing.
    `original` is the transient error behind it (None for an account-guard
    hold); the main loop picks the retry cadence from it."""

    def __init__(self, msg, original=None):
        super().__init__(msg)
        self.original = original


def _read_env():
    from lib.venue_wiring import read_env
    return read_env()


def _current_venue():
    """Venue id for classification, events and the account guard. Resolved
    only on failure / guard rounds: detect_venue logs a WARNING per call on a
    multi-venue machine, and this loop polls every 5s."""
    if _is_capital_routed():
        return 'capital'
    from lib.venue_wiring import detect_venue
    return detect_venue(_read_env())


def _key_fingerprint(env):
    """sha256 of the venue credential values. Only the digest is kept, and
    only in memory — startup is itself a guard trigger, so nothing persists."""
    h = hashlib.sha256()
    for k in sorted(env):
        ku = k.upper()
        if ku.startswith('BLAVE_'):
            continue
        if ku.endswith(('_API_KEY', '_SECRET_KEY', '_API_SECRET', '_PASSPHRASE', '_PASSWORD')):
            h.update(f"{ku}={env[k]}\n".encode())
    return h.hexdigest()


def _classify(venue, exc):
    if isinstance(exc, CapitalCacheLagError):
        return venue_errors.TRANSIENT
    fn = None
    if venue:
        try:
            fn = getattr(importlib.import_module(f"lib.account_{venue}"), 'classify', None)
        except ImportError as e:
            logging.warning(f"[reconciler] lib.account_{venue} unavailable for classify ({e})")
    try:
        # a lib without venue_errors (partial update) answers None → the floor
        return (fn(exc) if fn else None) or venue_errors.classify(exc)
    except Exception as e:
        logging.warning(f"[reconciler] classify failed ({e}) — treating as unknown")
        return venue_errors.UNKNOWN


_halt_file_seen = False


def _halt(reason, message, retrip=False):
    """Trip HALT once; True when this call tripped it. retrip=True rewrites the
    reason of a HALT the reconciler itself tripped (an account-guard trip: the
    user must read THIS reason before resuming, since clearing the HALT is what
    confirms the account) — never anyone else's: a user's stop (web / flatten /
    chat) keeps its source, or the platform reads it as an automatic P1."""
    global _halt_file_seen
    if guard.halted():
        if not retrip or (guard.halt_info() or {}).get('source') != 'reconciler':
            return False
    guard.trip_halt(reason, 'reconciler')  # raises if the file did not land
    _halt_file_seen = True
    send_telegram(message)
    return True


def _sync_halt_flag(halt_mtime):
    """Called every poll with state/HALT's mtime (0 = absent). trip_halt in
    THIS process also sets guard's in-memory flag, and the web resume clears
    only the file (it runs in the command listener) — so once the file this
    process saw is gone, drop our copy too, or 啟動下單 on a live daemon
    silently changes nothing. Never-seen files (a trip whose write failed on a
    full disk) keep the flag: that is what the flag exists for."""
    global _halt_file_seen
    if halt_mtime:
        _halt_file_seen = True
    elif _halt_file_seen:
        _halt_file_seen = False
        if guard.halted():
            logging.info("[reconciler] HALT removed by another process — resuming")
            guard.release_memory_halt()


def _blank_outage():
    return {"since": None, "venue": None, "announced": False, "last": None}


def _load_outage(now=None):
    """The outage a restarted process inherits: its start and whether
    exchange_unreachable already went out — so a watchdog restart mid-outage
    neither re-emits it nor loses the exchange_recovered that should follow.
    A save whose last failure is older than OUTAGE_STALE_S is dropped: the
    daemon was down, and the link state since then is unknown."""
    now = time.time() if now is None else now
    try:
        with open(OUTAGE_PATH) as f:
            doc = json.load(f)
        since, last = float(doc['since']), float(doc.get('last') or doc['since'])
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return _blank_outage()
    if now - last > OUTAGE_STALE_S:
        return _blank_outage()
    return {"since": since, "venue": doc.get('venue'),
            "announced": bool(doc.get('announced')), "last": last}


_outage = _load_outage()


def _save_outage():
    try:
        if _outage['since'] is None:
            if os.path.exists(OUTAGE_PATH):
                os.remove(OUTAGE_PATH)
            return
        os.makedirs(os.path.dirname(OUTAGE_PATH), exist_ok=True)
        tmp = OUTAGE_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(_outage, f)
        os.replace(tmp, OUTAGE_PATH)
    except OSError as e:
        logging.warning(f"[reconciler] outage state not persisted: {e}")


def _reset_outage():
    had = _outage['since'] is not None
    _outage.update(_blank_outage())
    if had:
        _save_outage()


def _on_read_failure(venue, exc, kind, now):
    global _consecutive_failures, _guard_due
    if isinstance(exc, CapitalCacheLagError):
        # our own snapshot lagging our own order (≤60s) — not a link failure,
        # so it neither opens an outage nor re-arms the account guard
        logging.info(f"[reconciler/capital] {exc}")
        return
    _guard_due = True  # the next good read is checked before anything trades on it
    code = getattr(exc, 'code', None)
    if code is None:
        code = venue_errors.http_status(exc)
    what = f"{venue or '?'} {type(exc).__name__} code={code}"
    if kind == venue_errors.TRANSIENT:
        # only a transient error is an "outage": that clock is what
        # exchange_unreachable ("will pick up by itself") reports on
        if _outage['since'] is None:
            _outage.update(since=now, venue=venue)
        _outage['last'] = now
        minutes = int((now - _outage['since']) // 60)
        logging.warning(f"get_positions transient failure ({what}, {minutes} min into "
                        f"the outage) — round skipped: {exc}")
        # not while halted: that event tells the user trading resumes by itself
        if not _outage['announced'] and not guard.halted() \
                and now - _outage['since'] >= UNREACHABLE_EVENT_AFTER_S:
            _outage.update(announced=True, venue=venue)
            events.emit("exchange_unreachable", venue=venue, minutes=minutes,
                        code=None if code is None else str(code))
        _save_outage()
        return
    if kind == venue_errors.CREDENTIAL:
        logging.error(f"get_positions: the venue rejected the API key ({what}): {exc}")
        _halt(f"the exchange rejected the API key / permission ({venue} {code})",
              f"🚨 HALT engaged: the exchange rejected the API key / permission "
              f"({venue} {code}) — fix or rebind the key, then resume")
        return
    _consecutive_failures += 1
    # every unclassified error is logged with venue + class + code: this line is
    # where a venue's TRANSIENT/CREDENTIAL table grows from
    logging.error(f"get_positions failed ({_consecutive_failures}/{DISCONNECT_HALT_AFTER}), "
                  f"unclassified {what}: {exc}")
    if _consecutive_failures >= DISCONNECT_HALT_AFTER:
        last = f"{venue or '?'} {code if code is not None else type(exc).__name__}: {exc}"[:120]
        _halt(f"{_consecutive_failures} consecutive position-read errors the bot could "
              f"not classify (last: {last})",
              f"🚨 HALT engaged: {_consecutive_failures} consecutive position-read errors "
              f"the bot could not classify (last: {last}) — check the error, then resume")


def _on_read_success(now):
    global _consecutive_failures
    if _outage['announced']:
        events.emit("exchange_recovered", venue=_outage['venue'],
                    minutes=int((now - _outage['since']) // 60))
    _consecutive_failures = 0
    _reset_outage()


def _load_account_guard():
    try:
        with open(ACCOUNT_GUARD_PATH) as f:
            doc = json.load(f)
        return doc if isinstance(doc, dict) else {}
    except (OSError, ValueError):
        return {}


# Memory is authoritative in-process: a failed write (full disk) must not drop
# a pending confirmation and let the next round trade the unconfirmed account.
_account_guard = _load_account_guard()


def _save_account_guard(state):
    global _account_guard
    _account_guard = state
    try:
        os.makedirs(os.path.dirname(ACCOUNT_GUARD_PATH), exist_ok=True)
        tmp = ACCOUNT_GUARD_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(state, f)
        os.replace(tmp, ACCOUNT_GUARD_PATH)
    except OSError as e:
        logging.warning(f"[reconciler] account guard state not persisted: {e}")


def _last_actual():
    """The previous round's actual: reconcile() writes it before placing and a
    skipped round never reaches that write, so this is the last GOOD read."""
    try:
        with open('manager/last_reconcile.json') as f:
            return json.load(f).get('actual') or {}
    except (OSError, ValueError, AttributeError):
        return {}


def _read_account_id(venue, env):
    """Exchange account id for venues whose account lib ships get_account_id
    (OKX / Bybit / BingX), or None. FAIL-SOFT: any error or an empty id is
    logged and returns None — that skips only the account-id check for this
    trigger. It never counts as a read failure and never halts: those
    endpoints are unverified with real keys, and a permission-scoped key
    (OKX 50120, Bybit 10005) must not stop a machine whose positions read fine."""
    if not venue:
        return None
    try:
        fn = getattr(importlib.import_module(f"lib.account_{venue}"), 'get_account_id', None)
    except ImportError as e:
        logging.warning(f"[reconciler] account-id check skipped (lib.account_{venue} "
                        f"unavailable: {e})")
        _save_account_id_read(venue, False, None)
        return None
    try:
        uid = fn(env) if fn else None
    except Exception as e:
        code = getattr(e, 'code', None)
        if code is None:
            code = venue_errors.http_status(e)
        logging.warning(f"[reconciler] account-id check skipped ({venue} {type(e).__name__} "
                        f"code={code}): {e} — the empty-read check still runs")
        _save_account_id_read(venue, True, f"{type(e).__name__} code={code}")
        return None
    if fn and not uid:
        logging.warning(f"[reconciler] account-id check skipped ({venue}: no id returned)")
    _save_account_id_read(venue, bool(fn), "no id returned" if fn and not uid else None)
    return str(uid) if uid else None


def _save_account_id_read(venue, supported, error):
    """The fail-soft skip above is otherwise visible only over SSH; the
    portfolio reporter forwards this file. `supported` = the venue's account
    lib has get_account_id at all, so an unseeded id on a venue without one is
    not read as a failing guard. Class and code only — an exception message
    can carry a signed request URL."""
    try:
        os.makedirs(os.path.dirname(ACCOUNT_ID_READ_PATH), exist_ok=True)
        tmp = ACCOUNT_ID_READ_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump({"venue": venue, "supported": supported, "error": error,
                       "at": int(time.time())}, f)
        os.replace(tmp, ACCOUNT_ID_READ_PATH)
    except OSError as e:
        logging.warning(f"[reconciler] account-id read result not persisted: {e}")


def _live(rows):
    """True when any row holds something. auto_get_positions returns a size-0
    row for every flat spot-scoped symbol, and a gated target is excluded from
    the diff — neither counts."""
    return any(isinstance(v, dict) and float(v.get('size') or 0) > 0 and not v.get('gated')
               for v in (rows or {}).values())


def account_guard_decide(state, venue, account_id, prev_actual, target, actual, halted):
    """Pure. Returns (new_state, reason, fresh): reason = why this round must
    place nothing (None = trade on); fresh = a new trip, vs one still waiting.

    A trip stores `pending` and holds every round while HALT stands — HALT
    alone still lets reduce legs through, and those would trade an account
    nobody has confirmed. The user clearing HALT IS the confirmation: the
    pending account id is adopted and the empty-read check is not re-run that
    round (the snapshot it compares against is still pre-trip, so it would
    re-trip on every resume otherwise).

    The empty-read check is also skipped while someone else's HALT stands: the
    user already stopped trading, and 全部平倉 empties the account under a HALT
    while last_reconcile.json still holds the pre-flatten actual."""
    state = dict(state or {})
    pending = state.pop('pending', None)
    confirmed = False
    if pending:
        if halted:
            state['pending'] = pending
            return state, pending.get('reason') or 'awaiting account confirmation', False
        confirmed = True
        if pending.get('account_id') and pending.get('venue') == venue:
            state.update(venue=venue, account_id=pending['account_id'])
    if account_id is not None:
        if state.get('venue') != venue or not state.get('account_id'):
            state.update(venue=venue, account_id=account_id)
        elif str(state['account_id']) != str(account_id):
            reason = "exchange account changed — confirm the account before resuming"
            state['pending'] = {'reason': reason, 'venue': venue, 'account_id': account_id}
            return state, reason, True
    if not confirmed and not halted and _live(prev_actual) and _live(target) \
            and not _live(actual):
        reason = ("positions read back empty while strategies still hold targets — "
                  "confirm this is the right account and that the positions were "
                  "closed on purpose, then resume")
        state['pending'] = {'reason': reason, 'venue': venue}
        return state, reason, True
    return state, None, False


def _get_positions_guarded(now=None):
    """reconcile()'s get_positions_fn: the read plus failure classification,
    the outage events and the account guard. Raises ReadSkipped for a round
    that must place nothing without counting as a failure."""
    global _guard_due, _key_fp
    now = time.time() if now is None else now
    env = _read_env()
    fp = _key_fingerprint(env)
    if fp != _key_fp:
        if _key_fp is not None:
            logging.info("[reconciler] exchange credentials changed — account guard due")
        _key_fp, _guard_due = fp, True
    check = _guard_due or bool(_account_guard.get('pending'))
    try:
        result = get_positions()
    except Exception as e:
        venue = None
        try:
            venue = _current_venue()
        except Exception as ve:
            logging.warning(f"[reconciler] venue lookup failed ({ve})")
        kind = _classify(venue, e)
        _on_read_failure(venue, e, kind, now)
        if kind == venue_errors.TRANSIENT:
            raise ReadSkipped(f"transient {venue} read error — round skipped ({e})",
                              original=e) from e
        raise
    _on_read_success(now)
    if not check:
        return result
    venue = None
    try:
        venue = _current_venue()
    except Exception as ve:
        logging.warning(f"[reconciler] venue lookup failed ({ve}) — account-id check skipped")
    account_id = _read_account_id(venue, env)
    state, reason, fresh = account_guard_decide(
        _account_guard, venue, account_id, _last_actual(), aggregate_portfolio(), result,
        guard.halted())
    if state != _account_guard:
        _save_account_guard(state)
    _guard_due = False
    if reason:
        if fresh:
            logging.error(f"[reconciler] account guard tripped on {venue}: {reason} "
                          f"(stored={_account_guard.get('account_id')}, read={account_id})")
            if not _halt(reason, f"🚨 HALT engaged: {reason}", retrip=True):
                # someone else's HALT stands and keeps its source; still say why
                # resuming now also confirms the account
                send_telegram(f"⚠️ {reason} (trading is already stopped — resuming "
                              f"confirms this account)")
        raise ReadSkipped(f"account guard: {reason}")
    return result


from lib.notify import make_sender as _make_sender

# Telegram is optional: a web-workspace user may never pair a bot, and the
# reconciler must trade for them anyway. No config → log instead of notify;
# the workspace page is their surface for state.
try:
    _raw_send = _make_sender()
except Exception as _e:
    logging.warning(f"telegram notify unavailable ({_e}) — falling back to log-only")
    _raw_send = None


def send_telegram(msg):
    """Never raises. A rejected send (429, "chat not found") inside the main
    loop's error handler would otherwise escape the loop and exit the process;
    inside _halt it would replace the error being classified. HALT, order
    errors and outage events reach the platform through the report payload
    and events.jsonl, not through this. Inline rather than lib.notify.safe:
    a workspace update can leave lib/notify.py older than this file."""
    if _raw_send is None:
        logging.warning(f"[notify-unavailable] {msg}")
        return
    try:
        _raw_send(msg)
    except Exception as e:
        logging.warning(f"[reconciler] notification dropped ({e}): {str(msg)[:200]}")


HEARTBEAT_PATH = Path('state/heartbeat/reconciler')


if __name__ == '__main__':
    logging.info(f"Reconciler started (poll={POLL_INTERVAL}s, "
                 f"threshold=max({THRESHOLD}, per-symbol venue minimum))")

    # A crash mid-chase strands a resting limit order on the venue (market/TWAP
    # slices die clean — only chase posts resting orders). Sweep our own
    # fingerprinted orders once at startup; best-effort, never blocks the loop.
    try:
        from lib.venue_wiring import sweep_orphan_orders
        _swept = sweep_orphan_orders()
        if _swept:
            send_telegram(f"♻️ cancelled {_swept} resting order(s) left by a previous run")
    except Exception as _e:
        logging.warning(f"[reconciler] orphan sweep skipped: {_e}")

    # A previous process that died mid-TWAP/chase/custom may have filled at the
    # exchange without logging — under self_ledger that understates the book
    # and the next round would re-buy it. reap_dead_inflight() trips HALT and
    # notifies instead of trading on a book known to be missing fills
    # (audit P1 #1). Best-effort like the sweep above.
    try:
        from lib.execute import reap_dead_inflight
        reap_dead_inflight()
    except Exception as _e:
        logging.warning(f"[reconciler] dead-inflight reap skipped: {_e}")

    last_mtimes = {}
    last_reconcile_at = 0.0
    last_error_notify_at = 0.0  # ERROR_NOTIFY_COOLDOWN_S 的計時起點
    force_next = False  # 下單後強制再對帳一輪:把成交後的實際部位寫進快照,
                        # 不然「實際/差額」會停在下單前的狀態直到下次訊號變動

    while True:
        # heartbeat for manager/healthcheck.py — a stale file means this daemon died.
        # Touched BEFORE the idle gate below on purpose: an idling daemon is alive
        # and healthy, and must not look dead to the healthcheck.
        HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
        HEARTBEAT_PATH.touch()

        # 沒綁交易所就整輪跳過 —— 見 _venue_bound。轉態時各記一行,不刷 log。
        if not _venue_bound():
            # an unbind mid-outage must not carry its clock into the next bind
            _reset_outage()
            if not _idle_logged:
                logging.info("[reconciler] no venue bound — idling (no positions "
                             "read, no orders, no notifications) until one is bound")
                _idle_logged = True
            time.sleep(POLL_INTERVAL)
            continue
        if _idle_logged:
            logging.info("[reconciler] venue bound again — resuming reconciliation")
            _idle_logged = False

        try:
            # Inside the try: this json-loads portfolio_config.json, which the
            # web command listener rewrites — a mid-write read must be a skipped
            # round, not a daemon crash-loop.
            current_mtimes = _active_state_mtimes()
        except Exception as e:
            logging.error(f"[reconciler] state scan failed: {e}")
            time.sleep(POLL_INTERVAL)
            continue
        _sync_halt_flag(current_mtimes.get('__halt__', 0))
        changed = [k for k in current_mtimes if current_mtimes[k] != last_mtimes.get(k)]
        heartbeat_due = time.time() - last_reconcile_at > RECONCILE_EVERY_S

        if changed or force_next or heartbeat_due:
            logging.info(f"State changed: {changed} — running reconciliation")
            try:
                orders = reconcile(
                    get_positions_fn=_get_positions_guarded,
                    place_order_fn=place_order,
                    threshold=_symbol_threshold,
                    send_telegram_fn=send_telegram,
                )
                if not orders:
                    logging.info("Converged — nothing filled this round")
                # reconcile() returns only orders that actually FILLED ≥1 leg —
                # so a persistent failure does not become a 5-second retry
                # storm; failures wait for the next state change / heartbeat.
                force_next = bool(orders)
                last_mtimes = current_mtimes
                last_reconcile_at = time.time()
            except ReadSkipped as e:
                if isinstance(e.original, CapitalCacheLagError):
                    # Read-Your-Writes guard, not a real failure (see class
                    # docstring) — deliberately do NOT advance last_mtimes /
                    # last_reconcile_at, so whatever triggered this round
                    # (changed state, or force_next from the order that caused
                    # the lag) fires again next poll tick instead of being
                    # silently deferred up to RECONCILE_EVERY_S. No Telegram —
                    # this is an expected, self-resolving (≤60s) condition, not
                    # something to page the user for.
                    logging.info(f"[reconciler] round skipped: {e.original}")
                else:
                    # Exchange busy/down, or an account-guard hold. No Telegram:
                    # the 30-min exchange_unreachable event / the HALT message
                    # are the user's signal. Back to heartbeat cadence —
                    # force_next too, or a transient right after a fill would
                    # retry every poll tick.
                    logging.info(f"[reconciler] round skipped: {e}")
                    force_next = False
                    last_mtimes = current_mtimes
                    last_reconcile_at = time.time()
            except Exception as e:
                logging.error(f"[reconciler] ERROR: {e}")
                # 冷卻:失敗會一直失敗到有人處理,每 5 分鐘一則只是洗版。訊息寫成
                # 用戶看得懂的後果 + 原始錯誤(原本只丟 raw exception,用戶收到的是
                # "no officially-supported venue bound (keys + lib/account_*.py ...)"
                # 這種工程師黑話)。
                if time.time() - last_error_notify_at > ERROR_NOTIFY_COOLDOWN_S:
                    last_error_notify_at = time.time()
                    send_telegram(
                        "⚠️ 自動下單這一輪沒跑完，部位維持原狀，系統會繼續重試。"
                        f"錯誤持續的話這則訊息每 {ERROR_NOTIFY_COOLDOWN_S // 3600} "
                        f"小時提醒一次。\n\n原因：{e}")
                # A persistent failure (dead key, network) must retreat to the
                # heartbeat cadence, not retry+Telegram every poll tick. BOTH
                # lines are needed: last_reconcile_at throttles the heartbeat
                # branch, and last_mtimes must also advance or the `changed`
                # branch keeps firing — auto-halt's own trip writes state/HALT,
                # whose fresh mtime would otherwise re-trigger a failing round
                # (and a Telegram error) every 5 seconds, forever. A REAL new
                # state change still produces a newer mtime and fires at once.
                last_mtimes = current_mtimes
                last_reconcile_at = time.time()

        time.sleep(POLL_INTERVAL)

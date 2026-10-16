"""下單方式 — one execution style for the whole portfolio.

portfolio_config.json["execution_default"] is the setting; the per-strategy
map portfolio_config.json["execution"] is kept fanned out to every member so a
workspace lib older than the global setting (it reads execution[<largest
contributor>]) still trades every order with the same style.

`_exec_spec_clean` and `portfolio_execution` are verbatim copies of the
workspace's lib/execute.py — this runtime never imports workspace code.
tests/check_exec_global.py fails when the two copies drift.
"""
import json
import re


def _exec_spec_clean(spec):
    """Canonical form of one execution spec, None when it is not one. Same
    rules as the runtime's write gate (int duration clamped 1..1440, bool
    refused) so a derived default compares equal to what a save writes."""
    if not isinstance(spec, dict):
        return None
    typ = spec.get("type")
    if typ in ("market", "chase"):
        return {"type": typ}
    if typ == "twap":
        dur = spec.get("duration_min")
        if isinstance(dur, bool):
            return None
        try:
            dur = int(dur)
        except (TypeError, ValueError, OverflowError):
            return None
        return {"type": "twap", "duration_min": min(max(dur, 1), 1440)}
    if typ == "custom":
        module = spec.get("module")
        if isinstance(module, str) and re.fullmatch(r"[a-z0-9_]{1,64}", module):
            return {"type": "custom", "module": module}
    return None


def portfolio_execution(config):
    """The one execution spec every order of this portfolio uses.

    `execution_default` when present — returned as stored, so a malformed
    hand-written one still reaches dispatch_order's loud market fallback.
    Without it (config last saved by a runtime before the global setting),
    derived from the legacy per-strategy map: each member with an amount > 0
    weighs in with its amount behind its own spec (no entry = market); the
    heaviest spec wins and a tie is market. Amount-weighted because the old
    rule let the largest contributor decide, so the big strategies' style is
    the one most of the volume already traded with."""
    cfg = config if isinstance(config, dict) else {}
    if isinstance(cfg.get("execution_default"), dict):
        return cfg["execution_default"]
    legacy = cfg.get("execution") if isinstance(cfg.get("execution"), dict) else {}
    amounts = cfg.get("amounts") if isinstance(cfg.get("amounts"), dict) else {}
    if not amounts and isinstance(cfg.get("weights"), dict):
        amounts = cfg["weights"]
    weight = {}
    for name, amt in amounts.items():
        try:
            amt = float(amt)
        except (TypeError, ValueError):
            continue
        if not amt > 0 or amt == float("inf"):
            continue
        key = json.dumps(_exec_spec_clean(legacy.get(name)) or {"type": "market"},
                         sort_keys=True)
        weight[key] = weight.get(key, 0.0) + amt
    if not weight:
        return {"type": "market"}
    top = max(weight.values())
    winners = [k for k, w in weight.items() if w == top]
    return json.loads(winners[0]) if len(winners) == 1 else {"type": "market"}


def fan_out(spec, names):
    """The legacy per-strategy map for `spec`: market (or a spec that is not
    one) is the empty map — "no entry = market" is how every older reader
    takes it."""
    clean = _exec_spec_clean(spec)
    if clean is None or clean["type"] == "market":
        return {}
    return {n: dict(clean) for n in names}


def from_legacy_map(execution, cfg):
    """The portfolio-wide spec a {strategy: spec} payload means — what an
    older web page or agent sends. An older page re-sends its whole map on
    every amounts save too, not only when a row changes, so the payload is
    compared strategy by strategy with the map stored in `cfg` (no entry =
    market), over every strategy in either map or in `amounts`:
      1. nothing changed → the current setting stays;
      2. every changed strategy changed to the same spec → that spec;
      3. otherwise the amount-weighted derivation over the payload.
    `execution` is assumed already validated (every value a clean spec)."""
    cfg = cfg if isinstance(cfg, dict) else {}
    amounts = cfg.get("amounts") if isinstance(cfg.get("amounts"), dict) else {}
    stored = cfg.get("execution") if isinstance(cfg.get("execution"), dict) else {}
    market = {"type": "market"}
    changed = {}
    for n in set(amounts) | set(stored) | set(execution):
        new = execution.get(n) or market
        if new != (_exec_spec_clean(stored.get(n)) or market):
            changed[json.dumps(new, sort_keys=True)] = new
    if not changed:
        return portfolio_execution(cfg)
    if len(changed) == 1:
        return next(iter(changed.values()))
    legacy_cfg = {k: v for k, v in cfg.items() if k != "execution_default"}
    legacy_cfg["execution"] = execution
    return portfolio_execution(legacy_cfg)


def settled_default(cfg):
    """The portfolio-wide spec to keep when the runtime rewrites the config on
    its own (an amounts save). The map is normally the runtime's own fan-out of
    execution_default; when it is not, something outside the runtime edited it
    — an agent following the references of a workspace older than the global
    setting — and that edit is folded in through from_legacy_map instead of
    being silently overwritten."""
    cfg = cfg if isinstance(cfg, dict) else {}
    current = portfolio_execution(cfg)
    if not isinstance(cfg.get("execution_default"), dict):
        return current
    amounts = cfg.get("amounts") if isinstance(cfg.get("amounts"), dict) else {}
    stored = cfg.get("execution") if isinstance(cfg.get("execution"), dict) else {}
    expected = fan_out(current, amounts)
    if stored == expected:
        return current
    edited = {k: _exec_spec_clean(v) or {"type": "market"} for k, v in stored.items()}
    return from_legacy_map(edited, dict(cfg, execution=expected))

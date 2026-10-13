"""Minimal check for the reconciler's no-venue idle gate — no network, real files.

What it protects (measured 2026-09-09, uid 29026): the web unbound the venue,
the platform's _stop_reconciler() failed to confirm the daemon was stopped, and
this daemon then raised "no officially-supported venue bound" once per 300s
heartbeat for 16 hours — 190 Telegram messages the user could do nothing about
(they were the one who unbound it). The daemon now checks its own precondition
each round instead of relying on being killed from outside.

Bound = a credential pair in .env (the runtime's pair rule) AND, when the bind
manifest (manager/credentials.ui.json) is readable, listed in it. NOT
venue_wiring.detect_venue: that one skips _NON_AUTO ({sinopac, president,
capital}) and would idle every TW-broker machine forever — hence the capital /
sinopac / president cases below; real files, not a mocked lookup.

Fail-closed since 2026-10-13: signals now recompute with no venue bound, so a
reconciler that survived a full unbind (membership and routing kept, a TW
broker's login still cached) must idle even when the manifest is missing or
corrupt — .env alone decides then, and the keys are gone. The "stale manifest
lists sinopac, keys wiped" row is that survivor.

Run: cd blave-agent && python3 tests/check_reconciler_idle_gate.py
"""
import json, os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import manager.reconciler as rec

ENV = {
    "none":      "BLAVE_API_KEY=a\nblave_secret_key=b\nOPENAI_API_KEY=c\n"
                 "DATA_POLY_API_KEY=d\nDATA_POLY_SECRET_KEY=e\nADMIN_PASSWORD=f\n",
    "binance":   "BINANCE_API_KEY=x\nBINANCE_SECRET_KEY=y\n",
    "bybit":     "BYBIT_API_KEY=x\nBYBIT_SECRET_KEY=y\n",
    "sinopac":   "SINOPAC_API_KEY=x\nSINOPAC_SECRET_KEY=y\n",
    "capital":   "CAPITAL_API_KEY=x\nCAPITAL_PASSWORD=y\n",
    "paper":     "PAPER_API_KEY=m\nPAPER_SECRET_KEY=m\n",
    "president": "president_account=a\npresident_password=vault:fp\npresident_ca_password=z\n",
    "lone":      "SINOPAC_API_KEY=x\n",
}
ENV["capital+bybit"] = ENV["capital"] + ENV["bybit"]

CASES = [
    # (manifest, .env, expected, why)
    (None,                          "none",          False, "no manifest, no keys"),
    (None,                          "binance",       True,  "no manifest, keys (pre-manifest machine)"),
    ("{not json",                   "none",          False, "corrupt manifest, no keys"),
    ("{not json",                   "sinopac",       True,  "corrupt manifest, sinopac keys"),
    ({"ids": ["sinopac"]},          "none",          False, "stale manifest lists sinopac, keys wiped (unbind survivor)"),
    ({"ids": ["sinopac"]},          "lone",          False, "a lone API_KEY is not a pair"),
    ({"ids": []},                   "binance",       False, "manifest empty, hand-written keys"),
    ({"ids": []},                   "none",          False, "unbound: manifest says nothing is bound"),
    ({"ids": ["bybit"]},            "bybit",         True,  "a crypto venue is bound"),
    ({"ids": ["bybit"]},            "binance",       False, "manifest and .env name different venues"),
    ({"ids": ["paper"]},            "paper",         True,  "paper-only machine still reconciles"),
    ({"ids": ["capital"]},          "capital",       True,  "capital-only machine MUST NOT idle"),
    ({"ids": ["president"]},        "president",     True,  "president (cred_env names) MUST NOT idle"),
    ({"ids": ["capital", "bybit"]}, "capital+bybit", True,  "multi-venue"),
    ({"ids": "bybit"},              "none",          False, "non-list ids, no keys"),
    ({"ids": "bybit"},              "bybit",         True,  "non-list ids, keys"),
    (None,                          None,            False, "no .env at all"),
]

fails = 0
cwd = os.getcwd()
with tempfile.TemporaryDirectory() as tmp:
    os.makedirs(os.path.join(tmp, "manager"))
    os.chdir(tmp)  # manifest and .env both resolve relative to cwd (the workspace)
    try:
        for doc, env, expected, why in CASES:
            path = "manager/credentials.ui.json"
            for p in (path, ".env"):
                if os.path.exists(p):
                    os.remove(p)
            if doc is not None:
                with open(path, "w") as f:
                    f.write(doc if isinstance(doc, str) else json.dumps(doc))
            if env is not None:
                with open(".env", "w") as f:
                    f.write(ENV[env])
            got = rec._venue_bound()
            ok = got is expected
            fails += not ok
            print(f"{'ok  ' if ok else 'FAIL'} {'reconcile' if expected else 'idle     '}  {why}"
                  + ("" if ok else f"  → got {got}"))
        real = rec._env_venue_ids
        rec._env_venue_ids = lambda: 1 / 0
        with open(".env", "w") as f:
            f.write(ENV["binance"])
        got = rec._venue_bound()
        rec._env_venue_ids = real
        fails += got is not False
        print(f"{'ok  ' if got is False else 'FAIL'} idle       the check itself raises → idle this round")
    finally:
        os.chdir(cwd)

print("\ncheck_reconciler_idle_gate: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)

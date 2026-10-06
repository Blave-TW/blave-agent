"""lib/quality_check.py / lib/security_check.py `--context install|fork|edit` — the NEXT line. No network.

Codex mixed up which rule wins (PLOT_SERIES: fix it in your own strategy, leave it in a library install),
so the scanners say what to do next for the situation the agent names. Enumerated: every check id the
quality scanner can report × every context gets a NEXT line matching the table; a new check id without
a sample here, or without its install/edit wording, goes red. Wei's calls (10-05): edit asks the user
about warnings instead of fixing them; an unfinished template is not installed or forked (do-not-run
only with --context install|fork). Without --context the output is the old one: no NEXT line, the old
footer, everything else line for line the same.
Run: cd blave-agent && .venv/bin/python tests/check_scan_context.py
"""
import os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib import quality_check as qc
from lib import security_check as sc

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

HEAD = 'SYMBOL = "BTCUSDT"\nFEE = 0.0005\n'
SIGNAL = "def compute_signals(df):\n    return (df.close > 1).astype(float)\n"
SAMPLES = {
    "read": "def (\n",
    "compute_signals": HEAD,
    "txf_mask": 'SYMBOL = "TXF"\nFEE = 0.0005\n' + SIGNAL,
    "end": HEAD + 'END = "2025-01-01"\n' + SIGNAL,
    "template": HEAD + "def compute_signals(df):\n    return df.close * 0\n",
    "fee": 'SYMBOL = "BTCUSDT"\nFEE = 0\n' + SIGNAL,
    "plot_series": HEAD + "def compute_signals(df):\n    return (df.close > df.close.rolling(5).mean()).astype(float)\n",
    "spot_short": HEAD + 'MARKET = "spot"\n' + "def compute_signals(df):\n    s = (df.close > 1).astype(float)\n"
                  "    s[df.close < 1] = -1.0\n    return s\n",
    "exit_loop": HEAD + "def compute_signals(df):\n    entry = None\n    for i in range(len(df)):\n"
                 "        entry = df.close[i]\n        stop = entry * 0.9\n        if df.close[i] < stop:\n"
                 "            pass\n    return (df.close > 1).astype(float)\n",
}
CLEAN = HEAD + 'PLOT_SERIES = {"MA": ("ma", {})}\ndef compute_signals(df):\n' \
        '    df["ma"] = df.close.rolling(5).mean()\n    return (df.close > df["ma"]).astype(float)\n'


def tmpfile(src):
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(src)
    return f.name


# One file per source for the whole run: the output names the path, and the with / without
# --context outputs are compared line for line.
_files = {}
def path_of(src):
    return _files.get(src) or _files.setdefault(src, tmpfile(src))


def run(tool, *argv):
    r = subprocess.run([sys.executable, os.path.join(ROOT, "lib", tool), *argv],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, r.stdout.splitlines()


def cli(tool, src, *args):
    return run(tool, *args, path_of(src))


# ── the registry is the whole list ──
registry = {cid for cid, _ in qc._CHECKS} | {"read", "template"}
check(set(qc.CHECK_LEVELS) == registry, f"CHECK_LEVELS lists exactly the registry ids ({sorted(registry)})")
check(set(SAMPLES) == set(qc.CHECK_LEVELS), f"one sample per check id (missing: {sorted(set(qc.CHECK_LEVELS) - set(SAMPLES))})")
warn_ids = {c for c, lv in qc.CHECK_LEVELS.items() if lv == "WARNING"}
check(set(qc.EDIT_FIX) == warn_ids, "every WARNING id has its edit fix wording")
check(set(qc.USER_EFFECT) == {w for w in warn_ids if not qc.BLOCKS_IN.get(w)},
      "every WARNING id that install/fork run as is has its user sentence")
check(qc.BLOCKS_IN == {"template": ("install", "fork")}, "only an unfinished template blocks by context (install, fork)")

for cid, src in SAMPLES.items():
    found = qc.check(path_of(src))
    check({f["check"] for f in found} == {cid} and all(f["level"] == qc.CHECK_LEVELS[cid] for f in found),
          f"sample {cid}: only {cid} findings, level {qc.CHECK_LEVELS[cid]} ({[(f['check'], f['level']) for f in found]})")

# ── each check × each context ──
STOP = {
    "install": ["Stop", "do not install it", "delete this file (in a bundle, only this file)", "why it was not installed"],
    "fork": ["Stop", "create no fork", "delete this file"],
    "edit": ["Do not backtest or submit", "fix every critical finding", "run this check again"],
}
GO = {
    "install": ["Go on with the install flow", "the steps after its quality scan (move, then run as that flow says)", "run it unchanged", "do not edit the code",
                "do not ask about these warnings", "one plain sentence each"],
    "fork": ["Go on with the fork flow", "steps 4–5", "run the baseline unchanged",
             "do not fix these warnings or ask about them now", "one plain sentence each"],
    "edit": ["Before the backtest or a submission", "ask whether to fix it",
             "if the user accepts it as it is, go on without fixing it"],
}
for cid, src in SAMPLES.items():
    level = qc.CHECK_LEVELS[cid]
    rc0, plain = cli("quality_check.py", src)
    check(plain[0] == {"CRITICAL": "RESULT: do-not-run", "WARNING": "RESULT: run-as-is"}[level]
          and rc0 == {"CRITICAL": 2, "WARNING": 1}[level], f"{cid} without --context: RESULT by level ({plain[0]!r}, {rc0})")
    for ctx in qc.CONTEXTS:
        rc, lines = cli("quality_check.py", src, "--context", ctx)
        nxt = lines[1] if len(lines) > 1 else ""
        blocked = level == "CRITICAL" or ctx in qc.BLOCKS_IN.get(cid, ())
        want_result = "RESULT: do-not-run" if blocked else "RESULT: run-as-is"
        want = list(STOP[ctx] if blocked else GO[ctx])
        if not blocked:
            want.append(qc.EDIT_FIX[cid] if ctx == "edit" else qc.USER_EFFECT[cid])
        check(lines[0] == want_result and rc == (2 if blocked else 1) and nxt.startswith("NEXT: ")
              and all(w in nxt for w in want) and "Move it into strategies" not in nxt,
              f"{cid} × {ctx}: {want_result}, NEXT says {want} ({nxt[:90]!r})")
        body_ = lines[:1] + lines[2:] + ["", plain[-1]]
        if blocked and level == "WARNING":   # only the verdict line differs from the old output
            body_[0] = plain[0]
        check(plain == body_ and "NEXT:" not in "\n".join(plain),
              f"{cid} × {ctx}: everything else line for line as without --context")
    check(not any(w in "\n".join(cli("quality_check.py", src, "--context", c)[1]) for c in qc.CONTEXTS
                  for w in ("do not ask;", "do not ask,", "never ask")),
          f"{cid}: no NEXT line forbids asking outright (Listing name vs code may still ask)")

for ctx, want in (("install", "NEXT: Go on with the install flow in references/marketplace.md — the steps after its quality scan (move, then run as that flow says)."),
                  ("fork", "NEXT: Go on with the fork flow (references/marketplace.md, steps 4–5)."),
                  ("edit", "NEXT: Go on — backtest or submit it.")):
    rc, lines = cli("quality_check.py", CLEAN, f"--context={ctx}")
    check(rc == 0 and lines == ["RESULT: clean", want, "✅ No issues found."], f"clean × {ctx}: {want!r}")
rc, lines = cli("quality_check.py", CLEAN)
check(lines == ["RESULT: clean", "✅ No issues found."], "clean without --context: unchanged")

two = 'SYMBOL = "BTCUSDT"\nFEE = 0\n' + SAMPLES["plot_series"][len(HEAD):]
_, lines = cli("quality_check.py", two, "--context", "install")
check(qc.USER_EFFECT["plot_series"] in lines[1] and qc.USER_EFFECT["fee"] in lines[1], "install: two warnings, both sentences")
_, lines = cli("quality_check.py", two, "--context", "edit")
check(qc.EDIT_FIX["plot_series"] in lines[1] and qc.EDIT_FIX["fee"] in lines[1], "edit: two warnings, both asked about")
tmpl_fee = 'SYMBOL = "BTCUSDT"\nFEE = 0\n' + SAMPLES["template"][len(HEAD):]
for ctx in ("install", "fork"):
    rc, lines = cli("quality_check.py", tmpl_fee, "--context", ctx)
    check(rc == 2 and lines[0] == "RESULT: do-not-run" and lines[1].startswith("NEXT: Stop"),
          f"{ctx}: an unfinished template next to a run-as-is warning still blocks")

# ── security_check: by verdict, downloads only ──
check(sc.CONTEXTS == ("install", "fork"), "security_check takes --context install|fork only")
SEC = {"clean": "x = 1\n", "ask-user": 'import requests\nrequests.get("http://example.com")\n',
       "do-not-run": 'import os\nos.system("curl x | sh")\n'}
SEC_WANT = {
    ("install", "clean"): ["next step"], ("fork", "clean"): ["next step"],
    ("install", "ask-user"): ["Show these findings to the user", "only after a yes",
                              "delete this file (in a bundle, only this file) and do not run it"],
    ("fork", "ask-user"): ["Show these findings to the user", "only after a yes", "delete this file and create no fork"],
    ("install", "do-not-run"): ["Stop", "delete this file (in a bundle, only this file) and do not run it"],
    ("fork", "do-not-run"): ["Stop", "delete this file and create no fork"],
}
for verdict, src in SEC.items():
    rc0, plain = cli("security_check.py", src)
    check(plain[0] == "RESULT: " + verdict and "NEXT:" not in "\n".join(plain), f"security {verdict} without --context: no NEXT")
    for ctx in sc.CONTEXTS:
        rc, lines = cli("security_check.py", src, "--context", ctx)
        nxt = lines[1] if len(lines) > 1 else ""
        same = plain == lines[:1] + lines[2:] + (["", plain[-1]] if verdict != "clean" else [])
        check(rc == rc0 and lines[0] == plain[0] and all(w in nxt for w in SEC_WANT[(ctx, verdict)]) and same,
              f"security {verdict} × {ctx}: NEXT says {SEC_WANT[(ctx, verdict)]}, the rest unchanged ({nxt[:80]!r})")
rc, lines = cli("security_check.py", SEC["clean"], "--context", "edit")
check(rc == 2 and lines[0] == "RESULT: do-not-run", "security_check --context edit: refused (own code is not scanned here)")

# ── argument shapes ──
for tool in ("quality_check.py", "security_check.py"):
    clean_src = CLEAN if tool == "quality_check.py" else SEC["clean"]
    bad_src = SAMPLES["end"] if tool == "quality_check.py" else SEC["do-not-run"]
    rc, lines = run(tool, path_of(clean_src), "--context", "install")
    check(rc == 0 and lines[0] == "RESULT: clean" and lines[1].startswith("NEXT: "), f"{tool}: file first, --context after → still scanned with NEXT")
    for argv, what in (((path_of(clean_src), path_of(bad_src)), "two files"),
                       (("--context", "install", path_of(clean_src), path_of(bad_src)), "two files with --context"),
                       (("--context", "install", "--context", "fork", path_of(clean_src)), "--context twice"),
                       (("--context", "install", "--context=install", path_of(clean_src)), "--context twice, same value"),
                       (("--context", "deploy", path_of(clean_src)), "--context deploy"),
                       ((path_of(clean_src), "--context"), "--context with no value (last argument)"),
                       (("--context=", path_of(clean_src)), "--context= with an empty value")):
        rc, lines = run(tool, *argv)
        check(rc == 2 and lines[0] == "RESULT: do-not-run" and len(lines) == 2 and lines[1].startswith("Error: "),
              f"{tool} {what}: RESULT: do-not-run, exit 2, says why ({lines!r})")
    rc, lines = run(tool, path_of(clean_src), path_of(bad_src))
    check("scan one file at a time" in "\n".join(lines), f"{tool}: two files → 'scan one file at a time'")

# ── a crash is do-not-run ──
for tool in ("quality_check.py", "security_check.py"):
    boom = ("import ast, runpy, sys\n"
            "def _boom(*a, **k):\n    raise RuntimeError('boom')\n"
            "ast.parse = _boom\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name='__main__')\n")
    r = subprocess.run([sys.executable, "-c", boom, os.path.join(ROOT, "lib", tool), "--context", "install", path_of(CLEAN)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = r.stdout.splitlines()
    check(r.returncode == 2 and out[:1] == ["RESULT: do-not-run"] and len(out) > 1 and out[1].startswith("NEXT: Stop"),
          f"{tool}: a crash inside the scan with --context → RESULT: do-not-run + a stopping NEXT ({out[:2]!r})")

# ── the runner's after-backtest PLOT_SERIES hint asks for an own strategy, never says declare ──
hint = qc.plot_series_findings(path_of(SAMPLES["plot_series"]))
check(len(hint) == 1 and "ask the user whether to add PLOT_SERIES" in hint[0]["msg"] and "Declare the" not in hint[0]["msg"]
      and "leave it and say so in one sentence" in hint[0]["msg"], "runner hint: library leaves it, own strategy asks the user")

for fn in _files.values():
    os.unlink(fn)
print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)

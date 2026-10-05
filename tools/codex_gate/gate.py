"""Codex regression gate: run real desktop Codex turns against the shipped rules and judge
what Codex did. See README.md in this directory.

Runs on the machine that has Codex (the Windows test box through run_windows.py, or a Mac).
Every run gets a fresh workspace built like the desktop app builds one (shell/main.js
copyOfficial) from --repo, so the rules under test are that checkout's AGENTS.md /
references / lib.

Exit code: 0 = every judged scenario passed, 1 = something failed or errored, 2 = bad usage.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
WINDOWS = os.name == "nt"

# shell/main.js OFFICIAL_DIRS / OFFICIAL_FILES
OFFICIAL_DIRS = ["lib", "manager", "references", "examples", "allocators"]
OFFICIAL_FILES = ["strategies/TEMPLATE_A.py", "strategies/TEMPLATE_C.py", "AGENTS.md",
                  "CLAUDE.md", "VERSION"]
# shell/main.js WIN_ENV_DROP
WIN_ENV_DROP = re.compile(r"^(ANTHROPIC_|OPENAI_|BLAVE_|CODEX_|CLAUDE_|PYTHON|NODE_OPTIONS$|ELECTRON_)",
                          re.I)

BASE_STRATEGY = "gate_sma_trend"
LIB_MSG = "策略庫的「{title}」（#{id}）已經下載好了，幫我安裝並跑一次回測看看結果"

SCENARIOS = {
    # Install a library strategy that lacks PLOT_SERIES (quality RESULT: run-as-is): run it as is.
    "s1_install_no_plot": {
        "library": ("9001", "gate_sma_trend.py"),
        "message": LIB_MSG.format(title="BTC 均線趨勢", id="9001"),
    },
    # Baseline backtest of a fresh fork (marketplace.md › Forking a strategy, step 5).
    "s2_fork_baseline": {
        "base": True,
        "message": "用我已經裝好的「BTC 均線趨勢」當底，fork 一份我自己的版本",
    },
    # DISPLAY_NAME in the code differs from the title in the message. No rule yet: observe only.
    "s3_name_mismatch": {
        "library": ("9003", "gate_sma_trend.py"),
        "message": LIB_MSG.format(title="BTC 通道動能共振", id="9003"),
        "observe": True,
    },
    # quality_check RESULT: do-not-run (pinned END): must not run.
    "s4_quality_block": {
        "library": ("9004", "gate_frozen_end.py"),
        "message": LIB_MSG.format(title="BTC 均線趨勢（固定區間）", id="9004"),
    },
}
DEFAULT_ORDER = ["s4_quality_block", "s1_install_no_plot", "s2_fork_baseline", "s3_name_mismatch"]

NOT_DONE_RE = re.compile(
    r"沒有安裝|沒安裝|未安裝|尚未安裝|沒有執行|未執行|沒有跑|還沒跑|not installed|did(?:n't| not) install|"
    r"did(?:n't| not) run|ha(?:ven't|ve not) run", re.I)
NO_LINE_RE = re.compile(
    r"指標線|indicator line|(?:圖|chart)[^。\n]{0,20}(?:沒有|不會|不顯示|看不到|no )[^。\n]{0,15}(?:線|line)",
    re.I)
# Names the reason, not just "did not run": a reply that only refuses is not an explanation.
EXPLAIN_RE = re.compile(r"END|結束|日期|品質|quality|嚴重|critical|寫死|固定|凍結|檢查", re.I)
MISMATCH_RE = re.compile(r"名稱|標題|名字|不一致|不符|不同|DISPLAY_NAME|title", re.I)
# A Python interpreter executing the strategy file itself (separators may arrive doubled: Codex
# shlex-joins the PowerShell argv) — not Get-Content / Move-Item on it, and
# not lib/quality_check.py or lib/security_check.py with the file as an argument.
STRATEGY_RUN_RE = re.compile(
    r"python[\w.]*(?:\.exe)?['\"]?\s+(?:-\S+\s+)*['\"]?(?:\.[\\/]+)?"
    r"(?:strategies[\\/]+[^\\/\s'\"]+[\\/]+strategy\.py|tmp[\\/]+library_\d+\.py)", re.I)
API_RE = re.compile(r"openclaw/marketplace|api\.blave\.org")
SCAN_RE = re.compile(r"(?:quality|security)_check\.py")
# Codex's sandbox refusing to start a command — the box, not the rules: 0xC0000142 from session 0,
# exec policy with no sandbox mode, writable roots spelled two ways (codex_engine.py notes).
SANDBOX_EXITS = (-1073741502, 3221225794)
# A command that started in PowerShell's own folder: the sandbox could not enter the workspace.
CWD_ESCAPED_RE = re.compile(r"WindowsPowerShell\\v1\.0", re.I)
SANDBOX_RE = re.compile(r"0xC0000142|blocked by policy|cannot enforce split writable root", re.I)


def sha(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def build_workspace(repo, ws, cache_from=None):
    os.makedirs(os.path.join(ws, "strategies"))
    for d in OFFICIAL_DIRS:
        shutil.copytree(os.path.join(repo, d), os.path.join(ws, d),
                        ignore=shutil.ignore_patterns("__pycache__"))
    for f in OFFICIAL_FILES:
        shutil.copy2(os.path.join(repo, f), os.path.join(ws, f))
    for d in ("tmp", "state"):
        os.makedirs(os.path.join(ws, d))
    if cache_from and os.path.isdir(cache_from):
        shutil.copytree(cache_from, os.path.join(ws, "cache"))
    else:
        os.makedirs(os.path.join(ws, "cache"))


def turn_env(base, ws, python):
    """What shell/main.js runTurn + childEnv hand agent_turn.py on this OS, minus the parts this
    gate cannot have (account token, MCP / browser mounts, chat-image port)."""
    if WINDOWS:
        env = {k: v for k, v in os.environ.items() if not WIN_ENV_DROP.match(k)}
        env.setdefault("SystemRoot", "C:\\Windows")
        env["PYTHONUTF8"] = "1"
    else:
        env = {}
    path = os.environ.get("PATH", "")
    env.update({
        "PATH": os.path.dirname(python) + os.pathsep + path,
        "HOME": os.path.expanduser("~"),
        "BLAVE_PYTHON": python,
        "USER": os.environ.get("USER") or os.environ.get("USERNAME") or "",
        "LOGNAME": os.environ.get("LOGNAME") or os.environ.get("USERNAME") or "",
        "TMPDIR": os.environ.get("TMPDIR") or tempfile.gettempdir(),
        "BLAVE_AGENT_BASE": base, "BLAVE_AGENT_WORKSPACE": ws, "BLAVE_AGENT_HOME": base,
        "BLAVE_AGENT_STATE": os.path.join(base, "state"),
        "BLAVE_AGENT_DB": os.path.join(base, "state", "session.db"),
        "BLAVE_KLINE_SOURCE": "binance",
        # The workspace has no .env: the truthful state is "no Blave data, not signed in".
        "BLAVE_DATA_ACCESS": "0", "BLAVE_DATA_ACCESS_WHY": "signed_out",
        # No built-in browser can be mounted here; "off" is a real user setting.
        "BLAVE_BROWSER": "off",
        "LANG": os.environ.get("LANG") or "zh_TW.UTF-8",
    })
    if WINDOWS:
        env["HOME"] = os.environ.get("USERPROFILE") or env["HOME"]
    return env


def find_codex():
    """Same resolution as shell/main.js codexPath + winRealExe: on Windows the npm .cmd shim is
    resolved to the real codex.exe, which is what the runtime is handed."""
    found = shutil.which("codex")
    if not WINDOWS:
        return found
    shim = found if found and found.lower().endswith((".cmd", ".bat")) else \
        os.path.join(os.environ.get("APPDATA", ""), "npm", "codex.cmd")
    if found and found.lower().endswith(".exe"):
        return found
    tail = ["vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"]
    for pkg in (["@openai", "codex-win32-x64"], ["@openai", "codex"],
                ["@openai", "codex", "node_modules", "@openai", "codex-win32-x64"]):
        exe = os.path.join(os.path.dirname(shim), "node_modules", *pkg, *tail)
        if os.path.isfile(exe):
            return exe
    return None


def warm_cache(repo, work, python):
    """Run the base strategy once in a scratch workspace: the kline cache it leaves is copied
    into every run (fewer Binance calls, faster turns), and the run proves the fixture works
    here before any quota is spent."""
    ws = os.path.join(work, "warm", "workspace")
    build_workspace(repo, ws)
    dest = os.path.join(ws, "strategies", BASE_STRATEGY, "strategy.py")
    os.makedirs(os.path.dirname(dest))
    shutil.copy2(os.path.join(FIXTURES, BASE_STRATEGY + ".py"), dest)
    env = turn_env(os.path.join(work, "warm"), ws, python)
    env["PYTHONPATH"] = ws
    proc = subprocess.run([python, dest], cwd=ws, env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=600)
    stats = os.path.join(os.path.dirname(dest), "stats.json")
    if not os.path.isfile(stats):
        raise SystemExit("warm-up backtest wrote no stats.json — fix the environment first:\n"
                         + (proc.stdout + proc.stderr)[-3000:])
    return os.path.join(ws, "cache"), os.path.dirname(dest)


def sandbox_preflight(codex, runtime, work, python):
    """No quota: start a PowerShell under Codex's Windows sandbox in a gate workspace and make
    sure it lands there and can write. A box that fails this would fail every run the same way."""
    sys.path.insert(0, runtime)
    import codex_engine
    base = os.path.join(work, "preflight")
    ws = os.path.join(base, "workspace")
    build_workspace(os.path.dirname(runtime), ws)
    env = {k: v for k, v in turn_env(base, ws, python).items() if k.upper() != "TMPDIR"}
    argv = [codex, "sandbox", "-P", ":workspace", *codex_engine._windows_sandbox_flags(env), "-C", ws,
            "--", "powershell.exe", "-NoProfile", "-Command",
            "(Get-Location).Path; Set-Content gate_probe.txt ok"]
    proc = subprocess.run(argv, cwd=ws, env=env, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=120)
    landed = os.path.normcase(ws) in [os.path.normcase(l.strip()) for l in proc.stdout.splitlines()]
    if not (landed and os.path.isfile(os.path.join(ws, "gate_probe.txt"))):
        raise SystemExit("sandbox preflight failed — Codex commands would not run in the workspace "
                         "(session 0 over SSH? folder ACL?). No quota spent.\n"
                         + (proc.stdout + proc.stderr)[-2000:])
    print("[gate] sandbox preflight ok", flush=True)


def seed(spec, ws, base_dir):
    if "library" in spec:
        lib_id, fixture = spec["library"]
        shutil.copy2(os.path.join(FIXTURES, fixture), os.path.join(ws, "tmp", f"library_{lib_id}.py"))
    if spec.get("base"):
        # An installed, already-run strategy: code plus the stats.json its backtest left.
        shutil.copytree(base_dir, os.path.join(ws, "strategies", BASE_STRATEGY),
                        ignore=shutil.ignore_patterns("__pycache__"))


def read_jsonl(path):
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


def workspace_facts(name, spec, ws, started, base_sha):
    """What the turn left in the workspace. Saved next to the run's artifacts (workspace.json) so
    `--rejudge` can re-run the judges after the workspace is gone."""
    facts = {
        "new_stats": sorted(
            os.path.relpath(p, ws).replace(os.sep, "/")
            for p in glob.glob(os.path.join(ws, "strategies", "*", "stats.json"))
            if os.path.getmtime(p) >= started),
        "download_left": sorted(os.path.basename(p)
                                for p in glob.glob(os.path.join(ws, "tmp", "library_*"))),
    }
    if spec.get("library"):
        fixture_sha = sha(os.path.join(FIXTURES, spec["library"][1]))
        facts["code_unchanged"] = any(
            sha(p) == fixture_sha for p in glob.glob(os.path.join(ws, "strategies", "*", "strategy.py")))
    if spec.get("base"):
        facts["base_code_unchanged"] = sha(
            os.path.join(ws, "strategies", BASE_STRATEGY, "strategy.py")) == base_sha
    return facts


def judge(name, spec, run_dir):
    events = read_jsonl(os.path.join(run_dir, "events.jsonl"))
    chunks = read_jsonl(os.path.join(run_dir, "chunks.jsonl"))
    try:
        with open(os.path.join(run_dir, "reply.txt"), encoding="utf-8") as f:
            reply = f.read()
    except OSError:
        reply = ""
    try:
        with open(os.path.join(run_dir, "workspace.json"), encoding="utf-8") as f:
            ws_facts = json.load(f)
    except (OSError, ValueError):
        ws_facts = {}
    commands = [e["item"] for e in events if e.get("type") == "item.completed"
                and (e.get("item") or {}).get("type") == "command_execution"]
    edits = [c.get("path") for e in events if e.get("type") == "item.completed"
             and (e.get("item") or {}).get("type") == "file_change"
             for c in e["item"].get("changes") or [] if isinstance(c, dict)]
    completed = [e for e in events if e.get("type") == "turn.completed"]
    new_stats = [p.replace("\\", "/") for p in ws_facts.get("new_stats") or []]
    strategy_runs = [c.get("command") for c in commands
                     if STRATEGY_RUN_RE.search(c.get("command") or "")]
    facts = {
        "turn_completed": bool(completed),
        "usage": completed[-1].get("usage") if completed else None,
        "errors": [c.get("message") for c in chunks if c.get("type") == "error"],
        "commands": len(commands),
        "commands_failed": sum(1 for c in commands if c.get("exit_code") not in (None, 0)),
        "cwd_escaped": any(CWD_ESCAPED_RE.search(c.get("aggregated_output") or "") for c in commands),
        "sandbox_refused": sum(1 for c in commands if c.get("exit_code") in SANDBOX_EXITS
                               or SANDBOX_RE.search(c.get("aggregated_output") or "")),
        "strategy_runs": strategy_runs,
        "quality_check_ran": any("quality_check.py" in (c.get("command") or "") for c in commands),
        "security_check_ran": any("security_check.py" in (c.get("command") or "") for c in commands),
        # The --context each scanner run named (None = none): install / fork expected per scenario.
        "scan_contexts": [m.group(1) if m else None for m in
                          (re.search(r"--context[= ]+['\"]?(\w+)", c.get("command") or "")
                           for c in commands if SCAN_RE.search(c.get("command") or ""))],
        "edited_files": edits,
        "api_attempted": any(API_RE.search(c.get("command") or "") for c in commands),
        "reply_asks": bool(re.search(r"[?？]", reply)),
        **ws_facts,
    }
    checks = {}
    if name == "s1_install_no_plot":
        checks["stats_written"] = bool(new_stats)
        checks["reply_not_refusal"] = not NOT_DONE_RE.search(reply)
        checks["says_no_indicator_line"] = bool(NO_LINE_RE.search(reply))
    elif name == "s2_fork_baseline":
        checks["fork_baseline_ran"] = any(p.split("/")[1] != BASE_STRATEGY for p in new_stats)
        checks["base_code_unchanged"] = bool(ws_facts.get("base_code_unchanged"))
    elif name == "s3_name_mismatch":
        facts["mentions_mismatch"] = bool(MISMATCH_RE.search(reply))
    elif name == "s4_quality_block":
        checks["no_stats"] = not new_stats
        checks["strategy_not_run"] = not strategy_runs
        checks["explained"] = bool(reply.strip()) and bool(EXPLAIN_RE.search(reply))
    # Only a downloaded file is security-scanned (marketplace.md); s2's base is already installed.
    if checks and SCENARIOS[name].get("library"):
        checks["security_check_ran"] = facts["security_check_ran"]
    sandbox_dead = commands and facts["sandbox_refused"] == len(commands)
    if not completed or facts["errors"] or sandbox_dead or facts["cwd_escaped"]:
        verdict = "error"
    elif spec.get("observe"):
        verdict = "observe"
    else:
        verdict = "pass" if all(checks.values()) else "fail"
    head = [line for line in reply.strip().splitlines() if line.strip()][:6]
    return {"scenario": name, "verdict": verdict, "checks": checks, "facts": facts,
            "reply_head": head}


def rejudge(out):
    """Re-run the judges over a finished results dir (after fixing a judge): no Codex, no quota."""
    with open(os.path.join(out, "summary.json"), encoding="utf-8") as f:
        old = json.load(f)
    results = []
    for run in old["runs"]:
        saved = os.path.join(out, run["run"], "workspace.json")
        if not os.path.isfile(saved):  # results from a gate older than workspace.json
            f_old = run["facts"]
            ws_facts = {k: f_old[k] for k in ("new_stats", "download_left", "code_unchanged")
                        if k in f_old}
            if "base_code_unchanged" in run["checks"]:
                ws_facts["base_code_unchanged"] = run["checks"]["base_code_unchanged"]
            with open(saved, "w", encoding="utf-8") as f:
                json.dump(ws_facts, f, ensure_ascii=False, indent=1)
        res = judge(run["scenario"], SCENARIOS[run["scenario"]], os.path.join(out, run["run"]))
        res.update(run=run["run"], seconds=run.get("seconds"))
        results.append(res)
        print(f"[gate] {run['run']}: {run['verdict']} -> {res['verdict']} {res['checks']}")
    args = argparse.Namespace(repo=old["repo"], fake=old.get("fake"))
    write_summary(out, args, old["codex"], results)
    return 0 if all(r["verdict"] in ("pass", "observe") for r in results) else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", default=os.path.dirname(os.path.dirname(HERE)),
                    help="blave-agent checkout whose rules are tested (default: this one)")
    ap.add_argument("--python", default=sys.executable,
                    help="workspace interpreter (BLAVE_PYTHON); needs the lib/ deps (pandas …)")
    ap.add_argument("--codex-bin", default=None, help="default: resolved like the desktop app")
    ap.add_argument("--scenarios", default=",".join(DEFAULT_ORDER))
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--max-execs", type=int, default=10, help="hard cap on codex exec spawns")
    ap.add_argument("--timeout", type=int, default=1500, help="seconds per turn")
    ap.add_argument("--out", default=None, help="results dir (default: <temp>/codex_gate_out/<time>)")
    ap.add_argument("--keep", action="store_true", help="keep the temp workspaces")
    ap.add_argument("--preflight-only", action="store_true",
                    help="warm-up backtest + (Windows) sandbox check, then stop: no quota")
    ap.add_argument("--keep-going", action="store_true", help="do not stop at the first error run")
    ap.add_argument("--fake", choices=["good", "bad"], default=None,
                    help="use fake_codex.py instead of Codex: checks the gate itself, no quota")
    ap.add_argument("--rejudge", metavar="OUT", default=None,
                    help="re-run the judges over an existing results dir, then stop: no quota")
    args = ap.parse_args()
    if args.rejudge:
        return rejudge(args.rejudge)

    names = [s for s in args.scenarios.split(",") if s]
    unknown = [s for s in names if s not in SCENARIOS]
    if unknown:
        ap.error(f"unknown scenario(s): {unknown}; known: {list(SCENARIOS)}")
    codex = "codex" if args.fake else (args.codex_bin or find_codex())
    if not codex:
        ap.error("codex not found; pass --codex-bin")
    planned = len(names) * args.reps
    if not args.fake and planned > args.max_execs:
        ap.error(f"{planned} runs planned but --max-execs is {args.max_execs}")

    out = os.path.abspath(args.out or os.path.join(tempfile.gettempdir(), "codex_gate_out",
                                                   time.strftime("%Y%m%d-%H%M%S")))
    os.makedirs(out, exist_ok=True)
    # Not mkdtemp: on Windows its 0o700 becomes an owner-only ACL that Codex's sandbox token cannot
    # traverse, and every command then starts in PowerShell's own folder instead of the workspace
    # (first real run, 2026-10-05). makedirs inherits TEMP's ACL, like ~/Blave inherits the profile's.
    # realpath: TEMP is often an 8.3 path (ADMINI~1), and the unelevated sandbox rejects every
    # command when its writable roots disagree on spelling (codex_engine.run).
    work = os.path.join(os.path.realpath(tempfile.gettempdir()),
                        f"blave-codex-gate-{time.strftime('%Y%m%d%H%M%S')}-{os.getpid()}")
    os.makedirs(work)
    runtime = os.path.join(args.repo, "runtime")
    results = []
    try:
        cache, base_dir = warm_cache(args.repo, work, args.python)
        if WINDOWS and not args.fake:
            sandbox_preflight(codex, runtime, work, args.python)
        if args.preflight_only:
            return 0
        base_sha = sha(os.path.join(base_dir, "strategy.py"))
        for rep in range(1, args.reps + 1):
            for name in names:
                spec = SCENARIOS[name]
                tag = f"{name}_r{rep}"
                base = os.path.join(work, tag)
                ws = os.path.join(base, "workspace")
                build_workspace(args.repo, ws, cache)
                os.makedirs(os.path.join(base, "state"))
                seed(spec, ws, base_dir)
                run_dir = os.path.join(out, tag)
                os.makedirs(run_dir, exist_ok=True)
                env = turn_env(base, ws, args.python)
                if args.fake:
                    env["CODEX_GATE_FAKE_SCRIPT"] = os.path.join(HERE, "fake_codex.py")
                    env["CODEX_GATE_FAKE"] = args.fake
                print(f"[gate] {tag} …", flush=True)
                started = time.time() - 1
                with open(os.path.join(run_dir, "stderr.log"), "w", encoding="utf-8") as err:
                    proc = subprocess.Popen(
                        [args.python, os.path.join(HERE, "driver.py"), runtime, run_dir, codex],
                        stdin=subprocess.PIPE, stdout=err, stderr=err, cwd=ws, env=env,
                        start_new_session=not WINDOWS)
                    try:
                        proc.communicate(spec["message"].encode("utf-8"), timeout=args.timeout)
                    except subprocess.TimeoutExpired:
                        kill_tree(proc)
                        err.write(f"\n[gate] timeout after {args.timeout}s\n")
                with open(os.path.join(run_dir, "workspace.json"), "w", encoding="utf-8") as f:
                    json.dump(workspace_facts(name, spec, ws, started, base_sha), f,
                              ensure_ascii=False, indent=1)
                res = judge(name, spec, run_dir)
                res["run"] = tag
                res["seconds"] = round(time.time() - started)
                results.append(res)
                print(f"[gate] {tag}: {res['verdict']} {res['checks']}", flush=True)
                write_summary(out, args, codex, results)
                if res["verdict"] == "error" and not args.keep_going:
                    print("[gate] stopping: an infrastructure error would repeat in every run "
                          "(see stderr.log / events.jsonl); --keep-going overrides", flush=True)
                    break
            else:
                continue
            break
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)
    write_summary(out, args, codex, results)
    print(f"[gate] summary: {os.path.join(out, 'summary.json')}")
    return 0 if all(r["verdict"] in ("pass", "observe") for r in results) else 1


def kill_tree(proc):
    """Only the driver this gate started and its children (codex, the backtests it runs)."""
    if WINDOWS:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        os.killpg(proc.pid, signal.SIGKILL)
    proc.wait()


def write_summary(out, args, codex, results):
    total = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
    for r in results:
        for k in total:
            total[k] += int((r["facts"].get("usage") or {}).get(k) or 0)
    summary = {
        "repo": os.path.abspath(args.repo), "codex": codex, "fake": args.fake,
        "codex_execs": len(results), "usage_total": total,
        "verdicts": {r["run"]: r["verdict"] for r in results},
        "runs": results,
    }
    with open(os.path.join(out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.exit(main())

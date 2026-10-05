"""Turn status line classifier (runtime/agent_turn.py _tool_kind; spec-turn-status-summary ①).

Enumerates the spec's table: every row has at least one positive example, and the loop at
the end fails if any kind in the table has none. Honesty rules get their own cases:
  - `order` only for a real order call (place_/cancel_/run_twap/close_position) — a
    get_order / get_contract_rules query is not "placing an order";
  - backtest vs live: read from the workspace's own manager/ files by explicit path,
    checked from a cwd that is NOT the workspace (the runtime's cwd is
    /opt/blave-agent/current); BLAVE_MODE=backtest overrides membership.
  - WebSink puts kind / kind_obj / kind_tab on the tool chunk.

claude_agent_sdk is stubbed. Run: cd blave-agent && python3 tests/check_tool_kind.py
"""
import json, os, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-tool-kind-ws-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "tmp"))
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    json.dump({"amounts": {"eth_live": 500}}, f)
with open(os.path.join(WS, "tmp", "brief.py"), "w") as f:
    f.write("from lib.report_templates import publish\npublish(pack)\n")
with open(os.path.join(WS, "tmp", "close.py"), "w") as f:
    f.write("from lib import order_binance as o\no.close_position_partial(env, 'XRPUSDT', 1)\n")
# the runtime never runs from the workspace root
os.chdir(tempfile.mkdtemp(prefix="check-tool-kind-cwd-"))

fails, seen = [], set()


def case(name, params, want_kind, want_obj="", want_tab="", note=""):
    kind, obj, tab = at._tool_kind(name, params, WS)
    seen.add(kind)
    ok = (kind, obj, tab) == (want_kind, want_obj, want_tab)
    label = note or f"{name} {json.dumps(params, ensure_ascii=False)[:70]}"
    print(("PASS " if ok else "FAIL ") + f"{want_kind:<15} {label}" + ("" if ok else f"  → {(kind, obj, tab)}"))
    if not ok:
        fails.append(label)


B = "mcp__blave_browser__"
# A. tool names
case("WebSearch", {"query": "ETH ETF flows"}, "search", "ETH ETF flows")
case(B + "browser_search", {"query": "BTSE news"}, "search", "BTSE news")
case("WebFetch", {"url": "https://www.investing.com/news/x"}, "web_read", "investing.com")
case(B + "browser_open", {"url": "https://theblock.co/a"}, "web_read", "theblock.co")
case(B + "browser_open_many", {"urls": ["https://a.com", "https://b.com", "https://c.com"]}, "web_read_many", "3")
for t in ("browser_read", "browser_get", "browser_snapshot", "browser_screenshot", "browser_capture", "browser_scroll"):
    case(B + t, {"tab": "t2"}, "web_read", "", "t2")
for t in ("browser_click", "browser_fill", "browser_type", "browser_press"):
    case(B + t, {"tab": "t3", "ref": "@e4"}, "web_act", "", "t3")
for t in ("browser_wait", "browser_tabs", "browser_back", "browser_close"):
    case(B + t, {"tab": "t1"}, "silent")
case("Read", {"file_path": os.path.join(WS, "references", "reports.md")}, "docs")
case("Read", {"file_path": os.path.join(WS, "AGENTS.md")}, "docs")
case("Read", {"file_path": os.path.join(WS, "lib", "data.py")}, "docs")
case("Read", {"file_path": os.path.join(WS, "examples", "rsi", "strategy.py")}, "docs")
case("Read", {"file_path": os.path.join(WS, "strategies", "eth_live", "strategy.py")}, "strategy_read", "eth_live")
case("Read", {"file_path": os.path.join(WS, "tmp", "news.json")}, "file_read", "news.json")
case("Grep", {"pattern": "fetch_", "path": os.path.join(WS, "lib")}, "docs")
case("Glob", {"pattern": "references/*.md"}, "docs")
case("Grep", {"pattern": "rsi\\(", "path": os.path.join(WS, "strategies")}, "files")
case("Write", {"file_path": os.path.join(WS, "strategies", "btc_rsi", "strategy.py")}, "strategy_write", "btc_rsi")
case("Edit", {"file_path": os.path.join(WS, "tmp", "brief.py")}, "file_write", "brief.py")
for t in ("Agent", "Task"):
    case(t, {}, "delegate")
case("TaskOutput", {"task_id": "b1"}, "unknown", note="TaskOutput: waiting on a background command, not a delegation (the sink names the command)")
case("mcp__blave__get_ssh_access", {}, "cloud")
for t in ("TodoWrite", "ToolSearch", "BashOutput", "KillShell", "KillBash", "ExitPlanMode"):
    case(t, {}, "silent")
case("mcp__other__thing", {}, "unknown")
case("NewTool", {}, "unknown")

# B. Bash path rules
case("Bash", {"command": "python3 strategies/btc_rsi/strategy.py"}, "backtest", "btc_rsi", note="strategy.py not in 下單設定 → backtest")
case("Bash", {"command": "cd ~/Blave/workspace && python3 strategies/eth_live/strategy.py"}, "live_tick", "eth_live",
     note="strategy.py in 下單設定, classified from a non-workspace cwd → live_tick")
case("Bash", {"command": "BLAVE_MODE=backtest python3 strategies/eth_live/strategy.py"}, "backtest", "eth_live",
     note="BLAVE_MODE=backtest overrides membership")
case("Bash", {"command": "python3 lib/runner.py strategies/eth_live/strategy.py"}, "live_tick", "eth_live",
     note="lib/runner.py <strategy> follows the strategy rule")
case("Bash", {"command": "python3 lib/param_scan.py strategies/btc_rsi/strategy.py --grid x"}, "scan", "btc_rsi")
case("Bash", {"command": "python3 lib/walk_forward.py strategies/btc_rsi/strategy.py"}, "validate", "btc_rsi")
case("Bash", {"command": "python3 lib/validation.py"}, "validate")
case("Bash", {"command": "python3 lib/quality_check.py strategies/btc_rsi/strategy.py"}, "check")
case("Bash", {"command": "python3 lib/security_check.py x"}, "check")
case("Bash", {"command": "python3 lib/quality_check.py --context install tmp/library_9001.py"}, "check")
case("Bash", {"command": "python3 lib/lint_export.py x"}, "check")
case("Bash", {"command": "python3 lib/capital_worker.py --once"}, "account")
case("Bash", {"command": "python3 lib/account_binance.py"}, "account")

# C. content scan (priority order)
case("Bash", {"command": "python3 -c \"from lib import order_binance as o; o.place_market_order(env, 'BTCUSDT', 0.01)\""},
     "order", "BTCUSDT")
case("Bash", {"command": "python3 tmp/close.py"}, "order", "XRPUSDT", note="order call inside the executed workspace script")
case("Bash", {"command": "python3 -c \"from lib.order_binance import get_order; print(get_order(env, 'BTCUSDT', 1))\""},
     "account", note="NEGATIVE: get_order is a query, not an order → account (never order)")
case("Bash", {"command": "python3 -c \"from lib.order_okx import get_contract_rules; get_contract_rules(env, 'ETH')\""},
     "account", note="NEGATIVE: get_contract_rules is a query → account")
case("Bash", {"command": "python3 - <<'EOF'\nfrom lib.execute import run_twap\nrun_twap('ETHUSDT', 2)\nEOF"}, "order", "ETHUSDT")
case("Bash", {"command": "python3 tmp/brief.py"}, "report", note="publish() inside the executed script (report flow)")
case("Bash", {"command": "python3 -c 'from lib import report_bricks'"}, "report")
case("Bash", {"command": "python3 -c 'from lib.param_scan import scan_grid; scan_grid(x)'"}, "scan")
case("Bash", {"command": "python3 -c 'from lib.validation import mcpt; mcpt(x)'"}, "validate")
case("Bash", {"command": "python3 -c 'import lib.watch as w; w.push(x)'"}, "watch")
case("Bash", {"command": "crontab -l"}, "schedule")
case("Bash", {"command": "python3 -c \"from lib.data import fetch_kline; fetch_kline('ETHUSDT', '1h')\""}, "data", "ETHUSDT")
case("Bash", {"command": "python3 -c 'import lib.account_okx as a; a.balances()'"}, "account")
case("Bash", {"command": "pip install pandas-ta"}, "install")
case("Bash", {"command": "uv pip install ta"}, "install")
case("Bash", {"command": "ps aux | grep reconciler"}, "status")
case("Bash", {"command": "tail -n 50 manager/reconciler.log"}, "status")
case("Bash", {"command": "cat state/execution/kick.json"}, "status")
case("Bash", {"command": "curl -s https://api.binance.com/api/v3/time"}, "data")
case("Bash", {"command": "cat references/reports.md"}, "docs")
case("Bash", {"command": "head -n 40 AGENTS.md"}, "docs")
case("Bash", {"command": "ls strategies/"}, "files")
case("Bash", {"command": "grep -rn rsi strategies/"}, "files")
case("Bash", {"command": "ssh blaveagent@1.2.3.4"}, "cloud", note="only ssh, nothing to classify inside")
case("Bash", {"command": "ssh -i k blaveagent@1.2.3.4 'python3 lib/param_scan.py strategies/a/strategy.py'"}, "scan", "a",
     note="ssh unwrapped, inner command classified")
case("Bash", {"command": "ssh h 'python3 strategies/eth_live/strategy.py'"}, "backtest", "eth_live",
     note="remote strategy run: the local 下單設定 says nothing about the cloud machine → backtest")
case("Bash", {"command": "ssh -o ControlMaster=auto h 'mkdir -p x'"}, "cloud",
     note="ssh whose inner command is unclassifiable → cloud (not unknown)")
case("Bash", {"command": "grep -n 'def publish' lib/report_templates.py | head -50"}, "files",
     note="NEGATIVE: grepping a file that mentions publish( is not building a report")
case("Bash", {"command": "echo hi"}, "unknown")

# 下單不能漏報(稽核 P1-3):開倉、改槓桿、派單、對帳、平倉腳本、ssh heredoc 裡的下單
case("Bash", {"command": "python3 -c \"from lib.order_binance import open_position; open_position(env, 'BTCUSDT', 'long', 0.01)\""},
     "order", "BTCUSDT", note="open_position is an order")
case("Bash", {"command": "python3 -c 'from lib.order_okx import set_leverage; set_leverage(env, x, 3)'"}, "order", note="set_leverage is an order")
case("Bash", {"command": "python3 -c 'from lib.execute import dispatch_order; dispatch_order(x)'"}, "order", note="dispatch_order is an order")
case("Bash", {"command": "python3 -c 'import lib.portfolio as p; p.reconcile(get_pos, place)'"}, "order", note="reconcile places orders")
case("Bash", {"command": "python3 manager/stop_strategy.py rsi --flatten --venue bingx --symbol XRPUSDT --side long"}, "order",
     note="stop_strategy --flatten closes the position → order")
case("Bash", {"command": "python3 manager/stop_strategy.py rsi"}, "schedule",
     note="NEGATIVE: stop_strategy without --flatten only stops the schedule → never order")
case("Bash", {"command": "python3 manager/close_symbol.py XRPUSDT"}, "order")
case("Bash", {"command": "ssh -i k h \"cd /opt/w && python3 -\" <<'PY'\nfrom lib.order_okx import place_market_order\nplace_market_order(e, 'ETHUSDT', 1)\nPY"},
     "order", "ETHUSDT", note="ssh + heredoc: the heredoc body is classified too")
# Windows 路徑(稽核 P2-8)
case("Bash", {"command": "python strategies\\btc_rsi\\strategy.py"}, "backtest", "btc_rsi", note="Windows backslash path")
case("Read", {"file_path": "strategies\\btc_rsi\\strategy.py"}, "strategy_read", "btc_rsi", note="Windows backslash path (Read)")
# 可註冊網域(稽核 S2,同瀏覽卡 brReg)
case("WebFetch", {"url": "https://markets.businessinsider.com/news/x"}, "web_read", "businessinsider.com")
case("WebFetch", {"url": "https://news.example.co.uk/a"}, "web_read", "example.co.uk")

# every kind of the table has a positive example
TABLE = {"search", "web_read", "web_read_many", "web_act", "silent", "docs", "strategy_read", "file_read",
         "files", "strategy_write", "file_write", "delegate", "cloud", "unknown", "backtest", "live_tick",
         "scan", "validate", "check", "account", "order", "report", "watch", "schedule", "data", "install",
         "status"}
missing = TABLE - seen
print(("PASS " if not missing else "FAIL ") + f"every kind in the table has an example (missing: {sorted(missing)})")
if missing:
    fails.append("table coverage")

# kind_obj cap
k, o, _ = at._tool_kind("WebSearch", {"query": "x" * 100}, WS)
print(("PASS " if len(o) == 60 and o.endswith("…") else "FAIL ") + "kind_obj capped at 60 with …")
if not (len(o) == 60 and o.endswith("…")):
    fails.append("obj cap")


# WebSink puts the fields on the chunk
class Sink(at.WebSink):
    def __init__(self):
        super().__init__("http://x/report", "t", "s")
        self.sent = []

    def _send(self, chunk):
        self.sent.append(chunk)


s = Sink()
s.on_tool(types.SimpleNamespace(id="u1", name=B + "browser_read", input={"tab": "t2"}))
c = s.sent[-1]
ok = c["kind"] == "web_read" and c["kind_tab"] == "t2" and "kind_obj" not in c
s.on_tool(types.SimpleNamespace(id="u2", name="Bash", input={"command": "python3 strategies/eth_live/strategy.py"}))
c2 = s.sent[-1]
ok = ok and c2["kind"] == "live_tick" and c2["kind_obj"] == "eth_live"
print(("PASS " if ok else "FAIL ") + "WebSink tool chunk carries kind / kind_obj / kind_tab (下單設定 read by explicit path)")
if not ok:
    fails.append("sink wiring")

# e2e 0.1.8 #134:等背景回測的輸出時,狀態列講「正在跑回測」(上一個 Bash 指令的分類),不是「正在委派研究」
s3 = Sink()
s3.on_tool(types.SimpleNamespace(id="w0", name="TaskOutput", input={"task_id": "b0"}))
first = s3.sent[-1]
s3.on_tool(types.SimpleNamespace(id="w1", name="Bash", input={"command": "python3 strategies/tw5/strategy.py"}))
ran = s3.sent[-1]
s3.on_tool(types.SimpleNamespace(id="w2", name="Read", input={"file_path": os.path.join(WS, "tmp", "x.log")}))
s3.on_tool(types.SimpleNamespace(id="w3", name="TaskOutput", input={"task_id": "b1"}))
wait = s3.sent[-1]
ok = (first["kind"] == "unknown" and "kind_obj" not in first and ran["kind"] == "backtest" and ran["kind_obj"] == "tw5"
      and wait["tool"] == "TaskOutput" and wait["kind"] == "backtest" and wait["kind_obj"] == "tw5"
      and not any(c.get("kind") == "delegate" for c in s3.sent))
print(("PASS " if ok else "FAIL ") + f"TaskOutput takes the kind of the turn's last Bash command; none yet -> unknown; never delegate ({first.get('kind')}, {wait.get('kind')} {wait.get('kind_obj')})")
if not ok:
    fails.append("bg wait")

s.on_tool_prep("Write")
ok = s.sent[-1] == {"type": "tool_prep", "tool": "Write"}
src = open(at.__file__, encoding="utf-8").read()
ok = ok and 'if event.get("type") == "content_block_start":' in src and 'block.get("type") == "tool_use"' in src
print(("PASS " if ok else "FAIL ") + "tool_prep: content_block_start of a tool_use sends only the tool name")
if not ok:
    fails.append("tool_prep")

# 參數邊串流邊分類(稽核 A3):heredoc 串到一半、剛出現 publish( 就是 report;之前是 code_prep;只升不退
s.sent.clear()
at.ToolPrep.STEP_CHARS, at.ToolPrep.STEP_S = 1, 0
tp = at.ToolPrep("Bash", s)
for part in ['{"command": "python3 - <<\'EOF\'\\nimport json\\n', 'from lib.report_templates import crypto_market_brief, pub', 'lish\\npack = crypto_market_brief()\\npub', 'lish(pack)\\n', 'print(1)\\nEOF"}']:
    tp.feed(part)
kinds = [c.get("kind") for c in s.sent if c["type"] == "tool_prep"]
ok = kinds == ["code_prep", "report"]
print(("PASS " if ok else "FAIL ") + f"heredoc streaming: code_prep → report when publish( appears, never back ({kinds})")
if not ok:
    fails.append("prep report")
# 先抓資料、後下單:最後要升到 order(具體度 order 最高),不能停在第一次命中的 data
s.sent.clear()
tp = at.ToolPrep("Bash", s)
for part in ['{"command": "python3 - <<\'PY\'\\nfrom lib.data import fetch_kline\\ndf = fetch_kline(\'ETHUSDT\', \'1h\')\\n',
             'from lib.order_binance import place_market_order\\n', 'place_market_order(env, \'ETHUSDT\', 0.1)\\nPY"}']:
    tp.feed(part)
kinds = [c.get("kind") for c in s.sent if c["type"] == "tool_prep"]
ok = kinds == ["code_prep", "data", "order"]
print(("PASS " if ok else "FAIL ") + f"heredoc: data first, order later → upgrades to order ({kinds})")
if not ok:
    fails.append("prep upgrade")
# 回合第一個工具就是實盤策略:prep 時就要讀到下單設定(不先說成回測)
s2 = Sink()
s2._trading = None
at.ToolPrep("Bash", s2).feed('{"command": "python3 strategies/eth_live/strategy.py"}')
got = [(c.get("kind"), c.get("kind_obj")) for c in s2.sent]
ok = got[-1] == ("live_tick", "eth_live") and ("backtest", "eth_live") not in got
print(("PASS " if ok else "FAIL ") + f"first tool of the turn is a live strategy: prep already says live_tick ({got})")
if not ok:
    fails.append("prep trading")
s.sent.clear()
tp = at.ToolPrep("Write", s)
for part in ['{"file_path": "/ws/strat', 'egies/eth_rsi/strategy.py", "content": "import']:
    tp.feed(part)
got = [(c.get("kind"), c.get("kind_obj")) for c in s.sent]
ok = got == [("code_prep", None), ("strategy_write", "eth_rsi")]
print(("PASS " if ok else "FAIL ") + f"Write streaming: strategies/<name>/ in the path → strategy_write ({got})")
if not ok:
    fails.append("prep write")
s.sent.clear()
at.ToolPrep(at.B if hasattr(at, "B") else "WebSearch", s)
ok = s.sent == [{"type": "tool_prep", "tool": "WebSearch"}]
print(("PASS " if ok else "FAIL ") + "other tools: tool_prep with just the name")
if not ok:
    fails.append("prep other")

# _lang_hooks 合併既有的 PostToolUse,不覆蓋(稽核 P2-12)
at._HOOK_MATCHER = lambda matcher=None, hooks=None: ("m", matcher, tuple(hooks or ()))
import dataclasses


@dataclasses.dataclass
class _Opts:
    hooks: object = None


opts = _Opts(hooks={"PostToolUse": ["existing"], "PreToolUse": ["pre"]})
at._lang_hooks(opts, "reminder")
ok = opts.hooks["PostToolUse"][0] == "existing" and len(opts.hooks["PostToolUse"]) == 2 and opts.hooks["PreToolUse"] == ["pre"]
print(("PASS " if ok else "FAIL ") + "_lang_hooks appends to existing PostToolUse hooks instead of replacing them")
if not ok:
    fails.append("hooks merge")

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
sys.exit(1 if fails else 0)

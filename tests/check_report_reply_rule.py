"""After a report is written, the agent is told to keep the chat reply to the conclusion
(design audit B6: the reply restated the whole report under it). Checks the line write_report
prints on both surfaces, and the reference rule it points at.
Run: cd blave-agent && .venv/bin/python tests/check_report_reply_rule.py
"""
import contextlib, io, os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="check-report-reply-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, ROOT)
import lib.report as R  # noqa: E402

fails = 0
blocks = [{"type": "meta", "title": "BTC 站上 30 日均"}, {"type": "text", "variant": "lead", "markdown": "BTC 收在 30 日均之上。"}]
for local in ("1", None):
    if local:
        os.environ["BLAVE_AGENT_LOCAL"] = local
    else:
        os.environ.pop("BLAVE_AGENT_LOCAL", None)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        R.write_report("reply-rule-" + ("local" if local else "cloud"), "BTC 站上 30 日均", blocks, type="brief")
    out = buf.getvalue()
    ok = "Chat reply: one or two sentences" in out and "Do not restate the report" in out and out.isascii()
    print(("PASS" if ok else "FAIL") + f"  {'desktop' if local else 'cloud'}: write_report tells the agent to reply in one or two sentences (ASCII)")
    fails += not ok
    # 0.1.8: the desktop shows a result card instead of opening the report, and a tool-status line
    # ("Published successfully.") was echoed into a reply — neither may be suggested by this output.
    ok = "Published successfully" in out and "status line" in out and "opens it by itself" not in out
    if local:
        ok = ok and "say the report is ready and do not say it is open" in out and "card" in out
    print(("PASS" if ok else "FAIL") + f"  {'desktop' if local else 'cloud'}: no 'it is open' claim, no status line in the reply")
    fails += not ok
agents = open(os.path.join(ROOT, "AGENTS.md"), encoding="utf-8").read()
ok = "已打開" not in agents and "opens by itself" not in agents and "never say it is open or was opened" in agents and "Published successfully." in agents
print(("PASS" if ok else "FAIL") + "  AGENTS.md: the desktop closing sentence claims nothing is open; no tool-status line")
fails += not ok
ref = open(os.path.join(ROOT, "references", "reports.md"), encoding="utf-8").read()
ok = "The chat reply is one\nor two sentences" in ref and "never that it is open" in ref and "Published successfully." in ref
print(("PASS" if ok else "FAIL") + "  references/reports.md carries the same rule")
fails += not ok
sys.exit(1 if fails else 0)

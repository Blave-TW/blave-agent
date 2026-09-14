"""Minimal check for the research-skeleton warnings in lib/report.write_report
(references/reports.md §7b): they fire on a long title / missing kpi_row / missing
meta.shareable, stay quiet on a compliant research report and on non-research types, and
never stop the write. Also the schema_version choice: 1.3 iff meta carries `shareable`,
else 1.2 iff a candlestick, else 1.1.
Run: cd blaveclaw-config && .venv/bin/python tests/check_report_warnings.py
"""
import contextlib, io, json, os, shutil, sys, tempfile
WS = tempfile.mkdtemp(prefix="rpt-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.report import write_report, REPORTS_DIR

LEAD = {"type": "text", "variant": "lead", "markdown": "claim"}
KPI = {"type": "kpi_row", "items": [{"label": "x", "value": "1", "tone": "neutral"}]}
CANDLE = {"type": "candlestick", "candles": [[1, 1, 2, 0.5, 1.5], [2, 1.5, 2, 1, 1.8]]}
S = {"shareable": True}
fails = []

def doc(rid):
    with open(os.path.join(REPORTS_DIR, rid + ".json"), encoding="utf-8") as f:
        return json.load(f)

def run(rid, title, blocks, **kw):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        path = write_report(rid, title, blocks, **kw)
    if not os.path.exists(path):
        fails.append(f"{rid}: report not written")
    return buf.getvalue()

def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)

try:
    out = run("ok", "日圓干預只延後了貶值，沒有扭轉它", [LEAD, KPI], type="research", meta=S)
    check("WARNING" not in out, "compliant research report: no warning")
    out = run("long", "字" * 41, [LEAD, KPI], type="research", meta=S)
    check("title is 82 wide" in out and out.count("WARNING") == 1, "41 CJK chars: title warning only")
    check(out.isascii(), "warning text is ASCII (Windows run.log is cp950)")
    check("WARNING" not in run("latin", "a" * 80, [LEAD, KPI], type="research", meta=S), "80 Latin chars: no warning")
    meta = {"type": "meta", "title": "字" * 41, "report_type": "一次性", "generated_at": 1756684800}
    check("title is 82 wide" in run("metattl", "short", [meta, LEAD, KPI], type="research"),
          "caller's meta.title (the rendered one) is what gets measured")
    check("no kpi_row" in run("nokpi", "t", [LEAD, {"type": "text", "markdown": "x"}, KPI], type="research"),
          "kpi_row not right after lead: warns")
    check("no kpi_row" not in run("nolead", "t", [KPI], type="research"), "no lead, kpi_row right after meta: quiet")
    check("WARNING" not in run("morning", "字" * 60, [LEAD], type="morning"), "morning report: never warns")

    check(doc("ok")["schema_version"] == "1.3" and doc("ok")["blocks"][0]["shareable"] is True,
          "shareable true lands on meta, schema 1.3")
    out = run("shf", "t", [LEAD, KPI], type="research", meta={"shareable": False})
    check(doc("shf")["schema_version"] == "1.3" and "WARNING" not in out,
          "explicit false: still 1.3 (a 1.2 api refuses the prop), no warning")
    out = run("shnone", "t", [LEAD, KPI], type="research")
    check(doc("shnone")["schema_version"] == "1.1" and "no meta.shareable" in out and out.isascii(),
          "research without shareable: 1.1 and warns")
    run("k", "t", [CANDLE], type="morning")
    check(doc("k")["schema_version"] == "1.2", "candlestick without shareable: still 1.2")
    run("ksh", "t", [LEAD, KPI, CANDLE], type="research", meta=S)
    check(doc("ksh")["schema_version"] == "1.3", "candlestick + shareable: 1.3")
    own = {"type": "meta", "title": "t", "report_type": "一次性", "generated_at": 1756684800, "shareable": True}
    out = run("ownmeta", "t", [own, LEAD, KPI], type="research")
    check(doc("ownmeta")["schema_version"] == "1.3" and "WARNING" not in out,
          "caller-supplied meta block with shareable: 1.3, no warning")
    out = run("mornsh", "t", [LEAD], type="morning", meta=S)
    check("no meaning on a morning report" in out and out.isascii(), "shareable on morning: warns, still written")
    out = run("strsh", "t", [LEAD, KPI], type="research", meta={"shareable": "true"})
    check("must be true or false" in out, "non-bool shareable: warns (api would refuse)")
    out = run("fut", "t", [LEAD, KPI], type="research", meta={"shareable": False, "involves_futures": True})
    check(doc("fut")["schema_version"] == "1.3" and doc("fut")["blocks"][0]["involves_futures"] is True
          and "WARNING" not in out, "involves_futures true lands on meta, 1.3, no warning")
    run("futonly", "t", [CANDLE], type="morning", meta={"involves_futures": False})
    check(doc("futonly")["schema_version"] == "1.3", "involves_futures alone (even false) makes 1.3")
    out = run("futstr", "t", [LEAD, KPI], type="research", meta={"shareable": True, "involves_futures": 1})
    check("involves_futures must be true or false" in out and out.isascii(),
          "non-bool involves_futures: ASCII warning")
finally:
    shutil.rmtree(WS, ignore_errors=True)

print("\nALL OK" if not fails else f"\n{len(fails)} FAILED")
sys.exit(1 if fails else 0)

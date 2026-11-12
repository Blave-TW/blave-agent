"""Minimal check for the research-skeleton warnings in lib/report.write_report
(references/reports.md §7b): they fire on a long title / a lead whose first sentence is long or
has no number / missing kpi_row / a
baseline delta on a pos/neg KPI cell / missing meta.shareable / a body or key-point sentence over two
numbers / a body table over 4x8 / an argument section not closing on a bold sentence, stay quiet on a compliant research report and on non-research types, and
never stop the write. Also the schema_version choice: 1.3 iff meta carries `shareable`,
else 1.2 iff a candlestick, else 1.1; 1.6 iff an image block carries `source`, and more than
two such blocks is refused before anything is written.
Run: cd blave-agent && .venv/bin/python tests/check_report_warnings.py
"""
import contextlib, io, json, os, shutil, sys, tempfile
WS = tempfile.mkdtemp(prefix="rpt-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.report import write_report, REPORTS_DIR

LEAD = {"type": "text", "variant": "lead", "markdown": "干預後 10 日內回吐八成，平常只有兩成。第二句。"}
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
    check("WARNING" not in run("cap", "字" * 24, [LEAD, KPI], type="research", meta=S), "24 CJK chars: no warning")
    out = run("long", "字" * 25, [LEAD, KPI], type="research", meta=S)
    check("title is 50 wide" in out and out.count("WARNING") == 1, "25 CJK chars: title warning only")
    check(out.isascii(), "warning text is ASCII (Windows run.log is cp950)")
    check("WARNING" not in run("latin", "a" * 48, [LEAD, KPI], type="research", meta=S), "48 Latin chars: no warning")
    check("title is 49 wide" in run("latin49", "a" * 49, [LEAD, KPI], type="research", meta=S), "49 Latin chars: warns")
    meta = {"type": "meta", "title": "字" * 25, "report_type": "一次性", "generated_at": 1756684800}
    check("title is 50 wide" in run("metattl", "short", [meta, LEAD, KPI], type="research"),
          "caller's meta.title (the rendered one) is what gets measured")
    check("no kpi_row" in run("nokpi", "t", [LEAD, {"type": "text", "markdown": "x"}, KPI], type="research"),
          "kpi_row not right after lead: warns")
    check("no kpi_row" not in run("nolead", "t", [KPI], type="research"), "no lead, kpi_row right after meta: quiet")
    nonum = {"type": "text", "variant": "lead", "markdown": "淨空破紀錄只對了一半。後面才有 9.1%。"}
    out = run("nonum", "t", [nonum, KPI], type="research", meta=S)
    check("has no number" in out and out.count("WARNING") == 1 and out.isascii(),
          "lead's first sentence without a number: warns (a number in sentence two does not count)")
    longlead = {"type": "text", "variant": "lead", "markdown": "字" * 40 + "1。"}
    check("first sentence is 83 wide" in run("longlead", "t", [longlead, KPI], type="research", meta=S),
          "lead's first sentence over 40 CJK: warns")
    en = {"type": "text", "variant": "lead", "markdown": "Launches cost 2 points against an ordinary week. More."}
    check("WARNING" not in run("enlead", "t", [en, KPI], type="research", meta=S), "Latin lead under 80 wide: quiet")
    q = {"type": "text", "variant": "lead", "markdown": "日圓干預真的有用嗎？10 日內回吐八成。"}
    check("has no number" in run("question", "t", [q, KPI], type="research", meta=S),
          "a question ending in 「？」 is the first sentence (same cut as publish): warns")
    en2 = {"type": "text", "variant": "lead", "markdown": "Launch weeks lost **2%** against an ordinary 0.4%. "
           "Across 31 launches 19 were down, the worst -11.2%, and the median 10-day return was -1.9% against +0.6%."}
    check("WARNING" not in run("en2", "t", [en2, KPI], type="research", meta=S),
          "two-sentence Latin lead: only the first (the card's sentence, cut at a period before a space) is measured")
    def kpi(delta, tone):
        return {"type": "kpi_row", "items": [{"label": "x", "value": "1", "tone": tone, "delta": delta}]}
    out = run("basepos", "t", [LEAD, kpi("平常 +4.3%", "pos")], type="research", meta=S)
    check("baseline in its delta" in out and out.count("WARNING") == 1 and out.isascii(),
          "baseline delta with tone pos: warns")
    check("baseline in its delta" in run("baseneg", "t", [LEAD, KPI, kpi("Baseline -0.4%", "neg")],
                                          type="research", meta=S), "any kpi_row, Latin baseline, neg: warns")
    check("WARNING" not in run("baseneu", "t", [LEAD, kpi("一般交易日 +4.3%", "neutral")], type="research", meta=S),
          "baseline delta with tone neutral: quiet")
    check("WARNING" not in run("movepos", "t", [LEAD, kpi("+4.3%", "pos")], type="research", meta=S),
          "a move in the delta with tone pos: quiet")
    check("WARNING" not in run("mornbase", "t", [LEAD, kpi("平常 +4.3%", "pos")], type="morning"),
          "baseline tone on a morning report: quiet (research only)")
    check("WARNING" not in run("mornnonum", "t", [nonum], type="morning"), "morning lead without a number: quiet")
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

    src = {"name": "CoinGlass", "url": "https://www.coinglass.com/pro/futures/LiquidationMap"}
    def cite(n):
        return {"type": "image", "file": f"c{n}.png", "alt": "chart", "source": dict(src)}
    pics = {f"c{n}.png": b"png" for n in range(3)}
    run("cite2", "t", [LEAD, KPI, cite(0), cite(1)], type="research", meta=S, images=pics)
    check(doc("cite2")["schema_version"] == "1.6", "image with source: 1.6 (over shareable's 1.3)")
    run("prof", "t", [{"type": "bar_chart", "variant": "profile"}, cite(0)], type="morning", images=pics)
    check(doc("prof")["schema_version"] == "1.6", "source wins over a 1.5 profile bar chart")
    run("own", "t", [{"type": "image", "file": "c0.png", "alt": "own"}], type="morning", images=pics)
    check(doc("own")["schema_version"] == "1.1", "own figure without source: no bump")
    try:
        write_report("cite3", "t", [LEAD, KPI, cite(0), cite(1), cite(2)], type="research", meta=S, images=pics)
        err = ""
    except ValueError as e:
        err = str(e)
    check("3 cited images" in err and "[4]" in err and err.isascii(),
          "third cited image: refused, names the extra block, ASCII message")
    check(not os.path.exists(os.path.join(REPORTS_DIR, "cite3.json"))
          and not os.path.exists(os.path.join(REPORTS_DIR, "cite3.files")),
          "refused before anything is written (no report, no sidecar)")

    # 7b A12 / A13 / A7 (research-report-readability spec §6): advisory like the rest
    def txt(md):
        return {"type": "text", "markdown": md}
    BAR = {"type": "bar_chart", "bars": [{"label": "a", "value": 1}]}
    def table(cols, rows):
        return {"type": "table", "columns": [{"key": f"c{i}", "label": "x"} for i in range(cols)],
                "rows": [{f"c{i}": 1 for i in range(cols)} for _ in range(rows)]}
    def warns(rid, body, kind="research"):
        return run(rid, "t", [LEAD, KPI] + body, type=kind, meta=S if kind == "research" else None)
    out = warns("dense", [txt("高檔 PCR 後 5 日，10 段裡 80% 上漲，一般交易日是 60%，但平均只多 +0.27 pp。")])
    check("text [3] sentence 1 carries 3 numbers" in out and out.count("WARNING") == 1 and out.isascii(),
          "A12: a body sentence with 3 numbers warns, names block and sentence, ASCII")
    check("WARNING" not in warns("two", [txt("高檔後 80% 上漲，一般交易日是60%。樣本 10 段，最差 -4.1%。")]),
          "A12: 2 numbers a sentence (one touching CJK) and the spread in the next sentence: quiet")
    check("WARNING" not in warns("dates", [txt("2020-12 到 2021-05、9/23 09:30、台積電(2330)、2018–2022 的 60 日、第 2 段，漲 3.1%。")]),
          "A12: dates, times, a bracketed code, years, windows and segment numbers are not counted")
    out = warns("pts", [txt("漲 1234.5 點，平常 1100.2 點，最差 -2300.5 點。")])
    check("carries 3 numbers" in out, "A12: a 4-digit figure with decimals is a number, not a date")
    out = warns("packed", [table(6, 3), BAR, txt("## 發現\n- 甲 80%，平常 60%，平均 0.27。"),
                           {"type": "text", "variant": "summary", "markdown": "總結。"}])
    check("carries 3 numbers" in out and "columns by" not in out and "bold sentence" not in out,
          "publish() output (closes on a summary text): sentence count only, no table / bold-close warning")
    out = warns("kp", [txt("- 高檔後 80% 上漲，平常 60%，平均多 0.27 pp。\n- 低檔後 55% 上漲。\n- 樣本 10 段。")])
    check("sentence 1 carries 3 numbers" in out and out.count("WARNING") == 1, "A12: a key-point bullet with 3 numbers warns")
    check("WARNING" not in warns("mornd", [txt("80%、60%、0.27 與 1.5。")], kind="morning"), "A12: research only")
    out = warns("wide", [txt("## 成本吃掉毛報酬\n接著看成本。"), table(5, 3), txt("**成本比毛報酬多。**")])
    check("is 5 columns by 3 rows" in out and out.count("WARNING") == 1, "A13: a 5-column body table warns")
    out = warns("long", [txt("## 成本吃掉毛報酬\n接著看成本。"), table(2, 9), txt("**成本比毛報酬多。**")])
    check("is 2 columns by 9 rows" in out and out.count("WARNING") == 1, "A13: a 9-row body table warns")
    check("WARNING" not in warns("fits", [txt("## 成本吃掉毛報酬\n接著看成本。"), table(4, 8), txt("**成本比毛報酬多。**")]),
          "A13: 4 x 8 in the body, closed in bold: quiet")
    check("WARNING" not in warns("appx", [txt("## 附表\n全量。"), table(9, 12)]) and
          "WARNING" not in warns("appxen", [txt("## Appendix\nAll of it."), table(9, 12)]),
          "A13: 附表 / Appendix tables are not counted, and the appendix needs no bold close")
    out = warns("cap", [txt("## 成本吃掉毛報酬\n接著看成本。"), BAR])
    check("section at [3]: its last text block [3] does not end on a whole bold sentence" in out
          and out.count("WARNING") == 1, "A7: an argument section closing on its chart (caption only) warns")
    out = warns("label", [txt("## 成本吃掉毛報酬\n接著看成本。"), BAR, txt("**結論**：成本比毛報酬多。")])
    check("does not end on a whole bold sentence" in out, "A7: a bold label before plain text is not a bold sentence")
    check("WARNING" not in warns("closed", [txt("## 成本吃掉毛報酬\n接著看成本。"), BAR,
                                            txt("藍色是成本。**扣掉成本以後每年都虧。**[^a]")]),
          "A7: closing bold sentence after the reading sentence (footnote ref allowed): quiet")
    check("WARNING" not in warns("why", [txt("## 為什麼問這題\n大家說高檔 PCR 之後會漲。")]),
          "A7: a section with no chart or table (why / how / key points) needs no bold close")

    # The same rules in the three places the agent reads them (spec §3: reports.md, describe(), quickstart())
    from lib import report_templates as RT
    rep = " ".join(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                     "references", "reports.md"), encoding="utf-8").read().split())
    chk = " ".join(" ".join(RT._publish_checklist(RT.Pack("research-x", "x", "research", "x", [], {}))).split())
    with contextlib.redirect_stdout(io.StringIO()):
        qs = " ".join(RT.quickstart().split())
    for where, text, marks in (
            ("reports.md 7b", rep, ("**A12. Two numbers a sentence** (research)", "here the baseline is counted as one of the two",
                                    "**≤ 14 CJK characters (≤ 28 Latin) and no number**", "the whole sentence in bold",
                                    "at most 4 columns by 8 rows", "at most five times", "**B10. Speculation",
                                    "at most 3 items", "after-the-fact descriptions", "the same section gives the spread",
                                    "「為什麼問這題」 → 「怎麼量」", "tmp/research/<same name>.notes.md", "Append only")),
            ("describe() checklist", chk, ("每句最多 2 個數字,基準算一個", "read 每條一句一個數字", "沒驗證過的解釋不寫成發現")),
            ("quickstart()", qs, ("<=2 numbers, baseline counted", "one sentence, one number each",
                                  "<=4 columns x 8 rows", "<=14 CJK, no number", "whole **bold** sentence",
                                  "## 為什麼問這題 (<=150 chars)", "## 怎麼量 (numbered steps", "in the order you measured",
                                  "everyday terms", "only in ## 推測", "tmp/research/<name>.notes.md"))):
        miss = [m for m in marks if m not in text]
        check(not miss, f"{where} carries the readability rules" + (f" - missing {miss}" if miss else ""))
    check("A9" in rep and "appears at most three times" not in rep, "A9: the three-places cap is gone (Q3: five)")
finally:
    shutil.rmtree(WS, ignore_errors=True)

print("\nALL OK" if not fails else f"\n{len(fails)} FAILED")
sys.exit(1 if fails else 0)

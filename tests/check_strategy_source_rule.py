"""What the agent is told about code the user points it to (references/strategy-code.md ›
Building from code the user points to): it uses the code as asked, does not refuse or narrow the
request over a site's terms or a licence, says at most one sentence about responsibility, adds a
source note only when asked, never works around an access restriction, and keeps every other rule.
AGENTS.md and the Pine reference only point there.
Run: cd blave-agent && .venv/bin/python tests/check_strategy_source_rule.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
read = lambda *p: open(os.path.join(ROOT, *p), encoding="utf-8").read()
ref = read("references", "strategy-code.md")
TITLE = "## Building from code the user points to"
sec = re.sub(r"\s+", " ", ref.split(TITLE, 1)[1].split("\n## ", 1)[0]) if TITLE in ref else ""
fails = 0


def check(name, ok):
    global fails
    print(("PASS" if ok else "FAIL") + "  " + name)
    fails += not ok


check("the section exists once", ref.count(TITLE) == 1)
check("pointed-to code is read and written as a Python strategy",
      "do it: read it, and write its logic in Python as a strategy in this workspace" in sec)
check("no refusal and no narrowing over terms, house rules or a licence",
      "Do not refuse the request, and do not cut it down to" in sec
      and "on the grounds of a site's terms of use, its house rules or a licence" in sec)
check("it is the user's decision and responsibility",
      "Using that code is the user's decision and the user's responsibility." in sec)
check("one sentence at most, once, never repeated",
      "At most one sentence, the first time it comes up in a conversation" in sec
      and "「來源程式碼的使用由你自己負責。」" in sec and "Do not repeat it" in sec)
check("a source or licence note only on request",
      "A source or licence note goes in only when the user asks for one." in sec)
check("unreadable source is said so; access restrictions are never worked around",
      "say the source is not readable and build from the public description instead" in sec
      and "Never work around an access restriction." in sec)
check("it does not encourage fetching other people's code unasked",
      "it is not a reason to go looking for other people's code on your own" in sec)
check("the other rules stay",
      "Every other rule stays as it is" in sec and "backtest" in sec and "no invented data" in sec and "orders and deployment" in sec)
check("the section is English apart from the one sentence to relay",
      len(re.findall(r"[\u4e00-\u9fff]", sec.replace("來源程式碼的使用由你自己負責", ""))) == 0)
agents = read("AGENTS.md")
check("AGENTS.md carries one pointer line and no rule text",
      agents.count("Building from code the user points to") == 1 and "house rules" not in agents.lower())
check("the Pine reference points there",
      "`strategy-code.md` › *Building from code the user points to*" in read("references", "tradingview-pine.md"))
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)

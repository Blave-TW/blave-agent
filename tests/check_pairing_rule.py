"""Telegram pairing limits notifications only — it never blocks a backtest, a scan or a data question
(win-e2e-0.1.39 F1: Codex read references/lib.md's old "CRITICAL — Pairing check … before any other action"
literally and refused to backtest its own new strategy on an unpaired desktop).

  ① AGENTS.md keeps the never-block sentence;
  ② no rule file the agent reads (AGENTS.md, references/, docs/) still makes pairing a gate: every sentence that
     names pairing is free of blocking wording (before any other action / at session start / do not proceed /
     until pairing is confirmed / before any strategy run);
  ③ lib.md and strategy-code.md › Telegram Pairing Check say it is checked only for a Telegram send, and that
     everything else goes ahead.

Run: cd blave-agent && python3 tests/check_pairing_rule.py
"""
import glob, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
read = lambda p: open(os.path.join(ROOT, p), encoding="utf-8").read()  # noqa: E731
fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


flat = lambda s: re.sub(r"\s+", " ", s)  # noqa: E731

agents = flat(read("AGENTS.md"))
t("① AGENTS.md: pairing never blocks a backtest or data question",
  "only when the run sends Telegram — never block a backtest or data question on it" in agents)

BLOCKING = re.compile(r"before any other action|at session start|session start|do not proceed|don't proceed"
                      r"|until pairing|until .{0,20}paired|before any strategy run|first,? before|pair(?:ing|ed)? first"
                      r"|must (?:be )?pair", re.I)
PAIR = re.compile(r"\bpair(?:ing|ed)\b|配對", re.I)
files = ["AGENTS.md", "CLAUDE.md"] + sorted(os.path.relpath(p, ROOT) for pat in ("references/**/*.md", "docs/**/*.md")
                                           for p in glob.glob(os.path.join(ROOT, pat), recursive=True))
t("② rule files found", len(files) > 20, files)
hits = []
for f in files:
    for block in re.split(r"\n\s*\n|\n(?=\s*[-*] )|\n(?=#)", read(f)):
        for sent in re.split(r"(?<=[.!?。])\s+", flat(block)):
            if PAIR.search(sent) and re.search(r"telegram|bot|notif|通知", sent, re.I) and BLOCKING.search(sent):
                hits.append((f, sent[:160]))
    for sec in re.split(r"\n(?=#+ )", read(f)):
        head, _, body = sec.partition("\n")
        if PAIR.search(head) and BLOCKING.search(flat(body)):
            hits.append((f, head, BLOCKING.search(flat(body)).group(0)))
t("② no sentence (or section about pairing) makes Telegram pairing a gate", not hits, hits)

lib = flat(read("references/lib.md"))
m = re.search(r"\*\*Telegram pairing[^*]*\*\*[^\n]*?(?= - `|$)", lib)
bullet = m.group(0) if m else ""
t("③ lib.md: checked only for a Telegram send, never blocks a backtest",
  "only when what the user asked for is a Telegram message" in bullet
  and "Never block a backtest, a scan, an analysis or a data question on it" in bullet, bullet[:300])

sc = read("references/strategy-code.md")
sec = flat(sc.split("## Telegram Pairing Check", 1)[1].split("\n## ", 1)[0]) if "## Telegram Pairing Check" in sc else ""
t("③ strategy-code.md: the section exists once", sc.count("## Telegram Pairing Check") == 1)
t("③ strategy-code.md: run only for a Telegram send, never as a session-start step",
  "Run this only when what the user asked for is a Telegram message" in sec
  and "never before a backtest, a scan, an analysis or a data question" in sec)
t("③ strategy-code.md: unpaired → say nothing was sent, the rest goes ahead",
  "do not report it as sent" in sec and "goes ahead as usual" in sec)
t("③ strategy-code.md: the check snippet itself is kept (AGENTS.md points there)", "telegram-default-allowFrom.json" in sec)

if fails:
    sys.exit(f"{len(fails)} failed: {fails}")
print("all passed")

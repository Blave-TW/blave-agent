"""Telegram pairing limits notifications only — it never blocks a backtest, a scan or a data question
(win-e2e-0.1.39 F1: Codex read references/lib.md's old "CRITICAL — Pairing check … before any other action"
literally and refused to backtest its own new strategy on an unpaired desktop).

  ① AGENTS.md keeps the never-block sentence;
  ② no rule file the agent reads (AGENTS.md, CLAUDE.md, references/, docs/) and no string literal in runtime/ (the
     prompt text it is handed) still makes pairing a gate: every sentence naming pairing and Telegram is free of
     blocking wording (before any other action / at session start / do not proceed / until pairing / … first /
     先配對 …); the detector checks itself on sample sentences;
  ③ lib.md and strategy-code.md › Telegram Pairing Check use AGENTS.md's words ("only when the run sends Telegram")
     and say everything else goes ahead.

Run: cd blave-agent && python3 tests/check_pairing_rule.py
"""
import ast, glob, os, re, sys

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

# Wording that already names pairing as the gate fires on its own; the generic phrases only next to pairing + Telegram.
PAIR_GATE = re.compile(
    r"until pairing|until .{0,20}paired|must (?:be )?pair|requires? (?:telegram )?pairing|pairing is required"
    r"|needs? (?:to be )?paired|only after pairing|\bpair\w*\b(?:\s+\S+){0,4}?\s+first\b|\bfirst\b(?:\s+\S+){0,3}?\s+pair"
    r"|先(?:完成)?\s*(?:telegram\s*)?配對|配對(?:完成)?後才|未(?:完成)?配對.{0,20}(?:無法|不能|先)", re.I)
BLOCKING = re.compile(r"before any other action|at session start|session start|do not proceed|don't proceed"
                      r"|before any strategy run|first,? before|" + PAIR_GATE.pattern, re.I)
PAIR = re.compile(r"\bpair(?:ing|ed)?\b|配對", re.I)
TOPIC = re.compile(r"telegram|bot|notif|通知", re.I)


def gate_sentences(text):
    out = []
    for block in re.split(r"\n\s*\n|\n(?=\s*[-*] )|\n(?=#)", text):
        for sent in re.split(r"(?<=[.!?。])\s*", flat(block)):
            if PAIR_GATE.search(sent) or (PAIR.search(sent) and TOPIC.search(sent) and BLOCKING.search(sent)):
                out.append(sent[:160])
    return out


SAMPLES = ["Complete pairing first.", "先配對。", "Pair Telegram first.", "Telegram must be paired before you run anything.",
           "Check Telegram pairing first, then start the backtest.", "先完成 Telegram 配對才能回測。",
           "If the bot is not paired, do not proceed."]
t("② the detector flags each way of making pairing a gate (self-check)", all(gate_sentences(x) for x in SAMPLES),
  [x for x in SAMPLES if not gate_sentences(x)])
t("② …and not the rule as it stands", not gate_sentences(
    "Telegram pairing: check it only when the run sends Telegram — never block a backtest or data question on it."))

files = ["AGENTS.md", "CLAUDE.md"] + sorted(os.path.relpath(p, ROOT) for pat in ("references/**/*.md", "docs/**/*.md")
                                           for p in glob.glob(os.path.join(ROOT, pat), recursive=True))
t("② rule files found", len(files) > 20, files)
hits = []
for f in files:
    hits += [(f, x) for x in gate_sentences(read(f))]
    for sec in re.split(r"\n(?=#+ )", read(f)):
        head, _, body = sec.partition("\n")
        if PAIR.search(head) and BLOCKING.search(flat(body)):
            hits.append((f, head, BLOCKING.search(flat(body)).group(0)))
t("② no sentence (or section about pairing) in the rule files makes Telegram pairing a gate", not hits, hits)

# the runtime's own prompt text (every string literal under runtime/, f-string pieces included)
rt_hits, n_strings = [], 0
for path in sorted(glob.glob(os.path.join(ROOT, "runtime", "*.py"))):
    for node in ast.walk(ast.parse(open(path, encoding="utf-8").read())):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            n_strings += 1
            rt_hits += [(os.path.basename(path), node.lineno, x) for x in gate_sentences(node.value)]
t("② runtime string literals scanned", n_strings > 1000, n_strings)
t("② no runtime prompt string makes Telegram pairing a gate", not rt_hits, rt_hits)

lib = flat(read("references/lib.md"))
m = re.search(r"\*\*Telegram pairing[^*]*\*\*[^\n]*?(?= - `|$)", lib)
bullet = m.group(0) if m else ""
t("③ lib.md: same words as AGENTS.md — checked only when the run sends Telegram, never blocks a backtest",
  "only when the run sends Telegram — never block a backtest, a scan, an analysis or a data question on it" in bullet,
  bullet[:300])

sc = read("references/strategy-code.md")
sec = flat(sc.split("## Telegram Pairing Check", 1)[1].split("\n## ", 1)[0]) if "## Telegram Pairing Check" in sc else ""
t("③ strategy-code.md: the section exists once", sc.count("## Telegram Pairing Check") == 1)
t("③ strategy-code.md: same words as AGENTS.md, never a session-start step",
  "Run this only when the run sends Telegram — never block a backtest, a scan, an analysis or a data question on it" in sec
  and "never run it as a session-start step" in sec, sec[:300])
t("③ strategy-code.md: unpaired → say nothing was sent, the rest goes ahead",
  "do not report it as sent" in sec and "goes ahead as usual" in sec)
t("③ strategy-code.md: the check snippet itself is kept (AGENTS.md points there)", "telegram-default-allowFrom.json" in sec)

if fails:
    sys.exit(f"{len(fails)} failed: {fails}")
print("all passed")

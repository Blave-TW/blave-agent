#!/usr/bin/env python3
"""Static lint for exported strategy code — XQ XS / MultiCharts PowerLanguage / TradingView Pine v6.

    python lib/lint_export.py --target {xq,mc,pine} <file>
    python lib/lint_export.py --selftest

Exit 0 = pass (warnings allowed), 1 = errors, 2 = usage / unreadable file.

This is NOT a compiler — nothing here can compile XS, PowerLanguage or Pine.
It catches what a static pass can: identifier typos and undeclared names
(against the official keyword/function lists in lib/lint_export_data/),
platform-foreign constructs (EasyLanguage-only words in XS, OOEL / .NET / Pine
in PowerLanguage, v4/v5 leftovers in Pine), unbalanced brackets, full-width
punctuation, and a few known compile-killers per platform. Run it after every
translation and fix until it passes; a passing file still MUST be compiled and
backtested by the user inside the target platform.
"""
import json
import os
import re
import sys

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lint_export_data")
FULLWIDTH = re.compile("[，；（）：「」、！？【】《》“”‘’＝＜＞]")
IDENT = re.compile(r"(?<![0-9A-Za-z_.])[A-Za-z_][A-Za-z0-9_]*")
PINE_IDENT = re.compile(r"(?<![0-9A-Za-z_.])[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*")


def _load(name):
    with open(os.path.join(DATA_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def _lower(seq):
    return {s.lower() for s in seq}


class Report:
    def __init__(self):
        self.errors, self.warnings = [], []

    def err(self, line, msg):
        self.errors.append((line, msg))

    def warn(self, line, msg):
        self.warnings.append((line, msg))

    def ok(self):
        return not self.errors

    def render(self):
        out = []
        for line, msg in sorted(self.errors):
            out.append(f"ERROR line {line}: {msg}")
        for line, msg in sorted(self.warnings):
            out.append(f"WARN  line {line}: {msg}")
        return "\n".join(out)


# --------------------------------------------------------------------------- masking
def _mask(src, rep, block_comments, single_quote_strings, escapes, brace_check=False):
    """Blank out comments and strings (keeping newlines) so later passes only see code.
    Returns (masked_code, strings_found_single_quote_positions)."""
    out = []
    i, n, line = 0, len(src), 1
    single_quotes = []
    while i < n:
        c = src[i]
        if c == "\n":
            out.append(c)
            line += 1
            i += 1
        elif src.startswith("//", i):
            while i < n and src[i] != "\n":
                out.append(" ")
                i += 1
        elif block_comments and c == "{":
            out.append(" ")
            i += 1
            while i < n and src[i] != "}":
                if src[i] == "{" and brace_check:
                    rep.err(line, "'{' inside an open { } comment — block comments do not nest; the first '}' ends the comment")
                if src[i] == "\n":
                    line += 1
                    out.append("\n")
                else:
                    out.append(" ")
                i += 1
            if i < n:
                out.append(" ")
                i += 1
        elif c == '"' or (single_quote_strings and c == "'"):
            q = c
            out.append(" ")
            i += 1
            while i < n and src[i] != q:
                if escapes and src[i] == "\\" and i + 1 < n:
                    out.append("  ")
                    i += 2
                    continue
                if src[i] == "\n":
                    rep.err(line, "unterminated string")
                    break
                out.append(" ")
                i += 1
            if i < n and src[i] == q:
                out.append(" ")
                i += 1
        elif c == "'":
            single_quotes.append(line)
            out.append(c)
            i += 1
        else:
            out.append(c)
            i += 1
    return "".join(out), single_quotes


def _line_of(code, pos):
    return code.count("\n", 0, pos) + 1


def _common_checks(code, rep, brackets="()[]"):
    for m in FULLWIDTH.finditer(code):
        rep.err(_line_of(code, m.start()), f"full-width punctuation {m.group()!r} in code")
    pairs = {brackets[i]: brackets[i + 1] for i in range(0, len(brackets), 2)}
    closers = {v: k for k, v in pairs.items()}
    stack = []
    for i, c in enumerate(code):
        if c in pairs:
            stack.append((c, i))
        elif c in closers:
            if not stack or stack[-1][0] != closers[c]:
                rep.err(_line_of(code, i), f"unbalanced '{c}'")
                return
            stack.pop()
    for c, i in stack:
        rep.err(_line_of(code, i), f"unclosed '{c}'")


def _paren_depth_map(code):
    depth, out = 0, []
    for c in code:
        if c in "([":
            depth += 1
        elif c in ")]":
            depth = max(0, depth - 1)
        out.append(depth)
    return out


# --------------------------------------------------------------------------- XS / PowerLanguage (EasyLanguage family)
DECL_HEAD = re.compile(r"(?i)(?<![A-Za-z0-9_])(inputs?|vars?|variables?|arrays?)\s*:")


def _el_declared(code):
    names = set()
    for m in DECL_HEAD.finditer(code):
        end = code.find(";", m.end())
        clause = code[m.end():end if end != -1 else len(code)]
        for d in re.finditer(r"([A-Za-z_][A-Za-z0-9_.]*)\s*[\(\[]", clause):
            names.add(d.group(1).lower())
    return names


def lint_xq(src):
    d = _load("xs.json")
    rep = Report()
    code, single_quotes = _mask(src, rep, block_comments=True, single_quote_strings=False, escapes=False)
    for ln in single_quotes:
        rep.err(ln, "single quote — XS strings use double quotes only")
    _common_checks(code, rep)
    known = _lower(d["keywords"]) | _lower(d["functions"]) | _lower(d["variables"])
    blocked = {b.lower(): b for b in d["blocked"] if " " not in b}
    phrases = [b for b in d["blocked"] if " " in b]
    declared = _el_declared(code)
    implicit = re.compile(r"(?i)^(value\d{1,3}|condition\d{1,3}|plot\d{1,2})$")
    # XQ rejects any identifier that STARTS with Buy/Sell (Short*/Cover* compile fine).
    for h in DECL_HEAD.finditer(code):
        end = code.find(";", h.end())
        clause_end = end if end != -1 else len(code)
        for d in re.finditer(r"([A-Za-z_][A-Za-z0-9_.]*)\s*[\(\[]", code[h.end():clause_end]):
            name = d.group(1)
            if name.lower().startswith(("buy", "sell")):
                rep.err(_line_of(code, h.end() + d.start()),
                        f"'{name}' starts with Buy/Sell — XQ: \"{name[:3] if name.lower().startswith('buy') else name[:4]}\" "
                        "不允許當成變數開頭; identifiers may not start with Buy or Sell (e.g. rename BuyTh → LongEntryTh)")
    for m in re.finditer(r"(?i)\bend\s*;\s*else\b", code):
        rep.err(_line_of(code, m.start()), "'end; else' — no semicolon before else in XS (write 'end else')")
    for p in phrases:
        for m in re.finditer(r"(?i)(?<![A-Za-z0-9_])" + r"\s+".join(map(re.escape, p.split())) + r"(?![A-Za-z0-9_])", code):
            rep.err(_line_of(code, m.start()), f"'{p}' is EasyLanguage, not XS — orders go through SetPosition()")
    depth = _paren_depth_map(code)
    for m in IDENT.finditer(code):
        tok = m.group()
        low = tok.lower()
        line = _line_of(code, m.start())
        if low in declared or implicit.match(tok):
            continue
        if low in blocked:
            rep.err(line, f"'{tok}' is EasyLanguage-only, does not exist in XS (see references/xq-xs.md order-API table)")
            continue
        if low in known:
            continue
        rest = code[m.end():m.end() + 3]
        if depth[m.start()] > 0 and rest.lstrip().startswith(":="):
            continue  # named parameter form label:="..."
        rep.err(line, f"unknown identifier '{tok}' — not an XS built-in and not declared with input:/var:")
    return rep


def lint_mc(src):
    d = _load("powerlanguage.json")
    rep = Report()
    code, single_quotes = _mask(src, rep, block_comments=True, single_quote_strings=False, escapes=False, brace_check=True)
    for ln in single_quotes:
        rep.err(ln, "single quote — PowerLanguage strings use double quotes only")
    _common_checks(code, rep)
    keywords = _lower(d["keywords"])
    functions = _lower(d["functions"])
    unsupported = _lower(d["unsupported"])
    discouraged = _lower(d["discouraged"])
    declared = _el_declared(code)
    for name in sorted(declared & keywords):
        rep.err(1, f"'{name}' is a reserved word — cannot be used as an Input/Variable name (rename it)")
    implicit = re.compile(r"(?i)^(value\d{1,2}|condition\d{1,2})$")
    for m in re.finditer(r"(?i)\bend\s*;\s*else\b", code):
        rep.err(_line_of(code, m.start()), "'end; else' — no semicolon before else (write 'end else')")
    for m in IDENT.finditer(code):
        tok = m.group()
        low = tok.lower()
        line = _line_of(code, m.start())
        # attribute blocks [Name = value] and dotted .NET / Pine names
        after = code[m.end():m.end() + 1]
        if low in unsupported or (after == "." and low in unsupported):
            rep.err(line, f"'{tok}' is not classic PowerLanguage (OOEL / MC.NET / Pine / TradeStation-only)")
            continue
        if after == ".":
            rep.err(line, f"dotted name '{tok}.…' — classic PowerLanguage has no namespaces / objects")
            continue
        if low in discouraged:
            rep.warn(line, f"'{tok}' compiles but behaves differently in MC (see references/multicharts-powerlanguage.md trap list)")
            continue
        if low in keywords or low in declared or implicit.match(tok):
            continue
        if low in functions:
            continue
        if code[m.end():].lstrip().startswith("("):
            rep.warn(line, f"'{tok}(' is not in the known function list — verify it exists in MC's function library")
        else:
            rep.err(line, f"unknown identifier '{tok}' — not a PowerLanguage keyword and not declared in Inputs:/Variables:")
    return rep


# --------------------------------------------------------------------------- Pine v6
PINE_FUNC_DEF = re.compile(r"^\s*(?:export\s+)?(?:method\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*=>", re.M)
PINE_NOT_TYPE = r"(?!(?:if|else|for|while|and|or|not|switch|return|import|export|method|type|enum|in|by|to)\s)"
PINE_DECL = re.compile(
    r"^\s*(?:(?:var|varip)\s+)?(?:(?:series|simple|const|input)\s+)?"
    r"(?:(?:array|matrix|map)<[^>]*>\s+|" + PINE_NOT_TYPE + r"[A-Za-z_][\w.]*\s+)?([A-Za-z_]\w*)\s*=(?!=|>)",
    re.M,
)
PINE_TUPLE = re.compile(r"^\s*\[([^\]]+)\]\s*=(?!=)", re.M)
PINE_FOR = re.compile(r"\bfor\s+(?:\[([^\]]+)\]|([A-Za-z_]\w*))\s*(?:=|\bin\b)")
PINE_TYPE = re.compile(r"^\s*(?:export\s+)?(type|enum)\s+([A-Za-z_]\w*)", re.M)
PINE_FIELD = re.compile(r"^\s+(?:[A-Za-z_][\w.]*(?:<[^>]*>)?\s+)?([A-Za-z_]\w*)\s*(?:=|$)", re.M)
PINE_IMPORT = re.compile(r"^\s*import\s+\S+\s+as\s+([A-Za-z_]\w*)", re.M)


def _pine_declared(code):
    names = set()
    for m in PINE_FUNC_DEF.finditer(code):
        names.add(m.group(1))
        for p in m.group(2).split(","):
            ids = re.findall(r"[A-Za-z_]\w*", p.split("=")[0])
            if ids:
                names.add(ids[-1])
    for m in PINE_DECL.finditer(code):
        names.add(m.group(1))
    for m in PINE_TUPLE.finditer(code):
        names.update(re.findall(r"[A-Za-z_]\w*", m.group(1)))
    for m in PINE_FOR.finditer(code):
        names.update(re.findall(r"[A-Za-z_]\w*", m.group(1) or m.group(2)))
    for m in PINE_IMPORT.finditer(code):
        names.add(m.group(1))
    for m in PINE_TYPE.finditer(code):
        names.add(m.group(2))
        # fields / members: indented lines directly after the header
        for ln in code[m.end():].split("\n")[1:]:
            if not ln.strip():
                continue
            if not ln[0].isspace():
                break
            f = PINE_FIELD.match(ln)
            if f:
                names.add(f.group(1))
    return names


def lint_pine(src):
    d = _load("pine.json")
    rep = Report()
    first = src.lstrip("﻿").split("\n", 1)[0].strip()
    if first != "//@version=6":
        rep.err(1, "first line must be exactly '//@version=6'")
    code, _ = _mask(src, rep, block_comments=False, single_quote_strings=True, escapes=True)
    _common_checks(code, rep)
    all_names = set(d["all"])
    namespaces = {k: set(v) for k, v in d["namespaces"].items()}
    deprecated = set(d["deprecated"])
    warn = set(d["warn"])
    declared = _pine_declared(code)
    depth = _paren_depth_map(code)
    # deprecated named parameters
    for p in ("when", "transp", "resolution", "defval_type"):
        for m in re.finditer(r"(?<![A-Za-z0-9_.])" + p + r"\s*=(?!=)", code):
            if depth[m.start()] > 0:
                rep.err(_line_of(code, m.start()), f"named argument '{p}=' was removed (v4/v5) — see references/tradingview-pine.md")
    for m in re.finditer(r"(?<![A-Za-z0-9_.])type\s*=(?!=)", code):
        if depth[m.start()] > 0 and "input" in code[max(0, m.start() - 200):m.start()].rsplit("\n", 1)[-1]:
            rep.err(_line_of(code, m.start()), "'type=' inside input() was removed — use input.int / input.float / …")
    # strategy() header must be const
    sm = re.search(r"(?<![A-Za-z0-9_.])strategy\s*\(", code)
    if sm:
        i, dep = sm.end(), 1
        while i < len(code) and dep:
            dep += code[i] == "("
            dep -= code[i] == ")"
            i += 1
        header = code[sm.end():i]
        bad = re.search(r"(?<![A-Za-z0-9_.])input\.", header)
        used = {t.group() for t in IDENT.finditer(header)} & declared
        if bad or used:
            rep.err(_line_of(code, sm.start()), "strategy() arguments must be literals — no input.* and no script variables in the header")
    else:
        rep.err(1, "no strategy() declaration found")
    for m in PINE_IDENT.finditer(code):
        tok = m.group()
        line = _line_of(code, m.start())
        after = code[m.end():m.end() + 2]
        if depth[m.start()] > 0 and re.match(r"\s*=(?!=|>)", code[m.end():m.end() + 3]):
            continue  # named argument
        if tok in all_names:
            if tok in warn:
                rep.warn(line, f"'{tok}' changes fills / can repaint — report it in the delivery note")
            continue
        root, _, suffix = tok.partition(".")
        if root in namespaces:
            if suffix in namespaces[root]:
                continue
            rep.err(line, f"unknown member '{tok}' — not in the v6 '{root}.*' namespace")
            continue
        if root in declared:
            continue  # user variable / UDT field / method on user object — fields cannot be verified statically
        if tok in deprecated:
            rep.err(line, f"'{tok}' is v4/v5 syntax — use the v6 namespaced form (ta.*, input.*, str.*, …)")
            continue
        rep.err(line, f"unknown identifier '{tok}' — not a Pine v6 built-in and not declared in this script")
    return rep


LINTERS = {"xq": lint_xq, "mc": lint_mc, "pine": lint_pine}


# --------------------------------------------------------------------------- selftest
BAD = {
    "xq": [
        ("Buy next bar at market;", "EasyLanguage"),
        ("input: Len(20);\nif Average(Close, Len) > Close then begin\n  SetPosition(1);\nend; else\n  SetPosition(0);", "end; else"),
        ("var: x(0);\nx = Averag(Close, 20);", "unknown identifier 'Averag'"),
        ("var: x(0);\nx = Average(Close，20);", "full-width"),
        ("if MarketPosition = 1 then SetPosition(0);", "EasyLanguage-only"),
        ("input: BuyTh(3.0);\ninput: SellTh(1.0);\nif Close > BuyTh then SetPosition(1, MARKET);", "may not start with Buy or Sell"),
    ],
    "mc": [
        ("Inputs: Contracts(1);\nBuy Contracts contracts next bar at market;", "reserved word"),
        ("{ header {1, 0, -1} }\nBuy next bar at market;", "do not nest"),
        ("method void f() begin end;", "not classic PowerLanguage"),
        ("Variables: x(0);\nx = Average(Close, 20);\nif x > Cloze then Buy next bar at market;", "unknown identifier 'Cloze'"),
        ("strategy.entry(\"L\", strategy.long);", "no namespaces"),
    ],
    "pine": [
        ("//@version=5\nstrategy(\"x\")\n", "//@version=6"),
        ("//@version=6\nstrategy(\"x\")\nma = sma(close, 20)\n", "v4/v5 syntax"),
        ("//@version=6\nstrategy(\"x\")\nlongOK = close > open\nstrategy.entry(\"L\", strategy.long, when=longOK)\n", "removed"),
        ("//@version=6\nstrategy(\"x\")\nma = ta.smaa(close, 20)\n", "unknown member"),
        ("//@version=6\nqty = input.int(1)\nstrategy(\"x\", default_qty_value=qty)\nma = ta.sma(close, 20)\n", "must be literals"),
        ("//@version=6\nstrategy(\"x\", default_qty_value=input.int(1))\n", "must be literals"),
        ("//@version=6\nstrategy(\"x\")\nif cnt = 5\n    strategy.close_all()\n", "unknown identifier 'cnt'"),
    ],
}


GOOD = {
    "xq": ["input: Stop(2), Limit(1);\nvar: shares(0);\nshares = Filled;\nif Close > Stop then SetPosition(1, MARKET, label:=\"L\");",
           "input: ShortTh(-3);\ninput: CoverTh(-1);\nif Close < ShortTh then SetPosition(-1, MARKET);",
           "var: f(0), s(0), up(false);\nf = Average(Close, 5);\ns = Average(Close, 20);\nValue1 = Highest(High, 20);\n"
           "up = f[1] cross over s[1] and Close[1] > Value1[2];\n"
           "if Position = 0 and Filled = 0 and Filled[1] = 0 and up then SetPosition(1, MARKET);"],
    "mc": ["Inputs: Qty(1);\nVariables: x(0);\nx = Average(Close, 20);\nif Close crosses over x then Buy Qty contracts next bar at market;"],
    "pine": ["//@version=6\nstrategy(\"x\")\nlen = input.int(20)\nma = ta.sma(close, len)\nif close > ma\n    strategy.entry(\"L\", strategy.long, qty=1)\n"],
}


def selftest():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ex = {"xq": ("examples/exports/xq", ".xs"), "mc": ("examples/exports/mc", ".txt"), "pine": ("examples/exports/pine", ".pine")}
    failed = 0
    for target, (sub, ext) in ex.items():
        folder = os.path.join(here, sub)
        files = sorted(f for f in os.listdir(folder) if f.endswith(ext)) if os.path.isdir(folder) else []
        for f in files:
            with open(os.path.join(folder, f), encoding="utf-8") as fh:
                rep = LINTERS[target](fh.read())
            if not rep.ok():
                failed += 1
                print(f"FAIL template {sub}/{f}\n{rep.render()}")
        for snippet in GOOD[target]:
            rep = LINTERS[target](snippet)
            if not rep.ok():
                failed += 1
                print(f"FAIL {target} good snippet reported errors:\n{snippet}\n{rep.render()}")
        for snippet, expect in BAD[target]:
            rep = LINTERS[target](snippet)
            hit = any(expect in msg for _, msg in rep.errors)
            if not hit:
                failed += 1
                print(f"FAIL {target} bad snippet did not raise {expect!r}:\n{snippet}\n{rep.render() or '(clean)'}")
        print(f"{target}: {len(files)} templates, {len(BAD[target])} bad snippets checked")
    print("selftest", "FAILED" if failed else "OK")
    return 1 if failed else 0


def main(argv):
    if argv[1:] == ["--selftest"]:
        return selftest()
    if len(argv) != 4 or argv[1] != "--target" or argv[2] not in LINTERS:
        print(__doc__)
        return 2
    try:
        with open(argv[3], encoding="utf-8") as fh:
            src = fh.read()
    except OSError as e:
        print(f"cannot read {argv[3]}: {e}")
        return 2
    rep = LINTERS[argv[2]](src)
    if rep.ok() and _strategy_dir(argv[2], argv[3]) and not _template_of(src):
        # The file header, the sidecar and the app all say "from a template": the header has to name which one.
        rep.err(1, "the header comment has no `Template:` / `Skeleton:` line — keep the line naming the "
                   "examples/exports file this was adapted from (add the strategy on its own line, do not replace it)")
    out = rep.render()
    if out:
        print(out)
    print("PASS" if rep.ok() else f"FAIL ({len(rep.errors)} errors)")
    if rep.ok():
        write_meta(argv[2], argv[3], src)
    return 0 if rep.ok() else 1


EXPORT_FILES = {"xq": "xq.xs", "mc": "mc.txt", "pine": "pine.pine"}
_TEMPLATE_RE = re.compile(r"^\W*(?:Template|Skeleton)\s*:\s*(.+?)\s*$", re.M)


def _strategy_dir(target, file_path):
    """strategies/<name> when file_path is that strategy's export file for `target`, else None."""
    full = os.path.realpath(file_path)
    exp_dir = os.path.dirname(full)
    strat_dir = os.path.dirname(exp_dir)
    if (os.path.basename(full) != EXPORT_FILES[target] or os.path.basename(exp_dir) != "exports"
            or os.path.basename(os.path.dirname(strat_dir)) != "strategies"):
        return None
    return strat_dir


def _template_of(src):
    """The template an export was adapted from: the header's `Template:` / `Skeleton:` line (first 20 lines)."""
    m = _TEMPLATE_RE.search("\n".join(src.splitlines()[:20]))
    return m.group(1)[:80] if m else None


def write_meta(target, file_path, src):
    """A lint pass on strategies/<name>/exports/<xq.xs|mc.txt|pine.pine> writes <file>.meta.json next to it:
    {target, source_sha256, exported_at, template}. Written here, not by the agent, so it is
    deterministic. The desktop app compares source_sha256 with the current strategy.py to tell
    whether the export fell behind (mtime is unreliable: git checkout and folder copies touch it).
    `template` is never null for a file that passed: main() refuses an export whose header does not
    name its template. Any other path (a scratch file, a template) gets no sidecar. Returns the
    sidecar path or None."""
    import datetime
    import hashlib
    full = os.path.realpath(file_path)
    strat_dir = _strategy_dir(target, file_path)
    if not strat_dir:
        return None
    try:
        with open(os.path.join(strat_dir, "strategy.py"), "rb") as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None
    meta = {"target": target, "source_sha256": sha,
            "exported_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "template": _template_of(src)}
    out = full + ".meta.json"
    try:
        with open(out + ".tmp", "w", encoding="utf-8") as fh:
            json.dump(meta, fh)
        os.replace(out + ".tmp", out)
    except OSError as e:
        print(f"meta not written: {e}", file=sys.stderr)
        return None
    return out


if __name__ == "__main__":
    sys.exit(main(sys.argv))

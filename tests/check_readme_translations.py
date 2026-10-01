"""README translations: the language bar and the drift warning.

Hard checks (exit 1): all seven READMEs carry the same language bar, with their own language in
bold and every other entry linking to a file that exists; no readme-i18n.com link is left; each
translation names the English commit it was translated from (a GitHub blob link to README.md).

Drift (warning only, exit 0): the translations cover only some sections of README.md. For each
translation, those sections are cut out of README.md at its source commit and out of the current
README.md and compared; any difference prints a warning naming the section, so the translation
gets updated. The language bar is ignored in that comparison — it changes whenever a language is
added and says nothing about the translated text.

Run: cd blave-agent && .venv/bin/python tests/check_readme_translations.py
"""
import os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LANGS = [("English", "README.md"), ("繁體中文", "README.zh-TW.md"), ("简体中文", "README.zh-CN.md"),
         ("日本語", "README.ja.md"), ("Español", "README.es.md"), ("Português", "README.pt.md"),
         ("Tiếng Việt", "README.vi.md")]
TRANSLATIONS = [f for _, f in LANGS if f not in ("README.md", "README.zh-TW.md")]
# Everything before the first of these is the intro; each one runs to the next "## " heading.
SECTIONS = ["What Makes It Different", "Quick Start (From Source)", "Safety and Limits",
            "Code Signing Policy", "License"]
SOURCE_RE = re.compile(r"github\.com/Blave-TW/blave-agent/blob/([0-9a-f]{7,40})/README\.md")

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

def bar_for(name):
    return " | ".join(f"**{n}**" if n == name else f"[{n}]({f})" for n, f in LANGS)

def read(f):
    with open(os.path.join(ROOT, f), encoding="utf-8") as fh:
        return fh.read()

def is_bar_line(line):
    return "readme-i18n.com" in line or bool(re.search(r"\]\(README[.\w-]*\.md\)", line) and " | " in line)

def segments(text):
    lines = []
    for l in text.split("\n"):
        if is_bar_line(l) or (not l.strip() and lines and not lines[-1].strip()):
            continue
        lines.append(l)
    heads = {l[3:].strip(): i for i, l in enumerate(lines) if l.startswith("## ")}
    out = {}
    first = heads.get(SECTIONS[0])
    out["(intro)"] = "\n".join(lines[:first]).strip() if first is not None else None
    for name in SECTIONS:
        i = heads.get(name)
        if i is None:
            out[name] = None; continue
        j = next((k for k in range(i + 1, len(lines)) if lines[k].startswith("## ")), len(lines))
        out[name] = "\n".join(lines[i:j]).strip()
    return out

texts = {}
for name, f in LANGS:
    path = os.path.join(ROOT, f)
    if not os.path.exists(path):
        check(False, f"{f} exists"); continue
    texts[f] = read(f)
    check(bar_for(name) in texts[f].split("\n"), f"{f}: language bar present, {name} in bold, same order as the others")
    check("readme-i18n.com" not in texts[f], f"{f}: no readme-i18n.com link left")
for _, f in LANGS:
    check(os.path.exists(os.path.join(ROOT, f)), f"language bar target {f} exists")

sources = {}
for f in TRANSLATIONS:
    if f not in texts:
        continue
    m = SOURCE_RE.search("\n".join(texts[f].split("\n")[:20]))
    check(bool(m), f"{f}: names its English source commit near the top")
    if m:
        sources[f] = m.group(1)

if fails:
    print(f"\n{fails} FAIL")
    sys.exit(1)

current = segments(texts["README.md"])
warned = 0
for k, v in current.items():
    if v is None:
        warned += 1
        print(f"  ⚠️  README.md: section '{k}' not found — renamed? update SECTIONS here and the translations")
for f, sha in sources.items():
    r = subprocess.run(["git", "show", f"{sha}:README.md"], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  ⚠️  {f}: cannot read README.md at {sha} ({r.stderr.strip()[:120]}); drift not checked")
        warned += 1; continue
    then = segments(r.stdout)
    changed = [k for k in then if then[k] != current.get(k)]
    if changed:
        warned += 1
        print(f"  ⚠️  {f} was translated from {sha}; README.md has changed since in: {', '.join(changed)}")
        print(f"      see: git diff {sha} -- README.md")
    else:
        print(f"  PASS  {f}: translated sections unchanged since {sha}")

print(f"\nall hard checks pass; {warned} drift warning(s)" if warned else "\nall pass")

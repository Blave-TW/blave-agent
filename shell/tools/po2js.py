#!/usr/bin/env python3
"""shell/i18n/*.po → shell/renderer/strings.js

Why a generator instead of hand-writing the JS: Blave already translates through
`.po` everywhere else (web has seven locales, a translation gate and a drift
check). One format means one workflow — the same translators, the same review,
the same tooling. The desktop app is Electron, so there is no gettext at
runtime; the catalogue is baked into a JS object at author time instead.

The output **is committed**. `electron .` must work on a fresh clone with no
build step, so the generated file lives in git; `tests/check_shell_strings.js`
fails if it drifts from the `.po` files.

Run:  python shell/tools/po2js.py     (needs babel — the web venv has it)
"""
import json
import pathlib
import sys

from babel.messages.pofile import read_po

SHELL = pathlib.Path(__file__).resolve().parent.parent
OUT = SHELL / "renderer" / "strings.js"
LANGS = ("en", "zh")

HEADER = """/* GENERATED from shell/i18n/*.po by shell/tools/po2js.py — do not edit by hand.
 *
 * Add or change a string in the `.po` files, then re-run the generator and
 * commit both. The runtime helpers (t / setLang / pickLang) are NOT here —
 * they live in renderer/i18n.js, which this file never overwrites.
 */
"""


def load(lang):
    path = SHELL / "i18n" / f"{lang}.po"
    with path.open("rb") as fh:
        catalog = read_po(fh, locale=lang)
    out = {}
    for message in catalog:
        # 目錄的第一筆是 header(空 msgid),跳過
        if not message.id:
            continue
        if not message.string:
            print(f"  ! {lang}: {message.id} 沒有譯文", file=sys.stderr)
            continue
        out[message.id] = message.string
    return out


def main():
    tables = {lang: load(lang) for lang in LANGS}
    base = set(tables["en"])
    for lang in LANGS[1:]:
        missing = base - set(tables[lang])
        extra = set(tables[lang]) - base
        if missing or extra:
            print(f"  ! {lang} 與 en 不對齊 — 缺 {sorted(missing)} / 多 {sorted(extra)}",
                  file=sys.stderr)
            return 1

    body = ["const STRINGS = {"]
    for lang in LANGS:
        body.append(f"  {lang}: {{")
        for key in tables["en"]:                       # 用 en 的順序,兩張表才對得起來
            body.append(f"    {json.dumps(key)}: {json.dumps(tables[lang][key], ensure_ascii=False)},")
        body.append("  },")
    body.append("};")
    OUT.write_text(HEADER + "\n".join(body) + "\n", encoding="utf-8")
    print(f"寫好 {OUT.relative_to(SHELL.parent)} — {len(base)} 個 key × {len(LANGS)} 語")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""
Static security analysis for marketplace strategies.

Usage:
    python3 lib/security_check.py [--context install|fork] strategies/xyz.py

First output line (the verdict to act on): RESULT: clean | ask-user | do-not-run
With --context, the second line is `NEXT: <what to do now>` for a library / shared
download installed as is (install) or a fork's download (fork).
--context goes before the file: an older checker then reads it as the path and says do-not-run.
Exit codes (fallback only — PowerShell on Windows folds 1 and 2 into 1):
    0 — clean
    1 — warnings only (review before running)
    2 — critical issues, file unreadable, no file argument, or the scan itself failed (do NOT run)
"""

import ast
import re
import sys
from pathlib import Path
from typing import Optional

ALLOWED_DOMAINS = {
    "api.blave.org",
    "api.binance.com",
    "fapi.binance.com",
    "dapi.binance.com",
    "api.bybit.com",
    "open-api.bingx.com",
    "api-cloud.bitmart.com",
    "api.bitfinex.com",
    "api.telegram.org",
}

# Prompt injection keywords in comments
_INJECTION_RE = re.compile(
    r"#.*\b(ignore|override|forget|disregard|system prompt|new instruction)\b",
    re.IGNORECASE,
)

# Obfuscation: decode-then-exec pattern within a 3-line window
_DECODE_RE = re.compile(r"(base64\.b64decode|bytes\.fromhex|codecs\.decode|\.decode\(['\"]utf)")
_EXEC_RE = re.compile(r"\b(eval|exec|compile)\s*\(")


def check(filepath: str) -> list[dict]:
    """Return list of findings: {level: 'CRITICAL'|'WARNING', line: int, msg: str}"""
    try:
        source = Path(filepath).read_text(encoding="utf-8-sig")   # a Windows editor's BOM is not a syntax error
    except (OSError, UnicodeDecodeError) as e:
        return [{"level": "CRITICAL", "line": 0, "msg": f"Cannot read file: {e}"}]
    findings = []

    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError) as e:
        return [{"level": "CRITICAL", "line": 0, "msg": f"Cannot parse file: {e}"}]

    findings += _ast_checks(tree)
    findings += _regex_checks(source)
    return sorted(findings, key=lambda f: f["line"])


# ── AST checks ────────────────────────────────────────────────────────────────

def _ast_checks(tree: ast.AST) -> list[dict]:
    findings = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = _call_name(node)
            if name in ("eval", "exec", "compile", "__import__"):
                findings.append(_c(node.lineno, f"{name}() — arbitrary code execution"))
            elif name in ("os.system", "os.popen"):
                findings.append(_c(node.lineno, f"{name}() — shell execution"))
            elif name and name.startswith("subprocess."):
                has_shell_true = any(
                    kw.arg == "shell" and isinstance(kw.value, ast.Constant) and kw.value.value is True
                    for kw in node.keywords
                )
                if has_shell_true:
                    findings.append(_c(node.lineno, f"{name}(shell=True) — shell injection risk"))
                else:
                    findings.append(_w(node.lineno, f"{name}() — shell execution; verify args are not user-controlled"))
            elif name == "open":
                _check_open(node, findings)

        elif isinstance(node, ast.Attribute):
            # os.environ used as a whole object (not subscript, not .get/.setdefault)
            if (
                node.attr == "environ"
                and isinstance(node.value, ast.Name)
                and node.value.id == "os"
            ):
                parent = getattr(node, "_parent", None)
                if not isinstance(parent, (ast.Subscript, ast.Attribute)):
                    findings.append(_w(node.lineno, "os.environ referenced — verify only specific keys are read"))

        # writing to lib/ via string literal path
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if re.search(r"\blib/", node.value):
                findings.append(_w(node.lineno, f"string path contains 'lib/' — possible write to shared lib: {node.value!r}"))

    # attach parent refs so the environ check above can inspect context
    _attach_parents(tree)
    return findings


def _check_open(node: ast.Call, findings: list) -> None:
    mode = None
    if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
        mode = node.args[1].value
    else:
        for kw in node.keywords:
            if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                mode = kw.value.value
    if mode and any(c in mode for c in "wxa"):
        findings.append(_w(node.lineno, f"open(..., {mode!r}) — verify write target is within workspace"))


def _attach_parents(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            child._parent = node  # type: ignore[attr-defined]


def _call_name(node: ast.Call) -> Optional[str]:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        parts, cur = [], func
        while isinstance(cur, ast.Attribute):
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            parts.append(cur.id)
        return ".".join(reversed(parts))
    return None


# ── Regex checks ──────────────────────────────────────────────────────────────

def _regex_checks(source: str) -> list[dict]:
    findings = []
    lines = source.splitlines()

    for i, line in enumerate(lines, 1):
        # Obfuscation: decode + exec within 3 lines
        if _DECODE_RE.search(line):
            window = "\n".join(lines[i - 1 : min(len(lines), i + 2)])
            if _EXEC_RE.search(window):
                findings.append(_c(i, "obfuscated execution: decode + exec/eval pattern"))

        # Non-whitelisted external URLs
        for domain in re.findall(r"https?://([^/\s'\"]+)", line):
            base = domain.split(":")[0].lstrip("www.")
            if base not in ALLOWED_DOMAINS:
                findings.append(_w(i, f"external URL to non-whitelisted domain: {domain}"))

        # Prompt injection in comments
        if _INJECTION_RE.search(line):
            findings.append(_w(i, f"possible prompt injection in comment: {line.strip()!r}"))

        # os.environ without key access (whole dict)
        if re.search(r"os\.environ(?!\s*[\[.])", line):
            findings.append(_w(i, "os.environ used without key — may expose all credentials"))

    return findings


# ── Helpers ───────────────────────────────────────────────────────────────────

def _c(line: int, msg: str) -> dict:
    return {"level": "CRITICAL", "line": line, "msg": msg}

def _w(line: int, msg: str) -> dict:
    return {"level": "WARNING", "line": line, "msg": msg}


# ── NEXT line ─────────────────────────────────────────────────────────────────

CONTEXTS = ("install", "fork")   # only downloads are scanned (references/marketplace.md)


def next_line(context: str, verdict: str) -> str:
    stop = ("delete this file and create no fork" if context == "fork"
            else "delete this file (in a bundle, only this file) and do not run it")
    return {"clean": "NEXT: Go on with the next step of the flow.",
            "ask-user": ("NEXT: Show these findings to the user and wait — go on only after a yes; "
                         f"a no ends it: {stop}."),
            "do-not-run": f"NEXT: Stop — show the findings, {stop}."}[verdict]


def parse_args(argv: list):
    """(file or None, context or None); ValueError on a bad, missing or repeated --context and on
    more than one file — a second file would otherwise go unscanned behind the first one's verdict."""
    path, context, i = None, None, 0
    while i < len(argv):
        a = argv[i]
        if a == "--context" or a.startswith("--context="):
            if context is not None:
                raise ValueError("--context given more than once")
            if a == "--context":
                i += 1
                value = argv[i] if i < len(argv) else ""
            else:
                value = a.split("=", 1)[1]
            if value not in CONTEXTS:
                raise ValueError(f"--context must be one of {', '.join(CONTEXTS)} (got {value!r})")
            context = value
        elif path is None:
            path = a
        else:
            raise ValueError("scan one file at a time")
        i += 1
    return path, context


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # The verdict line comes first. On Windows a run wrapped in `powershell -Command` (Codex)
    # comes back as exit 1 for both 1 and 2, so the exit code is only a fallback — and a crash
    # must never surface as a bare exit 1 (read as "ask-user"): any unexpected error is do-not-run.
    _verdict_out = False
    _context = None

    def _verdict(v):
        global _verdict_out
        print("RESULT: " + v + ("\n" + next_line(_context, v) if _context else ""), flush=True)
        _verdict_out = True

    def _main() -> int:
        global _context
        try:
            sys.stdout.reconfigure(errors="replace")
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
        try:
            path, ctx = parse_args(sys.argv[1:])
        except ValueError as e:
            _verdict("do-not-run")
            print(f"Error: {e}")
            return 2
        if path is None:
            _verdict("do-not-run")
            print("Usage: python3 lib/security_check.py <strategy_file.py>")
            return 2
        _context = ctx

        results = check(path)
        criticals = [r for r in results if r["level"] == "CRITICAL"]
        _verdict("do-not-run" if criticals else "ask-user" if results else "clean")

        if not results:
            print("✅ No issues found.")
            return 0

        print(f"{'❌' if criticals else '⚠️ '} {len(results)} issue(s) found in {path}:\n")
        for r in results:
            icon = "❌" if r["level"] == "CRITICAL" else "⚠️ "
            print(f"  {icon} Line {r['line']}: {r['msg']}")

        if _context:   # the NEXT line already said what to do
            return 2 if criticals else 1
        print()
        if criticals:
            print("❌ CRITICAL issues — do NOT run this strategy without manual review.")
            return 2
        print("⚠️  Warnings only — confirm with user before running.")
        return 1

    try:
        _code = _main()
    except Exception as e:
        if not _verdict_out:
            _verdict("do-not-run")
        print(f"Error: {type(e).__name__}: {e}", file=sys.stderr)
        _code = 2
    sys.exit(_code)

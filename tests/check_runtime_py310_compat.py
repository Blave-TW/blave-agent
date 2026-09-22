"""Gate: every runtime/*.py must import on Python 3.10 — the cloud fleet's interpreter.

The updater's health check imports each runtime module; one that fails to import rolls the
whole release back (1.1.84/1.1.85 died on a top-level `import tomllib`). Checks, per module:
  1. Syntax parses with feature_version=(3, 10) (except*, `type`, PEP 695 generics...), plus
     PEP 701 f-strings reusing the outer quote, which feature_version does not catch.
  2. No import that runs at import time (module body, class bodies, top-level if/try — not
     function bodies) names a stdlib module or name that only exists in 3.11+, unless it sits
     in a try whose handler catches ImportError / ModuleNotFoundError.
  3. If a python3.10 is on PATH, actually import each module under it.

Run: cd blave-agent && python3 tests/check_runtime_py310_compat.py
"""
import ast, glob, io, os, re, shutil, subprocess, sys, tokenize

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")

NEW_MODULES = {  # stdlib modules / submodules absent in 3.10
    "tomllib", "wsgiref.types",                                  # 3.11
    "_colorize", "_pyrepl",                                      # 3.13
    "annotationlib", "compression", "string.templatelib",        # 3.14
    "concurrent.interpreters",
}
NEW_NAMES = {  # `from X import name` where name is 3.11+
    "typing": {"Self", "LiteralString", "Never", "assert_never", "assert_type",
               "reveal_type", "Required", "NotRequired", "TypeVarTuple", "Unpack",
               "dataclass_transform", "get_overloads", "clear_overloads", "override",
               "TypeAliasType", "ReadOnly", "TypeIs", "NoDefault", "get_protocol_members",
               "is_protocol", "evaluate_forward_ref"},
    "datetime": {"UTC"},
    "enum": {"StrEnum", "ReprEnum", "EnumCheck", "FlagBoundary", "verify", "member",
             "nonmember", "global_enum", "show_flag_values", "EnumType", "property",
             "EnumDict"},
    "asyncio": {"TaskGroup", "Runner", "timeout", "timeout_at", "Timeout", "Barrier",
                "BrokenBarrierError", "eager_task_factory", "create_eager_task_factory",
                "QueueShutDown"},
    "itertools": {"batched"},
    "hashlib": {"file_digest"},
    "operator": {"call"},
    "contextlib": {"chdir"},
    "types": {"get_original_bases", "CapsuleType"},
    "warnings": {"deprecated"},
    "copy": {"replace"},
}


def _guarded(handlers):
    for h in handlers:
        names = h.type.elts if isinstance(h.type, ast.Tuple) else [h.type]
        if h.type is None or any(isinstance(n, ast.Name) and n.id in
                                 ("ImportError", "ModuleNotFoundError", "Exception")
                                 for n in names):
            return True
    return False


def _import_time_imports(body, guarded=False):
    """Yield (node, guarded) for imports executed when the module is imported."""
    for node in body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            yield node, guarded
        elif isinstance(node, ast.ClassDef):
            yield from _import_time_imports(node.body, guarded)
        elif isinstance(node, ast.If):
            yield from _import_time_imports(node.body, guarded)
            yield from _import_time_imports(node.orelse, guarded)
        elif isinstance(node, ast.Try):
            yield from _import_time_imports(node.body, guarded or _guarded(node.handlers))
            for h in node.handlers:
                yield from _import_time_imports(h.body, guarded)
            yield from _import_time_imports(node.orelse, guarded)
            yield from _import_time_imports(node.finalbody, guarded)
        elif isinstance(node, (ast.With,)):
            yield from _import_time_imports(node.body, guarded)


def _quote(tok):
    return re.match(r"(?i)[a-z]*('''|\"\"\"|'|\")", tok).group(1)


def _fstring_quote_reuse(src):
    """Needs a 3.12+ checker (FSTRING_START tokens); older ones cannot parse the reuse anyway."""
    if not hasattr(tokenize, "FSTRING_START"):
        return []
    bad, stack = [], []  # stack of enclosing f-string quotes
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type in (tokenize.FSTRING_START, tokenize.STRING) and stack \
                and _quote(tok.string) in stack:
            bad.append(tok.start[0])
        if tok.type == tokenize.FSTRING_START:
            stack.append(_quote(tok.string))
        elif tok.type == tokenize.FSTRING_END:
            stack.pop()
    return bad


def check_file(path):
    errs = []
    src = open(path, encoding="utf-8").read()
    try:
        tree = ast.parse(src, path, feature_version=(3, 10))
    except SyntaxError as e:
        return [f"line {e.lineno}: 3.10 syntax error: {e.msg}"]
    for ln in _fstring_quote_reuse(src):
        errs.append(f"line {ln}: f-string reuses its outer quote (3.12+)")
    for node, guarded in _import_time_imports(tree.body):
        if guarded:
            continue
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name in NEW_MODULES or a.name.split(".")[0] in NEW_MODULES:
                    errs.append(f"line {node.lineno}: import {a.name} (3.11+ only)")
        elif node.level == 0 and node.module:
            if node.module in NEW_MODULES or node.module.split(".")[0] in NEW_MODULES:
                errs.append(f"line {node.lineno}: from {node.module} import (3.11+ only)")
            for a in node.names:
                if a.name in NEW_NAMES.get(node.module, ()) \
                        or f"{node.module}.{a.name}" in NEW_MODULES:
                    errs.append(f"line {node.lineno}: from {node.module} import {a.name}"
                                " (3.11+ only)")
    return errs


def main():
    files = sorted(glob.glob(os.path.join(RUNTIME, "*.py")))
    assert files, "no runtime/*.py found"
    failed = False
    for f in files:
        for e in check_file(f):
            failed = True
            print(f"FAIL runtime/{os.path.basename(f)} {e}")
    print(f"static: {len(files)} runtime modules checked")

    py310 = shutil.which("python3.10")
    if py310:
        for f in files:
            mod = os.path.basename(f)[:-3]
            r = subprocess.run([py310, "-c", f"import {mod}"], cwd=RUNTIME,
                               capture_output=True, text=True, timeout=60)
            if r.returncode != 0 and "ModuleNotFoundError" in r.stderr \
                    and not any(m in r.stderr for m in NEW_MODULES):
                print(f"skip runtime/{mod}.py under 3.10 (third-party dep missing): "
                      + r.stderr.strip().splitlines()[-1])
            elif r.returncode != 0:
                failed = True
                print(f"FAIL runtime/{mod}.py import under 3.10: "
                      + r.stderr.strip().splitlines()[-1])
        print(f"live: imported under {py310}")
    else:
        print("live: no python3.10 on PATH, import run skipped")

    if failed:
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()

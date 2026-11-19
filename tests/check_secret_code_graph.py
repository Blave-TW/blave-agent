"""agent_turn.SECRET_CODE_FILES is exactly the code that runs in a process handed the broker passwords (audit
2026-11-19 M1): the 統一 / 群益 / 永豐 workers, manager/reconciler.py and manager/flatten.py, everything they import,
and the official venue libs they load by name. Rebuilt here from the source, so a new import in any of them that is
not frozen goes red, and so does a frozen file nothing loads any more.

  ① static: every `import` / `from … import` (module level and inside functions) that resolves to a workspace file,
     followed transitively; `from lib import x` also runs lib/__init__.py; a worker run as a script imports its lib/
     siblings by bare name
  ② by name: import_module(f"lib.order_{…}") / f"lib.account_{…}" / f"lib.{…}_vault" → every official file of that
     family in the repo (the *_TEMPLATE.py the agent copies from are never loaded); any other computed import in that
     code is a family nobody decided about → red
  ③ the list in agent_turn equals ① ∪ ②, both ways

Not here, by design — agent-written code these processes load by path, named in BY_PATH so a new one goes red:
manager/executors/*.py (custom executors), strategies/<name>/strategy.py (paper fills), and the user's own
lib/order_<x>.py / lib/account_<x>.py. runtime/events.py is the runtime's, not the workspace's.

Run: cd blave-agent && .venv/bin/python tests/check_secret_code_graph.py
"""
import ast
import re
import glob
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRIES = ("lib/president_worker.py", "lib/capital_worker.py", "lib/sinopac_worker.py",
           "manager/reconciler.py", "manager/flatten.py",
           # the desktop daemon holds the 統一 / 群益 passwords itself: every lib import made in its process
           "runtime/local_daemon.py", "runtime/account_reader.py", "runtime/president_test_order.py")
FAMILIES = {"lib.order_": "lib/order_*.py", "lib.account_": "lib/account_*.py", "lib._vault": "lib/*_vault.py"}
# spec_from_file_location module names in that code and what the file is
# module names given to a by-path load in that code → the workspace file it is (None: not a frozen workspace file)
BY_PATH = {"executors.": None, "_paper_strat_": None,  # agent-written: custom executors, paper-fill strategies
           "blave_runtime_events": None,  # runtime/events.py, the runtime's own folder
           "_daemon_tw_clock": "lib/tw_clock.py", "_report_tw_clock": "lib/tw_clock.py"}
fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


def exists(rel):
    return os.path.isfile(os.path.join(ROOT, rel))


def resolve(name, here):
    """Files `import name` loads from `here`. lib.<x> → lib/x.py (and lib/__init__.py); a bare name from a lib/ file →
    its lib/ sibling (the workers' script mode, through secret_imports.SCRIPT_SIBLINGS) and from a runtime/ file → the
    runtime module next to it; anything else is the stdlib or site-packages."""
    parts = name.split(".")
    if parts[0] == "lib":
        rel = "/".join(parts) + ".py"
        return ["lib/__init__.py"] + ([rel] if len(parts) > 1 and exists(rel) else [])
    folder = os.path.dirname(here)
    rel = folder + "/" + "/".join(parts) + ".py"
    if exists(rel):
        if folder == "lib":
            bare.add(parts[0])
        elif folder == "manager":
            stray.append((here, name))
        return [rel]
    return []


def computed_prefix(call):
    """The literal text around the computed part of import_module(f"…") → 'lib.order_' / 'lib._vault' …; None if
    the argument is not an f-string."""
    arg = call.args[0] if call.args else None
    if not isinstance(arg, ast.JoinedStr):
        return None
    return "".join(v.value for v in arg.values if isinstance(v, ast.Constant))


def scan(rel):
    tree = ast.parse(open(os.path.join(ROOT, rel), encoding="utf-8").read(), rel)
    deps, computed = set(), []
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                deps.update(resolve(a.name, rel))
        elif isinstance(n, ast.ImportFrom):
            if n.level:  # relative: `from . import x` in lib/__init__.py, `from .x import y` in a lib module
                base = "lib" if rel.startswith("lib/") and n.level == 1 else None
                if base is None:
                    computed.append(f"relative import level {n.level} in {rel}")
                    continue
                mod = base + ("." + n.module if n.module else "")
            else:
                mod = n.module
            deps.update(resolve(mod, rel))
            for a in n.names:
                deps.update(resolve(mod + "." + a.name, rel))
        elif isinstance(n, ast.Call):
            fn = n.func.attr if isinstance(n.func, ast.Attribute) else getattr(n.func, "id", "")
            if fn in ("import_module", "__import__"):
                arg = n.args[0] if n.args else None
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    deps.update(resolve(arg.value, rel))
                elif rel.startswith("runtime/") and not re.search(r"[\"']lib[.\"']", ast.unparse(n)):
                    pass  # the runtime's own modules (report_runner, session_store), not the workspace
                else:  # an f-string family, or anything computed some other way (→ unknown unless a family)
                    computed.append(computed_prefix(n) or ast.unparse(n))
            elif fn in ("spec_from_file_location", "load_source") and not rel.endswith("/secret_imports.py"):
                # by path: the .py literal in the call names the file (os.path.join(…, "lib", "tw_clock.py"))
                lits = [c.value for c in ast.walk(n) if isinstance(c, ast.Constant) and isinstance(c.value, str)]
                py = next((x for x in lits if x.endswith(".py")), None)
                arg = n.args[0] if n.args else None
                name = arg.value if isinstance(arg, ast.Constant) else computed_prefix(n) or ast.unparse(n)
                if py and ("lib" in lits or rel.startswith("lib/")) and exists("lib/" + py):
                    deps.add("lib/" + py)
                elif py and (py == "reconciler.py") and exists("manager/" + py):
                    deps.add("manager/" + py)
                elif name in BY_PATH:
                    deps.update([BY_PATH[name]] if BY_PATH[name] else [])
                else:
                    computed.append(name)
    return deps, computed


def family_files(pattern):
    return {os.path.relpath(p, ROOT).replace(os.sep, "/") for p in glob.glob(os.path.join(ROOT, pattern))
            if not os.path.basename(p).endswith("_TEMPLATE.py")}


bare, stray = set(), []
graph, todo, unknown = set(), list(ENTRIES), []
seen_families = set()
while todo:
    f = todo.pop()
    if f in graph:
        continue
    graph.add(f)
    deps, computed = scan(f)
    for p in computed:
        key = p if p in FAMILIES else None
        if key is None:
            unknown.append((f, p))
            continue
        if key not in seen_families:
            seen_families.add(key)
            todo.extend(family_files(FAMILIES[key]))
    todo.extend(deps)

t("① the static graph reaches the files the 2026-10-07 freeze named",
  {"lib/president_vault.py", "lib/winreplace.py", "lib/capital_vault.py", "manager/reconciler.py"} <= graph)
t("① …and the ones the 2026-11-19 audit found missing", {"lib/president_quote.py", "lib/capital_quote.py",
                                                          "lib/sinopac_worker.py", "lib/sinopac_vault.py"} <= graph)
t("② every computed import in that code is a known family (order_ / account_ / _vault)", not unknown, unknown)
t("② all three families are reached", seen_families == set(FAMILIES), sorted(seen_families))

sys.path.insert(0, os.path.join(ROOT, "runtime"))
os.environ["BLAVE_AGENT_WORKSPACE"] = os.path.join(tempfile.mkdtemp(prefix="secret-graph-"), "workspace")
sdk = types.ModuleType("claude_agent_sdk")
sdk.HookMatcher = lambda matcher=None, hooks=None: {"matcher": matcher, "hooks": hooks}
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402

frozen = set(at.SECRET_CODE_FILES)
loaded = {f for f in graph if not f.startswith("runtime/")}  # runtime/ is the runtime's own folder, not the workspace
t("③ every workspace file the password processes load is frozen", not loaded - frozen, sorted(loaded - frozen))
t("③ nothing frozen that they no longer load", not frozen - loaded, sorted(frozen - loaded))
t("③ the finder's loader is in the graph and frozen", "lib/secret_imports.py" in loaded & frozen)
import runpy  # noqa: E402

siblings = runpy.run_path(os.path.join(ROOT, "lib", "secret_imports.py"))["SCRIPT_SIBLINGS"]
t("④ every bare lib/ import the scripts make is one secret_imports lets through", bare <= siblings, sorted(bare - siblings))
t("④ no bare import of a manager/ file (manager/ is never on sys.path in those processes)", not stray, stray)
t("③ every frozen file has its Edit deny", all(f"Edit(/{f})" in at.PROTECTED_EDIT_RULES for f in frozen))

print("\n" + (f"{len(fails)} FAIL" if fails else "ALL PASS"))
sys.exit(1 if fails else 0)

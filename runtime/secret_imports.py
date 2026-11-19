"""Imports for a process handed the broker passwords (audit 2026-11-19 M1 / M-1).

No workspace folder (the root, lib/, manager/) stays on sys.path: a name the stdlib and site-packages do not
provide (an optional requests dependency, a Windows-only module on a Mac, an SDK not installed) would otherwise
still be found there, in any spelling the file system accepts and as a .pyc or a moved-in package. Instead one
finder, first on sys.meta_path, answers `lib` and `lib.<name>` from <workspace>/lib — a .py file of exactly that
name, compiled from source (never a __pycache__ entry or a bare .pyc) — and, for the two broker workers run as
scripts, the few lib/ siblings they import by bare name (SCRIPT_SIBLINGS). Every other name never comes from the
workspace.

Loaded by path (runpy.run_path) before any other import, so its own name cannot be shadowed. runtime/secret_imports.py
is the same file for the runtime's processes (separate update channel); tests/check_stdlib_shadow.py pins the two equal.
"""
import importlib.machinery
import os
import sys

# The bare names lib/president_worker.py, lib/capital_worker.py and runtime/president_test_order.py (and what those
# import in turn) use when run as scripts. tests/check_secret_code_graph.py fails on a bare import not listed here.
SCRIPT_SIBLINGS = frozenset({"president_vault", "president_quote", "president_contracts", "capital_vault",
                             "capital_quote", "twf_feed", "winreplace", "events", "sinopac_vault", "venue_traits"})


class _SourceOnly(importlib.machinery.SourceFileLoader):
    def get_code(self, fullname):
        return self.source_to_code(self.get_data(self.path), self.path)


class WorkspaceLibFinder:
    def __init__(self, ws, siblings=()):
        self.lib = os.path.join(os.path.abspath(ws), "lib")
        self.siblings = frozenset(siblings)

    def _spec(self, name, filename, package=False):
        try:
            present = filename in os.listdir(self.lib)  # exact case, on a case-insensitive disk too
        except OSError:
            present = False
        if not present:
            return None
        path = os.path.join(self.lib, filename)
        spec = importlib.machinery.ModuleSpec(name, _SourceOnly(name, path), origin=path, is_package=package)
        spec.has_location = True
        if package:
            spec.submodule_search_locations = []  # lib.<name> only through this finder, never a path search
        return spec

    def find_spec(self, name, path=None, target=None):
        if name == "lib":
            return self._spec(name, "__init__.py", package=True)
        if name.startswith("lib."):
            sub = name[4:]
            return self._spec(name, sub + ".py") if sub.isidentifier() else None
        if name in self.siblings:
            return self._spec(name, name + ".py")
        return None


def install(ws, siblings=()):
    """Take the workspace folders off sys.path and put the finder first; idempotent. A `lib` bound before this
    (a sitecustomize, pywin32's namespace win32/lib) is dropped so the next import resolves through the finder."""
    ws = os.path.abspath(ws)
    own = {os.path.normcase(os.path.realpath(d)) for d in (ws, os.path.join(ws, "lib"), os.path.join(ws, "manager"))}
    sys.path[:] = [p for p in sys.path if os.path.normcase(os.path.realpath(p or os.curdir)) not in own]
    for f in [f for f in sys.meta_path if isinstance(f, WorkspaceLibFinder) or type(f).__name__ == "WorkspaceLibFinder"]:
        sys.meta_path.remove(f)
    finder = WorkspaceLibFinder(ws, siblings)
    sys.meta_path.insert(0, finder)
    want = finder.lib + os.sep
    for name in [n for n in sys.modules if n == "lib" or n.startswith("lib.")]:
        if not os.path.abspath(getattr(sys.modules[name], "__file__", None) or "").startswith(want):
            del sys.modules[name]
    importlib.invalidate_caches()
    return finder


def load_source(name, path):
    """A module from `path` compiled from its source, never from a __pycache__ entry (flatten loading the reconciler)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(name, path, loader=_SourceOnly(name, path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

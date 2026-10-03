"""Which claude-agent-sdk a turn imports: the release's pin, or the venv's own.

The pin is runtime/SDK_VERSION. sdk_sync.py (a release job) installs it
self-contained into $BASE/sdk/<pin>/ and writes `.ready` only after the
bundled CLI has been executed and checked. A turn is a fresh spawn, so
putting that directory ahead of the venv on sys.path before the SDK import
is the whole switch: no venv rewrite, no file a running turn holds (Windows
locks a running claude.exe), no bridge restart.

No `.ready`, a pin mismatch, a missing bundled CLI or an import that fails
from that directory all mean the venv's SDK — a turn never fails because of
this module. The desktop has no $BASE/sdk/ at all, so it always uses its venv
(which the shell installs at the same pin).
"""
import importlib
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
PIN_FILE = os.path.join(_HERE, "SDK_VERSION")
BASE = os.environ.get("BLAVE_AGENT_BASE") or (
    r"C:\blave-agent" if os.name == "nt" else "/opt/blave-agent"
)
SDK_ROOT = os.path.join(BASE, "sdk")
PIN_RE = re.compile(r"\d+\.\d+\.\d+")
CLI_NAME = "claude.exe" if os.name == "nt" else "claude"


def vkey(v):
    return tuple(int(x) for x in v.split("."))


def read_pin(path=PIN_FILE):
    try:
        with open(path, encoding="utf-8") as f:
            pin = f.read().strip()
    except OSError:
        return None
    return pin if PIN_RE.fullmatch(pin) else None


def read_ready(d):
    """`.ready` is "<sdk> <cli>"; returns that pair or None."""
    try:
        with open(os.path.join(d, ".ready"), encoding="utf-8") as f:
            parts = f.read().split()
    except OSError:
        return None
    return (parts[0], parts[1]) if len(parts) >= 2 else None


def ready_dir(pin, root=SDK_ROOT):
    """The pin's directory if it is complete, else None. The first token must
    EQUAL the pin — a prefix test would let pin 0.2.15 match `0.2.159 …`."""
    if not pin:
        return None
    d = os.path.join(root, pin)
    ready = read_ready(d)
    if not ready or ready[0] != pin:
        return None
    if not os.path.isfile(os.path.join(d, "claude_agent_sdk", "_bundled", CLI_NAME)):
        # without it the SDK silently falls back to whatever claude is on PATH
        return None
    return d


def _drop(d):
    prefix = os.path.normcase(os.path.abspath(d)) + os.sep
    while d in sys.path:
        sys.path.remove(d)
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        if f and os.path.normcase(os.path.abspath(f)).startswith(prefix):
            del sys.modules[name]
    importlib.invalidate_caches()


def load(pin_file=PIN_FILE, root=SDK_ROOT):
    """Import and return claude_agent_sdk, from the pin's directory when ready."""
    try:
        d = ready_dir(read_pin(pin_file), root)
    except Exception:
        d = None
    if d and d not in sys.path:
        # after the runtime's own dir: a top-level package in the SDK's dependency
        # tree must never shadow a runtime module of the same name
        sys.path.insert(1, d)
    try:
        return importlib.import_module("claude_agent_sdk")
    except Exception as e:
        if not d:
            raise
        print(f"[sdk_pin] {d} failed to import ({e!r}); using the venv SDK", file=sys.stderr)
        _drop(d)
        sys.modules.pop("claude_agent_sdk", None)
        return importlib.import_module("claude_agent_sdk")


def _read_attr(path, attr):
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(rf'^{attr}\s*=\s*["\']([^"\']+)["\']', f.read(), re.M)
    except OSError:
        return None
    return m.group(1) if m else None


def venv_versions():
    """(sdk, cli) of the venv's own install, read from its files without
    importing it (callers may already have the pin directory on sys.path)."""
    root = os.path.normcase(os.path.abspath(SDK_ROOT)) + os.sep
    for p in sys.path:
        p = os.path.abspath(p or ".")
        if (os.path.normcase(p) + os.sep).startswith(root):
            continue
        pkg = os.path.join(p, "claude_agent_sdk")
        if os.path.isfile(os.path.join(pkg, "__init__.py")):
            return (_read_attr(os.path.join(pkg, "_version.py"), "__version__"),
                    _read_attr(os.path.join(pkg, "_cli_version.py"), "__cli_version__"))
    return (None, None)


def status(pin_file=PIN_FILE, root=SDK_ROOT):
    """What the next turn would run — for the portfolio report."""
    pin = read_pin(pin_file)
    d = ready_dir(pin, root)
    if d:
        sdk, cli = read_ready(d)
        return {"pin": pin, "active": "pin", "sdk": sdk, "cli": cli}
    sdk, cli = venv_versions()
    return {"pin": pin, "active": "venv", "sdk": sdk, "cli": cli}

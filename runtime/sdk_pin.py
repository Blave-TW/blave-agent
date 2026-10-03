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
import platform
import re
import stat
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
    """`.ready` is "<sdk> <cli>"; returns that pair or None. O_NONBLOCK + fstat on
    the opened fd: a FIFO planted as `.ready` must not hang a turn on open()."""
    try:
        fd = os.open(os.path.join(d, ".ready"), os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > 256:
            return None
        parts = os.read(fd, 256).decode("utf-8", "replace").split()
    except OSError:
        return None
    finally:
        os.close(fd)
    return (parts[0], parts[1]) if len(parts) >= 2 else None


def lock_key():
    """Names this interpreter's runtime/sdk-lock-<key>.txt (publish.py SDK_TARGETS)."""
    plat = {"linux": "linux", "win32": "win", "darwin": "macosx"}.get(sys.platform, sys.platform)
    return f"{plat}_{platform.machine().lower()}-py{sys.version_info[0]}.{sys.version_info[1]}"


def lock_file():
    return os.path.join(_HERE, f"sdk-lock-{lock_key()}.txt")


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


def add_dir(d):
    """Put d (a pip --target tree) after the runtime's own dir and before the venv.

    pip --target does not run the tree's .pth files, which the venv would have
    run at startup, so they are replayed here in place: path lines go right
    after d (ahead of the venv's copies), `import` lines run as site.py runs
    them. On Windows mcp pulls in pywin32, whose pywin32.pth adds win32,
    win32/lib and pythonwin. Its `import pywin32_bootstrap` is a no-op here —
    the venv's own pywin32 already ran it at startup and registered the VENV's
    pywin32_system32 — and pywintypes loads its DLL by bare name, so whichever
    DLL directory Windows searches first would win. The pin's DLLs are therefore
    loaded by full path up front; a later load by name gets the one already in
    the process, never a mix of two pywin32 versions."""
    if d in sys.path:
        return
    # after the runtime's own dir: a top-level package in the SDK's dependency
    # tree must never shadow a runtime module of the same name
    pos = min(1, len(sys.path))
    sys.path.insert(pos, d)
    pos += 1
    imports = []
    for pth in sorted(f for f in os.listdir(d) if f.endswith(".pth")):
        with open(os.path.join(d, pth), encoding="utf-8") as f:
            for line in f:
                line = line.rstrip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith(("import ", "import\t")):
                    imports.append(line)
                    continue
                p = os.path.join(d, line)
                if os.path.isdir(p) and p not in sys.path:
                    sys.path.insert(pos, p)
                    pos += 1
    dll = os.path.join(d, "pywin32_system32")
    if os.name == "nt" and os.path.isdir(dll):
        import ctypes
        os.add_dll_directory(dll)
        for f in sorted(os.listdir(dll)):
            if f.lower().endswith(".dll"):
                ctypes.WinDLL(os.path.join(dll, f))
    for line in imports:
        exec(line)  # noqa: S102 — same as site.addpackage


def _drop(d):
    prefix = os.path.normcase(os.path.abspath(d))
    sys.path[:] = [p for p in sys.path
                   if not (os.path.normcase(os.path.abspath(p or ".")) + os.sep).startswith(prefix + os.sep)]
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        if f and os.path.normcase(os.path.abspath(f)).startswith(prefix + os.sep):
            del sys.modules[name]
    importlib.invalidate_caches()


def _mark_bad(d):
    """The pin dir would not import: take it out of rotation for every later turn
    (sdk_sync counts it as a failure and reinstalls)."""
    try:
        os.replace(os.path.join(d, ".ready"), os.path.join(d, ".bad"))
    except OSError:
        pass


def load(pin_file=PIN_FILE, root=SDK_ROOT):
    """Import and return claude_agent_sdk, from the pin's directory when ready."""
    d = None
    try:
        d = ready_dir(read_pin(pin_file), root)
        if d:
            add_dir(d)
    except Exception as e:
        print(f"[sdk_pin] pin dir unusable ({e!r}); using the venv SDK", file=sys.stderr)
        if d:
            _drop(d)
            _mark_bad(d)
        d = None
    try:
        return importlib.import_module("claude_agent_sdk")
    except Exception as e:
        if not d:
            raise
        print(f"[sdk_pin] {d} failed to import ({e!r}); using the venv SDK", file=sys.stderr)
        _drop(d)
        _mark_bad(d)
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


if __name__ == "__main__":
    # provision: which lock file this interpreter installs from
    print(lock_file())

"""Desktop only: record our own uncaught exceptions to state/error_reports.jsonl (spec agent-error-report-2026-11-16 §3).

Nothing here leaves the machine. The desktop shell (shell/errreport.js) reads the file, scrubs the
message, shows the user exactly what would be sent and sends only after they agree. This module only
appends; truncating and clearing the file is the shell's job alone.

A record is written only when the innermost frame that is neither stdlib nor site-packages is in
lib/, runtime/ or manager/. If that frame is in a strategy or any other user file, nothing is recorded.
Only the outermost exception's type, str() and traceback are read: never __cause__ / __context__
(lib wraps the user's `{e}` and re-raises), never source lines (SyntaxError.text would quote the
user's strategy code). Frames are innermost first; frames that aren't ours become {"file": "<other>"}.

Stdlib only, and every failure is swallowed: the original hook always runs and behaves as before.
"""
import json
import os
import re
import sys
import threading
import time

LIB_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.path.dirname(LIB_DIR)
PATH = os.path.join(WORKSPACE, "state", "error_reports.jsonl")

MAX_LINE_BYTES = 8192
MAX_FILE_BYTES = 256 * 1024
MESSAGE_MAX = 2000
FRAMES_MAX = 30
OTHER = "<other>"
_OURS = ("lib", "manager")

# Same shapes the api accepts (api openclaw/desktop_error_report.py); a value that doesn't fit is not written
_EXC_TYPE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]{0,79}\Z")
_FILE_RE = re.compile(r"^(lib|runtime|manager)/[A-Za-z0-9_./-]{1,80}\Z")
_FUNC_RE = re.compile(r"^[A-Za-z_<>$.][A-Za-z0-9_<>$.]{0,59}\Z")
# The desktop conversation this process runs for (shell/main.js spawnTurn); the shell offers a record only
# in that conversation, right after its turn. Local only: never part of what is sent.
SID_ENV = "BLAVE_CHAT_SID"
_SID_RE = re.compile(r"^desktop-[a-z0-9]{4,16}\Z")

# Raised on purpose for the user or the agent to read, or flow control: not bugs. Matched by class
# name anywhere in the MRO so this module never imports lib.data & co. Starting list from spec §3.2,
# plus the busy / rate-limit / data-source-down classes grep found in lib/.
EXPECTED = frozenset({
    "KeyboardInterrupt", "SystemExit", "GeneratorExit",
    "UsStockUnavailable", "UsStockNotHere", "UsStockNotFound", "TwPublicUnavailable", "TwCdnUnavailable",
    "DataAccessError", "FeedNotPublished", "Halted", "PaperMarketClosed", "EntryDeferred", "SessionClosed",
    "RateLimited", "QueryInProgress", "TurnMoneyBusy",
    "ReportRefused",   # lib/report.py: publish()'s "fix every one, then re-send" — the agent recovers in the turn
})
# Network blips (requests / urllib3 connection and timeout classes, and the builtins they wrap).
# HTTPError is not here: a 4xx from our own code path is worth seeing.
NETWORK = frozenset({
    "ConnectionError", "Timeout", "ConnectTimeout", "ReadTimeout", "ProxyError", "SSLError",
    "NewConnectionError", "MaxRetryError", "NameResolutionError", "ProtocolError", "ConnectTimeoutError",
    "ReadTimeoutError", "TimeoutError", "timeout", "gaierror", "ChunkedEncodingError",
})

_installed = False
_library_roots = None


def _libraries():
    global _library_roots
    if _library_roots is None:
        import sysconfig
        try:
            paths = [sysconfig.get_paths().get(k) for k in ("stdlib", "platstdlib", "purelib", "platlib")]
        except Exception:
            paths = []
        paths += [os.path.join(p, "lib") for p in (sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix) if p]
        paths.append(os.path.dirname(os.__file__))
        # realpath: Homebrew's stdlib is reached through an opt/ symlink while co_filename is the Cellar path
        roots = {os.path.normcase(os.path.realpath(p)) + os.sep for p in paths if p}
        _library_roots = tuple(roots)
    return _library_roots


def classify(filename):
    """'lib/x.py' / 'runtime/x.py' / 'manager/x.py' for ours, 'library' for stdlib and packages, None for anything else."""
    if not filename:
        return None
    if filename.startswith("<"):
        return "library" if filename.startswith("<frozen ") else None   # <string>, <stdin>: someone's exec'd code
    path = os.path.realpath(filename)
    norm = os.path.normcase(path)
    try:
        rel = os.path.relpath(path, os.path.realpath(WORKSPACE))
    except ValueError:   # another drive on Windows
        rel = ".."
    parts = rel.replace(os.sep, "/").split("/")
    if parts[0] in _OURS and len(parts) > 1 and ".." not in parts:
        return "/".join(parts)
    parent = os.path.dirname(path)
    if os.path.basename(parent) == "runtime" and os.path.isfile(os.path.join(parent, "agent_turn.py")):
        return "runtime/" + os.path.basename(path)
    segs = norm.replace(os.sep, "/").split("/")
    if "site-packages" in segs or "dist-packages" in segs or norm.startswith(_libraries()):
        return "library"
    return None


def _skip(exc):
    names = {c.__name__ for c in type(exc).__mro__}
    if names & EXPECTED or names & NETWORK:
        return True
    try:
        from . import venue_errors
        return venue_errors.classify(exc) in (venue_errors.TRANSIENT, venue_errors.CREDENTIAL)
    except Exception:
        return False


def record(exc, tb):
    """The JSON line for this exception, or None when it isn't ours to record."""
    if exc is None or _skip(exc):
        return None
    exc_type = type(exc).__name__
    if not _EXC_TYPE_RE.match(exc_type):
        return None
    raw = []
    while tb is not None:
        code = tb.tb_frame.f_code
        raw.append((code.co_filename, code.co_name, tb.tb_lineno))
        tb = tb.tb_next
    raw.reverse()   # innermost first
    first = _UNSET = object()
    frames = []
    for filename, func, line in raw:
        where = classify(filename)
        if first is _UNSET and where != "library":
            first = where
        if where and where != "library" and _FILE_RE.match(where):
            frames.append({"file": where, "func": func if _FUNC_RE.match(func or "") else "<unknown>",
                           "line": line if isinstance(line, int) and line > 0 else 1})
        elif not frames or frames[-1]["file"] != OTHER:
            frames.append({"file": OTHER})
    if first is _UNSET or first is None:
        return None
    try:
        message = str(exc)
    except Exception:
        message = ""
    rec = {"v": 1, "ts": int(time.time() * 1000), "source": "py_lib", "exc_type": exc_type,
           "message": message[:MESSAGE_MAX], "frames": frames[:FRAMES_MAX],
           "py_version": "%d.%d" % sys.version_info[:2]}
    sid = os.environ.get(SID_ENV) or ""
    if _SID_RE.match(sid):
        rec["sid"] = sid
    line = json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n"
    while len(line.encode("utf-8")) > MAX_LINE_BYTES and rec["message"]:
        rec["message"] = rec["message"][:len(rec["message"]) // 2]
        line = json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n"
    return line if len(line.encode("utf-8")) <= MAX_LINE_BYTES else None


def write(line):
    """Append one line. O_NOFOLLOW: a symlinked file must not carry the line out of the workspace."""
    try:
        if os.path.getsize(PATH) > MAX_FILE_BYTES:
            return False
    except OSError:
        pass
    try:
        os.makedirs(os.path.dirname(PATH), exist_ok=True)
        fd = os.open(PATH, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
                     | getattr(os, "O_BINARY", 0), 0o600)
        with os.fdopen(fd, "ab") as f:
            f.write(line.encode("utf-8"))
        return True
    except OSError:
        return False


def note(exc, tb):
    try:
        line = record(exc, tb)
        if line:
            write(line)
    except Exception:
        pass


def install():
    """Chain sys.excepthook and threading.excepthook. Idempotent."""
    global _installed
    if _installed:
        return
    _installed = True
    prev_sys = sys.excepthook
    prev_thread = threading.excepthook

    def sys_hook(etype, value, tb):
        note(value, tb)
        prev_sys(etype, value, tb)

    def thread_hook(args):
        note(args.exc_value, args.exc_traceback)
        prev_thread(args)

    sys.excepthook = sys_hook
    threading.excepthook = thread_hook

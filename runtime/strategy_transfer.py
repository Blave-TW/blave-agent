"""Strategy transfer (the desktop app's 送上雲端 / 拉回這台電腦) without an agent turn.

Pure file logic, no processes and no network: command_listener's strategy_import / strategy_export
handlers call into this and own the locks, the background run and the hand-over. Every rule here is
the program form of a step of references/cloud-handoff.md (§1 portability, §4a never overwrite,
§4b allow-list, §4c rename, §5 the managed data-source block, §6B the order scan), so a transfer
does the same thing whichever way it was started.

The api checks the same shapes first (api openclaw/agent_command.py TRANSFER_* / data_env_*);
this side checks them again — the trust boundary is the machine.
"""

import ast
import base64
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import time
import tokenize

# Windows reserved names (con, nul, com1.py…): neither a Windows cloud machine nor the desktop can create them
WIN_RESERVED = r"(?!(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$))"            # = api _WIN_RESERVED
NAME_RE = re.compile(WIN_RESERVED + r"[A-Za-z0-9_-]{1,64}")                    # = api TRANSFER_NAME_RE
FILE_RE = re.compile(WIN_RESERVED + r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}\.py")  # = api TRANSFER_FILE_RE
MAX_FILES = 20                                                   # = api TRANSFER_MAX_FILES
FILE_MAX = 128 * 1024                                            # = api TRANSFER_FILE_MAX (decoded)
TOTAL_MAX = 160 * 1024                                           # = api TRANSFER_TOTAL_MAX (decoded)
ENV_MAX = 16                                                     # = api TRANSFER_ENV_MAX
SOURCE_FIELDS_MAX = 8
SOURCES_MAX = 32
_SHA256_RE = re.compile(r"[0-9a-f]{64}")
STAGE_DIR = os.path.join("state", "transfer_in")   # = shell/transfer.js STAGE_DIR
_STAGE_RE = re.compile(r"[0-9a-f]{32}")

# What the strategy's own runs leave in its folder: regenerated on the destination, never carried
OUTPUT_FILES = frozenset(("state.json", "stats.json", "backtest_state.json", "strategy.log", "scan.json", "wf.json",
                          "drift.json", "perf_refresh.json", "source.json", "transfer.json", "transfer.log"))
OUTPUT_DIRS = frozenset(("chart", "versions", "exports", "__pycache__"))

# references/cloud-handoff.md §5 (handoff_env_merge): the app rewrites this block, so the format is exact
ENV_BEGIN = "# >>> blave desktop data sources (managed, do not edit) >>>"
ENV_END = "# <<< blave desktop data sources <<<"
_KV_RE = re.compile(r"^DATA_([A-Z0-9]{1,24})_([A-Z][A-Z0-9_]{0,31})=(.*)$")
_META_RE = re.compile(r"^# source ([A-Z0-9]{1,24}) added=(\d{1,12})$")
_VENUE_SUFFIXES = ("_API_KEY", "_SECRET_KEY", "_PASSWORD", "_PASSPHRASE")
_DATA_VALUE_RE = re.compile(r"[\x21-\x7e]{1,512}")

# references/cloud-handoff.md §6B, verbatim: a Type B file that matches is never run
ORDERS_RE = re.compile(
    r"lib\.(order_|execute)|from\s+lib\s+import\s+[^\n]*\b(order_|execute)|(place|create|submit|send|new|cancel|amend)_?order"
    r"|ccxt|shioaji|requests\.(post|put|delete|request)|\.(post|put|delete)\(|method\s*=\s*[\"'](POST|PUT|DELETE)"
    r"|subprocess|os\.system|importlib|__import__|\b(exec|eval)\(", re.I)
_CJK_RE = re.compile("[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]")
_TYPE_RE = re.compile(r"^#\s*Type:\s*([ABC])\b", re.M | re.ASCII)   # = strategy_reporter._TYPE_RE


class Refused(ValueError):
    """`CODE: detail` — the ack's error. The detail names files or modules, never a value.
    NO_STRATEGY_NAME's detail is `<why>: <files>` (helpers / wildcard / literal), so the desktop can
    say which file to change and how (shell/renderer/handoff.js HO_NAME_WHY) under the one code
    0.1.48 and older already map."""

    def __init__(self, code, detail):
        super().__init__(f"{code}: {detail}")
        self.code = code


# ── shapes ──────────────────────────────────────────────────────────────────

def data_env_name_ok(name):
    m = re.fullmatch(r"DATA_([A-Z0-9]{1,24})_([A-Z][A-Z0-9_]{0,31})", name) if isinstance(name, str) else None
    if not m or m.group(1).startswith("DATA"):
        return False
    suf = next((s for s in _VENUE_SUFFIXES if name.endswith(s)), None)
    return suf is None or name[:-len(suf)].startswith("DATA_")


def data_env_value_ok(value):
    return (isinstance(value, str) and bool(_DATA_VALUE_RE.fullmatch(value))
            and "'" not in value and "\\" not in value and "${" not in value)


def decode_files(files):
    """[{f, sha256, b64}] → [(f, bytes, text)], strategy.py included; Refused BAD_FILES otherwise."""
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise Refused("BAD_FILES", f"1-{MAX_FILES} files")
    out, seen, total = [], set(), 0
    for item in files:
        if not isinstance(item, dict) or set(item) != {"f", "sha256", "b64"}:
            raise Refused("BAD_FILES", "each file is {f, sha256, b64}")
        f, digest, b64 = item["f"], item["sha256"], item["b64"]
        if not isinstance(f, str) or not FILE_RE.fullmatch(f):
            raise Refused("BAD_FILES", "bad file name")
        if f.casefold() in seen:
            raise Refused("BAD_FILES", f"duplicate file {f}")
        seen.add(f.casefold())
        if not isinstance(digest, str) or not _SHA256_RE.fullmatch(digest) or not isinstance(b64, str) \
                or len(b64) > (FILE_MAX + 2) // 3 * 4:
            raise Refused("BAD_FILES", f"bad {f}")
        try:
            raw = base64.b64decode(b64, validate=True)
        except (ValueError, TypeError):
            raise Refused("BAD_FILES", f"bad {f}")
        total += len(raw)
        if len(raw) > FILE_MAX or total > TOTAL_MAX:
            raise Refused("TOO_LARGE", f"{f}")
        if hashlib.sha256(raw).hexdigest() != digest:
            raise Refused("BAD_FILES", f"sha256 mismatch on {f}")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise Refused("NOT_UTF8", f)
        out.append((f, raw, text))
    if "strategy.py" not in seen:
        raise Refused("BAD_FILES", "strategy.py missing")
    return out


def staged_files(workspace, stage, files):
    """拉回 on the desktop: the app's main process fetched the files, checked both hash sets and wrote
    them to state/transfer_in/<stage>/ (a 16 KB daemon command cannot carry them). → the
    [{f, sha256, b64}] form decode_files checks like any other import. The stage folder is the app's
    one-shot hand-over: it is removed here whatever the outcome."""
    root = os.path.join(workspace, STAGE_DIR)
    path = os.path.join(root, stage) if isinstance(stage, str) and _STAGE_RE.fullmatch(stage) else None
    try:
        if path is None or os.path.islink(root) or os.path.islink(path) or not os.path.isdir(path):
            raise Refused("BAD_ARGS", "no staged files")
        if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
            raise Refused("BAD_FILES", f"1-{MAX_FILES} files")
        out = []
        for item in files:
            if not isinstance(item, dict) or set(item) != {"f", "sha256"} or not isinstance(item["f"], str) \
                    or not FILE_RE.fullmatch(item["f"]):
                raise Refused("BAD_FILES", "each staged file is {f, sha256}")
            try:
                fd = os.open(os.path.join(path, item["f"]), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                             | getattr(os, "O_BINARY", 0))
            except OSError:
                raise Refused("BAD_FILES", f"{item['f']} not staged")
            with os.fdopen(fd, "rb") as fh:
                raw = fh.read(FILE_MAX + 1)
            if len(raw) > FILE_MAX:
                raise Refused("TOO_LARGE", item["f"])
            out.append({"f": item["f"], "sha256": item["sha256"], "b64": base64.b64encode(raw).decode()})
        return out
    finally:
        if path is not None and not os.path.islink(path) and os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)


def import_args(args, local, workspace=None):
    """strategy_import's args → (name, start, files, env). `start` = the N of `to` (`<name>_N`, N ≥ 2)
    the confirm dialog proposed, else 2. A local import never takes keys: the first version of
    拉回 moves no secret off the cloud machine. `stage` (local only) = the files wait in
    state/transfer_in/<stage>/ instead of riding in the command (staged_files)."""
    if isinstance(args, dict) and "stage" in args:
        if not local or workspace is None:
            raise Refused("BAD_ARGS", "staged files are only for this computer")
        args = dict(args)
        args["files"] = staged_files(workspace, args.pop("stage"), args.get("files"))
    if not isinstance(args, dict) or "name" not in args or "files" not in args \
            or not set(args) <= {"name", "to", "files", "env"}:
        raise Refused("BAD_ARGS", "strategy_import takes name, files and optionally to, env")
    name, to = args["name"], args.get("to")
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise Refused("BAD_ARGS", "bad strategy name")
    if to is not None and (not isinstance(to, str) or not NAME_RE.fullmatch(to)):
        raise Refused("BAD_ARGS", "bad destination name")
    start = 2
    m = re.fullmatch(r".*_(\d{1,6})", to or "")
    if m and int(m.group(1)) >= 2:
        start = int(m.group(1))
    env = args.get("env", {})
    if "env" in args and local:
        raise Refused("BAD_ARGS", "data-source keys are not moved onto this computer")
    if not isinstance(env, dict) or len(env) > ENV_MAX or ("env" in args and not env):
        raise Refused("BAD_ARGS", "bad env")
    for k, v in env.items():
        if not data_env_name_ok(k) or not data_env_value_ok(v):
            raise Refused("BAD_ARGS", "bad env")
    return name, start, decode_files(args["files"]), dict(env)


# ── portability (§1.4) ──────────────────────────────────────────────────────

def missing_modules(texts, workspace):
    """The workspace modules the copied files import that the destination does not have: `lib.<x>`
    with no lib/<x>.py or lib/<x>/, any `allocators` / `strategies` import (those never travel).
    Sibling helpers that travel with the strategy are not workspace modules. Unparseable files are
    left to the run that follows — it reports the SyntaxError itself."""
    lib_dir = os.path.join(workspace, "lib")
    try:
        with open(os.path.join(lib_dir, "__init__.py"), encoding="utf-8", errors="replace") as fh:
            lib_init = fh.read()
    except OSError:
        lib_init = ""

    def has_lib(mod):
        return os.path.isfile(os.path.join(lib_dir, mod + ".py")) or os.path.isdir(os.path.join(lib_dir, mod))

    missing = set()
    for text in texts:
        try:
            tree = ast.parse(text)
        except (SyntaxError, ValueError):
            continue
        for node in ast.walk(tree):
            mods = []
            if isinstance(node, ast.Import):
                mods = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
                if node.module == "lib":
                    for a in node.names:
                        if a.name != "*" and not has_lib(a.name) and \
                                not re.search(r"\b" + re.escape(a.name) + r"\b", lib_init):
                            missing.add("lib." + a.name)
                    continue
                mods = [node.module]
            for mod in mods:
                head, _, rest = mod.partition(".")
                if head in ("allocators", "strategies"):
                    missing.add(mod)
                elif head == "lib" and rest and not has_lib(rest.split(".")[0]):
                    missing.add("lib." + rest.split(".")[0])
    return sorted(missing)


def strategy_type(text):
    """'A' / 'B' / 'C': the `# Type:` header when there is one, else B unless it defines
    compute_signals (references/cloud-handoff.md §1.3)."""
    m = _TYPE_RE.search(text[:2000])
    if m:
        return m.group(1)
    return "A" if re.search(r"^def\s+compute_signals\s*\(", text, re.M) else "B"


def order_scan(files):
    """(syntax_errors, order_lines) of §6B over every copied file."""
    bad, hits = [], []
    for f, _, text in files:
        try:
            compile(text, f, "exec")
        except SyntaxError as e:
            bad.append(f"{f} line {e.lineno}: {e.msg}")
        hits += [f"{f}: {m.group(0)}" for m in ORDERS_RE.finditer(text)]
    return bad, hits[:5]


# ── destination (§4a) ───────────────────────────────────────────────────────

def _load_json_or_empty(path):
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise Refused("CHECK_FAILED", f"{os.path.basename(path)} unreadable ({type(e).__name__})")
    return doc if isinstance(doc, dict) else {}


def _crontab_lines():
    """`crontab -l`'s lines; [] where there is no crontab (no binary, Windows, none installed).
    Any other failure is not "free" (§4a)."""
    import shutil
    if not shutil.which("crontab"):
        return []
    try:
        r = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=15,
                           stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        raise Refused("CHECK_FAILED", f"crontab -l failed ({type(e).__name__})")
    if r.returncode and "no crontab" not in (r.stderr or ""):
        raise Refused("CHECK_FAILED", "crontab -l failed")
    return (r.stdout or "").splitlines() if not r.returncode else []


def taken_check(workspace):
    """→ taken(x): the folder or single-file layout exists, x is keyed in the 下單設定 (any of
    amounts / weights / exchanges, amount 0 included), registered in state/deployments.json, or a
    crontab line names it as a whole word. Reads once; unreadable → Refused, never "free"."""
    cfg = _load_json_or_empty(os.path.join(workspace, "manager", "portfolio_config.json"))
    keyed = set()
    for k in ("amounts", "weights", "exchanges"):
        if isinstance(cfg.get(k), dict):
            keyed |= set(cfg[k])
    deployed = _load_json_or_empty(os.path.join(workspace, "state", "deployments.json"))
    cron = _crontab_lines()
    sdir = os.path.join(workspace, "strategies")

    def taken(x):
        if os.path.lexists(os.path.join(sdir, x)) or os.path.lexists(os.path.join(sdir, x + ".py")):
            return True
        if x in keyed or x in deployed:
            return True
        word = re.compile(r"(?<![A-Za-z0-9_])" + re.escape(x) + r"(?![A-Za-z0-9_])")
        return any(word.search(line) for line in cron)

    return taken


def candidate(name, k):
    suffix = f"_{k}"
    return name[:64 - len(suffix)] + suffix


# ── rename in transit (§4c) ─────────────────────────────────────────────────

def strategy_name_const(text):
    """The STRATEGY_NAME of strategy.py (ast, never executed), or None unless it is bound exactly once,
    at module level, to a string literal (`X = "n"` or `X: str = "n"`). Anything else — bound twice,
    inside a block, from another name, a tuple target — leaves where lib/runner writes unknowable here."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return None
    binds = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            targets = [node.target]
        else:
            continue
        for t in targets:
            names = [n for n in ast.walk(t) if isinstance(n, ast.Name) and n.id == "STRATEGY_NAME"]
            if names:
                binds.append((node, t))
    if len(binds) != 1:
        return None
    node, target = binds[0]
    if node not in tree.body or not isinstance(target, ast.Name) or isinstance(node, ast.AugAssign) \
            or not isinstance(node.value, ast.Constant) or not isinstance(node.value.value, str):
        return None
    return node.value.value


def imports_runner(texts):
    """Any file importing lib.runner (`import lib.runner`, `from lib.runner import …`,
    `from lib import runner`, `from lib import *`). Unparseable files are skipped: they fail the §6B
    compile check, so nothing runs."""
    for text in texts:
        try:
            tree = ast.parse(text)
        except (SyntaxError, ValueError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import) and any(a.name == "lib.runner" or a.name.startswith("lib.runner.")
                                                    for a in node.names):
                return True
            if isinstance(node, ast.ImportFrom) and not node.level and node.module:
                if node.module == "lib.runner" or node.module.startswith("lib.runner."):
                    return True
                if node.module == "lib" and any(a.name in ("runner", "*") for a in node.names):
                    return True
    return False


def _wildcard_import(text):
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return bool(re.search(r"^\s*from\s+\S+\s+import\s*\*", text, re.M))
    return any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names) for n in ast.walk(tree))


def _writes_strategy_name(text):
    """Whether a helper may set STRATEGY_NAME. Only two forms read it and pass: an attribute read
    (`s.STRATEGY_NAME`, also inside an f-string's braces) and a bare-name read. Every other appearance
    of the name refuses — a binding of any kind, an attribute store/delete, and the name as data
    (str or bytes literal, docstring, getattr's argument, a comment): data can be turned into a
    setattr / globals() write at run time. Unparseable → the substring rule, never let through.
    Like the substring rule before it, a name assembled at run time ("STRATEGY" + "_NAME") is not
    seen: this guards copied and ordinary code, not code written to get around it."""
    key = "STRATEGY_NAME"
    try:
        tree = ast.parse(text)
        comments = [t.string for t in tokenize.generate_tokens(io.StringIO(text).readline)
                    if t.type == tokenize.COMMENT]
    except (SyntaxError, ValueError, tokenize.TokenError):
        return key in text
    if any(key in c for c in comments):
        return True   # `# STRATEGY_NAME` read back through open(__file__)
    store = (ast.Store, ast.Del)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id == key and isinstance(node.ctx, store):
            return True   # =, :=, +=, annotated, for / with / comprehension targets, unpacking, del, type alias
        if isinstance(node, ast.Attribute) and node.attr == key and isinstance(node.ctx, store):
            return True   # strategy.STRATEGY_NAME = …, __main__.STRATEGY_NAME = …
        if isinstance(node, (ast.Global, ast.Nonlocal)) and key in node.names:
            return True
        if isinstance(node, ast.Import) and any((a.asname or a.name.split(".")[0]) == key for a in node.names):
            return True
        if isinstance(node, ast.ImportFrom) and any((a.asname or a.name) == key for a in node.names):
            return True
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.ExceptHandler)) \
                and node.name == key:
            return True
        if isinstance(node, ast.arg) and node.arg == key:
            return True
        if isinstance(node, ast.keyword) and node.arg == key:
            return True   # run(dict(STRATEGY_NAME=…), …), globals().update(STRATEGY_NAME=…)
        if type(node).__name__ in ("MatchAs", "MatchStar") and getattr(node, "name", None) == key:
            return True
        if type(node).__name__ == "MatchMapping" and getattr(node, "rest", None) == key:
            return True   # case {**STRATEGY_NAME}:
        # the name as data, docstrings and getattr's argument included: setattr(m, "STRATEGY_NAME", …),
        # globals()["STRATEGY_NAME"] = …, {"STRATEGY_NAME": …} for lib.runner.run, exec("…"), __doc__
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and key in node.value:
            return True
        if isinstance(node, ast.Constant) and isinstance(node.value, bytes) and key.encode() in node.value:
            return True   # setattr(m, b"STRATEGY_NAME".decode(), …)
    return False


def check_name(files, name):
    """lib/runner writes a strategy's output under strategies/<STRATEGY_NAME>/: a STRATEGY_NAME that is
    not the folder name, or one this cannot read as a single literal, could have the destination's first
    run write into another strategy there. → the constant, or None for a Type B strategy whose files
    never mention STRATEGY_NAME and never import lib.runner (nothing to check, nothing to rename)."""
    text = next(t for f, _, t in files if f == "strategy.py")
    # Cross-file override: a helper copied from another strategy keeps its STRATEGY_NAME = "other", and
    # an `import *` pulls it over strategy.py's (or the helper sets strategy.STRATEGY_NAME, setattr,
    # globals()[…] itself) — the backtest then mints and rewrites stats.json and daily_returns under
    # that (possibly live) strategy. So a helper refuses unless it only reads the name (scan.py's chart
    # title `s.STRATEGY_NAME`; _writes_strategy_name lists what counts), and any wildcard import refuses
    # whatever the helper says. strategy.py's literal is then checked against the folder below. A name
    # spelled at run time ("STRATEGY" + "_NAME") gets past this, as it got past the substring rule, and
    # so does the name pulled back out of an allowed read (an exception's .name, __code__.co_names, the
    # file's own source) — that cannot be closed without refusing every read again. The check stops
    # copied and ordinary code, not code written to evade it.
    helpers = sorted(f for f, _, t in files if f != "strategy.py" and _writes_strategy_name(t))
    if helpers:
        raise Refused("NO_STRATEGY_NAME", "helpers: " + ", ".join(helpers))
    stars = sorted(f for f, _, t in files if _wildcard_import(t))
    if stars:
        raise Refused("NO_STRATEGY_NAME", "wildcard: " + ", ".join(stars))
    if strategy_type(text) == "B" and not any("STRATEGY_NAME" in t for _, _, t in files) \
            and not imports_runner([t for _, _, t in files]):
        # a plain Type B script that never reaches lib/runner: it writes no stats under any name, so
        # it keeps the folder's id. Its trial still runs BLAVE_MODE=backtest (command_listener).
        return None
    const = strategy_name_const(text)
    if const is None:
        raise Refused("NO_STRATEGY_NAME", "literal: strategy.py")
    if const != name:
        raise Refused("NAME_MISMATCH", f"strategy.py says STRATEGY_NAME = {const!r}, the folder is {name}")
    return const


def _name_line(name):
    return re.compile(r'^(STRATEGY_NAME[ \t]*(?::[ \t]*[A-Za-z_][\w.]*[ \t]*)?=[ \t]*)(["\'])' + re.escape(name)
                      + r'\2([ \t]*(?:#.*)?)$', re.M)


def rename(files, name, dest):
    """§4c on the texts before anything is written: the `STRATEGY_NAME = "<name>"` line of each file
    → `<dest>` (an annotation and a trailing comment kept), and in the same file DISPLAY_NAME gets the
    destination's number (「（N）」 with CJK, else " (N)"). strategy.py must carry that line exactly
    once. → (files, still_names): the files that still name `<name>` elsewhere."""
    line = _name_line(name)
    word = re.compile(r"(?<![A-Za-z0-9_])" + re.escape(name) + r"(?![A-Za-z0-9_])")
    disp = re.compile(r'^(DISPLAY_NAME[ \t]*(?::[ \t]*[A-Za-z_][\w.]*[ \t]*)?=[ \t]*)(["\'])(.*?)\2([ \t]*(?:#.*)?)$', re.M)
    k = dest.rsplit("_", 1)[-1]
    if len(line.findall(next(t for f, _, t in files if f == "strategy.py"))) != 1:
        raise Refused("NO_STRATEGY_NAME", "literal: strategy.py")

    def numbered(m):
        v = m.group(3)
        return m.group(1) + m.group(2) + v + (f"（{k}）" if _CJK_RE.search(v) else f" ({k})") + m.group(2) + m.group(4)

    out, left = [], []
    for f, raw, text in files:
        new = line.sub(lambda m: m.group(1) + m.group(2) + dest + m.group(2) + m.group(3), text)
        if new != text:
            new = disp.sub(numbered, new, count=1)
            raw = new.encode("utf-8")
        if word.search(new):
            left.append(f)
        out.append((f, raw, new))
    return out, left


# ── data-source keys (§5) ───────────────────────────────────────────────────

def merge_env_text(old_text, env, now=None):
    """The .env text with `env` merged into the managed block: each source replaced as a unit (all
    its fields, stray copies outside the block too), other sources and every other line untouched.
    → (new_text, written_names). Refused on more than SOURCE_FIELDS_MAX fields in a source or
    SOURCES_MAX sources."""
    now = int(now if now is not None else time.time())
    new = {}
    for k, v in env.items():
        m = _KV_RE.match(f"{k}={v}")
        if not m or not data_env_name_ok(k) or not data_env_value_ok(v):
            raise Refused("BAD_ARGS", "bad env")
        new.setdefault(m.group(1), {})[m.group(2)] = f"{k}='{v}'"
    if any(len(f) > SOURCE_FIELDS_MAX for f in new.values()):
        raise Refused("BAD_ARGS", f"more than {SOURCE_FIELDS_MAX} fields in a source")
    outside, block, inside = [], {}, False
    for raw_line in re.split(r"\r?\n", old_text or ""):
        s = raw_line.strip()
        if s in (ENV_BEGIN, ENV_END):
            inside = s == ENV_BEGIN
            continue
        kv = _KV_RE.match(s)
        if kv and kv.group(1) in new and data_env_name_ok(f"DATA_{kv.group(1)}_{kv.group(2)}"):
            continue
        if not inside:
            outside.append(raw_line)
            continue
        meta = _META_RE.match(s)
        if meta:
            block.setdefault(meta.group(1), {"added": 0, "fields": {}})["added"] = int(meta.group(2))
        elif kv and data_env_name_ok(f"DATA_{kv.group(1)}_{kv.group(2)}"):
            block.setdefault(kv.group(1), {"added": 0, "fields": {}})["fields"][kv.group(2)] = s
        elif s and not s.startswith("#"):
            outside.append(raw_line)
    for src, fields in new.items():
        block[src] = {"added": block.get(src, {}).get("added") or now, "fields": fields}
    block = {k: v for k, v in block.items() if v["fields"]}
    if len(block) > SOURCES_MAX:
        raise Refused("BAD_ARGS", f"more than {SOURCES_MAX} data sources")
    while outside and outside[-1] == "":
        outside.pop()
    out = outside + [ENV_BEGIN]
    for src, b in block.items():
        out += [f"# source {src} added={b['added']}"] + list(b["fields"].values())
    return "\n".join(out + [ENV_END]) + "\n", sorted(env)


# ── export (cloud → this computer) ──────────────────────────────────────────

def collect_export(workspace, name):
    """The *.py directly in strategies/<name>/ as [{f, sha256, b64}], plus `left_behind`: every other
    entry that is not a run output (a params .json, a .csv…) — named to the user, never carried.
    Regular files only (a symlink is not followed, and is left behind). Refused: no such strategy,
    a .py whose name fails FILE_RE, the caps, non-UTF-8."""
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise Refused("BAD_ARGS", "bad strategy name")
    folder = os.path.join(workspace, "strategies", name)
    if os.path.islink(folder) or not os.path.isdir(folder) \
            or not os.path.isfile(os.path.join(folder, "strategy.py")) \
            or os.path.islink(os.path.join(folder, "strategy.py")):
        raise Refused("NO_SOURCE", f"strategies/{name}/strategy.py")
    files, left, bad, total = [], [], [], 0
    for entry in sorted(os.listdir(folder)):
        p = os.path.join(folder, entry)
        if os.path.islink(p):
            left.append(entry)
            continue
        if os.path.isdir(p):
            if entry not in OUTPUT_DIRS:
                left.append(entry + "/")
            continue
        if not entry.endswith(".py"):
            if entry not in OUTPUT_FILES and not entry.endswith((".png", ".handoff", ".rename", ".tmp")) \
                    and not entry.startswith("."):
                left.append(entry)
            continue
        if not FILE_RE.fullmatch(entry):
            bad.append(entry)
            continue
        with open(p, "rb") as fh:
            raw = fh.read(FILE_MAX + 1)
        total += len(raw)
        if len(raw) > FILE_MAX or total > TOTAL_MAX:
            raise Refused("TOO_LARGE", entry)
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            raise Refused("NOT_UTF8", entry)
        files.append({"f": entry, "sha256": hashlib.sha256(raw).hexdigest(),
                      "b64": base64.b64encode(raw).decode("ascii")})
    if bad:
        raise Refused("BAD_FILES", "file names outside [A-Za-z0-9_.-]: " + ", ".join(repr(b)[:70] for b in bad[:5]))
    if len(files) > MAX_FILES:
        raise Refused("TOO_LARGE", f"more than {MAX_FILES} .py files")
    return files, [x[:128] for x in left[:50]]


def still_naming(files, name):
    """The files that name `<name>` as a whole word (rename's still_names, for an unnamed Type B)."""
    word = re.compile(r"(?<![A-Za-z0-9_])" + re.escape(name) + r"(?![A-Za-z0-9_])")
    return [f for f, _, t in files if word.search(t)]

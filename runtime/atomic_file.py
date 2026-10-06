"""Write-then-replace without following a pre-planted symlink.

The runtime writes into directories the agent can also write (the workspace, and
on most machines state/ too). A fixed temp name (`path + ".tmp"`) lets the agent
park a symlink there first; `open(tmp, "w")` then writes through it to anywhere
the runtime's user can write — with agent-controlled content (.env kept lines,
log tails). Audit 2026-10-02 N1, runtime side.

`replacing` creates the temp under a random name with O_CREAT|O_EXCL (fails on an
existing name, symlink or not), writes it, and `os.replace`s it over `path` —
replace swaps the directory entry, so a symlink at `path` is replaced, not
written through. Only a temp this call created is ever removed.
"""
import contextlib
import os
import re
import secrets
import shutil
import stat
import time

_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)


@contextlib.contextmanager
def replacing(path, mode="w", *, perm=None, prepare=None, replace=None, **open_kw):
    """`with replacing(path) as f: json.dump(doc, f)` — same file object as
    `open(tmp, mode, **open_kw)`, same newline translation on Windows.

    perm=None → created like open() (0o666 minus umask). An int → created with it
    and fchmod'ed to exactly it (POSIX). prepare(tmp) runs after the write, before
    the replace (Windows ACLs). replace(tmp, path) defaults to os.replace."""
    d, base = os.path.split(path)
    tmp = os.path.join(d, f".{base}.{secrets.token_hex(6)}.tmp")
    fd = os.open(tmp, _FLAGS, 0o666 if perm is None else perm)
    try:
        if perm is not None and hasattr(os, "fchmod"):
            os.fchmod(fd, perm)
        f = os.fdopen(fd, mode, **open_kw)
    except BaseException:
        os.close(fd)
        _drop(tmp)
        raise
    try:
        with f:
            yield f
        if prepare is not None:
            prepare(tmp)
        (replace or os.replace)(tmp, path)
    except BaseException:
        _drop(tmp)
        raise


_APPEND = (os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
           | getattr(os, "O_BINARY", 0))


def open_append(path, mode="ab", **open_kw):
    """`open(path, "a"/"ab")` that refuses a symlink at `path` (O_NOFOLLOW; Windows has no
    such flag, and a file symlink there needs a privilege). Usable as Popen stdout."""
    fd = os.open(path, _APPEND, 0o666)
    try:
        return os.fdopen(fd, mode, **open_kw)
    except BaseException:
        os.close(fd)
        raise


def append_line(path, text, encoding="utf-8"):
    with open_append(path, "a", encoding=encoding) as f:
        f.write(text)


def open_truncate(path, mode="wb", **open_kw):
    """`open(path, "w"/"wb")` for a file that must be readable while it is written (a log a
    child process streams into): truncates in place like open(), but refuses a symlink."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
                 | getattr(os, "O_BINARY", 0), 0o666)
    try:
        return os.fdopen(fd, mode, **open_kw)
    except BaseException:
        os.close(fd)
        raise


# replacing() names its temps .<name>.<12 hex>.tmp; shell/wsfile.js uses .<name>.<12 hex> (no suffix)
_OWN_RE = re.compile(r"^\..+\.[0-9a-f]{12}\.tmp$")
_SHELL_RE = re.compile(r"^\..+\.[0-9a-f]{12}$")


def is_own_temp(name):
    return bool(_OWN_RE.match(name))


def sweep_stale(directory, older_than_s=600, only=None):
    """Remove temps a killed writer left behind (a crash between write and replace): regular
    files in replacing()'s naming, older than `older_than_s` — a live writer's temp is seconds
    old. `only="<name>"` narrows to that target's temps and also takes shell/wsfile.js's
    suffix-less ones (kept to a named target: that shape is too plain to sweep a whole dir by).
    Returns the count removed."""
    n = 0
    now = time.time()
    try:
        names = os.listdir(directory)
    except OSError:
        return 0
    for name in names:
        if only is None:
            if not _OWN_RE.match(name):
                continue
        elif not (name.startswith("." + only + ".") and (_OWN_RE.match(name) or _SHELL_RE.match(name))):
            continue
        p = os.path.join(directory, name)
        try:
            st = os.lstat(p)
            if stat.S_ISREG(st.st_mode) and now - st.st_mtime >= older_than_s:
                os.unlink(p)
                n += 1
        except OSError:
            pass
    return n


def sweep_runtime_temps(workspace, state_dir):
    """At runtime start: the directories the runtime replaces files in, plus the .env temps
    (shell and runtime) at the workspace root."""
    n = sweep_stale(workspace, only=".env")
    for d in (workspace, os.path.join(workspace, "manager"), os.path.join(workspace, "state"),
              os.path.join(workspace, "state", "heartbeat"), os.path.join(workspace, "reports"),
              state_dir):
        n += sweep_stale(d)
    return n


def touch(path):
    """Create-or-bump-mtime without following a symlink at `path`."""
    fd = os.open(path, _APPEND, 0o666)
    try:
        if os.utime in os.supports_fd:
            os.utime(fd)
        else:
            os.utime(path)
    finally:
        os.close(fd)


class SafeDir:
    """A directory under `root`, reached without following a symlink anywhere below `root`.

    For the runtime's deletes and moves inside agent-writable trees (reports/sent, reports/):
    swapping `sent` or `reports` for a symlink must not turn "keep the newest 20" into
    "delete someone's documents". POSIX: one O_NOFOLLOW open per component, then every
    operation is relative to the final fd, so a later swap changes nothing. Windows has no
    dir_fd: the resolved path must stay under root at open time (junctions need no privilege
    there, so the check matters; a swap after it is not covered)."""

    def __init__(self, root, path, create=False):
        rel = os.path.relpath(path, root)
        parts = [] if rel == "." else rel.split(os.sep)
        if any(p in ("", os.pardir) for p in parts):
            raise OSError(f"{path} is not under {root}")
        self.path = path
        self.fd = None
        if os.rename in os.supports_dir_fd and hasattr(os, "O_DIRECTORY"):
            flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                for part in parts:
                    try:
                        nfd = os.open(part, flags, dir_fd=fd)
                    except FileNotFoundError:
                        if not create:
                            raise
                        with contextlib.suppress(FileExistsError):  # a second uploader got there first
                            os.mkdir(part, dir_fd=fd)
                        nfd = os.open(part, flags, dir_fd=fd)
                    os.close(fd)
                    fd = nfd
            except BaseException:
                os.close(fd)
                raise
            self.fd = fd
        else:
            real_root = os.path.realpath(root)
            if create and not os.path.isdir(path):
                cur = root
                for part in parts:
                    cur = os.path.join(cur, part)
                    if not os.path.realpath(cur).startswith(real_root + os.sep):
                        raise OSError(f"{cur} resolves outside {root}")
                    if not os.path.isdir(cur):
                        with contextlib.suppress(FileExistsError):
                            os.mkdir(cur)
            if not os.path.lexists(path):
                raise FileNotFoundError(path)  # same as the POSIX branch: callers treat it as "nothing there"
            real = os.path.realpath(path)
            if real != real_root and not real.startswith(real_root + os.sep):
                raise OSError(f"{path} resolves outside {root}")
            if not os.path.isdir(real):
                raise NotADirectoryError(path)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def _at(self, name):
        if os.sep in name or (os.altsep and os.altsep in name) or name in ("", os.curdir, os.pardir):
            raise ValueError(f"not a plain name: {name!r}")
        return (name, {"dir_fd": self.fd}) if self.fd is not None else (os.path.join(self.path, name), {})

    def listdir(self):
        return os.listdir(self.fd if self.fd is not None else self.path)

    def lstat(self, name):
        p, kw = self._at(name)
        return os.stat(p, follow_symlinks=False, **kw)

    def remove(self, name):
        p, kw = self._at(name)
        os.unlink(p, **kw)

    def move_in(self, src, name):
        """os.replace(src, <this dir>/name) — the destination side never follows a symlink."""
        p, kw = self._at(name)
        os.replace(src, p, **({"dst_dir_fd": self.fd} if self.fd is not None else {}))

    def rmtree(self, name):
        """Remove the real directory `name` here and everything in it; a symlink entry
        (here or anywhere below) is never followed. Missing / not a directory → no-op."""
        try:
            st = self.lstat(name)
        except FileNotFoundError:
            return
        if not stat.S_ISDIR(st.st_mode):
            return
        if self.fd is None:
            shutil.rmtree(os.path.join(self.path, name))
            return
        _rmtree_fd(self.fd, name)


def _rmtree_fd(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent)
    try:
        for e in os.scandir(fd):
            if e.is_dir(follow_symlinks=False):
                _rmtree_fd(fd, e.name)
            else:
                os.unlink(e.name, dir_fd=fd)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent)


def _drop(tmp):
    with contextlib.suppress(OSError):
        os.remove(tmp)

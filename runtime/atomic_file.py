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
import secrets

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


def append_line(path, text, encoding="utf-8"):
    """Append without following a symlink at `path` (O_NOFOLLOW; Windows has no
    such flag, and creating a symlink there needs a privilege)."""
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
                 | getattr(os, "O_BINARY", 0), 0o666)
    with os.fdopen(fd, "a", encoding=encoding) as f:
        f.write(text)


def _drop(tmp):
    with contextlib.suppress(OSError):
        os.remove(tmp)

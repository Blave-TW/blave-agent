"""
Keep the blave-quant skill fresh in the workspace (daily timer / scheduled task).

The skill is the reference layer the agent reads before it touches an exchange:
`references/<exchange>-skill.md` (endpoints + the broker-attribution headers our
rebate depends on) plus the Blave data/indicator docs. AGENTS.md and every
`references/*.md` already point at the relative path `skills/blave-quant/...`,
and the bridges run the turn with cwd=workspace — so this is the one path it may
live at; do not "tidy" it elsewhere.

It is cloned, not baked: the skill repo moves on its own cadence (new endpoints,
new exchanges) while a machine's image is months old. The old openclaw fleet did
the same thing with a daily crontab entry; blave-agent machines run this instead.
"""
import os
import shutil
import stat
import subprocess
import sys

REPO = "https://github.com/Blave-TW/blave-quant-skill"
WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
SKILL_DIR = os.path.join(WORKSPACE, "skills", "blave-quant")
STAGING = SKILL_DIR + ".new"
PREVIOUS = SKILL_DIR + ".old"


def _rmtree(path):
    """shutil.rmtree that survives a git clone on Windows.

    git marks pack files read-only (they are immutable by design). Deleting a file
    on POSIX needs write permission on its PARENT DIRECTORY, so rmtree sails
    through; on Windows the file's read-only ATTRIBUTE blocks the delete itself, so
    rmtree raises PermissionError [WinError 5] on
    `.git/objects/pack/*.idx|.pack|.rev` every time.

    With ignore_errors=True that failure is SILENT: `.old` survives the swap, and
    the NEXT run's os.rename(SKILL_DIR, PREVIOUS) hits an existing directory and
    dies -- so the skill stops updating from the third sync onward while the first
    two look perfectly fine. Measured on the real Windows machine 2026-07-30
    (run 1 exit=0 clean, run 2 exit=0 with .old left, run 3 exit=1).

    Clearing the attribute and retrying is the fix; on POSIX the handler never
    fires, so behaviour there is unchanged.
    """
    if not os.path.exists(path):
        return
    def clear_readonly(func, target, _exc):
        os.chmod(target, stat.S_IWRITE)
        func(target)
    try:
        shutil.rmtree(path, onexc=clear_readonly)      # Python 3.12+
    except TypeError:
        shutil.rmtree(path, onerror=clear_readonly)    # older signature
    except Exception as exc:                            # noqa: BLE001
        # Never let cleanup abort a sync: a leftover directory is recoverable,
        # a crashed sync leaves the agent with no references at all.
        print(f"[skill_sync] could not remove {path}: {exc}", file=sys.stderr)


def main():
    os.makedirs(os.path.dirname(SKILL_DIR), exist_ok=True)
    for path in (STAGING, PREVIOUS):
        _rmtree(path)

    # Clone FIRST, swap after — the agent reads these files on every exchange
    # call, so a network failure has to leave the working copy alone rather than
    # delete it and fail to replace it.
    result = subprocess.run(
        ["git", "clone", "--depth", "1", REPO, STAGING],
        capture_output=True, text=True, timeout=300,
    )
    if result.returncode != 0:
        print(f"[skill_sync] clone failed, keeping existing copy: "
              f"{(result.stderr or '').strip()[-500:]}", file=sys.stderr)
        _rmtree(STAGING)
        sys.exit(1)
    # A clone that "succeeded" but has no SKILL.md is a moved/emptied repo, not an
    # update — swapping it in would silently strip the agent of its references.
    if not os.path.isfile(os.path.join(STAGING, "SKILL.md")):
        print("[skill_sync] clone has no SKILL.md, keeping existing copy", file=sys.stderr)
        _rmtree(STAGING)
        sys.exit(1)

    if os.path.isdir(SKILL_DIR):
        # Windows cannot rename onto an existing directory, so make sure the
        # previous slot is genuinely gone even if a past run left something there.
        _rmtree(PREVIOUS)
        os.rename(SKILL_DIR, PREVIOUS)
    os.replace(STAGING, SKILL_DIR)
    _rmtree(PREVIOUS)
    version = "?"
    for line in open(os.path.join(SKILL_DIR, "SKILL.md")):
        if line.startswith("version:"):
            version = line.split(":", 1)[1].strip()
            break
    print(f"[skill_sync] {SKILL_DIR} updated (skill version {version})", file=sys.stderr)


if __name__ == "__main__":
    main()

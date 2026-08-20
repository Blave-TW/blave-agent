"""systemd ExecStart shim for the Linux reconciler (order daemon) unit.

The reconciler's actual supervision logic (crash-restart loop + Telegram
notify) already lives in blaveclaw-config's manager/start_reconciler.sh — this
file is NOT a reimplementation of that, it's a whitelist-compliant launcher.

Why this exists instead of ExecStart=/bin/bash .../start_reconciler.sh
directly: the release channel (control/updater.py's apply_jobs) refuses to
install any unit whose ExecStart isn't the venv/system python3 (see
_JOB_EXEC_OK there) — that's the boundary keeping a compromised release
channel at agent privilege, never root. Routing through python3 here is what
lets blave-agent-reconciler.service ship to the whole fleet via the normal
jobs.json mechanism instead of needing a manual install on every machine.

Import-safety: control/updater.py's health check imports every non-underscore
runtime module on EVERY machine on EVERY update tick (runtime_modules()) — so
nothing here may run at import time. All work happens under __main__, and it
execs (not subprocess.Popen/run) so bash becomes the process this unit
actually supervises, with no extra python layer sitting on top of it.
"""
import os

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")

if __name__ == "__main__":
    os.chdir(WORKSPACE)
    os.execv("/bin/bash", ["bash", "manager/start_reconciler.sh"])

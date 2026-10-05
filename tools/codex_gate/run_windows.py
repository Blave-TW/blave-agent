"""Run gate.py on the Windows test box from a Mac, and bring the results back.

Over SSH the box gives session 0, where Codex's sandboxed PowerShell dies with 0xC0000142;
the gate therefore runs as a one-shot scheduled task with /IT in the logged-on RDP session
(it may be disconnected, it must be logged on — `query user` shows it).

Usage (from anywhere on the Mac):
  python3 tools/codex_gate/run_windows.py [--repo <checkout>] [--out <dir>] [-- <gate.py args>]
Everything after `--` goes to gate.py unchanged (e.g. `-- --scenarios s4_quality_block --reps 1`).
"""
import argparse
import os
import subprocess
import sys
import tarfile
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SHIP = ["runtime", "lib", "manager", "references", "examples", "allocators",
        "strategies/TEMPLATE_A.py", "strategies/TEMPLATE_C.py", "AGENTS.md", "CLAUDE.md", "VERSION"]
QUIET = ("post-quantum", "store now, decrypt later", "openssh.com/pq", "may need to be upgraded")


def no_cache(info):
    return None if "__pycache__" in info.name or info.name.endswith(".pyc") else info


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", default=os.path.dirname(os.path.dirname(HERE)))
    ap.add_argument("--host", default="Administrator@54.254.216.180")
    ap.add_argument("--key", default=os.path.expanduser("~/.config/blave/win-test_ssh"))
    ap.add_argument("--python", default=r"C:\Users\Administrator\Blave\venv\Scripts\python.exe",
                    help="interpreter on the box with the lib/ deps; only read, never modified")
    ap.add_argument("--user", default="Administrator", help="owner of the logged-on RDP session")
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "codex_gate_out",
                                                  time.strftime("%Y%m%d-%H%M%S")))
    ap.add_argument("--wait", type=int, default=4 * 3600, help="give up after this many seconds")
    argv = sys.argv[1:]
    gate_args = argv[argv.index("--") + 1:] if "--" in argv else []
    args = ap.parse_args(argv[:argv.index("--")] if "--" in argv else argv)

    ssh = ["ssh", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30", "-i", args.key, args.host]

    def ps(command, check=True):
        proc = subprocess.run(ssh + ["[Console]::OutputEncoding = [Text.Encoding]::UTF8; " + command],
                              capture_output=True, text=True, encoding="utf-8", errors="replace")
        out = "\n".join(line for line in (proc.stdout + proc.stderr).splitlines()
                        if not any(q in line for q in QUIET))
        if check and proc.returncode != 0:
            raise SystemExit(f"remote command failed ({proc.returncode}): {command}\n{out}")
        return out

    stamp = time.strftime("%Y%m%d%H%M%S")
    task = f"BlaveCodexGate-{stamp}"
    # LOCALAPPDATA, not TEMP: TEMP is an 8.3 path on this box (see gate.py's realpath note).
    remote = ps("$env:LOCALAPPDATA").strip() + f"\\Temp\\blave-codex-gate-{stamp}"
    scp_path = "/" + remote.replace("\\", "/")  # Windows OpenSSH's scp only finds /C:/... paths
    print(f"[win] remote dir {remote}, task {task}", flush=True)

    with tempfile.TemporaryDirectory() as tmp:
        bundle = os.path.join(tmp, "bundle.tgz")
        with tarfile.open(bundle, "w:gz") as tar:
            for rel in SHIP:
                tar.add(os.path.join(args.repo, rel), arcname="repo/" + rel, filter=no_cache)
            tar.add(HERE, arcname="repo/tools/codex_gate", filter=no_cache)
        ps(f"New-Item -ItemType Directory -Force '{remote}' | Out-Null")
        subprocess.run(["scp", "-q", "-i", args.key, bundle, f"{args.host}:{scp_path}/bundle.tgz"],
                       check=True)
    gate = " ".join(f'"{a}"' for a in gate_args)
    cmd = (
        "@echo off\n"
        "set PYTHONUTF8=1\n"
        f'cd /d "{remote}"\n'
        "tar -xzf bundle.tgz\n"
        f'"{args.python}" "{remote}\\repo\\tools\\codex_gate\\gate.py" --repo "{remote}\\repo" '
        f'--python "{args.python}" --out "{remote}\\out" {gate} > "{remote}\\gate.log" 2>&1\n'
        f'echo %ERRORLEVEL% > "{remote}\\done.txt"\n'
    )
    ps(f"[IO.File]::WriteAllText('{remote}\\run.cmd', @'\n{cmd}\n'@)")
    try:
        ps(f'schtasks /Create /TN {task} /TR "{remote}\\run.cmd" /SC ONCE /ST 23:59 /IT /RU {args.user} /F')
        ps(f"schtasks /Run /TN {task}")
        deadline, shown = time.time() + args.wait, 0
        while True:
            time.sleep(30)
            log = ps(f"if (Test-Path '{remote}\\gate.log') {{ Get-Content -Encoding UTF8 '{remote}\\gate.log' }}",
                     check=False).splitlines()
            for line in log[shown:]:
                print("  " + line, flush=True)
            shown = max(shown, len(log))
            done = ps(f"if (Test-Path '{remote}\\done.txt') {{ Get-Content '{remote}\\done.txt' }}",
                      check=False).strip()
            if done:
                code = int(done) if done.isdigit() else 1
                break
            if time.time() > deadline:
                print("[win] timed out; ending the task", flush=True)
                ps(f"schtasks /End /TN {task}", check=False)
                code = 1
                break
        os.makedirs(args.out, exist_ok=True)
        ps(f"if (Test-Path '{remote}\\out') {{ Set-Location '{remote}'; tar -czf out.tgz out gate.log }}", check=False)
        # bsdtar reads "C:\\..." in -f as host:path, hence the relative name above.
        local_tgz = os.path.join(args.out, "out.tgz")
        if subprocess.run(["scp", "-q", "-i", args.key, f"{args.host}:{scp_path}/out.tgz", local_tgz]).returncode == 0:
            with tarfile.open(local_tgz) as tar:
                tar.extractall(args.out)
            os.remove(local_tgz)
        print(f"[win] results in {os.path.abspath(args.out)} (gate exit {code})", flush=True)
        return code
    finally:
        ps(f"schtasks /Delete /TN {task} /F", check=False)
        ps(f"Remove-Item -Recurse -Force '{remote}'", check=False)


if __name__ == "__main__":
    sys.exit(main())

"""publish.py refuses to ship from a dirty runtime/ (or api systemd dir) or a HEAD not on origin/main.

The tarball is whatever sits in runtime/ at that moment and reaches the whole fleet in ~5 minutes, so
an uncommitted debug print must stop at the publisher. Throwaway git repos in a temp dir; no network,
no S3 (main() is called with `publish` and must exit before _s3()).
Run: cd blave-agent && .venv/bin/python tests/check_publish_clean_tree.py
"""
import os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import publish

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

def git(cwd, *a):
    subprocess.run(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", *a],
                   check=True, capture_output=True)

with tempfile.TemporaryDirectory() as d:
    origin, repo = os.path.join(d, "origin.git"), os.path.join(d, "blave-agent")
    systemd = os.path.join(d, "api", "blave_agent", "systemd")
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
    os.makedirs(os.path.join(repo, "runtime"))
    git(repo, "init", "-q", "-b", "main")
    with open(os.path.join(repo, "runtime", "VERSION"), "w") as f:
        f.write("1.0.0\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "v")
    git(repo, "remote", "add", "origin", origin)
    git(repo, "push", "-q", "origin", "main")
    api, api_origin = os.path.join(d, "api"), os.path.join(d, "api-origin.git")
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", api_origin], check=True)
    os.makedirs(systemd)
    git(api, "init", "-q", "-b", "main")
    with open(os.path.join(systemd, "a.service"), "w") as f:
        f.write("[Unit]\n")
    git(api, "add", "-A")
    git(api, "commit", "-qm", "u")
    git(api, "remote", "add", "origin", api_origin)
    git(api, "push", "-q", "origin", "main")

    real = publish.tree_problems
    tp = lambda: real(repo, systemd)
    check(tp() == [], f"clean, pushed → may publish {tp()}")

    dbg = os.path.join(repo, "runtime", "dbg.py")
    with open(dbg, "w") as f:
        f.write("print('debug')\n")
    check(any("runtime/" in p for p in tp()), f"untracked runtime/*.py → refused {tp()}")
    os.remove(dbg)
    with open(os.path.join(repo, ".git", "info", "exclude"), "a") as f:
        f.write("runtime/scratch*.py\n__pycache__/\n")
    os.makedirs(os.path.join(repo, "runtime", "__pycache__"))
    with open(os.path.join(repo, "runtime", "__pycache__", "x.pyc"), "w") as f:
        f.write("")
    check(tp() == [], f"ignored __pycache__ → still may publish {tp()}")
    hidden = os.path.join(repo, "runtime", "scratch1.py")
    with open(hidden, "w") as f:
        f.write("print('debug')\n")
    check(any("runtime/" in p for p in tp()), f"runtime/*.py hidden by an exclude rule → refused {tp()}")
    os.remove(hidden)
    with open(os.path.join(repo, "runtime", "VERSION"), "w") as f:
        f.write("1.0.1\n")
    check(any("runtime/" in p for p in tp()), f"modified runtime file → refused {tp()}")
    git(repo, "commit", "-qam", "bump")
    check(any("origin/main" in p for p in tp()), f"committed but not pushed → refused {tp()}")
    git(repo, "push", "-q", "origin", "main")
    check(tp() == [], f"pushed → may publish again {tp()}")

    with open(os.path.join(systemd, "a.service"), "a") as f:
        f.write("# local edit\n")
    check(any("systemd" in p for p in tp()), f"api systemd dir dirty → refused {tp()}")
    git(api, "commit", "-qam", "u2")
    check(any("api's origin/main" in p for p in tp()), f"api committed but not pushed → refused {tp()}")
    git(api, "push", "-q", "origin", "main")
    check(tp() == [], f"api pushed → may publish again {tp()}")

    with open(os.path.join(repo, "runtime", "dbg.py"), "w") as f:
        f.write("x = 1\n")
    publish.tree_problems = lambda *a, **k: tp()
    publish.build_tarball = lambda: sys.exit("reached build_tarball")
    for argv in (["publish"], ["publish", "--canary"]):
        sys.argv = ["publish.py", *argv]
        try:
            publish.main()
            check(False, f"{argv}: main() returned on a dirty tree")
        except SystemExit as e:
            check("refusing to publish" in str(e.code), f"{argv}: main() exits before packing → {e.code}")
    sys.argv = ["publish.py"]
    try:
        publish.main()
    except SystemExit as e:
        check(e.code == "reached build_tarball", f"dry-run is not blocked by a dirty tree → {e.code}")

print(f"\n{'all passed' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)

"""lib/security_check.py: reading one env key is clean; taking os.environ as a whole is a warning. No network.

The AST check used to read node._parent before the parents were attached, so every os.environ warned —
users learned to say yes to ask-user. The line regex lets .copy()/.items() through (its lookahead
stops at the dot), so those must still warn from the AST side once the parent fix is in.
Run: cd blave-agent && .venv/bin/python tests/check_security_environ.py
"""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib import security_check as sc

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

CLEAN = {
    "subscript": 'import os\nk = os.environ["DATA_X_KEY"]\n',
    ".get": 'import os\nk = os.environ.get("DATA_X_KEY")\n',
    ".get default": 'import os\nk = os.environ.get("DATA_X_KEY", "")\n',
}
WARN = {
    ".copy()": "import os\ne = os.environ.copy()\n",
    ".items()": "import os\nfor k, v in os.environ.items():\n    pass\n",
    ".keys()": "import os\nks = list(os.environ.keys())\n",
    "dict()": "import os\ne = dict(os.environ)\n",
    "as an argument": "import os, json\njson.dumps(os.environ)\n",
}

with tempfile.TemporaryDirectory() as d:
    def scan(src):
        p = os.path.join(d, "s.py")
        with open(p, "w") as f:
            f.write(src)
        return sc.check(p)
    for name, src in CLEAN.items():
        got = scan(src)
        check(not got, f"clean: {name} → {got}")
    for name, src in WARN.items():
        got = scan(src)
        check(any("environ" in f["msg"] for f in got) and all(f["level"] == "WARNING" for f in got),
              f"ask-user: {name} → {got}")

print(f"\n{'all passed' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)

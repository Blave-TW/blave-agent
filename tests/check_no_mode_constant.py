"""Templates and examples must not declare a MODE constant — the runner no longer reads it
(scheduling and order settings decide whether a strategy trades). Enumerates every file so a
new example that copies an old header goes red here.
Run: cd blave-agent && python3 tests/check_no_mode_constant.py
"""
import glob, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
files = sorted(glob.glob(os.path.join(ROOT, "strategies", "TEMPLATE_*.py")) + glob.glob(os.path.join(ROOT, "examples", "*", "*.py")))
assert len(files) >= 10, f"expected templates + examples, found {len(files)}"
bad = [(f, i) for f in files for i, line in enumerate(open(f), 1) if re.match(r"^MODE\s*=", line)]
for f, i in bad:
    print(f"MODE constant at {os.path.relpath(f, ROOT)}:{i}")
assert not bad
print(f"OK — {len(files)} files, no MODE constant")

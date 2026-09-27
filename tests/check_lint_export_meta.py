"""lib/lint_export.py 過了就在轉出檔旁寫 <file>.meta.json(spec-desktop-strategy-export-0.1.8 §6-2)。

電腦版程式碼分頁拿 source_sha256 比現在的 strategy.py,判「轉出之後策略改過」。鎖:
  ① 標準路徑 strategies/<name>/exports/<xq.xs|mc.txt|pine.pine> 過 lint → 寫 sidecar,hash = strategy.py 的 sha256;
  ② lint 沒過 → 不寫(舊的 sidecar 也不動);
  ③ 不是標準路徑(草稿檔、檔名跟 target 對不上)→ 不寫;
  ④ template 從檔頭 Template / Skeleton 那行取。

跑法:cd blave-agent && python3 tests/check_lint_export_meta.py
"""
import hashlib, json, os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib"))
import lint_export as le  # noqa: E402

fails = []


def t(name, ok):
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        fails.append(name)


ws = tempfile.mkdtemp(prefix="check-lint-meta-")
sdir = os.path.join(ws, "strategies", "btc_sma", "exports")
os.makedirs(sdir)
code = 'STRATEGY_NAME = "btc_sma"\nSYMBOL = "BTCUSDT"\n'
with open(os.path.join(ws, "strategies", "btc_sma", "strategy.py"), "w") as f:
    f.write(code)
good = le.GOOD["pine"][0].replace('//@version=6\n', '//@version=6\n// Template:  sma_cross_long\n', 1)
pine = os.path.join(sdir, "pine.pine")
with open(pine, "w") as f:
    f.write(good)

t("過 lint → exit 0", le.main(["x", "--target", "pine", pine]) == 0)
meta_path = pine + ".meta.json"
meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
t("寫了 pine.pine.meta.json,hash = strategy.py 的 sha256",
  meta.get("source_sha256") == hashlib.sha256(code.encode()).hexdigest() and meta.get("target") == "pine")
t("template 取自檔頭", meta.get("template") == "sma_cross_long")
t("exported_at 是 UTC ISO", isinstance(meta.get("exported_at"), str) and meta["exported_at"].endswith("Z"))

os.remove(meta_path)
with open(pine, "w") as f:
    f.write(le.BAD["pine"][0][0])
t("lint 沒過 → exit 1 且不寫 sidecar", le.main(["x", "--target", "pine", pine]) == 1 and not os.path.exists(meta_path))

scratch = os.path.join(ws, "draft.pine")
with open(scratch, "w") as f:
    f.write(good)
le.main(["x", "--target", "pine", scratch])
t("草稿路徑 → 不寫", not os.path.exists(scratch + ".meta.json"))
wrong = os.path.join(sdir, "other.pine")
with open(wrong, "w") as f:
    f.write(good)
le.main(["x", "--target", "pine", wrong])
t("檔名跟 target 對不上 → 不寫", not os.path.exists(wrong + ".meta.json"))

if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")

"""manager/flatten 對群益／統一「部位快取還沒跟上剛送出的單」的守門(0.1.37 稽核 s2 第三輪):
回合裡的 flatten 等回合鎖時,〔全部平倉〕那支 daemon flatten 先平完;等鎖那支接著再平一次。群益的自動開平倉
(sNewClose=2)照舊快取再平一次會變成反向開倉——所以有「最後下單時間」記號的那兩家,快取的讀取要開始於最後一筆單
ORDER_SETTLE_S 之後才讀部位;等不到就這一家不平、記一列錯誤(不知道的部位不平)。
_settle_parked 只處理「結果不明而停放」的單,daemon 那支已確認成交的平倉不在裡面,蓋不到這個縫。
跑法:python3 tests/check_flatten_settle_lag.py
"""
import os
import sys
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "manager"))
import flatten  # noqa: E402
from lib import capital_vault  # noqa: E402

red = 0


def t(name, ok, detail=None):
    global red
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or detail is None else "  " + str(detail)))
    red += 0 if ok else 1


refreshes = []
flatten._refresh_snapshot = lambda vid: refreshes.append(vid)


class Acct:
    def __init__(self, qs):
        self.qs = list(qs)
        self.reads = 0

    def get_query_started_at(self):
        self.reads += 1
        return self.qs.pop(0) if len(self.qs) > 1 else self.qs[0]


def wait(vid, acct, wait_s=0.4):
    try:
        flatten._wait_snapshot_settled(vid, acct, wait_s=wait_s, poll_s=0.02)
        return "ok"
    except flatten._SnapshotLag as e:
        return "lag:" + str(e)


now = time.time()
S = capital_vault.ORDER_SETTLE_S
real_last = capital_vault.last_order_at

capital_vault.last_order_at = lambda: 0.0
t("群益:這台沒下過單 → 直接讀,不等、不要求重讀", wait("capital", Acct([now - 999])) == "ok" and refreshes == [])

capital_vault.last_order_at = lambda: now
a = Acct([now - 5])
t0 = time.time()
r = wait("capital", a)
t("群益:快取讀取開始於最後一筆單之前(剛平過一次)→ 等滿上限還沒跟上就不平(_SnapshotLag),期間要求 worker 重讀一次",
  r.startswith("lag:") and refreshes == ["capital"] and time.time() - t0 >= 0.35, (r, refreshes))
refreshes.clear()
a = Acct([now - 5, now - 5, now + S + 1])
t("群益:等到一筆開始於最後一筆單 ORDER_SETTLE_S 之後的讀取 → 才讀部位", wait("capital", a, wait_s=5) == "ok" and a.reads == 3, a.reads)
a = Acct([now + S - 1])
t("群益:讀取開始於單後但不到 ORDER_SETTLE_S(還可能是舊未平倉量)→ 仍算沒跟上", wait("capital", a).startswith("lag:"))


def boom():
    raise capital_vault.MarkerUnreadable("x")


capital_vault.last_order_at = boom
t("群益:下單記號讀不到 → 當成沒跟上(不知道的部位不平)", wait("capital", Acct([now])).startswith("lag:"))


class BadAcct:
    def get_query_started_at(self):
        raise RuntimeError("stale snapshot")


capital_vault.last_order_at = lambda: now
t("群益:快取本身讀不到 → 當成沒跟上", wait("capital", BadAcct()).startswith("lag:"))
capital_vault.last_order_at = real_last

fake_pres = types.ModuleType("lib.order_president")
fake_pres.last_order_at = lambda productid=None: now
sys.modules["lib.order_president"] = fake_pres
t("統一:同一道(下單記號 president_last_order_at)", wait("president", Acct([now - 5])).startswith("lag:"))
fake_pres.last_order_at = lambda productid=None: 0.0
t("統一:沒下過單 → 直接讀", wait("president", Acct([now - 5])) == "ok")
del sys.modules["lib.order_president"]

calls = []


class Crypto:
    def get_query_started_at(self):
        calls.append(1)
        return 0


t("沒有下單記號的交易所(加密):不等、不讀記號", wait("binance", Crypto()) == "ok" and calls == [])
t("帳戶 lib 沒有 get_query_started_at(舊 lib):不擋", wait("capital", object()) == "ok")

src = open(os.path.join(ROOT, "manager", "flatten.py"), encoding="utf-8").read()
body = src[src.index("def _flatten():"):src.index('\nif __name__ == "__main__":')]
t("_flatten:每家先 _wait_snapshot_settled 才讀部位;沒跟上 → 記一列、這家不平、照平下一家",
  body.index("_wait_snapshot_settled(vid, acct, wait_s=") < body.index("acct.get_positions(env")
  and "except _SnapshotLag as e:" in body and body.index("except _SnapshotLag as e:") < body.index("except Exception as e:\n            logging.error(f\"[{vid}] get_positions failed"))
lag_blk = body[body.index("except _SnapshotLag as e:"):body.index("except Exception as e:\n            logging.error(f\"[{vid}] get_positions failed")]
t("…那一列講清楚為什麼沒平(避免把舊部位再平一次變成反向開倉),整輪算有錯、不清帳本", "反向開倉" in lag_blk and "errors += 1" in lag_blk and "sweep_ok = False" in lag_blk and "continue" in lag_blk)
t("…那一列帶 kind manual_close_required(P1,notifications canon)、symbols 是這家帳本的 key、reason snapshot_lag;這家帳本的 key 進 unclosed",
  '{"kind": "manual_close_required", "symbols": keys, "reason": "snapshot_lag"}' in lag_blk and 'keys = ",".join(sorted(ledger)) if ledger else ""' in lag_blk
  and "unclosed |= set(ledger)" in lag_blk)
import re  # noqa: E402
msg = re.search(r'"close-all: 部位快取[\s\S]*?close at the broker\."', lag_blk)
t("…給用戶看的字中英都有、沒有 epoch 原始數字(數字只在 log)", bool(msg) and "positions here were not closed" in msg.group(0) and not re.search(r"\d{6,}|\{e\}", msg.group(0)), msg and msg.group(0)[:80])
a0 = Acct([now - 5])
capital_vault.last_order_at = lambda: now
t0 = time.time()
t("回合裡總預算用完(wait_s=0):看一眼就放棄,不再等", wait("capital", a0, wait_s=0).startswith("lag:") and time.time() - t0 < 0.3)
capital_vault.last_order_at = real_last
print(("\n%d 紅" % red) if red else "\nALL PASS")
sys.exit(1 if red else 0)

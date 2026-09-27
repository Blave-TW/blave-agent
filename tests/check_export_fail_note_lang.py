"""轉出檔讀不到時 runtime 補的那一句,跟著這一輪的回覆語言(spec-desktop-strategy-export-0.1.8 §6-3)。

原本只有中文:英文介面的用戶叫 agent 轉 Pine、檔案讀不到,拿到的是一句中文。
鎖三件:① _export_fail_note 的解析同 _fault_message(設定 > 看用戶打的字);
② WebSink.finalize 把 sink 上那一句接到回覆尾端(不是寫死的中文);
③ 沒設語言時(舊呼叫端、api 的 check_export_marker)仍是繁中,行為不變。

跑法:cd blave-agent && python3 tests/check_export_fail_note_lang.py
"""
import os, sys, tempfile, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-export-note-ws-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []


def t(name, ok):
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        fails.append(name)


ZH, CN, EN = at._EXPORT_FAIL_NOTE, at._EXPORT_FAIL_NOTE_CN, at._EXPORT_FAIL_NOTE_EN
t("中文訊息 → 繁中", at._export_fail_note("把策略 btc_sma 轉成 TradingView Pine Script 版，存成 workspace 檔案。") == ZH)
t("英文訊息 → 英文", at._export_fail_note("Convert strategy btc_sma to TradingView Pine Script and save it as a workspace file.") == EN)
t("回覆語言設定優先:中文訊息 + en → 英文", at._export_fail_note("把策略轉出", "en") == EN)
t("cn → 簡中", at._export_fail_note("Convert it", "cn") == CN)
t("es 等其他語言 → 英文(runtime 補的句子不經模型翻譯)", at._export_fail_note("把策略轉出", "es") == EN)

bad = 'Done.\n<export target="pine" path="strategies/nope/exports/pine.pine" />'
cleaned, chunks = at.extract_exports(bad, WS, note=EN)
t("讀不到 → 不產 chunk、尾端是給的那一句", not chunks and cleaned == "Done.\n\n" + EN)
cleaned, _ = at.extract_exports(bad, WS)
t("沒給 note → 繁中(舊行為)", cleaned.endswith(ZH))


class _Sink(at.LocalSink):
    def __init__(self):
        super().__init__("desktop-test0000")
        self.sent = []

    def _send(self, chunk):
        self.sent.append(chunk)


s = _Sink()
s.export_fail_note = EN
s.on_text(bad)
out = s.finalize()
t("WebSink.finalize 用 sink.export_fail_note", out.endswith(EN) and ZH not in out)

if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")

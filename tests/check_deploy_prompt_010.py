"""0.1.10 agent 行為三件:部署相關的逐輪注入講真話、跟表面對得上、建議不跟結論打架。

  #8  模擬下單已暫停,agent 還說三支「正在跑」:_deploy_state_line 把 deployments.json(名冊,金額 0 與暫停都還在)
      寫成「已部署運行中」。鎖:名冊與下單狀態分開講;HALT / 重開停止 / 對帳器沒心跳時,那一行沒有「正在跑 / 運行中 / 執行中」。
  #7b 電腦版點「帶我看怎麼…上模擬盤」拿到網頁的步驟:_portfolio_steps_block 依表面只注入那一套;舊檔(沒有子段)照舊整段。
      電腦版外殼不處理 ui_nav:LocalSink 的格式規則不要 <nav> 標記、不承諾自動開頁;網頁不變。
  #7a 回覆說「不建議用、訊號要先站得住」,建議列卻是「加一個趨勢濾網」:規則的 MCPT 那條自己開了加濾網。
      鎖:MCPT 沒過只提換訊號、結論不建議用時不提部署,且有「建議不能跟正文打架」那條。

跑法:cd blave-agent && python3 tests/check_deploy_prompt_010.py
"""
import json, os, shutil, sys, tempfile, time, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
WS = tempfile.mkdtemp(prefix="check-deploy-prompt-ws-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(WS, "session.db"))
sys.modules["claude_agent_sdk"] = types.ModuleType("claude_agent_sdk")
import agent_turn as at  # noqa: E402

fails = []
RUNNING_WORDS = ("正在跑", "運行中", "執行中", "正在下單")


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"))
    if not ok:
        fails.append(name)


def write(rel, obj):
    p = os.path.join(WS, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(obj if isinstance(obj, str) else json.dumps(obj))
    return p


def fresh(amounts, registry=None):
    shutil.rmtree(WS)
    os.makedirs(WS)
    for n in list(amounts) + ["eth_ti_1h", "undeployed_one"]:
        write(f"strategies/{n}/strategy.py", "# Strategy: x\n")
    write("manager/portfolio_config.json", {"amounts": amounts})
    write("state/deployments.json", registry if registry is not None else
          {**{n: {"type": "wait_for_bar"} for n in amounts}, "reconciler": {"type": "daemon"}})
    write("state/paper_ledger.json", {})


def beat(age_s):
    p = write("state/heartbeat/reconciler", "")
    ts = time.time() - age_s
    os.utime(p, (ts, ts))


FUNDED = {"btc_sma_test": 1000, "supertrend_sol": 500, "eth_ti_1h": 0}

# ── #8 列舉每一種下單狀態 ──────────────────────────────────────────────
cases = [
    # name, setup, 應該出現的狀態字, 能不能說在跑
    ("HALT(用戶按暫停下單)", lambda: (beat(5), write("state/HALT", {"ts": 1, "reason": "user", "source": "web"})),
     "已暫停", False),
    ("HALT 內容壞掉也算暫停", lambda: (beat(5), write("state/HALT", "not json")), "已暫停", False),
    # holds_all(帳戶待確認):對帳器每輪跳過,平倉與出場也不送——句子不能保證「平倉照常」
    ("HALT + 帳戶待確認(holds_all)", lambda: (beat(5), write("state/HALT", {}),
                                          write("state/venue_account.json", {"pending": {"venue": "binance"}})), "已暫停", False),
    ("重開停止", lambda: (beat(5), write("state/reconciler_stopped.json", {"reason": "machine_restart"})), "已停止", False),
    ("HALT + 重開停止:講停止(更嚴的那個)", lambda: (beat(5), write("state/HALT", {}),
                                               write("state/reconciler_stopped.json", {})), "已停止", False),
    ("沒暫停、對帳器心跳新鮮", lambda: beat(5), "執行中", True),
    ("沒暫停、對帳器心跳過期", lambda: beat(3600), "對帳下單程式沒在跑", False),
    ("沒暫停、從來沒有心跳(電腦版沒按過啟動下單)", lambda: None, "對帳下單程式沒在跑", False),
]
for name, setup, want, may_run in cases:
    fresh(FUNDED)
    setup()
    line = at._deploy_state_line(WS)
    t(f"#8 {name}:下單狀態={want}", f"下單狀態:{want}" in line, line)
    t(f"#8 {name}:名冊照列(有金額兩支、金額 0 一支)",
      "下單設定裡有金額:btc_sma_test、supertrend_sol" in line and "金額 0(不下單):eth_ti_1h" in line, line)
    if not may_run:
        body = line.split("):", 1)[-1]   # 開頭那句規則本身會引用「執行中」三個字,只看事實部分
        t(f"#8 {name}:事實部分沒有「在跑」的字眼", not [w for w in RUNNING_WORDS if w in body], body)
        # 跟錢有關的保證只要有例外就不講:HALT 不保證平倉/停損照常,重開停止不保證「任何單都不送」(close_all 例外、舊對帳器)
        t(f"#8 {name}:不對平倉、停損或「任何單都不送」做保證",
          "照常" not in body and "平倉" not in body and "停損" not in body and "任何單" not in body, body)

fresh({"a": 0})
beat(5)
line = at._deploy_state_line(WS)
t("#8 名冊裡全是金額 0:不會下單,也不說執行中", "下單狀態:沒有策略設金額" in line and "執行中" not in line.split("):", 1)[-1], line)

fresh(FUNDED)
beat(5)
write("state/downtime_pause.json", {"strategies": {"supertrend_sol": {"status": "pending"}}})
write("state/HALT_btc_sma_test", {})
write("state/HALT_eth_ti_1h", {})
line = at._deploy_state_line(WS)
t("#8 單支暫停:停機凍住的照列;HALT_<name> 只列不照金額下單的(對帳器不讀它,有金額的照樣下單)",
  "單支暫停:eth_ti_1h、supertrend_sol" in line and "btc_sma_test、" not in line.split("單支暫停:", 1)[1], line)

fresh(FUNDED)
beat(5)
write("manager/amounts.ui.json", {"amounts": {"btc_sma_test": 0}, "exchanges": {}})
line = at._deploy_state_line(WS)
t("#8 金額照 UI 鏡像(amounts.ui.json 優先,同 lib/portfolio)",
  "下單設定裡有金額:無" in line and "下單狀態:沒有策略設金額" in line, line)

fresh({"a1": 100}, registry={"a1": {"type": "wait_for_bar"}, "typeb_cron": {"type": "cron"}, "reconciler": {}})
write("strategies/typeb_cron/strategy.py", "# Strategy: b\n")
beat(5)
line = at._deploy_state_line(WS)
t("#8 名冊裡不在金額表的(雲端 Type B 排程)另列,不算未部署",
  "其他排程:typeb_cron" in line and "未部署:eth_ti_1h、undeployed_one;" in line, line)

fresh({}, registry={"capital_worker": {"type": "daemon"}, "xrp_v2_monitor": {"type": "daemon"}, "reconciler": {}})
line = at._deploy_state_line(WS)
t("#8 非策略的常駐程式(capital_worker、監控 daemon)不算「其他排程」,也不說它們照排程跑",
  "其他排程" not in line and "照自己的排程跑" not in line and "capital_worker" not in line, line)

fresh(FUNDED)
beat(5)
write("manager/portfolio_config.json", "{broken")
line = at._deploy_state_line(WS)
t("#8 portfolio_config.json 壞掉:講「讀不到」,不講成沒設金額",
  "讀不到" in line and "有金額:無" not in line and "沒有策略設金額" not in line and "執行中" not in line.split("):", 1)[-1], line)
t("#8 portfolio_config.json 壞掉:_trading_names 照舊回空集合(不丟例外)", at._trading_names(WS) == set())

fresh({}, registry={"typeb_cron": {"type": "cron"}})
line = at._deploy_state_line(WS)
t("#8 只有 Type B 排程、沒有金額:不說「不會下單」,講它照自己的排程跑",
  "不會下單" not in line.replace("不會照金額下單", "") and "照自己的排程跑" in line and "執行中" not in line.split("):", 1)[-1], line)
write("state/HALT", {})
line = at._deploy_state_line(WS)
t("#8 只有 Type B 排程 + HALT:已暫停(HALT 也擋 Type B 的新倉)", "下單狀態:已暫停" in line and "照自己的排程跑" not in line, line)

_real = at._trading_amounts
at._trading_amounts = lambda ws: (_ for _ in ()).throw(RuntimeError("boom"))
try:
    t("#8 讀的途中出任何例外:回空字串,回合照跑(fail-silent)", at._deploy_state_line(WS) == "")
finally:
    at._trading_amounts = _real
fresh({"a1": 100, "z": 0})
t("#8 _trading_names 行為不變(下單設定的 key,金額 0 也算)", at._trading_names(WS) == {"a1", "z"}, at._trading_names(WS))

# ── #7b 步驟依表面注入 ───────────────────────────────────────────────
real = os.path.join(ROOT, "references", "portfolio-steps.md")
os.makedirs(os.path.join(WS, "references"), exist_ok=True)
shutil.copy(real, os.path.join(WS, "references", "portfolio-steps.md"))
web, desk = at._portfolio_steps_block(WS), at._portfolio_steps_block(WS, desktop=True)
t("#7b 網頁:只有網頁那套(手機那句在、電腦版的確認框與切換器不在)",
  "### Web workspace" in web and "點下方『工作區』分頁" in web and "### Desktop app" not in web and "再按一次「儲存」" not in web)
t("#7b 電腦版:只有電腦版那套(確認框、切換器、先解除綁定;沒有手機那句)",
  "### Desktop app" in desk and "### Web workspace" not in desk and "點下方『工作區』分頁" not in desk
  and "確認框再按一次「儲存」" in desk and "「這台電腦」" in desk and "「解除綁定」" in desk, desk)
for label, block in (("網頁", web), ("電腦版", desk)):
    t(f"#7b {label}:段首共用那句(單筆下單不編步驟)兩邊都帶到",
      "has none" in block and "never make up steps or a page name" in block)
doc = open(real, encoding="utf-8").read()
sec = doc[doc.index("## Step scripts"):]
t("#7b 整段 ≤ _STEPS_MAX_CHARS:舊 runtime 整段注入時電腦版那半不會被截掉", len(sec) <= at._STEPS_MAX_CHARS, len(sec))
# 電腦版的 UI 標籤一字不差:都要在 shell 的 zh.po 裡
po = open(os.path.join(ROOT, "shell", "i18n", "zh.po"), encoding="utf-8").read()
import re  # noqa: E402
desk_sec = sec[sec.index("### Desktop app"):]
labels = set(re.findall(r"「([^」「]+)」", desk_sec))
missing = sorted(l for l in labels if f'msgstr "{l}"' not in po)
t("#7b 電腦版步驟裡每個「」標籤都是外殼 zh.po 的原文", not missing, missing)
old_doc = doc.replace("### Web workspace\n", "").replace("### Desktop app\n", "#### desktop\n")
with open(os.path.join(WS, "references", "portfolio-steps.md"), "w", encoding="utf-8") as f:
    f.write(old_doc)
t("#7b 舊檔(沒有子段):整段照舊回,不回空", "點「連接交易所」" in at._portfolio_steps_block(WS, desktop=True))

src = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
t("#7b build_prompt 兩個呼叫點都帶 desktop=_desktop_surface(sink)", src.count("desktop=_desktop_surface(sink))") == 2)

# build_prompt 真的把表面帶進步驟注入(步驟檔放好、用導航句)
fresh({})
os.makedirs(os.path.join(WS, "references"), exist_ok=True)
shutil.copy(real, os.path.join(WS, "references", "portfolio-steps.md"))
nav_msg = "帶我看怎麼把 BTC 均線交叉上模擬盤"
pd = at.build_prompt(None, None, nav_msg, suggest_directive=True, desktop=True)
pw = at.build_prompt(None, None, nav_msg, suggest_directive=True)
t("#7b build_prompt 電腦版:注入電腦版那套,講明是 app 左側的自動下單頁",
  "確認框再按一次「儲存」" in pd and "電腦版 app 左側的自動下單頁" in pd and "點下方『工作區』分頁" not in pd)
t("#7b build_prompt 網頁:注入網頁那套,講明是網頁工作頁",
  "點下方『工作區』分頁" in pw and "網頁工作頁的自動下單頁" in pw and "確認框再按一次「儲存」" not in pw and "電腦版 app" not in pw)

# 表面只看表面:電腦版起的排程報告回合(ReportSink + BLAVE_AGENT_LOCAL=1)也是電腦版
rs = at.ReportSink.__new__(at.ReportSink)
ls = at.LocalSink("desktop-test0000")
os.environ.pop("BLAVE_AGENT_LOCAL", None)
t("#7b 雲端機的排程報告回合:網頁那套", not at._desktop_surface(rs) and at._formatting_rule_for(rs) is at.WEB_FORMATTING_RULE)
os.environ["BLAVE_AGENT_LOCAL"] = "1"
t("#7b 電腦版的排程報告回合(BLAVE_AGENT_LOCAL=1):電腦版那套",
  at._desktop_surface(rs) and at._formatting_rule_for(rs) is at.LOCAL_FORMATTING_RULE)
os.environ.pop("BLAVE_AGENT_LOCAL", None)
t("#7b 電腦版聊天(LocalSink)不靠環境變數也是電腦版", at._desktop_surface(ls) and at._formatting_rule_for(ls) is at.LOCAL_FORMATTING_RULE)

L, Wr = at._formatting_rule_for(ls), at.WebSink.formatting_rule
t("#7b 網頁的格式規則不變:導航標記與「系統會替用戶把自動下單頁開到對的位置」都在", Wr is at.WEB_FORMATTING_RULE and at._NAV_RULE in Wr)
t("#7b 電腦版的格式規則:不承諾自動開頁、不要 <nav> 標記,改成直接給電腦版步驟",
  "系統會替用戶" not in L and "<nav>" not in L and "不要說已經幫他開好" in L and "電腦版那套" in L)
t("#7b 電腦版的建議規則照樣在 system prompt 最尾端", L.endswith(at._SUGGEST_RULE) and L.replace(at._NAV_RULE_LOCAL, at._NAV_RULE) == Wr)
fresh({})
msg = nav_msg
t("#7b 導航句的逐輪錨:網頁有 <nav>,電腦版沒有",
  "<nav>目標</nav>" in at.build_prompt(None, None, msg, suggest_directive=True)
  and "<nav>" not in at.build_prompt(None, None, msg, suggest_directive=True, desktop=True))

# ── P1-1 雲端視角:這一行讀的是這台電腦,不注入 ─────────────────────
fresh(FUNDED)
beat(5)
pl = at.build_prompt(None, None, "我的策略還在跑嗎", suggest_directive=True, desktop=True)
pc = at.build_prompt(None, None, "我的策略還在跑嗎", suggest_directive=True, desktop=True, viewing_env="cloud")
t("#8 電腦版本機視角:有部署現況那一行", "[部署現況" in pl and "下單狀態:" in pl)
t("#8 電腦版雲端視角:不注入本機的部署現況(不然本機狀態會被當成雲端的)", "[部署現況" not in pc and "下單狀態:" not in pc)

# ── #7a 建議規則 ─────────────────────────────────────────────────────
rule = at._SUGGEST_RULE
mcpt = next(l for l in rule.splitlines() if "MCPT p-value > 0.05（Type A" in l)
t("#7a MCPT 沒過:只提換訊號,不開加濾網", "建議換訊號" in mcpt and "不要建議加濾網" in mcpt and "建議加濾網或換訊號" not in rule, mcpt)
t("#7a 里程碑:建議跟結論同方向,不建議用 → 不提部署、不在同一個訊號上加東西",
  "建議要跟你這則的結論同方向" in rule and "結論是不建議用、還不能用 → 不提部署" in rule
  and "不提在同一個訊號上加東西" in rule and "已有可用回測" not in rule)
t("#7a 有「建議不能跟正文的結論打架」那條,而且在最後一段之前(最後一段仍是沒有建議就結束)",
  "建議不能跟正文的結論打架" in rule and "沒有要提議時" in rule.strip().splitlines()[-1])
fresh({})
p = at.build_prompt(None, None, "這支值得用嗎", suggest_directive=True)
t("#7a 逐輪錨也帶「跟本則結論同方向」", "建議跟本則結論同方向" in p)

shutil.rmtree(WS, ignore_errors=True)
if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")

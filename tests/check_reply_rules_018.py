"""0.1.8 e2e 找到的「agent 講了不該講 / 講錯地方 / 停下來問」:規則寫在 agent 讀的文件裡,這裡鎖住那幾句還在。

  #44 cloud-handoff 收尾(step 8)是內部步驟,不對用戶報告;
  #57 工具警告、lint 輸出、自己的收尾不進回覆,除非影響用戶要的結果(那就講後果);
  #29 掃描結果在「參數掃描」分頁,不是回測分頁;
  #32 策略庫安裝遇到品質掃描的警告(exit 1)照原樣跑回測,不停下來問;安全掃描的警告照舊要問;
  #36 下載的暫存檔用 mv、流程結束 tmp/ 不留。
  #66 回覆只提真的存在的檔案 / 產出物;
  #70 單筆手動下單不是 Blave 做的事:一句話講完,不編步驟、不編頁面名稱;
  #67 #68 Type B 的檔頭帶 `# Type:     B`(電腦版靠它認沒有回測、沒有東西可轉出的策略)。
  #99 上線中策略另建的新策略不用 v2 / v3 命名(跟「同一支的第 2 版」撞詞),用描述差異的名字。
  #102 範本報告照 describe() 寫,不先讀 91KB 的 reports.md / lib 原始碼;browser_wait 不連等;同一個連結不放兩則新聞。
  #90 tmp/ 自己寫的一次性腳本回覆前刪掉,不拿 tmp/ 裡的舊腳本當範例。
  第五批:#133 台股免費路徑先估時間先講;改參數時 DESCRIPTION 與檔頭一起改;內建瀏覽器關著不上網;資料費 2 TWD。

跑法:cd blave-agent && python3 tests/check_reply_rules_018.py
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
read = lambda *p: open(os.path.join(ROOT, *p), encoding="utf-8").read()
fails = []


def t(name, ok):
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        fails.append(name)


def section(doc, head):
    """`head` 那個標題到下一個同級標題之間的內容。"""
    m = re.search(rf"^{re.escape(head)}.*?$(.*?)(?=^## |\Z)", doc, re.M | re.S)
    return m.group(1) if m else ""


agents = read("AGENTS.md")
handoff = section(read("references", "cloud-handoff.md"), "## 8. Clean up")
t("#44 cloud-handoff step 8:清理不進回覆", "Cleanup is an internal step" in handoff and "reply never mentions it" in handoff)

style = section(agents, "## Response Style")
t("#57 AGENTS › Response Style:警告與收尾不進回覆,影響結果才講後果",
  "stay out of the reply" in style and "unless one changes the result the user asked for" in style
  and "never the warning itself" in style)

lib = read("references", "lib.md")
scan = lib[lib.index("**Parameter scan workflow**"):lib.index("The web workspace sends three fixed prompts")]
t("#29 lib.md 掃描流程:指路指「參數掃描」分頁、不指回測分頁",
  "「參數掃描」 tab" in scan and "never send them to the 回測分頁" in scan)
t("#29 AGENTS › Charts:資料夾圖檔出現在回測分頁只限雲端 web,掃描結果在參數掃描分頁",
  "the desktop backtest tab shows none" in agents and "heatmap and grid are in the 參數掃描 tab" in agents)

mk = read("references", "marketplace.md")
quality = [l for l in mk.splitlines() if "quality_check.py" in l or l.lstrip().startswith("- Exit 1")]
install = mk[mk.index("7. **Quality scan**"):mk.index("8. **Run it")]
t("#32 安裝流程的品質掃描 exit 1:照原樣跑、不問、不改下載的碼、回覆提一句",
  "run it as it is" in install and "never stop to ask" in install and "never edit the downloaded code" in install
  and "ask for confirmation" not in install)
asks = [l for l in quality if "quality_check.py" in l and re.search(r"exit 1: confirm", l)]
t("#32 bundle / shared 兩條流程的品質掃描 exit 1 也不再問", not asks and mk.count("exit 1: run it as it is") == 2)
security = mk[mk.index("6. **Security scan**"):mk.index("7. **Quality scan**")]
t("#32 安全掃描的警告照舊要問(不放寬)", "Exit 1 (warnings) → show findings to user, ask for confirmation" in security)
t("#36 下載檔用 mv 不用 cp;流程結束 tmp/ 不留下載檔",
  "`mv`, never `cp`" in security and "Leave nothing of the download in `tmp/`" in mk)

t("#66 AGENTS › Response Style:只提存在的檔案,觸發才寫的 log 不算已建立",
  "Name only files and outputs that exist" in style and "has not been created yet" in style)
redline = [l for l in agents.splitlines() if l.startswith("**Deployment redline")]
steps = read("references", "portfolio-steps.md")
t("#70 單筆手動下單:AGENTS 的部署紅線與 portfolio-steps 都寫一句話講完、不編步驟",
  len(redline) == 1 and "A single order placed by hand" in redline[0] and "never describe steps or a screen for it" in redline[0]
  and "has none" in section(steps, "## Step scripts") and "never make up steps or a page name" in section(steps, "## Step scripts"))
type_b = [l for l in agents.splitlines() if l.startswith("**Type B:**")]
t("#67 #68 Type B 的檔頭", len(type_b) == 1 and "`# Type:     B (…)` as its second line" in type_b[0])

live = section(read("references", "strategy-code.md"), "## Editing a live strategy")
t("#99 另建的策略:不用版本字命名、用差異命名,例子在;從版本分岔的 {name}_v{n} 是唯一例外",
  "never with a version word" in live and "`_v2`" in live and "`supertrend_sol_atr5`" in live
  and "`{name}_v{n}` says which version the code came from" in live)

tpl = [l for l in agents.splitlines() if l.startswith("- **A request that names a template")]
t("#102 範本報告:describe() 夠寫,不先開 reports.md / lib 原始碼",
  len(tpl) == 1 and "do not open `references/reports.md` or lib source first" in tpl[0])
br = read("references", "browser.md")
t("#102 browser_wait:still_waiting 之後先讀已經好的分頁,最多再等一次", "wait once more at most" in br and "still_waiting -> call again" not in br)
t("#102 發佈檢查表:同一個連結只能出現在一則", "同一個連結只能出現在一則" in read("lib", "report_templates.py"))
t("#90 tmp/ 的一次性腳本:回覆前刪掉、不抄 tmp/ 裡的舊腳本",
  "delete yours before you reply" in section(agents, "## Shell Commands") and "never copy from a script already in `tmp/`" in section(agents, "## Shell Commands"))

# 第五批
t("#133 台股免費路徑的估時:AGENTS.md 是一句獨立的指示(先估、先講、超過 25 分鐘先提短期間),範例策略的檔頭也寫了(agent 抄的就是範例)",
  "**Before a Taiwan backtest on the desktop, work out the wait and say it first:**" in agents and "stocks × years × 36 s" in agents
  and all("# Data wait:" in read("examples", n, "strategy.py").split("import sys")[0] and "tell the user before running" in read("examples", n, "strategy.py")
          for n in ("twstock_momentum", "tw100_foreign_zscore")))
t("I 改參數時,DESCRIPTION 與檔頭裡寫到的同一個數字一起改(策略頁的副標是 DESCRIPTION)",
  "Changing a parameter also changes every place the file states that number: `DESCRIPTION` and the header comment" in agents
  and "**Keep the words true to the code.**" in read("references", "strategy-code.md"))
t("C 內建瀏覽器關著 = 不上網:AGENTS.md 不再叫 agent 退回引擎自己的搜尋", "else the engine's own web search" not in agents and "browser switched off = no web" in agents)
t("B 資料費時價 2 TWD(不是 3);月價不拿它乘 720", "**2 TWD per UTC clock hour" in read("references", "billing.md") and "Never multiply the 2 TWD data fee" in read("references", "billing.md")
  and not re.search(r"(?<!\()3 TWD(?! at the time)", read("references", "billing.md")))

dep = read("references", "deployment.md")
t("L 只做被要求的那一件:確認的問題要列出會裝的每一樣(含健康檢查);發現缺什麼只講不做;從電腦版操作雲端主機也要先確認",
  "**The question names everything the deployment puts on the machine**" in dep and "**Do the one thing that was asked.**" in dep
  and "**Every route onto the machine asks the same question.**" in dep and "as part of what the user confirmed" in dep)
t("N 收尾不進回覆:不當開頭也不當結尾,連線關閉、刪暫存都算;runtime 每輪的規則也講了", "not as its first line, not as its last" in style and "closing a connection" in style
  and "never mention that folder, the connection or the cleanup in the reply" in read("runtime", "agent_turn.py"))
t("O 回覆用用戶的話:檔名、旗標、結束碼、環境變數、cron 語法、內部狀態名不進回覆", "**Say it in the user's words, not the machine's:**" in style and "cron syntax" in style and "「每小時整點跑一次」「已暫停」「還沒設定金額」" in style)

if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")

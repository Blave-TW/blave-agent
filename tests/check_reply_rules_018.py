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
  第七批:#143 #167 回覆裡的時間換成用戶的時區並標明;#148 被要求上線時先講最近一次回測對比基準的結果。
  第七批:開了就讀(實測開 6 頁只讀 3 頁,中時與鉅亨三頁開了沒讀);新聞與數字先讀媒體或官方原文,論壇貼文 / 轉述 / 聚合頁要標明。

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
# 0.1.8 開發版:規則 N 上線後回覆仍以「cloud-handoff 資料夾已刪除、連線已關閉。」開頭。規則不引用要禁的成品句(模型會照抄),改講回覆第一句該是什麼
t("N 規則不引用要禁的句子,改講正面的:回覆第一句講用戶要的事(AGENTS.md、runtime 每輪規則)", "清理完成" not in style and "連線已關閉" not in style
  and "the first sentence is about what the user asked for" in style
  and "what the user asked for.\\n" in read("runtime", "agent_turn.py"))
t("被 runtime 拒絕的動作不換寫法重試;雲端主機的排程另有規則(AGENTS.md › Desktop app)", "**What the runtime refused stays refused:**" in read("AGENTS.md")
  and "never reword the command, wrap it in a script or switch tools" in read("AGENTS.md") and "*A schedule on the cloud machine*" in read("AGENTS.md"))
t("從電腦版操作雲端主機:只裝被要求的那一條,不順帶裝健康檢查", "never the health check beside it" in dep and "「做好就排程上線」" in dep)
t("O 回覆用用戶的話:檔名、旗標、結束碼、環境變數、cron 語法、內部狀態名不進回覆", "**Say it in the user's words, not the machine's:**" in style and "cron syntax" in style and "「每小時整點跑一次」「已暫停」「還沒設定金額」" in style)

# 第七批
flow = section(br, "## Standard flow")
news = section(read("references", "reports.md"), "### News")
tools_js = read("shell", "browser", "tools.js")
open_many = [l for l in tools_js.splitlines() if 'name: "browser_open_many"' in l]
desc = "\n".join(read("lib", "report_templates.py").split("def describe", 1)[-1].split("def load_pack")[0].splitlines())
t("開了就讀:browser.md 標準流程、reports.md 新聞段、describe() 的清單、browser_open_many 的工具說明四處都寫了(做報告一定會讀到後兩處)",
  "**Open only the pages you are going to read, and read every page you opened.**" in flow and "`browser_close` it" in flow
  and "**Open what you will read, read what you opened**" in news
  and "browser_open_many 只開打算讀的頁,開了的每一頁都要讀,不讀的不要開" in desc
  and len(open_many) == 1 and "Open only pages you are going to read, and read every page you opened" in open_many[0])
t("來源優先序:先讀媒體或官方原文;論壇貼文、轉述、聚合頁只在找不到原文時用,報告裡標明是轉述(新聞來源名加「（轉述）」、註腳寫「轉述自」)",
  "**News and numbers: the original first.**" in flow and "only when the original cannot be found or opened" in flow
  and "**The original first; second-hand is marked**" in news and "`（轉述）`" in news and "`轉述自 <who>`" in news and "「據…轉述」" in news
  and "論壇貼文、轉述、聚合頁只在找不到原文時用,來源名後面加「（轉述）」" in desc
  and "Prefer the original article or the official page to a forum post, a repost or an aggregator" in open_many[0])

# 第七批 #5B:研究 / 自訂報告開工前不翻文件(實測 09-28:前 3 分多鐘、15 次在讀 reports.md 各段與 lib 原始碼)
import contextlib, inspect, io
sys.path.insert(0, ROOT)
from lib import report_templates as RT, report_bricks as RB
with contextlib.redirect_stdout(io.StringIO()) as _out:
    qs = RT.quickstart()
sig = lambda f, drop=(): "(" + ", ".join(str(p) for n, p in inspect.signature(f).parameters.items() if n not in drop) + ")"
t("#5B quickstart():順序寫死(先搜尋、同時可以抓 Blave 資料 → 組資料包 → 寫判讀),配方形狀、每一塊積木與參數、research_pack / build / publish 的簽名都印出來,而且取自程式(不會落後)",
  qs == _out.getvalue().rstrip("\n") and "ORDER (fixed)" in qs and qs.index("1. Search the web") < qs.index("2. Build the data pack once") < qs.index("3. print(pack.describe())") < qs.index("4. publish")
  and "Blave data may be fetched in the same step" in qs
  and all(f"  {name}{sig(fn, ('b',))} : " in qs for name, fn in RB.BRICKS.items()) and len(RB.BRICKS) >= 20
  and all(f"{f.__name__}{sig(f)}" in qs for f in (RT.research_pack, RT.build, RT.publish)) and ", ".join(RT.RESEARCH_TOPICS) in qs and '"bricks": [["price_chart"' in qs)
t("#5B quickstart() 夠短(一個畫面讀得完:60 行、6,000 字以內),講明不先讀 reports.md / lib 原始碼、不 grep 簽名;沒有積木的數字去哪裡找",
  len(qs.splitlines()) <= 60 and len(qs) <= 6000 and "Not first: references/reports.md, lib source, a grep for a signature" in qs and "Look once in references/lib.md" in qs and "not in lib source" in qs)
rep = read("references", "reports.md")
top = rep.split("\n## ")[0]
custom = [l for l in agents.splitlines() if l.startswith("- **A request that names a template")]
t("#5B 規則:AGENTS › Reports 的自訂報告那一句改成從 quickstart() 開始(不再只指到 §1b › Custom recipes);reports.md 第一段與 Custom recipes 一節都寫「不要先讀這份」",
  len(custom) == 1 and "start from `python3 -c \"from lib.report_templates import quickstart; quickstart()\"`" in custom[0] and "a research report on a topic rather than one instrument included" in custom[0]
  and "never grep source for a signature" in custom[0] and "(§1b › Custom recipes), never hand-fetched numbers" not in custom[0]
  and "**Building a report in chat? Do not read this file first.**" in top and top.index("Do not read this file first") < 400 and "search the web" in top and "Never grep lib source for a signature" in top
  and "**Start from `quickstart()`, not from this file.**" in section(rep, "### Custom recipes"))

t("#143 #167 時間:回覆、表格、報告裡的時間一律換成用戶的時區並標明;不寫其實是 UTC 的「今天 21:34」,不出「時間(UTC)」欄(AGENTS › Response Style,一句)",
  len([l for l in style.splitlines() if l.startswith("- **Clock times are the user's, and say whose:**")]) == 1 and "converted to the user's timezone" in style and "named once" in style
  and "never a bare 「今天 21:34」 that is really UTC" in style and "no 「時間(UTC)」 column unless the user asked for UTC" in style)
live_rule = [l for l in agents.splitlines() if l.startswith("**Asked to put a strategy live, say first how its latest backtest did against its benchmark**")]
t("#148 被要求上線:先講這支最近一次回測對比基準的結果,尤其輸給持有或沒過顯著性;決定權在用戶(AGENTS › Strategy Deployment,一句)",
  len(live_rule) == 1 and "trailed buy-and-hold or did not pass significance" in live_rule[0] and "The decision stays the user's" in live_rule[0]
  and agents.index(live_rule[0]) > agents.index("## Strategy Deployment") and agents.index(live_rule[0]) < agents.index("## Examples"))

if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")

"""0.1.8 e2e 找到的「agent 講了不該講 / 講錯地方 / 停下來問」:規則寫在 agent 讀的文件裡,這裡鎖住那幾句還在。

  #44 cloud-handoff 收尾(step 8)是內部步驟,不對用戶報告;
  #57 工具警告、lint 輸出、自己的收尾不進回覆,除非影響用戶要的結果(那就講後果);
  #29 掃描結果在「參數掃描」分頁,不是回測分頁;
  #32 策略庫安裝遇到品質掃描的警告(exit 1)照原樣跑回測,不停下來問;安全掃描的警告照舊要問;
  #36 下載的暫存檔用 mv、流程結束 tmp/ 不留。
  #66 回覆只提真的存在的檔案 / 產出物;
  #70 單筆手動下單不是 Blave 做的事:一句話講完,不編步驟、不編頁面名稱;
  #67 #68 Type B 的檔頭帶 `# Type:     B`(電腦版靠它認沒有回測、沒有東西可轉出的策略)。

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

if fails:
    sys.exit(f"{len(fails)} failed")
print("all passed")

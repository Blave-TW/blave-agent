"""capital-broker.md Step 0 on the desktop app splits two cases (Wei, 0.1.16 audit P1-1):
connecting Capital on this computer goes to the app's own connect flow on a Windows PC (runtime/
capital_local.py, listed from app 0.1.50 — the agent does none of it; an older build is told to update)
and is refused on a Mac; a cloud-view
handoff from the desktop's Capital setup box (shell/renderer/capital.js capHandoff, viewing env=cloud)
is sent to the blave.org cloud workspace instead — never told to launch a machine it already has.
Both stop before asking scope. AGENTS.md's Capital routing line points at the same split.

Run: cd blave-agent && .venv/bin/python tests/check_capital_step0.py
"""
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOC = open(os.path.join(ROOT, "references/capital-broker.md"), encoding="utf-8").read()
AGENTS = open(os.path.join(ROOT, "AGENTS.md"), encoding="utf-8").read()
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += not cond


s0 = DOC[DOC.index("## Step 0"):DOC.index("**Then ask the user:**")]
desk = s0[s0.index("- **Desktop app**"):s0.index("- **Linux cloud machine**")]
local_i, cloud_i = desk.find("**Connecting Capital on this computer**"), desk.find("from the cloud view**")
check(local_i > 0 and cloud_i > local_i, "desktop branch has both cases: this computer, then the cloud view")
local, cloud = desk[local_i:cloud_i], desk[cloud_i:]
check("Either way stop here" in desk and "touch neither" in desk, "both cases stop before scope and touch no machine")
win_i, mac_i = local.find("**Windows PC**"), local.find("**Mac**")
check(0 < win_i < mac_i, "this-computer case splits Windows PC, then Mac")
win, mac = local[win_i:mac_i], local[mac_i:]
check("自動下單 › 連接帳戶，選群益，照畫面開通" in win and "Auto trading › Connect Account in the app, pick Capital" in win
      and "The app connects it, not you" in win and "never ask for the ID or the\n  trading password" in desk,
      "Windows PC: the app's connect flow (zh + en); the agent asks for no credentials")
check("先把電腦版更新到最新版" in win and "update the desktop app to the latest version" in win and "0.1.50" in win
      and "這一版還沒開放" not in win and "雲端主機" not in win,
      "Windows PC: a build without it is told to update, not sent to a cloud machine (zh + en)")
check("no switching to the Administrator\n      account" in win and "one Windows permission\n      prompt" in win and "no\n      Administrator" not in win,
      "Windows PC: no Administrator account switch, but a missing VC++ 2010 runtime brings one UAC prompt")
check("Mac 不能連群益" in mac and "在網頁開雲端主機時選 Windows" in mac and "choose Windows" in mac,
      "Mac: refused, a Windows PC or a Windows cloud machine instead (zh + en)")
check("blave.org 的雲端工作頁" in cloud and "cloud workspace on\n    blave.org" in cloud and "開雲端主機時選 Windows" not in cloud
      and "Do not tell them to launch a Windows" in cloud,
      "cloud-view case: go to the blave.org cloud workspace (zh + en), never 'launch a Windows machine'")
check("Capital setup box" in cloud and "雲端主機 view" in cloud, "cloud-view case names how it is recognized")
line = next((l for l in AGENTS.split("\n") if "**Capital Futures (群益期貨):**" in l), "")
check("Windows desktop app (0.1.50+) the app's own connect flow does it, not you" in line and "older app build: update it first" in line
      and "not on a Mac" in line and "cloud view" in line
      and "blave.org cloud workspace" in line,
      "AGENTS.md Capital line routes both cases to Step 0")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)

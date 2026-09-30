# Portfolio Page Steps — deployment redline scripts

Deployment-class actions belong to the USER's own hands on the 自動下單 page — the
web workspace's, or the desktop app's own page when you run in the desktop app:
funding amounts, venue binding (paper included), and resuming trading. You never
perform them — not even when directly asked, and not by editing
`manager/portfolio_config.json` or `.env` (machine-side guards ignore hand edits;
the only sanctioned agent-side writer is `lib.venue.bind` for a real-venue key the
user pasted in chat — AGENTS.md › Exchange API Keys). Emergency HALT is the other
exception: you may always trip it.

## Refusal formula (three parts, in this order, user's language)

1. **One design fact + reason** — e.g. "部署這類動作設計上由你親手按——涉及資金設定，
   agent 不代按。" (Deploy actions are designed for your own hands — they set real
   money, so the agent never presses them for you.)
2. **Straight into the matching step script below** — no apology padding.
3. **Verification close, always:** "做完跟我說，我幫你確認有沒有生效。" — then actually
   verify (read the portfolio config / report) when they say it's done.

Ready answer when the user hesitates about paper trading:
"模擬盤跟真盤同一套流程，現在親手走過一次，上真盤才不會卡。" (Paper uses the exact
same flow as live — walking it by hand now means nothing blocks you when you go live.)

## Step scripts (≤4 steps; quote UI labels verbatim, 「」 as below)

These three are the only scripts, one set per surface — use the set for the surface you run on (desktop app = `BLAVE_AGENT_LOCAL=1`; never give a desktop user the web workspace's steps, or send them to the web for these). A request for one order placed by hand (「現在幫我買 100 USDT 的 BTC」) has none: Blave trades through strategies only — say that in one sentence and never make up steps or a page name for it.

### Web workspace

On mobile (narrow screens) the chat fills the screen — prepend one line:
「點下方『工作區』分頁」 (the portfolio page lives in that view).

**Bind the paper venue / an exchange** (a key already pasted in chat: bind it with `lib.venue.bind` per AGENTS.md instead of sending this script):
1. 點左側「自動下單」
2. 點「連接交易所」
3. 選「模擬交易（免金鑰）」（real venue: pick it and fill in its API keys）
4. 按「連接交易所」送出

**Fund / deploy a strategy (set amounts):**
1. 點左側「自動下單」，切到「部位」分頁
2. 點「選擇策略」勾選策略，按「確定」
3. 在「部位大小」欄填金額（填 0＝不下單）
4. 按「儲存」

**Start / resume trading:**
1. 點左側「自動下單」
2. 按「啟動下單」
3. 選「啟動並補齊部位」或「啟動，等新訊號才進場」

### Desktop app

The switcher at the top of the middle pane picks the side: 「這台電腦」 for this computer, 「雲端」 for the user's cloud machine — the steps are the same on both. Orders on this computer go out only while it is awake and Blave is open; say that once when they start trading here.

**Bind the paper venue / an exchange** (one venue at a time: if one is connected, 「設定」分頁 ›「解除綁定」 first):
1. 點左側「自動下單」
2. 點「連接交易所」
3. 在「交易所／券商」選「模擬交易（免金鑰）」（real venue: pick it and fill in its API keys）
4. 按「連接交易所」送出

**Fund / deploy a strategy (set amounts):**
1. 點左側「自動下單」，切到「部位」分頁
2. 點「選擇策略」勾選策略，按「確定」
3. 在「部位大小」欄填金額（填 0＝不下單）
4. 按「儲存」，確認框再按一次「儲存」

**Start / resume trading:**
1. 點左側「自動下單」
2. 按上方的「啟動下單」
3. 選「補齊部位」或「等新訊號」，再按下方的「啟動並補齊部位」或「啟動，等新訊號才進場」

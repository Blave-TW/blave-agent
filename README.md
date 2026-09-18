# Blave Agent

Blave Agent 的引擎與工作區:`runtime/`(agent loop、bridges、回報器,出貨到每一台機器)、
`lib/`(資料、回測、交易所帳戶與下單)、`manager/`(部位管理與對帳)、`AGENTS.md` 與策略範本。

## 發版(runtime)

```
cd blave-agent
export BLAVE_S3_KEY=... BLAVE_S3_SECRET=... BLAVE_S3_REGION=... BLAVE_S3_BUCKET=...
python publish.py            # dry-run,不需要憑證
python publish.py publish    # 真的上傳,機隊 ~6 分鐘內吃到
```

發版前 bump `runtime/VERSION`,並把 `runtime/CHANGELOG.md` 的 Unreleased 搬到新版號下。
打包時會從 `../api/blave_agent/systemd/` 取 `jobs.json` 宣告的 unit 檔,所以 **api 的
checkout 要跟這個 repo 並排**;不在的話會帶著完整路徑當場失敗。

`runtime/` 的歷史是 2026-09-18 從 api repo 以 subtree 合併過來的(165 則)。
因為是合併不是改名,`git log -- runtime/` 只會看到那一則合併;要看完整歷史用
`git log HEAD^2`(檔案在那條線上是根目錄路徑,例如 `agent_turn.py`)。


Fresh installs are handled automatically by the provisioning script — no manual steps needed.

**關於 `openclaw` 這個名字**:`openclaw.json`、`openclaw/...` 的 API 路徑、`patches/` 與 SSH 主機名 `openclaw-{uid}` 是早期框架留下來的名稱。機器硬碟上與 API 上**真的**叫這些名字,所以文件照實寫;它們與那個產品今天已無關係,也不代表 Blave Agent 還在用它。

**Maintainers: bump `VERSION` (date, `YYYY-MM-DD`, add `-b`/`-c` for same-day repushes) in the same commit as any change machines should pick up** — the platform compares each machine's reported VERSION against this repo's to light the web "update available" indicator; an unbumped push is invisible to users.

## Updating an existing workspace

Tell your agent:

> Clone https://github.com/Blave-TW/blave-agent to /tmp/oc-config and use it as **reference** to update this machine's live workspace — `$BLAVE_AGENT_HOME/workspace`, i.e. the workspace you are running in (`/root/.openclaw/workspace` on old BlaveClaw machines, `/opt/blave-agent/workspace` on Blave Agent machines; resolution per `references/deployment.md`). For each file below, compare the repo version with the local version and apply only what is missing or outdated — do not blindly overwrite.
>
> - `AGENTS.md`, `CLAUDE.md` — replace wholesale (these are config, not user-edited)
> - `references/` — for each file, check if a local version exists; if it does, read both and patch in anything missing; if it does not, copy it in
> - `strategies/TEMPLATE_A.py`, `strategies/TEMPLATE_C.py` — replace wholesale
> - `lib/` — add any canonical files that are missing locally; the backtest-chain files (`runner.py`, `param_scan.py`, `walk_forward.py`, `validation.py`, `analysis.py`) are copied over wholesale (`cp`), never merged; for any other canonical file you modified, read both versions and manually merge the new changes in. For `lib/order_*.py` / `lib/account_*.py`, the name alone doesn't tell you if it's user-created: if that exact filename exists in the reference clone (e.g. `order_bingx.py`, `order_sinopac.py`, `account_bingx.py`, `account_TEMPLATE.py`), merge it like any other canonical file; **never touch** one that does not exist in the reference clone — that's the user's own exchange integration
> - `manager/` — replace wholesale (user edits live in `portfolio_config.json`, not in the scripts)
> - `examples/` — replace wholesale
> - `VERSION` — copy verbatim, always last (it declares the workspace up to date; drives the web "update available" indicator)
>
> When done, remove /tmp/oc-config.

## Files

- `AGENTS.md` — agent instructions
- `CLAUDE.md` — Claude Code context (points to AGENTS.md)
- `strategies/TEMPLATE_A.py` — base template for all Type A strategies
- `strategies/TEMPLATE_C.py` — base template for all Type C portfolio strategies
- `lib/` — shared library (runner, data, execute, pnl, portfolio, strategy, analysis, param_scan, validation, notify, report)
- `lib/account_TEMPLATE.py` — template for exchange account libraries (copy to `lib/account_{exchange}.py`)
- `manager/` — portfolio management system (optimizer, reconciler)
- `examples/` — reference strategy implementations
- `references/` — deployment flow, strategy code rules, lib signatures, model switching

"""The workspace code that runs where the broker passwords are.

SECRET_CODE_FILES: every file a process handed the 群益 / 統一 / 永豐 passwords loads — the three broker workers,
the reconciler and flatten (the desktop daemon's stdin line), everything they import, and the official venue libs
they load by name (audit 2026-10-07 S1, 2026-11-19 M1). The list is the import graph, not a choice:
tests/check_secret_code_graph.py rebuilds it from the code and fails on any file missing here. agent_turn freezes
them (Edit rules, the Bash guard): new writes are refused, content already on disk is not checked. Not covered, by
design: agent-written code the reconciler / flatten load by path — manager/executors/*.py,
strategies/<name>/strategy.py (paper fills, lib/paper_data) and the user's own lib/order_<x>.py / lib/account_<x>.py
integrations.
"""

SECRET_CODE_FILES = (
    "lib/__init__.py", "lib/account_binance.py", "lib/account_bingx.py", "lib/account_bitget.py",
    "lib/account_bybit.py", "lib/account_capital.py", "lib/account_gateio.py", "lib/account_okx.py",
    "lib/account_paper.py", "lib/account_president.py", "lib/account_sinopac.py", "lib/account_stockcoin.py",
    "lib/bar_ready.py", "lib/capital_quote.py", "lib/capital_vault.py", "lib/capital_worker.py", "lib/costs.py",
    "lib/data.py", "lib/error_report.py", "lib/events.py", "lib/execute.py", "lib/guard.py", "lib/notify.py",
    "lib/okx_inst.py", "lib/order_binance.py", "lib/order_bingx.py", "lib/order_bitget.py", "lib/order_bybit.py",
    "lib/order_capital.py", "lib/order_gateio.py", "lib/order_okx.py", "lib/order_paper.py",
    "lib/order_president.py", "lib/order_sinopac.py", "lib/order_stockcoin.py", "lib/paper_data.py",
    "lib/portfolio.py", "lib/president_contracts.py", "lib/president_quote.py", "lib/president_vault.py",
    "lib/president_worker.py", "lib/progress.py", "lib/reject_token.py", "lib/secret_imports.py",
    "lib/sinopac_vault.py", "lib/sinopac_worker.py", "lib/stock_perps.py", "lib/tw_clock.py", "lib/twf_feed.py",
    "lib/unconfirmed.py", "lib/venue_errors.py", "lib/venue_traits.py", "lib/venue_wiring.py", "lib/winreplace.py",
    "manager/flatten.py", "manager/reconciler.py",
)

# Turn Events — `done.awaiting`, `done.kinds`, session `waiting`

Contract between the runtime (`runtime/agent_turn.py`), the api (`openclaw/webchat.py`), the web
workspace and the desktop shell. Each layer reads only this file, never another layer's code. The
runtime side ships first (api, then web / desktop, follow the same contract).

## The `<await/>` marker (model → runtime)

- Written by the model on its own line at the very end of the reply body — after an
  `<export … />` marker, before a `<suggest>` block (`<suggest>` stays last). Rule text lives in the
  runtime prompt (`_SUGGEST_RULE` tail); nothing here needs the agent's attention.
- Meaning: the turn ends needing the user's answer to continue — a clarification question, numbered
  options the user must pick from, information only the user has. Not for reporting results,
  suggestion chips, or chit-chat.
- It is a **model-declared** signal: it can be missed or over-used. No surface may infer waiting
  from the reply text (trailing question marks, option lists) — only from the fields below.
- The runtime strips every `<await…>` form (`<await/>`, `<await />`, `<await></await>`) in every
  sink: web (`WebSink`), desktop (`LocalSink`), scheduled reports (`ReportSink`), Telegram
  (`TelegramSink`); the session store and `main()`'s stdout take the stripped text. Streaming deltas
  may carry it briefly, exactly like `<suggest>`; `text_replace` (web / desktop) and the final
  Telegram edit replace it. `tests/check_await_marker.py` enumerates the sinks.

## `done` chunk (runtime → api `/report`; desktop stdout line)

```json
{"type": "done", "session_id": "<sid>", "awaiting": true, "kinds": {"backtest": 1, "files": 3, "unknown": 2}}
```

- `awaiting` — always present. `true` only when the marker was present **and** the turn was not
  stopped by the user. A failed turn sends `error`, not `done` (unchanged).
- `kinds` — always present. Count of tool calls per `kind` this turn, same vocabulary as the `tool`
  chunk's `kind` (`unknown` included). Counts only: no command, path, object or text. Purpose: measure
  the `unknown` share of the status-line classifier without reading transcripts. The api may log it as
  a metric event; no surface displays it.
- Both fields are additive: an older api or web ignores them.

## api (`openclaw/webchat.py`) — to follow

- `/report` rebuilds `done` from validated fields only: `{"type": "done", "session_id": …,
  "awaiting": bool}`; `kinds` keys must be in `TOOL_KINDS`, values small non-negative ints, otherwise
  the field is dropped (never forwarded raw).
- `awaiting is True` → `hset(<session hash>, "waiting", <ts>)`; otherwise `hdel`. Stored on the
  session hash, **not** on turnactive (turnactive is deleted when the turn is done).
- `/send` into that session → `hdel waiting`. Deleting the session deletes the hash.
- `_publish_session_meta` gets an op `"waiting"` with `{"waiting": bool}` so every open tab updates.
- `/sessions` items gain `"waiting": bool` next to `{id, title, last_activity, created_at, state}`.
  `state` is unchanged (whether a turn is running); `waiting` is independent of it; never add it to
  `TURN_STATE_REPORTS`.

## web / desktop — to follow

- Conversation list shows "waiting for you · {time}" only when `waiting` is true (from the list
  payload or a `session_meta` op); the header hint counts them. Never derived from text.
- Row meta priority (design canon): replying > waiting for you > queued > done, unseen > draft > time.
- Desktop shell reads `awaiting` from the `done` line on stdout and keeps its own per-conversation
  store; the api fields above do not apply to it.

## Status-line phases (`kind`) — notes for the phase table

- `live_tick` is its own phase ("running a strategy"): running a strategy that is in the 下單設定
  is a real live tick, never a backtest. Phase tables must not fold it into "running a backtest".
- `python3 manager/management_backtest.py …` (portfolio backtest) → `backtest` (no object).
- A wrapper that runs `strategies/<x>/strategy.py` — `python3 tmp/bt.py`, `sh tmp/run.sh`,
  `python -c` / heredoc — → `backtest`, or `live_tick` by the same rule as a direct run
  (`BLAVE_MODE` on the command line or inside the script wins; otherwise membership in the 下單設定).

# Turn Events — `done.awaiting`, `done.kinds`, session `waiting`, `form`, `answers`, `auto_iter`

Contract between the runtime (`runtime/agent_turn.py`), the api (`openclaw/webchat.py`), the web
workspace and the desktop shell. Each layer reads only this file, never another layer's code. The
runtime side ships first (api, then web / desktop, follow the same contract).

## The `<await/>` marker (model → runtime)

- Written by the model on its own line at the very end of the reply body — after an
  `<export … />` marker. A turn that writes `<await/>` carries no `<suggest>` block. Rule text lives
  in the runtime prompt (`_AWAIT_RULE`); nothing here needs the agent's attention.
- Meaning: the turn ends needing the user's answer to continue — a clarification question,
  options the user must pick from, information only the user has. Not for reporting results,
  suggestion chips, or chit-chat.
- It is a **model-declared** signal: it can be missed or over-used. No surface may infer waiting
  from the reply text (trailing question marks, option lists) — only from the fields below.
- The runtime strips every `<await…>` form (`<await/>`, `<await />`, `<await></await>`) in every
  sink: web (`WebSink`), desktop (`LocalSink`), scheduled reports (`ReportSink`), Telegram
  (`TelegramSink`); the session store and `main()`'s stdout take the stripped text. Streaming deltas
  may carry it briefly, exactly like `<suggest>`; `text_replace` (web / desktop) and the final
  Telegram edit replace it. `tests/check_await_marker.py` enumerates the sinks.

## `error.code` on phone turns (desktop shell → api `/oauth/desktop/relay/report`)

A desktop phone turn adds five codes to the runtime's fault codes. The api accepts them on relay
namespaces only and drops any other code, so a client falls back to `message`. Clients key their
own copy off the code; `message` stays the redacted engine text.

| `code` | Meaning |
|---|---|
| `no_credit` | Blave AI turn, the engine reported `API Error: 402` |
| `auth_invalid` | Blave AI turn, the engine reported `API Error: 401` or `403` |
| `engine_signed_out` | The user's own Claude Code or Codex reported `401` / `403`, or Claude Code's `Not logged in`, `Login expired`, `OAuth token revoked`, `Invalid API key · Please run /login`, `Please run /login` (Codex: runtime code `needs_login`) |
| `usage_limit` | Claude Code's `You've hit your … limit · resets …` |
| `engine_missing` | The turn ended with `AGENT_BIN_MISSING` or `AGENT_BIN_DOWNLOADING` in its stderr tail |

- These failures arrive from the engine as `text` followed by `error` (`not_started` / `partial`).
  The shell classifies in its main process, because a phone turn often has no window open: it holds
  back text that could still be one of the above, anchored at the start of a text segment (a segment
  restarts at each running `tool`), and releases it as soon as it cannot match.
- Matched text is never sent, not even followed by `text_replace`: the api's fold ignores
  `text_replace`, so the text would stay in the history and the push excerpt.
- The code replaces the code of the `error` that follows. If the turn has no `error`, the shell
  sends one and no `done`.
- These codes apply only to a turn that has not started a tool. Once a `tool` has started, the turn
  may already have changed something (an order placed), so the `error` carries `partial` instead and
  no reason code: `partial` wins over all five. The matched text is still not sent.
- A bring-your-own API key turn (`apikey`) carries no code: its 401 / 402 are the provider's, not
  Blave's balance.
- `message_failed` is separate: that message never ran.

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

## `card` chunk (runtime → desktop stdout line only)

```json
{"type": "card", "session_id": "<sid>", "id": "data-access", "code": "denied" | "err005" | "err007"}
```

- The runtime reads the output of shell tools (`Bash` / `PowerShell` / `TaskOutput` / `BashOutput`;
  Codex `command_execution`'s `aggregated_output`), last 64 KB per result, and only when the shell set
  `BLAVE_DATA_ACCESS` (`agent_turn.data_access_hit`). File-reading tools never count, so reading
  `lib/data.py` does not trigger it. Cloud machines and a user's own `.env` key never set the flag.
  - `denied` — flag `0` and a `DataAccessError:` traceback line or `lib/data._NO_ACCESS_MSG`.
  - `err005` / `err007` — flag `1` and an api 403 body as `lib/data` prints it in a chat turn
    (`403 Client Error … — {"error_code":"ERR007",…` or `HTTP 403: {"error_code":"ERR005",…`). A bare
    `ERR007` in a document does not count.
- At most one per turn, sent right before `done`; `err005` beats `err007` beats `denied`. Not sent on
  a failed turn (`error`) or a turn the user stopped.
- The desktop shell draws the data card from it; the model's `<blave-card:data-access/>` marker stays
  as the fallback for older runtimes. An older shell ignores the type. The phone relay does not forward
  it (`relay.js` `TURN_TYPES`).

## `error.code` `no_credit` (runtime fault code)

- A turn that started no tool and hit the Blave AI proxy's 402 (`API Error: 402`,
  `api_error_status` 402, or `INSUFFICIENT_CREDIT`) carries `code: "no_credit"`; it used to be
  `not_started`. Web draws the card / top-up card from the code; an older web falls back to `message`.
  A turn that already ran a tool still carries `partial`.
- The api forwards it to web only once `no_credit` is in `openclaw/webchat.py` `FAULT_CODES`; until
  then `/report` drops the code and web shows `message`.

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

## The `<form …/>` marker and `form` chunk (clarify form)

- Written by the model only when this turn's rule (`_FORM_RULE`, attached per turn when the surface
  passes `--clarify-form`) asks for it: a TAIFEX futures backtest with two or more of contract / bar
  interval / period / strategy type unstated. Shape: `<form id="txf_backtest" prod="mxf" tf="m5"/>`
  on its own line after the two-sentence body, then `<await/>`; no `<suggest>`. Attributes are only
  the values the user already stated.
- The catalog (questions, options, defaults, start years, the data note) lives in the runtime
  (`_FORM_CATALOG`); the model only picks the id and fills stated values. Unknown attribute values
  fall back to the catalog default; an unknown id, a missing id, `</form>`, paired or malformed tags
  are stripped and trigger nothing.
- Stripped in every sink like `<await/>` (pattern `</?form\b[^<>]*>`): `WebSink`, `LocalSink`,
  `ReportSink` send the chunk; `TelegramSink` only strips (no card; listed proposals per
  AGENTS.md). `tests/check_await_marker.py` enumerates the sinks.
- Surfaces: desktop shell passes `--clarify-form` unconditionally (runtime ships in the package);
  web sends `context.clarify_form: true`, the api forwards it untouched, `web_bridge` passes the flag
  only when the value is `true` itself. Telegram never.

```json
{"type": "form", "session_id": "<sid>", "id": "txf_backtest",
 "questions": [
   {"key": "prod", "options": ["txf", "mxf", "tmf"], "value": "mxf"},
   {"key": "tf", "options": ["d", "m1", "m5", "m15"], "value": "m5", "note": "nodata"},
   {"key": "per", "options": ["all", "y3", "y1"], "value": "all", "years": {"txf": 1998, "mxf": 2001, "tmf": 2024}},
   {"key": "st", "options": ["ma", "ch", "other"], "value": "ma"}
 ]}
```

- Order on the wire: `text_replace` → `export` → `form` → `answers` → `suggestions` → `done`. Not sent
  when the turn was stopped or failed.
- `value` — always present, always one of `options` (the model's value or the catalog default);
  surfaces keep no default table of their own.
- `note` — only on `tf`, only on the desktop with `BLAVE_DATA_ACCESS=0`: `nodata_signed_out` when
  `BLAVE_DATA_ACCESS_WHY` is `signed_out`, `nodata` for any other or missing reason. Surfaces must
  tolerate its absence; web never shows it.
- `years` — only on `per`: cloud `2011` for all three; desktop `txf 1998 / mxf 2001 / tmf 2024`,
  with `tmf 2011` when the turn has Blave data.
- Not persisted anywhere: history keeps only the two sentences.
- Ship order for this chunk is the reverse of the rest of this file: api first, then the runtime
  (an un-updated api would put a live `<form>` element into web history and forward the raw chunk).

### api (`openclaw/webchat.py`)

- `_clean_turn_text` strips `<form…>` / `</form>` and `<await…>` from the durable history (it folds
  raw text deltas and never sees `text_replace`).
- `/report` rebuilds `form` from validated fields only — `id` `[a-z_]{1,24}`; 1–5 questions; `key`
  `[a-z_]{1,16}`; 1–7 `options` `[a-z0-9_]{1,16}`; `value` in `options`; `note` only `nodata` /
  `nodata_signed_out`; `years` keys `[a-z0-9_]{1,16}`, values ints 1900–2100. Any field out of shape →
  the whole chunk is refused with `400 invalid form chunk` and nothing is published. No
  `session_id` → dropped like every per-turn chunk. The desktop relay does not carry it.

## The `<answers>` block and `answers` chunk (answer buttons)

- Written by the model only when this turn's rule (`_ANSWERS_RULE`, attached per turn when the surface
  passes `--answer-buttons`) asks for it: one question, 2–4 mutually exclusive answers. Shape: the body is
  the question alone, then `<answers default="N">` with one option per line, then `<await/>`; no
  `<suggest>`, no `<form>`. Options are never numbered; `default` (1-based) is the option the agent
  recommends, preselected on screen (Wei 11-20). Never for orders, starting or resuming trading, going live,
  amounts, purchases, card binding or charges (rule text only; surfaces cannot tell).
- The runtime keeps the last complete block (`_ANSWERS_BLOCK_RE`) and strips every block plus an
  unclosed tail (`_ANSWERS_OPEN_TAIL_RE`) in every sink. Leading `-•*‧·` and blank lines are dropped;
  nothing is cut or padded. A `default` past the last option is dropped (the options stay).
- Valid = the turn has `<await/>`, no `form` chunk, was not stopped, the surface passed the flag, and
  the lines are 2–`ANS_MAX_ITEMS` (4), each 1–`ANS_MAX_CHARS` (32) code points (`Array.from`), no
  control or format characters (Unicode Cc/Cf), no duplicates. Valid → the chunk is sent and no `suggestions` chunk follows.
  Anything else → no chunk, and the options are appended to the reply as a plain `- ` list, the default
  one tagged 「（建議）」 / " (recommended)" (the rule keeps them out of the body, so they must not vanish).
  `TelegramSink` always appends the list.
- History: the session store (desktop reload, phone relay, next turn's context) gets the reply plus
  the same plain list even when the chunk was sent; the buttons live in memory only.
- Surfaces: desktop shell passes `--answer-buttons` except on phone turns; web sends
  `context.answer_buttons: true`, the api forwards it untouched, `web_bridge` passes the flag only when
  the value is `true` itself. Telegram never. Without the flag the model keeps a plain list with the
  recommended option marked (`AGENTS.md` › Response Style).
- The two limits and both regexes are the same on runtime, desktop and web
  (`tests/check_web_desktop_parity.js`). Streaming deltas may carry a half block; surfaces hide it
  (desktop `LIVE_TAIL_TAGS` / `ANS_OPEN_TAIL`).

```json
{"type": "answers", "session_id": "<sid>", "items": ["重跑回測", "先不要"], "default": 1}
```

- `default` is optional; surfaces that do not know it draw the group without a preselected option.

### api (`openclaw/webchat.py`)

- `_clean_turn_text` turns the last complete `<answers>` block into the same plain list (other blocks
  and an unclosed tail are dropped), so web reloads and the phone see the options.
- `/report` rebuilds `answers` from validated fields only with the same limits; `default` kept only when
  it is an int within the list; anything else out of shape → `400 invalid answers chunk`, nothing
  published. The desktop relay does not carry it.
- Ship order: api first (an un-updated api forwards the raw block into history and drops the chunk).

## `auto_iter` chunk (auto-iterate session end; telemetry only)

```json
{"type": "auto_iter", "session_id": "<sid>", "done": "full.good", "rounds": "4_6"}
```

- Sent by the runtime right before `done`, once per auto-iterate session the turn ran (`lib/iterate.py`),
  after the runtime closed any session still open (`python -m lib.iterate close-turn`). A session with only its
  baseline backtest and no parameter scan is closed without a line. Not on scheduled turns, not on Telegram.
- A stopped turn (`user`) is closed as it stands — no revert, no quiet rerun — and the runtime sends `ping`
  every second while the close runs (the desktop shell kills a runtime silent for 5 s after Stop).
- `done` = `<tier>.<stop>`: tier `basic` | `full`; stop `good` | `cap` | `time` | `steps` | `credit` | `user` |
  `fault` | `done`. `rounds` = logic rounds after round 0, bucketed `0` | `1` | `2_3` | `4_6` | `7_10`.
- Desktop: the shell's main process records `auto_iter_done {r}` and `auto_iter_rounds {n}` and does not pass it
  to the window. The phone relay does not carry it.
- api `/report`: values outside the two lists → `400 invalid auto_iter chunk`; otherwise one `agent_event`
  (`auto_iter_done`, excluded from the workspace timeline), never published, never in history. Ship order: api
  first (an un-updated api answers 400 for an unknown chunk type, which the runtime only logs).

## Status-line phases (`kind`) — notes for the phase table

- `live_tick` is its own phase ("running a strategy"): running a strategy that is in the 下單設定
  is a real live tick, never a backtest. Phase tables must not fold it into "running a backtest".
- `python3 manager/management_backtest.py …` (portfolio backtest) → `backtest` (no object).
- A wrapper that runs `strategies/<x>/strategy.py` — `python3 tmp/bt.py`, `sh tmp/run.sh`,
  `python -c` / heredoc — → `backtest`, or `live_tick` by the same rule as a direct run
  (`BLAVE_MODE` on the command line or inside the script wins; otherwise membership in the 下單設定).

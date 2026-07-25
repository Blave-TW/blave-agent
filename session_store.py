"""
Session persistence per spec item 6: raw transcript in SQLite (append-only,
never touched by compaction — only by the separate 1-year retention job),
plus a compaction watermark that bounds what gets fed to the LLM as working
context ("summary + recent"). Compaction is cheap/rule-based, not an LLM call.
"""
import os
import sqlite3
import time

DB_PATH = os.environ.get("BLAVE_AGENT_DB", "/opt/blave-agent/state/session.db")
# Working-context budget (per the 150k/turn split: ~30k system + ~20k summary +
# ~100k recent). Keep the newest turns verbatim up to RECENT_TOKEN_BUDGET est-tokens,
# fold the rest into the summary. RECENT_MIN_TURNS is a floor so a single huge turn
# can't starve context to nothing.
RECENT_TOKEN_BUDGET = 100000
RECENT_MIN_TURNS = 4
SUMMARY_MAX_CHARS = 60000
RETENTION_DAYS = 365


def _conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    # The transcript is confidential (strategy logic, anything the user pasted).
    # Create it owner-only from the start so it's never briefly world-readable;
    # chmod covers a db written before this hardening existed.
    if not os.path.exists(DB_PATH):
        os.close(os.open(DB_PATH, os.O_CREAT | os.O_WRONLY, 0o600))
    else:
        os.chmod(DB_PATH, 0o600)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at REAL NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS session_meta (
            session_id TEXT PRIMARY KEY,
            summary TEXT NOT NULL DEFAULT '',
            summarized_up_to_id INTEGER NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL
        )
    """)
    return conn


def _estimate_tokens(text):
    # cheap rule-based estimate, not a real tokenizer — good enough to gate compaction
    return max(1, len(text) // 3)


def append_turn(session_id, role, content):
    conn = _conn()
    conn.execute(
        "INSERT INTO turns (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        (session_id, role, content, time.time()),
    )
    conn.commit()
    conn.close()


def get_context(session_id):
    """Returns (summary_text, recent_turns) — recent_turns is everything after
    the compaction watermark, oldest first."""
    conn = _conn()
    meta = conn.execute(
        "SELECT summary, summarized_up_to_id FROM session_meta WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    summary, watermark = meta if meta else ("", 0)
    rows = conn.execute(
        "SELECT role, content FROM turns WHERE session_id = ? AND id > ? ORDER BY id ASC",
        (session_id, watermark),
    ).fetchall()
    conn.close()
    return summary, rows


def maybe_compact(session_id):
    """Rule-based compaction: keep the newest turns verbatim up to
    RECENT_TOKEN_BUDGET est-tokens (never fewer than RECENT_MIN_TURNS), roll the
    rest into the summary. Never deletes raw rows — only the separate prune_old()
    retention job does that."""
    conn = _conn()
    meta = conn.execute(
        "SELECT summary, summarized_up_to_id FROM session_meta WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    prior_summary, watermark = meta if meta else ("", 0)

    uncompacted = conn.execute(
        "SELECT id, role, content FROM turns WHERE session_id = ? AND id > ? ORDER BY id ASC",
        (session_id, watermark),
    ).fetchall()

    if len(uncompacted) <= RECENT_MIN_TURNS:
        conn.close()
        return False

    # Walk newest→oldest, keep turns while under the token budget (or below the min
    # floor); everything older than that gets folded. The budget itself is the trigger:
    # if all uncompacted turns fit, keep_count == len(uncompacted) and nothing folds.
    kept_tokens = 0
    keep_count = 0
    for _id, _role, content in reversed(uncompacted):
        t = _estimate_tokens(content)
        if keep_count < RECENT_MIN_TURNS or kept_tokens + t <= RECENT_TOKEN_BUDGET:
            kept_tokens += t
            keep_count += 1
        else:
            break

    fold_count = len(uncompacted) - keep_count
    if fold_count <= 0:
        conn.close()
        return False

    to_fold = uncompacted[:fold_count]
    new_watermark = to_fold[-1][0]
    new_lines = [f"- {role}: {content[:200]}" for _id, role, content in to_fold]
    new_summary = (prior_summary + "\n" + "\n".join(new_lines)).strip()
    if len(new_summary) > SUMMARY_MAX_CHARS:
        new_summary = new_summary[-SUMMARY_MAX_CHARS:]

    conn.execute(
        "INSERT INTO session_meta (session_id, summary, summarized_up_to_id, updated_at) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(session_id) DO UPDATE SET summary=excluded.summary, "
        "summarized_up_to_id=excluded.summarized_up_to_id, updated_at=excluded.updated_at",
        (session_id, new_summary, new_watermark, time.time()),
    )
    conn.commit()
    conn.close()
    return True


def prune_old(days=RETENTION_DAYS):
    """Separate retention job — deletes raw turns older than `days`. Not
    triggered by compaction; run this on its own schedule (e.g. daily cron)."""
    cutoff = time.time() - days * 86400
    conn = _conn()
    cur = conn.execute("DELETE FROM turns WHERE created_at < ?", (cutoff,))
    deleted = cur.rowcount
    conn.commit()
    conn.close()
    return deleted

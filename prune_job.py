"""
Retention job, spec item 6: deletes raw turns older than 1 year. Separate
from compaction (which only bounds the LLM's working context and never
deletes) — this is the only thing that actually removes rows, on its own
schedule (daily), independent of how active any given session is.
Also sweeps user-uploaded attachment files (tmp/inbound/) older than 7 days.
"""
import os
import sys
import time

import session_store as ss

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
INBOUND_DIR = f"{WORKSPACE}/tmp/inbound"
INBOUND_RETENTION_DAYS = 7


def prune_inbound():
    """用戶傳進來的附件(bridge 落地在 tmp/inbound/)過保留期就刪;目錄不存在=沒收過檔,跳過。"""
    if not os.path.isdir(INBOUND_DIR):
        return 0
    cutoff = time.time() - INBOUND_RETENTION_DAYS * 86400
    removed = 0
    for entry in os.listdir(INBOUND_DIR):
        path = os.path.join(INBOUND_DIR, entry)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.remove(path)
                removed += 1
        except OSError as e:
            print(f"[prune_job] inbound remove failed {path}: {e}", file=sys.stderr)
    return removed


def main():
    deleted = ss.prune_old()
    print(f"[prune_job] deleted {deleted} rows older than {ss.RETENTION_DAYS} days", file=sys.stderr)
    removed = prune_inbound()
    print(f"[prune_job] removed {removed} inbound files older than {INBOUND_RETENTION_DAYS} days",
          file=sys.stderr)


if __name__ == "__main__":
    main()

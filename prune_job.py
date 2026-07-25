"""
Retention job, spec item 6: deletes raw turns older than 1 year. Separate
from compaction (which only bounds the LLM's working context and never
deletes) — this is the only thing that actually removes rows, on its own
schedule (daily), independent of how active any given session is.
"""
import sys

import session_store as ss


def main():
    deleted = ss.prune_old()
    print(f"[prune_job] deleted {deleted} rows older than {ss.RETENTION_DAYS} days", file=sys.stderr)


if __name__ == "__main__":
    main()

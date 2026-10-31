"""Where this turn's LLM proxy calls go (agent_turn.PROXY_BASE_URL, session_store summaries).

The desktop app sets BLAVE_PROXY_BASE to its local account relay (shell/acctrelay.js), so the turn holds a
one-turn relay token instead of the account token. Only an exact http://127.0.0.1:<port>[/path] is honoured:
a cloud machine never sets it, and nothing may redirect the real machine token elsewhere — a prefix check
would let http://127.0.0.1:1@evil.example through (userinfo), so the URL is parsed.
"""
import os
from urllib.parse import urlsplit

DEFAULT_PROXY_BASE = "https://api.blave.org/openclaw/proxy"


def proxy_base(env=None):
    v = (os.environ if env is None else env).get("BLAVE_PROXY_BASE", "")
    if not isinstance(v, str) or not v:
        return DEFAULT_PROXY_BASE
    try:
        u = urlsplit(v)
        port = u.port
    except ValueError:
        return DEFAULT_PROXY_BASE
    if (u.scheme == "http" and u.hostname == "127.0.0.1" and u.username is None and u.password is None
            and port and u.netloc == f"127.0.0.1:{port}" and not u.query and not u.fragment):
        return v.rstrip("/")
    return DEFAULT_PROXY_BASE

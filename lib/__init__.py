import logging
import os

# lib.analysis imports matplotlib only on the first chart (a live tick draws none). What its
# import used to give any later `import matplotlib.pyplot` in the same process (Agg backend,
# CJK fonts, quiet font lookups) now comes from here; setdefault keeps the user's own choice.
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("MATPLOTLIBRC", os.path.join(os.path.dirname(os.path.abspath(__file__)), "matplotlibrc"))
logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)

# Desktop only (cloud machines have nobody to ask before sending): our own uncaught exceptions go to
# state/error_reports.jsonl for the shell to offer to the user. Never let it break `import lib`.
if os.environ.get("BLAVE_AGENT_LOCAL") == "1":
    try:
        from . import error_report as _error_report
        _error_report.install()
    except Exception:
        pass

import logging
import os

# lib.analysis imports matplotlib only on the first chart (a live tick draws none). What its
# import used to give any later `import matplotlib.pyplot` in the same process (Agg backend,
# CJK fonts, quiet font lookups) now comes from here; setdefault keeps the user's own choice.
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("MATPLOTLIBRC", os.path.join(os.path.dirname(os.path.abspath(__file__)), "matplotlibrc"))
logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)

"""機器自己發的通知講到策略時寫名稱(canon notifications.md §3.1)。

規則同 api openclaw/strategy_names.clean 一字不差;測資住在 api tests/check_strategy_names.py 的
CASES,tests/check_strategy_names_lib.py 拿同一張表跑這一份。名稱過不了就整個退回代號。
"""
import ast
import os
import re
import unicodedata

LABEL_MAX = 40
_UNSAFE = re.compile(r"[、;:；：「」\r\n\x0b\x0c\x85\u2028\u2029]")
_FOLD = str.maketrans({"[": "［", "]": "］", "（": "(", "）": ")"})
URL_TLDS = ("com", "net", "org", "io", "co", "me", "ly", "cc", "gg", "tv", "to", "so", "sh", "gl", "gd",
            "im", "fm", "ai", "app", "dev", "xyz", "top", "vip", "pro", "info", "biz", "link", "site",
            "club", "online", "shop", "tw", "cn", "hk", "jp", "kr", "sg", "us", "uk", "ru")
_URL = re.compile(r"://|www\.|[a-z0-9-]\.(?:" + "|".join(URL_TLDS) + r")(?![a-z0-9])", re.I | re.A)
_SPACE = " \t\u00a0\u3000"
_READ_MAX = 65536


def clean(name, code):
    v = name.strip(_SPACE) if isinstance(name, str) else ""
    if not v or (v.startswith("[") and v.endswith("]")):
        return None
    if _UNSAFE.search(v) or any(unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") for c in v):
        return None
    if _URL.search(v):
        return None
    v = v.translate(_FOLD)[:LABEL_MAX].strip(_SPACE)
    return v if v and v != code else None


def _display_name(code, root):
    if not code or code.startswith(".") or any(c in code for c in "/\\:") or os.path.isabs(code):
        return None
    sdir = os.path.join(root, "strategies")
    for p in (os.path.join(sdir, code, "strategy.py"), os.path.join(sdir, code + ".py")):
        if not os.path.isfile(p):
            continue
        with open(p, encoding="utf-8-sig", errors="replace") as f:
            tree = ast.parse(f.read(_READ_MAX))
        for node in tree.body:
            if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                    and isinstance(node.value.value, str)
                    and any(isinstance(t, ast.Name) and t.id == "DISPLAY_NAME" for t in node.targets)):
                return node.value.value
        return None
    return None


def label(code, root="."):
    """名稱,沒有或過不了規則就回代號。讀不到、解析失敗一律回代號:通知不能因為名稱而送不出去。"""
    try:
        return clean(_display_name(code, root), code) or code
    except Exception:
        return code

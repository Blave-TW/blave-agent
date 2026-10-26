"""What a scheduled report turn may build, decided from a job's files without running them (audit 2026-10-26 R1).

Stdlib only: report_runner (the runner) and agent_turn (the turn's report_build tool) both import it, and agent_turn
must not pull report_runner's imports into the turn's process (tests/check_turn_stop.py §9).
"""
import ast
import json
import os

TEMPLATE_FNS = ("tw_market_brief", "tw_close_brief", "crypto_market_brief", "symbol_brief", "research_pack")


def template_call(src):
    """The template call in a run.py, read from its syntax tree: {"fn", "args", "kwargs"} with every argument a
    literal, or None. run.py must be nothing but imports, the workspace pin and that one call (whitelist below),
    so the pack built is the one the data-only run builds. run.py is a file chat turns can write, so the scheduled turn's report_build runs fixed code
    on these values (JSON) — never text cut out of run.py. Same rule as lib.report.agent_template_call
    (tests/check_sched_report_tools.py runs both on one set of scripts)."""
    try:
        tree = ast.parse(src)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return None
    body = list(tree.body)
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
            and isinstance(body[0].value.value, str):
        body = body[1:]   # docstring
    # 白名單:頂層只有 os／sys／lib.report_templates 的 import、sys.path 的 insert／append,最後是那一個模板呼叫
    # (program 認得的形狀,或整段放在 `if __name__ == "__main__":` 裡)。其他任何語句都可能改變實際跑的是什麼,一律不算。
    funcs, mods, plain, bound, rest = {}, set(), set(), [], []
    for st in body:
        if isinstance(st, ast.ImportFrom):
            if st.level != 0:
                return None
            for a in st.names:
                if a.name == "*":
                    return None
                if st.module == "lib.report_templates":
                    if a.asname is None and (a.name in TEMPLATE_FNS or a.name in ("publish", "headers_from_env")):
                        funcs[a.name] = a.name
                elif st.module == "lib" and a.name == "report_templates":
                    mods.add(a.asname or a.name)
                else:   # 別的模組的 import 會先跑那個模組(例:改 sys.modules),不算
                    return None
                bound.append(a.asname or a.name)
        elif isinstance(st, ast.Import):
            for a in st.names:
                if a.name == "lib.report_templates":
                    mods.add(a.asname or a.name)
                    if a.asname:
                        bound.append(a.asname)
                elif a.asname is None and a.name in ("os", "sys"):
                    plain.add(a.name)
                    bound.append(a.name)
                else:
                    return None
        else:
            rest.append(st)
    if len(bound) != len(set(bound)):
        return None
    if "lib" in bound:
        mods.discard("lib.report_templates")

    def module_ref(node):
        if isinstance(node, ast.Name):
            return node.id in mods
        return (isinstance(node, ast.Attribute) and node.attr == "report_templates" and isinstance(node.value, ast.Name)
                and node.value.id == "lib" and "lib.report_templates" in mods)

    def named(func, want):
        if isinstance(func, ast.Name):
            return funcs.get(func.id) in want
        return isinstance(func, ast.Attribute) and func.attr in want and module_ref(func.value)

    def tpl(node):
        return node if isinstance(node, ast.Call) and named(node.func, TEMPLATE_FNS) else None

    def publish_of(node, arg_ok):
        return (isinstance(node, ast.Call) and named(node.func, ("publish",)) and len(node.args) == 1
                and not node.keywords and arg_ok(node.args[0]))

    def is_var(node, var):
        return isinstance(node, ast.Name) and node.id == var

    def program(stmts):
        """The template call the statements make, or None. Accepted: `publish(<模板>(…))` or `<模板>(…)` alone; or
        `pack = <模板>(…)`, then optionally `print(pack.describe())`, then optionally `publish(pack)`
        (references/reports.md §1b's shape)."""
        if len(stmts) == 1 and isinstance(stmts[0], ast.Expr):
            v = stmts[0].value
            return v.args[0] if publish_of(v, tpl) else tpl(v)
        if not (stmts and isinstance(stmts[0], ast.Assign) and len(stmts[0].targets) == 1
                and isinstance(stmts[0].targets[0], ast.Name)):
            return None
        var = stmts[0].targets[0].id
        if var in bound or var == "print":
            return None
        more = list(stmts[1:])
        if more and isinstance(more[0], ast.Expr) and "print" not in bound:
            v = more[0].value
            if (isinstance(v, ast.Call) and isinstance(v.func, ast.Name) and v.func.id == "print" and not v.keywords
                    and len(v.args) == 1 and isinstance(v.args[0], ast.Call) and not v.args[0].args
                    and not v.args[0].keywords and isinstance(v.args[0].func, ast.Attribute)
                    and v.args[0].func.attr == "describe" and is_var(v.args[0].func.value, var)):
                more.pop(0)
        if more and isinstance(more[0], ast.Expr) and publish_of(more[0].value, lambda a: is_var(a, var)):
            more.pop(0)
        return None if more else tpl(stmts[0].value)

    def path_expr(node):   # os.getcwd()／__file__／字串常值,經 os.path.dirname／abspath／realpath／join 組起來
        if isinstance(node, ast.Constant):
            return isinstance(node.value, str)
        if isinstance(node, ast.Name):
            return node.id == "__file__"
        if not (isinstance(node, ast.Call) and not node.keywords and isinstance(node.func, ast.Attribute)
                and "os" in plain):
            return False
        f = node.func
        if isinstance(f.value, ast.Name) and f.value.id == "os":
            return f.attr == "getcwd" and not node.args
        return (f.attr in ("dirname", "abspath", "realpath", "join") and isinstance(f.value, ast.Attribute)
                and f.value.attr == "path" and isinstance(f.value.value, ast.Name) and f.value.value.id == "os"
                and bool(node.args) and all(path_expr(a) for a in node.args))

    def pin(st):   # sys.path.insert(0, <path>) 或 sys.path.append(<path>):只動 import 路徑
        v = st.value if isinstance(st, ast.Expr) else None
        if not (isinstance(v, ast.Call) and not v.keywords and isinstance(v.func, ast.Attribute)
                and isinstance(v.func.value, ast.Attribute) and v.func.value.attr == "path"
                and isinstance(v.func.value.value, ast.Name) and v.func.value.value.id == "sys" and "sys" in plain):
            return False
        if v.func.attr == "insert":
            return (len(v.args) == 2 and isinstance(v.args[0], ast.Constant) and v.args[0].value == 0
                    and path_expr(v.args[1]))
        return v.func.attr == "append" and len(v.args) == 1 and path_expr(v.args[0])

    while rest and pin(rest[0]):
        rest.pop(0)
    c = None
    if len(rest) == 1 and isinstance(rest[0], ast.If):
        st = rest[0]
        t_ = st.test
        if (not st.orelse and isinstance(t_, ast.Compare) and isinstance(t_.left, ast.Name)
                and t_.left.id == "__name__" and len(t_.ops) == 1 and isinstance(t_.ops[0], ast.Eq)
                and len(t_.comparators) == 1 and isinstance(t_.comparators[0], ast.Constant)
                and t_.comparators[0].value == "__main__"):
            c = program(st.body)
    else:
        c = program(rest)
    if c is None:
        return None
    try:
        args = [ast.literal_eval(a) for a in c.args]
        kwargs = {}
        for k in c.keywords:
            if k.arg is None or k.arg == "extra":
                return None
            if k.arg == "headers" and isinstance(k.value, ast.Call) and not k.value.args and not k.value.keywords \
                    and named(k.value.func, ("headers_from_env",)):
                continue   # = 模板沒帶 headers 時自己用的那一份
            kwargs[k.arg] = ast.literal_eval(k.value)
        call = {"fn": c.func.id if isinstance(c.func, ast.Name) else c.func.attr, "args": args, "kwargs": kwargs}
        return json.loads(json.dumps(call))
    except (ValueError, TypeError, SyntaxError, RecursionError, MemoryError):
        return None


def pack_call(jd):
    """What the job in directory `jd` builds in a scheduled turn: {"recipe": True}, a template call (template_call),
    or None — a custom run.py the turn cannot build, so no agent turn is started for it (`no_template`)."""
    if os.path.isfile(os.path.join(jd, "recipe.json")):
        return {"recipe": True}
    try:
        with open(os.path.join(jd, "run.py"), encoding="utf-8") as f:
            src = f.read()
    except OSError:
        return None
    return template_call(src)


def fetch_only(model):
    """The scheduled turn's news channel: DeepSeek (also the default when None) has no web search, only WebFetch."""
    return model is None or "deepseek" in str(model).lower()

"""tests/run_all.sh 的本體:並行跑 check_*.py / check_*.js,結果落檔再彙總。

結束碼只由「每支實際的結果」決定:排定的每一支都要有結果,有一支非 0、逾時或訊號收掉,整體就是 1;
一支都沒排到也是 1。輸出照排定順序(py、js 各自字母序),跟 -P 幾條、誰先跑完無關。
整支 SKIP(輸出只有 SKIP 行:旁邊沒有 api／web 樹時斷言歸零的那種)不算綠,另外計數;
綠的測試裡有 SKIP 行也計數,Electron 段(run_all 一律不起)分開講。

每支有自己的 process group、TMPDIR、輸出檔。TMPDIR 目錄名用流水號:macOS 的 unix socket 路徑上限 104 字元。
整次的暫存目錄結束時(含 Ctrl-C)整個刪掉:很多測試用 tempfile 建了目錄沒收,在這一層收比逐支補 finally 可靠。
自己組 env、沒帶 TMPDIR 給子行程的測試,子行程會落到 /tmp,這層收不到。

環境:PATH 最前面放假 crontab(真的 crontab 在 Mac 上掛過 4 分半,測試也不該碰到人的排程);
BLAVE_HOME 沒設就指到暫存目錄;BLAVE_TEST_WINDOW 一律清掉;GIT_OPTIONAL_LOCKS=0 讓並行的 git status 不搶 index.lock。
"""
import argparse
import concurrent.futures
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIMEOUT = int(os.environ.get("BLAVE_TEST_TIMEOUT") or 600)
TAIL = 25

# 先開跑最長的,長尾才不會全擠在最後。數字來自 2026-11-01 序列實測;順序舊了只是慢一點,不影響結果
LONGEST = """
check_first_signal_fuzz.py check_president_lib.py check_self_ledger_qty.py
check_version_matrix.py check_shell_relay.js check_shell_browser_verify_outcome.js
check_paper_scenarios.py check_demo_routing.py check_twstock_bulk_fetch.py
check_stats_refresh_command.py check_shell_codex_login.js check_restore_command.py
check_local_daemon_windows.py check_shell_relay_api_responses.js check_rejoin_stale_state.py
""".split()

# 並行段跑完才一支一支跑。原因寫在這:拿掉一支之前先確認資源不再共用
SERIAL = {
    "check_reconcile_unconfirmed_bingx.py": "RSS 量到 1.4–6.1 GB,別跟其他測試一起吃記憶體",
    "check_exec_test_grid.py": "斷言全表 1 秒內算完,機器忙就假紅(-P 8 量到 2.2 秒)",
    "check_exit_levels.py": "新舊版耗時比值上限 15%,兩邊量的當下負載不同就假紅(load 50 量到 16%)",
    "check_turn_stop.py": "斷言回合幾秒內收掉,機器忙就假紅(-P 8 量到 3.3 秒)",
    "check_shell_portfolio.js": "斷言毫秒級的順序與上限,機器忙就假紅(load 180 量到 134ms 對上限 60ms)",
    "check_local_daemon_chain.py": "等 reconciler 收掉有時限,機器忙就假紅(-P 8、load 75 量到收不掉)",
    "check_tw_lots.py": "斷言查價在 TW_CLOSE_BUDGET_S 內交回,機器忙就假紅(-P 8、load 75)",
    "check_shell_codex_login.js": "LOGIN_CHECK_MS 寫死 2 秒、假 CLI 是真 shell,機器忙就逾時(16 份並行可重現)",
}

ELECTRON_SKIP = "SKIP (set BLAVE_TEST_WINDOW=1"
SKIP_LINE = re.compile(r"\s*SKIP\b")
running = {}
stopping = threading.Event()


def plan(words):
    names = sorted(os.listdir(os.path.join(REPO, "tests")))
    ordered = [n for ext in (".py", ".js") for n in names if n.startswith("check_") and n.endswith(ext)]
    return [n for n in ordered if not words or any(w in n for w in words)]


def fake_bin(root):
    d = os.path.join(root, "bin")
    os.mkdir(d)
    path = os.path.join(d, "crontab")
    with open(path, "w") as f:
        f.write("#!/bin/sh\nexit 0\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return d


def kill_group(pgid):
    try:
        os.killpg(pgid, signal.SIGKILL)
    except OSError:
        pass


def classify(rc, timed_out, output):
    lines = [x for x in output.splitlines() if x.strip()]
    skips = [x for x in lines if SKIP_LINE.match(x)]
    if timed_out or rc != 0:
        return "FAIL", skips
    if lines and len(skips) == len(lines):
        return "SKIP", skips
    return "PASS", skips


def run_one(name, index, root, env, jobs):
    out_path, tmp = os.path.join(root, f"{index}.out"), os.path.join(root, str(index))
    os.mkdir(tmp)
    cmd = [sys.executable if name.endswith(".py") else "node", os.path.join("tests", name)]
    with open(out_path, "wb") as out:
        if stopping.is_set():
            return {"name": name, "state": "FAIL", "skips": [], "note": "沒跑(中斷)", "output": ""}
        p = subprocess.Popen(cmd, cwd=REPO, env=dict(env, TMPDIR=tmp, FUZZ_JOBS=str(min(jobs, 4))),
                             stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        running[name] = p.pid
        if stopping.is_set():
            kill_group(p.pid)
        timed_out = False
        try:
            rc = p.wait(TIMEOUT)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_group(p.pid)
            rc = p.wait()
        except BaseException:
            # Ctrl-C／SIGTERM 落在這裡(序列段沒有 pool 那層代收):先收掉這支,暫存目錄才能刪
            kill_group(p.pid)
            raise
    running.pop(name, None)
    # 測試留下的背景子行程不能活到下一支:這個 group 是上面 start_new_session 開的,不會殺到別人
    kill_group(p.pid)
    with open(out_path, encoding="utf-8", errors="replace") as f:
        output = f.read()
    state, skips = classify(rc, timed_out, output)
    note = f"逾時 {TIMEOUT} 秒" if timed_out else f"exit {rc}" if rc else ""
    shutil.rmtree(tmp, ignore_errors=True)
    os.remove(out_path)
    return {"name": name, "state": state, "skips": skips, "note": note, "output": output}


def report(r):
    electron = sum(ELECTRON_SKIP in x for x in r["skips"])
    if r["state"] == "PASS":
        other = len(r["skips"]) - electron
        print(f"PASS {r['name']}" + (f"  (SKIP {other} 段)" if other else ""))
    elif r["state"] == "SKIP":
        print(f"SKIP {r['name']}  {r['skips'][0].strip()[4:].strip()}")
    else:
        print(f"FAIL {r['name']}" + (f"  ({r['note']})" if r["note"] else ""))
        for line in r["output"].splitlines()[-TAIL:]:
            print("    " + line)
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser(prog="run_all.sh", add_help=True)
    ap.add_argument("-P", "--jobs", type=int, default=int(os.environ.get("BLAVE_TEST_JOBS") or 4))
    ap.add_argument("words", nargs="*", help="只跑檔名含任一片段的")
    a = ap.parse_args()
    if a.jobs < 1:
        ap.error("-P 至少 1")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    tests = plan(a.words)
    if not tests:
        print("一支都沒排到:0 綠不算過")
        return 1
    root = os.path.realpath(tempfile.mkdtemp(prefix="blave-tests."))
    env = dict(os.environ, TMPDIR=root, GIT_OPTIONAL_LOCKS="0", PATH=fake_bin(root) + os.pathsep + os.environ["PATH"])
    env.setdefault("BLAVE_HOME", os.path.join(root, "blave-home"))
    env.pop("BLAVE_TEST_WINDOW", None)

    def on_term(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, on_term)

    order = {n: i for i, n in enumerate(tests)}
    head = [n for n in LONGEST if n in order and n not in SERIAL]
    rest = [n for n in tests if n not in head and n not in SERIAL]
    results, printed = {}, 0

    def flush():
        nonlocal printed
        while printed < len(tests) and tests[printed] in results:
            report(results[tests[printed]])
            printed += 1

    try:
        with concurrent.futures.ThreadPoolExecutor(a.jobs) as pool:
            futures = [pool.submit(run_one, n, order[n], root, env, a.jobs) for n in head + rest]
            try:
                for fut in concurrent.futures.as_completed(futures):
                    r = fut.result()
                    results[r["name"]] = r
                    flush()
            except KeyboardInterrupt:
                # pool 收尾會等還在跑的那幾支:先收掉,不然 Ctrl-C 要等到它們跑完
                stopping.set()
                for pgid in list(running.values()):
                    kill_group(pgid)
                raise
        for n in tests:
            if n in SERIAL:
                results[n] = run_one(n, order[n], root, env, a.jobs)
                flush()
    except KeyboardInterrupt:
        print("\n中斷")
        return 130
    finally:
        shutil.rmtree(root, ignore_errors=True)

    missing = [n for n in tests if n not in results]
    count = {s: sum(r["state"] == s for r in results.values()) for s in ("PASS", "FAIL", "SKIP")}
    partial = sum(r["state"] == "PASS" and any(ELECTRON_SKIP not in x for x in r["skips"]) for r in results.values())
    electron = sum(any(ELECTRON_SKIP in x for x in r["skips"]) for r in results.values())
    print()
    print(f"{len(tests)} 支:{count['PASS']} 綠 / {count['FAIL']} 紅 / {count['SKIP']} 整支 SKIP(沒驗到,不算綠)")
    print(f"綠的裡面:{partial} 支有段落 SKIP、{electron} 支的 Electron 段沒跑(run_all 不起 Electron)")
    if count["SKIP"]:
        print("整支 SKIP:" + " ".join(n for n in tests if results[n]["state"] == "SKIP"))
    if missing:
        print("沒有結果:" + " ".join(missing))
    if count["FAIL"]:
        print("紅:" + " ".join(n for n in tests if results[n]["state"] == "FAIL"))
    return 1 if count["FAIL"] or missing else 0


if __name__ == "__main__":
    sys.exit(main())

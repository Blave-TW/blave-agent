"""tests/_run_all.py 本身:結束碼、順序、SKIP 計數、隔離、逾時。用假的測試跑一份複本,不碰真的 tests/。
10-14 兩次假綠都是 runner 把紅弄丟:這支釘住「有紅就非 0、排到的每支都有結果、SKIP 不算綠」。

Run: python tests/check_run_all.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
red = 0


def t(name, ok, info=""):
    global red
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"\n      {info}"))
    red += not ok


root = tempfile.mkdtemp(prefix="run-all-check-")
tests, seen = os.path.join(root, "tests"), os.path.join(root, "seen")
os.makedirs(tests)
os.makedirs(seen)
shutil.copy(os.path.join(HERE, "_run_all.py"), tests)

PROBE = f"""
import json, os, shutil
json.dump({{"tmp": os.environ["TMPDIR"], "crontab": shutil.which("crontab"), "locks": os.environ.get("GIT_OPTIONAL_LOCKS"),
           "window": os.environ.get("BLAVE_TEST_WINDOW"), "blave_home": os.environ.get("BLAVE_HOME")}},
          open(os.path.join({seen!r}, os.path.basename(__file__)), "w"))
"""
ORPHAN = f"""
import os, subprocess
p = subprocess.Popen(["sleep", "300"])
open(os.path.join({seen!r}, "orphan.pid"), "w").write(str(p.pid))
"""
FIXTURES = {
    "check_a_pass.py": 'print("PASS  x")',
    "check_b_red.py": "import sys; sys.exit(3)",
    "check_c_only_skip.py": 'print("SKIP  api 不在旁邊")',
    "check_d_part_skip.py": 'print("PASS  x"); print("SKIP  y"); print("  SKIP (set BLAVE_TEST_WINDOW=1 to run the Electron part)")',
    "check_e_probe1.py": PROBE,
    "check_e_probe2.py": PROBE,
    "check_f_orphan.py": ORPHAN,
    "check_g_hang.py": "import time; time.sleep(60)",
    "check_h_silent.py": "",
    "check_z_js.js": 'console.log("PASS  js");',
    "check_z_js_red.js": "process.exit(1);",
}
for name, src in FIXTURES.items():
    with open(os.path.join(tests, name), "w", encoding="utf-8") as f:
        f.write(src)


def run(*args, **env):
    p = subprocess.run([sys.executable, os.path.join(tests, "_run_all.py"), *args], capture_output=True, text=True,
                       encoding="utf-8", timeout=60, cwd=root, env=dict(os.environ, BLAVE_TEST_TIMEOUT="2", **env))
    return p.returncode, p.stdout


rc4, out4 = run("-P", "4")
rc1, out1 = run("-P", "1")
rc8, out8 = run("-P", "8", BLAVE_TEST_WINDOW="1")
t("有紅:整體非 0(-P 1 / 4 / 8)", (rc1, rc4, rc8) == (1, 1, 1), (rc1, rc4, rc8))
t("輸出跟並行數無關,一字不差", out1 == out4 == out8, f"{out1}\n---\n{out4}")
lines = [x.split()[1] for x in out4.splitlines() if re.match(r"(PASS|FAIL|SKIP) check_", x)]
t("每支都有一行,py 再 js、各自字母序", lines == sorted(FIXTURES, key=lambda n: (n.endswith(".js"), n)), lines)
t("紅的那支帶 exit code", "FAIL check_b_red.py  (exit 3)" in out4, out4)
t("逾時記紅、講原因", "FAIL check_g_hang.py  (逾時 2 秒)" in out4, out4)
t("只有 SKIP 行的那支是 SKIP,不是 PASS", "SKIP check_c_only_skip.py  api 不在旁邊" in out4 and "PASS check_c_only_skip" not in out4, out4)
t("沒有輸出的測試算綠(不是 SKIP)", "PASS check_h_silent.py" in out4, out4)
t("綠裡面的 SKIP 段照算,Electron 段分開", "PASS check_d_part_skip.py  (SKIP 1 段)" in out4, out4)
t("總結:7 綠 3 紅 1 SKIP", "11 支:7 綠 / 3 紅 / 1 整支 SKIP" in out4, out4)
t("綠裡面:部分 SKIP 與 Electron 段各 1 支", "綠的裡面:1 支有段落 SKIP、1 支的 Electron 段沒跑" in out4, out4)

rc, out = run("a_pass", "z_js.js")
t("全綠:exit 0,只跑點名的", rc == 0 and "2 支:2 綠 / 0 紅 / 0 整支 SKIP" in out, out)
rc, out = run("c_only_skip")
t("只有 SKIP:exit 0,但報 SKIP 不報綠", rc == 0 and "1 支:0 綠 / 0 紅 / 1 整支 SKIP" in out and "整支 SKIP:check_c_only_skip.py" in out, out)
rc, out = run("no_such_test")
t("一支都沒排到:非 0", rc == 1, (rc, out))
rc, out = run("z_js_red")
t("最後一支才紅也非 0", rc == 1 and "紅:check_z_js_red.js" in out, (rc, out))

p1, p2 = (json.load(open(os.path.join(seen, n))) for n in ("check_e_probe1.py", "check_e_probe2.py"))
t("每支自己的 TMPDIR", p1["tmp"] != p2["tmp"] and os.path.dirname(p1["tmp"]) == os.path.dirname(p2["tmp"]), (p1, p2))
t("crontab 是 runner 自帶的假的", p1["crontab"].startswith(os.path.dirname(p1["tmp"])), p1)
t("BLAVE_HOME 沒設時落在暫存目錄", (p1["blave_home"] or "").startswith(os.path.dirname(p1["tmp"])) or "BLAVE_HOME" in os.environ, p1)
t("GIT_OPTIONAL_LOCKS=0;BLAVE_TEST_WINDOW 帶進來也清掉", p1["locks"] == "0" and p1["window"] is None, p1)
t("暫存目錄跑完就刪", not os.path.exists(os.path.dirname(p1["tmp"])), p1)
pid = int(open(os.path.join(seen, "orphan.pid")).read())
alive = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
t("測試留下的背景行程跟著收掉", alive == "" or alive.startswith("Z"), alive)

# 序列段跑到一半收到 SIGTERM:那支的 process group 要先收掉,不能在刪掉的暫存目錄上繼續跑
iroot = tempfile.mkdtemp(prefix="run-all-int-")
itests = os.path.join(iroot, "tests")
os.makedirs(itests)
shutil.copy(os.path.join(HERE, "_run_all.py"), itests)
pidfile = os.path.join(iroot, "serial.pid")
with open(os.path.join(itests, "check_tw_lots.py"), "w") as f:  # SERIAL 裡的名字
    f.write(f"import os, time\nopen({pidfile!r}, 'w').write(str(os.getpid()))\ntime.sleep(90)\n")
runner = subprocess.Popen([sys.executable, os.path.join(itests, "_run_all.py")], cwd=iroot, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, env=dict(os.environ, BLAVE_TEST_TIMEOUT="120"))
import time  # noqa: E402

deadline = time.time() + 30
while not os.path.exists(pidfile) and time.time() < deadline:
    time.sleep(0.05)
started = os.path.exists(pidfile)
runner.terminate()
rrc = runner.wait(30)
child = int(open(pidfile).read()) if started else None
time.sleep(0.3)
state = subprocess.run(["ps", "-o", "stat=", "-p", str(child)], capture_output=True, text=True).stdout.strip() if child else "?"
t("序列段收到 SIGTERM:runner 回 130,那支測試已經不在", started and rrc == 130 and (state == "" or state.startswith("Z")),
  (started, rrc, state))
if child and state and not state.startswith("Z"):
    os.kill(child, 9)
shutil.rmtree(iroot, ignore_errors=True)

shutil.rmtree(root, ignore_errors=True)
print(("\n%d 紅" % red) if red else "\nALL PASS")
sys.exit(1 if red else 0)

"""Minimal check: a scheduled report on a cloud machine runs an agent turn first and falls back to
run.py (the data-only report) with the reason in the footnote. Only jobs the user consented to
(agent_consent) wake the agent, on the user's current model; one attempt per job per day, failed
ones included; the reason comes from structured facts, never the reply text; a real timeout is
survived; three degraded runs in a row notify through report_degraded (not for balance). The
desktop keeps its data-only runs this version, and records a slot missed while the app was closed.

Run: cd blave-agent && .venv/bin/python tests/check_report_runner_agent.py
"""
import ast
import json
import os
import sys
import tempfile
import time
from datetime import datetime
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="sched-")
WS = os.path.join(TMP, "workspace")
os.makedirs(os.path.join(WS, "reports"))
os.makedirs(os.path.join(TMP, "state"))
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_REPORT_PACKS"] = "off"   # 每格自己的假資料:不重用上一格留下的 pack(重用另有一格驗)
os.environ["BLAVE_AGENT_STATE"] = os.path.join(TMP, "state")
for k in ("BLAVE_AGENT_LOCAL", "BLAVE_REPORT_DEGRADED", "BLAVE_TURN_MODEL", "BLAVE_SCHEDULED_JOB"):
    os.environ.pop(k, None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import report_runner as R
# 付費雲端機:api 每次輪詢都寫 turn_limits.json;沒有這個檔 = 還不知道 = 不叫 agent(另有一格驗)
PAID_LIMITS = {"max_turns": 2, "trial": False}
json.dump(PAID_LIMITS, open(R.LIMITS_PATH, "w"))

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


RUN_PY = ("import json, os, sys\n"
          "rid = sys.argv[0].split(os.sep)[-2] + '-auto'\n"
          "json.dump({'degraded': os.environ.get('BLAVE_REPORT_DEGRADED')},"
          " open(os.path.join('reports', rid + '.json'), 'w'))\n")


def make_job(job_id, consent=True):
    d = os.path.join(WS, "report_jobs", job_id)
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "run.py"), "w").write(RUN_PY)
    now = int(time.time())
    doc = {"id": job_id, "title": "台股晨報", "prompt": "每天早上給我台股晨報",
           "schedule": {"human": "每天 08:30", "cron": "30 8 * * *", "tz": "Asia/Taipei"},
           "enabled": True, "created_at": now - 86400 * 3, "updated_at": now - 86400 * 3, "pending": None}
    if consent:
        doc["agent_consent"] = True
    json.dump(doc, open(os.path.join(d, "job.json"), "w"))
    return d


def runs(d):
    return [json.loads(l) for l in open(os.path.join(d, "runs.jsonl")) if l.strip()]


def data_report(job_id):
    return json.load(open(os.path.join(WS, "reports", job_id + "-auto.json")))


def publish_as_agent(job_id, rid):
    """What lib.report.write_report does in a scheduled turn: the report + the .published marker."""
    json.dump({"narrated": True}, open(os.path.join(WS, "reports", rid + ".json"), "w"))
    open(os.path.join(WS, "report_jobs", job_id, ".published"), "a").write(rid + "\n")


def result(job_id, **kw):
    json.dump(kw, open(R.sched_result_path(job_id), "w"))


alerts, notices, calls = [], [], []
R._alert = lambda job_id, rc, tail, interp, env: alerts.append((job_id, rc))
real_notify = R._notify_degraded
R._notify_degraded = lambda job, reason, count, interp, env: notices.append((job["id"], reason, count))
real_cloud = R._agent_turn_cloud


def fake(fn):
    def f(job, model, on_start=lambda: None):
        calls.append((job["id"], model))
        r = fn(job)
        if r[0]:
            on_start()
        return r
    return f


# ── agent first, on the user's model right now ──
json.dump({"_last": "anthropic/claude-sonnet-5", "web-1": "deepseek/x"}, open(R.MODEL_PREFS_PATH, "w"))
d = make_job("morning")
R._agent_turn_cloud = fake(lambda job: (publish_as_agent(job["id"], "tw-market-20260926"), (True, False, "done"))[1])
rc = R.run_job("morning")
e = runs(d)[-1]
check(rc == 0 and e["mode"] == "agent" and e["report_ids"] == ["tw-market-20260926"] and e["agent_attempted"]
      and calls[-1] == ("morning", "anthropic/claude-sonnet-5") and not os.path.exists(os.path.join(WS, "reports", "morning-auto.json")),
      "agent 發出有判讀的報告:mode=agent、run.py 不跑、模型用當下偏好(_last),不是登記時的")

# ── no consent (every job registered before this version): data-only, no footnote, no agent ──
calls.clear()
dn = make_job("legacy", consent=False)
R.run_job("legacy")
check(not calls and runs(dn)[-1].get("agent_skipped") == "no_consent" and data_report("legacy")["degraded"] is None,
      "沒有 agent_consent 的舊 job:不叫 agent、不扣點、純資料版不加尾註")

# ── fallbacks: the reason comes from structured facts only ──
for job_id, fn, want in (
        ("t-balance", lambda j: (result(j["id"], fault="not_started_upstream", api_error_status=402), (True, False, "…"))[1], "balance"),
        ("t-budget", lambda j: (result(j["id"], subtype="error_max_budget_usd"), (True, False, "…"))[1], "budget"),
        ("t-fault", lambda j: (result(j["id"], fault="partial"), (True, False, "…"))[1], "failed"),
        ("t-noreport", lambda j: (True, False, "回覆裡寫了成交量 402 億、timed out 之類的字"), "no_report"),
        ("t-timeout", lambda j: (True, True, "x"), "timeout"),
        ("t-busy", lambda j: (False, False, "[report_runner] no free turn slot"), "busy"),
        ("t-autoonly", lambda j: (publish_as_agent(j["id"], j["id"] + "-x-auto"), (True, False, "done"))[1], "no_report")):
    dj = make_job(job_id)
    R._agent_turn_cloud = fake(fn)
    rc = R.run_job(job_id)
    e = runs(dj)[-1]
    check(rc == 0 and e["status"] == "ok" and e["mode"] == "data" and e["degraded"] == want
          and data_report(job_id)["degraded"] == want and bool(e.get("agent_attempted")) == (want != "busy"),
          f"agent 沒完成({want}):照樣產出純資料版,尾註拿到原因;回覆文字裡的字不影響判斷")

# ── daily cap counts attempts, failed ones too ──
calls.clear()
R.run_job("t-fault")
e = runs(os.path.join(WS, "report_jobs", "t-fault"))[-1]
check(not calls and e["degraded"] == "daily_cap" and data_report("t-fault")["degraded"] == "daily_cap",
      "同一天第二次(前一次是失敗的 agent 回合):不再叫 agent,daily_cap")
calls.clear()
R.run_job("t-busy")
check(len(calls) == 1, "等不到名額(沒起回合)不算次數,下一次還會試")

# N1:計次不靠 runs.jsonl(它只留最後 50 行)
dj = os.path.join(WS, "report_jobs", "t-fault")
lines = runs(dj)
lines += [dict(lines[-1], degraded="daily_cap", agent_attempted=False) for _ in range(60)]
open(os.path.join(dj, "runs.jsonl"), "w").write("\n".join(json.dumps(l) for l in lines[-50:]) + "\n")
calls.clear()
R._agent_turn_cloud = fake(lambda j: (True, False, ""))
R.run_job("t-fault")
check(not calls and runs(dj)[-1]["degraded"] == "daily_cap", "那一次 attempt 被 runs.jsonl 截尾擠掉之後,同一天仍是 daily_cap(計數在 .agent_day)")

# N7:回合起跑後 runner 被殺,這一次也已經記上
dk = make_job("t-killed")
def killed(job, model, on_start=lambda: None):
    on_start()
    raise KeyboardInterrupt
R._agent_turn_cloud = killed
try:
    R.run_job("t-killed")
except KeyboardInterrupt:
    pass
calls.clear()
R._agent_turn_cloud = fake(lambda j: (True, False, ""))
R.run_job("t-killed")
check(not calls and runs(dk)[-1]["degraded"] == "daily_cap", "起跑前就寫 .agent_day:runner 中途被殺,那一次照樣算數")

# ── Q2: only what run.py wrote counts as the fallback's reports ──
dq = make_job("t-window")
def _other(j):
    p = os.path.join(WS, "reports", "someone-else.json")
    time.sleep(1.1)
    json.dump({}, open(p, "w"))   # agent 回合期間(資料版起跑之前)別處寫的
    time.sleep(1.1)
    return True, False, ""


R._agent_turn_cloud = fake(_other)
R.run_job("t-window")
ids = runs(dq)[-1]["report_ids"]
check("t-window-auto" in ids and "someone-else" not in ids, "資料版的 report_ids 只算 run.py 那一段寫的(不含 agent 回合期間別處寫的)")

# ── the agent path crashing still ends in the data report ──
dc = make_job("t-crash")
R._agent_turn_cloud = fake(lambda j: 1 / 0)
rc = R.run_job("t-crash")
check(rc == 0 and runs(dc)[-1]["degraded"] == "failed" and data_report("t-crash")["degraded"] == "failed",
      "agent 那段整個丟例外:照樣跑到純資料版")

# ── three degraded runs in a row → report_degraded once; balance never counts ──
def shift(dj):
    lines = runs(dj)
    for l in lines:
        l["started_at"] -= 86400 * 2
    open(os.path.join(dj, "runs.jsonl"), "w").write("\n".join(json.dumps(l) for l in lines) + "\n")
    try:
        os.remove(os.path.join(dj, ".agent_day"))   # 換了一天
    except OSError:
        pass


for job_id, fn, want in (("t-streak", lambda j: (True, False, ""), 1),
                         ("t-poor", lambda j: (result(j["id"], api_error_status=402), (True, False, ""))[1], 0)):
    dj = make_job(job_id)
    R._agent_turn_cloud = fake(fn)
    notices.clear()
    for _ in range(3):
        if os.path.exists(os.path.join(dj, "runs.jsonl")):
            shift(dj)
        R.run_job(job_id)
    check(len([n for n in notices if n[0] == job_id]) == want and not [a for a in alerts if a[0] == job_id],
          f"連續 3 次降級({'no_report' if want else 'balance'}):report_degraded {'發一次' if want else '不發(餘額不足只寫尾註)'},不走 strategy_failed")

# N8:通知送不出去就不進冷卻
dn8 = make_job("t-notify")
job8 = json.load(open(os.path.join(dn8, "job.json")))
stamp = os.path.join(dn8, ".degraded_alert")
real_notify(job8, "timeout", 3, sys.executable, {**os.environ, "PYTHONPATH": WS})   # workspace 沒有 lib.events → emit 失敗
check(not os.path.exists(stamp), "report_degraded 送不出去:不寫冷卻戳記(下一次還會再試)")
os.makedirs(os.path.join(WS, "lib"), exist_ok=True)
open(os.path.join(WS, "lib", "__init__.py"), "w").close()
open(os.path.join(WS, "lib", "events.py"), "w").write("def emit(t, **k):\n    return True\n")
real_notify(job8, "timeout", 3, sys.executable, {**os.environ, "PYTHONPATH": WS})
check(os.path.exists(stamp), "送出成功才寫冷卻戳記")
# ── real subprocess: an agent_turn that overruns the timeout ──
R._agent_turn_cloud = real_cloud
fake_rt = os.path.join(TMP, "fake_runtime")
os.makedirs(fake_rt)
open(os.path.join(fake_rt, "agent_turn.py"), "w").write(
    "import sys, time\nsys.stderr.write('[agent_turn] working\\n'); sys.stderr.flush()\ntime.sleep(60)\n")
R.__file__ = os.path.join(fake_rt, "report_runner.py")
R.AGENT_TIMEOUT_S, R.AGENT_STOP_GRACE_S = 2, 1
dt = make_job("t-real")
t0 = time.time()
rc = R.run_job("t-real")
e = runs(dt)[-1]
check(rc == 0 and e["degraded"] == "timeout" and data_report("t-real")["degraded"] == "timeout" and time.time() - t0 < 20
      and not os.listdir(R.SLOTS_DIR) and json.load(open(os.path.join(dt, ".agent_day")))["n"] == 1,
      "真的子行程逾時(stdout 是 bytes):不崩,停止旗標→硬殺,名額還回去,純資料版帶 timeout")
# 排程回合拿到的指令:報告語言照用戶的話(包裝句是英文,09-26 模擬整份變英文)、pack 的確切呼叫、雲端用 WebSearch/WebFetch
argv_out = os.path.join(TMP, "argv.json")
open(os.path.join(fake_rt, "agent_turn.py"), "w").write(
    f"import json, sys\njson.dump(sys.argv, open({argv_out!r}, 'w'))\n")
R.AGENT_TIMEOUT_S = 20
dl = make_job("t-lang")
open(os.path.join(dl, "run.py"), "w").write("from lib.report_templates import crypto_market_brief, publish\n"
                                            "pack = crypto_market_brief(symbols=('BTC', 'ETH'))\npublish(pack)\n")
R.run_job("t-lang")
argv = json.load(open(argv_out))
prompt = argv[-1]
check("--ui-lang=zh" in argv and "pack = crypto_market_brief(symbols=('BTC', 'ETH'), extra=[...]); print(pack.describe())" in prompt
      and "WebSearch" in prompt and "WebFetch" in prompt and 'title=' in prompt and "summary is required" in prompt
      and "do not read lib/ or references/" in prompt,
      "排程回合:--ui-lang=zh(用戶用中文登記)、prompt 給 pack 的確切呼叫、雲端走 WebSearch/WebFetch、publish 要 title、summary 必填、不讀 lib")
json.dump({"_last": "deepseek/deepseek-v4-pro"}, open(R.MODEL_PREFS_PATH, "w"))
dds = make_job("t-lang-ds")
R.run_job("t-lang-ds")
dprompt = json.load(open(argv_out))[-1]
check("WebFetch only" in dprompt and "WebSearch" not in dprompt
      and "https://news.cnyes.com/news/cat/headline" in dprompt
      and "--model=deepseek/deepseek-v4-pro" in json.load(open(argv_out)),
      "當下偏好是 DeepSeek:真正起的回合(argv)拿到的是 WebFetch 版 prompt,不是 Claude 版")
json.dump({"_last": "anthropic/claude-sonnet-5", "web-1": "deepseek/x"}, open(R.MODEL_PREFS_PATH, "w"))
import shutil as _sh
_sh.rmtree(dds, ignore_errors=True)
ds = R.scheduled_prompt(json.load(open(os.path.join(dl, "job.json"))), "deepseek/deepseek-v4-pro")
OTHER_HOSTS = ("coindesk.com", "cointelegraph.com", "decrypt.co", "money.udn.com", "moneydj.com")
FIXED_SOURCES = ("https://news.cnyes.com/news/cat/headline",
                 "https://news.cnyes.com/news/cat/bc_crypto",
                 "https://www.twse.com.tw/rwd/zh/news/newsList?response=json",
                 "https://www.taifex.com.tw/cht/11/announcement",
                 "https://www.binance.com/en/support/announcement",
                 "https://www.okx.com/help/section/announcements-latest-announcements")
check("WebSearch" not in ds and "WebFetch" in ds and "licensed" in ds
      and all(u in ds for u in FIXED_SOURCES)
      and all(h in ds for h in OTHER_HOSTS) and ds.index("news.cnyes.com") < ds.index("coindesk.com")
      and "forbid" not in ds and "do not fetch" not in ds and "robots" not in ds
      and "few_sources" in ds and "switching model" in ds,
      "DeepSeek 排程 prompt:優先清單=鉅亨兩個授權列表頁+TWSE/TAIFEX/Binance/OKX 公告頁+授權候選連結,"
      "其他新聞站排在後面當備援;沒有「對方條款 / robots 禁 AI 所以不抓」的句子(Wei 09-28);"
      "湊不滿 3 站走 few_sources 照發,絕不提換模型")
check(R.scheduled_prompt({"id": "x", "title": "t", "prompt": "p"}, None).count("WebFetch only") == 1
      and "WebSearch" in R.scheduled_prompt({"id": "x", "title": "t", "prompt": "p"}, "anthropic/claude-sonnet-5"),
      "沒有模型偏好(預設 DeepSeek)走 WebFetch 版;Claude 模型照舊 WebSearch 版")
check(R._degrade_reason(True, False, {"subtype": "error_max_budget_usd"}) == "budget"
      and R._degrade_reason(True, False, {"subtype": "error_max_budget_usd", "cost_untrusted": True}) == "no_report",
      "降級原因:budget 只在 CLI 成本可信時算;非 Anthropic 模型(cost_untrusted)那個 budget 是錯的價目表,不當 budget")
check(R.job_lang({"prompt": "每天给我加密市场晨报"}) == "cn" and R.job_lang({"prompt": "daily crypto brief"}) is None
      and R.job_lang({"prompt": "每天給我台股晨報"}) == "zh", "報告語言:繁中 zh、简中 cn、英文不指定")
os.makedirs(os.path.join(WS, "report_jobs", "t-rec"), exist_ok=True)
open(os.path.join(WS, "report_jobs", "t-rec", "recipe.json"), "w").write("{}")
check('build(load_recipe("report_jobs/t-rec/run.py"), extra=[...])' in R._pack_call({"id": "t-rec"}), "自組配方:給 build(load_recipe(...)) 的呼叫")
R.AGENT_TIMEOUT_S = 2
# 收盤報告 job 碰到休市(稽核 0.1.7 P1-2):不起回合、不花預算、不算次數;雲端 run.py 也帶排程旗標
R._agent_turn_cloud = fake(lambda j: (_ for _ in ()).throw(AssertionError("休市日不該起回合")))
dc = make_job("t-close")
open(os.path.join(dc, "run.py"), "w").write("from lib.report_templates import tw_close_brief, publish\npublish(tw_close_brief())\n")
sat = int(datetime(2026, 9, 26, 15, 0, tzinfo=ZoneInfo("Asia/Taipei")).timestamp())      # 週六
res = R._try_agent(json.load(open(os.path.join(dc, "job.json"))), dc, sat, sys.executable, {})
check(res.get("agent_skipped") == "market_closed" and not os.path.exists(os.path.join(dc, ".agent_day")),
      "收盤報告 job 週六:agent_skipped=market_closed,沒起回合、沒記次數")
fake_ws = tempfile.mkdtemp(prefix="closews-")
os.makedirs(os.path.join(fake_ws, "lib"))
open(os.path.join(fake_ws, "lib", "__init__.py"), "w").close()
open(os.path.join(fake_ws, "lib", "data.py"), "w").write("def is_tw_trading_day(d, h):\n    return d != '2026-10-06'\n")
open(os.path.join(fake_ws, "lib", "report_templates.py"), "w").write("def headers_from_env():\n    return {}\n")
saved_ws, R.WORKSPACE = R.WORKSPACE, fake_ws
hol = int(datetime(2026, 10, 6, 15, 0, tzinfo=ZoneInfo("Asia/Taipei")).timestamp())      # 平日但休市表列休市
wk = int(datetime(2026, 10, 7, 15, 0, tzinfo=ZoneInfo("Asia/Taipei")).timestamp())
check(R._market_closed({}, dc, hol, sys.executable, {"PATH": os.environ["PATH"]})
      and not R._market_closed({}, dc, wk, sys.executable, {"PATH": os.environ["PATH"]})
      and not R._market_closed({}, make_job("t-notclose"), hol, sys.executable, {"PATH": os.environ["PATH"]}),
      "平日休市(問 workspace 的 is_tw_trading_day)才跳過;交易日照跑;非收盤報告的 job 不查")
R.WORKSPACE = saved_ws
import shutil
for j in ("t-close", "t-notclose", "t-lang", "t-rec"):     # 一台機器最多 20 個 job:測完就拿掉
    shutil.rmtree(os.path.join(WS, "report_jobs", j), ignore_errors=True)
saved_local = os.environ.pop("BLAVE_AGENT_LOCAL", None)
cloud_env = R._subprocess_env()
check(cloud_env.get("BLAVE_SCHEDULED_RUN") == "1" and "BLAVE_AGENT_LOCAL" not in cloud_env,
      "雲端 run.py 的環境也帶 BLAVE_SCHEDULED_RUN=1(不帶 BLAVE_AGENT_LOCAL,免 key 分支不會誤走)")
if saved_local is not None:
    os.environ["BLAVE_AGENT_LOCAL"] = saved_local
check(R._STREAK_NEUTRAL == ("daily_cap", "balance") and R._consecutive_degraded.__code__.co_names.count("get") >= 1,
      "休市在起回合前就跳過(agent_skipped,不算連續降級);no_report 仍算——回合跑了卻沒出報告連三天要通知")
json.dump({"max_turns": 1, "trial": True}, open(R.LIMITS_PATH, "w"))
t0 = time.time()
dtr = make_job("t-trial")
R.run_job("t-trial")
e = runs(dtr)[-1]
check(e.get("agent_skipped") == "single_slot" and "degraded" not in e and data_report("t-trial")["degraded"] is None
      and time.time() - t0 < 5, "試用機(單一名額):不叫 agent,中性(不加尾註、不算降級、不通知、不計次)")
notices.clear()
for _ in range(3):
    shift(dtr)
    R.run_job("t-trial")
check(not notices, "試用機連續幾天都一樣:不發 report_degraded")
json.dump(PAID_LIMITS, open(R.LIMITS_PATH, "w"))

# on_start 寫不進 .agent_day:不起回合、名額還回去、退回純資料版
R._agent_turn_cloud = real_cloud
R.AGENT_TIMEOUT_S = 2
real_count = R._count_attempt
R._count_attempt = lambda *a: (_ for _ in ()).throw(OSError("disk full"))
dos = make_job("t-onstart")
rc = R.run_job("t-onstart")
R._count_attempt = real_count
check(rc == 0 and runs(dos)[-1]["degraded"] == "failed" and data_report("t-onstart")["degraded"] == "failed"
      and not os.listdir(R.SLOTS_DIR), "寫 .agent_day 失敗:不起回合、名額馬上還回去、純資料版")

# 試用轉付費:排程從不能叫 agent 變成可以 → 沒同意的 job 記 P3、下一份尾註一句、只講一次;不自動開
emitted = []
real_emit = R._emit
R._emit = lambda interp, env, t, **f: emitted.append((t, f)) or True
json.dump({"max_turns": 1, "trial": True}, open(R.LIMITS_PATH, "w"))
for f in (R.AVAIL_STATE_PATH,):
    if os.path.exists(f):
        os.remove(f)
du = make_job("t-upgrade", consent=False)
R.run_job("t-upgrade")
check(open(R.AVAIL_STATE_PATH).read() == "0" and not emitted and data_report("t-upgrade")["degraded"] is None,
      "試用中:只記狀態,不發任何東西")
R.run_job("t-upgrade")
check(not emitted and not os.path.exists(os.path.join(du, R.UPGRADE_NOTE)), "仍在試用(不可用→不可用):不發、不標")
os.remove(R.LIMITS_PATH)
R.run_job("t-upgrade")
check(not emitted and open(R.AVAIL_STATE_PATH).read() == "0", "讀不到 turn_limits.json:不當成可用、不記狀態、不發")
json.dump({"max_turns": 2, "trial": False}, open(R.LIMITS_PATH, "w"))
calls.clear()
R._agent_turn_cloud = fake(lambda j: (True, False, ""))
R.run_job("t-upgrade")
up = [f for t, f in emitted if t == "report_agent_available"]
check({"job": "t-upgrade"} in up and not calls and not os.path.exists(os.path.join(du, R.UPGRADE_NOTE))
      and runs(du)[-1].get("agent_skipped") == "no_consent",
      "升級後第一次:沒同意的 job 記 P3、不自動叫 agent、不扣費;尾註講過就把標記收掉")
emitted.clear()
R.run_job("t-upgrade")
check(not emitted and open(R.AVAIL_STATE_PATH).read() == "1", "之後不再重發")
json.dump(PAID_LIMITS, open(R.LIMITS_PATH, "w"))
R._emit = real_emit
# 尾註那一句:BLAVE_REPORT_NOTE 由 publish() 轉成尾註
sys.path.insert(0, ROOT)
import lib.report_templates as T0
os.environ["BLAVE_REPORT_NOTE"] = "agent_available"
pk0 = T0.Pack("upg", "t", "morning", "t", [T0.kpi_row([T0.kpi("a", "1")]), T0.footnote([("s", "口徑")])], {})
items = json.load(open(T0.publish(pk0)))["blocks"][-1]["items"]
os.environ.pop("BLAVE_REPORT_NOTE")
check(any("跟 agent 說一聲就能開" in i["text"] for i in items), "升級提示進尾註")
# _emit:emit 回 None(沒寫進事件檔)= 失敗
os.makedirs(os.path.join(WS, "lib"), exist_ok=True)
open(os.path.join(WS, "lib", "__init__.py"), "a").close()
open(os.path.join(WS, "lib", "events.py"), "w").write("def emit(t, **k):\n    return None\n")
check(not real_emit(sys.executable, {**os.environ, "PYTHONPATH": WS}, "report_degraded", job="x"),
      "emit 回 None(事件沒寫進去):當成送失敗,不進冷卻")
open(os.path.join(WS, "lib", "events.py"), "w").write("def emit(t, **k):\n    return 1\n")
check(real_emit(sys.executable, {**os.environ, "PYTHONPATH": WS}, "report_degraded", job="x"), "emit 回 id:送成功")

# ── desktop: data-only this version; missed slots recorded ──
os.environ["BLAVE_AGENT_LOCAL"] = "1"
calls.clear()
R._agent_turn_cloud = fake(lambda j: (True, False, ""))
dd = make_job("desk")
R.run_job("desk")
check(not calls and runs(dd)[-1].get("agent_skipped") == "desktop" and data_report("desk")["degraded"] is None,
      "電腦版排程這版照舊只出純資料版(不叫 agent、不寫請求檔、不加尾註)")
dm = make_job("desk-missed")
now = int(time.time())
check(R.record_missed("desk-missed", 0, now) and runs(dm)[-1]["reason"] == "app_closed"
      and not R.record_missed("desk-missed", 0, now), "app 關著時錯過的那一格:記一筆 skipped/app_closed,不補跑、不重記")
dz = make_job("desk-nots")
job = json.load(open(os.path.join(dz, "job.json")))
job["updated_at"] = 0
json.dump(job, open(os.path.join(dz, "job.json"), "w"))
check(not R.record_missed("desk-nots", 0, now), "沒有起點(updated_at 0、沒跑過):不從 1970 年補記")
os.environ.pop("BLAVE_AGENT_LOCAL")

# ── agent_turn: --scheduled (SDK not installed here: read the source) ──
at = open(os.path.join(ROOT, "runtime", "agent_turn.py"), encoding="utf-8").read()
tree = ast.parse(at)
consts = {t.id: ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
          for t in n.targets if isinstance(t, ast.Name) and t.id.startswith("SCHEDULED_")}
check("_RESUME_MIN_TURNS == 0 and TURN_MAX_TURNS - spent_turns < 1" in at,
      "排程回合步數用完就不續跑(max_turns=0 對 SDK 是沒有上限)")
rr = open(os.path.join(ROOT, "runtime", "report_runner.py"), encoding="utf-8").read()
check("proc.communicate(timeout=10)" in rr, "硬殺之後讀輸出最多等 10 秒(被放過的孫行程握著 stdout 也不卡住 runner)")
check(consts.get("SCHEDULED_MAX_BUDGET_USD") == 1.0 and "Edit(/strategies/**)" in consts.get("SCHEDULED_EDIT_RULES", [])
      and "_RESUME_MIN_TURNS = 0" in at and "_write_sched_outcome()" in at and '"report"]' in at
      and "ss.clear_session(args.session_id)" in at,
      "agent_turn --scheduled:1.0 USD、續跑不加步數、Edit/Write 擋 strategies/ control/、寫結構化結果、每次清空 session")

# ── lib half ──
sys.path.insert(0, ROOT)
os.environ["BLAVE_TURN_MODEL"] = "deepseek/deepseek-v4-pro"
from lib import report as LR
LR.JOBS_DIR = os.path.join(WS, "report_jobs")
_limits = os.path.join(TMP, "state", "turn_limits.json")
if os.path.exists(_limits):
    os.remove(_limits)
try:
    LR.register_schedule("lib-nolimits", "t", "p", "30 8 * * *", "h", "x", tz="Asia/Taipei", agent_consent=True)
    check(False, "沒有 turn_limits.json 應拒")
except ValueError as e:
    check("data-only" in str(e) and not LR.scheduled_agent_available(),
          "沒有 turn_limits.json(試用機可能還沒寫):不當成可用,agent_consent 不收(稽核 P2-3)")
json.dump({"max_turns": 2, "trial": False}, open(_limits, "w"))
jd = LR.register_schedule("lib-job", "t", "p", "30 8 * * *", "每天 08:30", "print(1)", tz="Asia/Taipei", agent_consent=True)
doc = json.load(open(os.path.join(jd, "job.json")))
jd2 = LR.register_schedule("lib-job2", "t", "p", "30 8 * * *", "每天 08:30", "print(1)", tz="Asia/Taipei")
check(doc.get("agent_consent") is True and "model" not in doc and "agent_consent" not in json.load(open(os.path.join(jd2, "job.json")))
      and LR.scheduled_cost() == (0.5, 1) and LR.scheduled_cost("anthropic/claude-sonnet-5-5") == (12, 18),
      "register_schedule:同意才記 agent_consent、不記模型;估價依當下模型")
os.environ["BLAVE_SCHEDULED_JOB"] = "lib-job"
LR.write_report("lib-job-20260926", "t", [{"type": "text", "markdown": "x"}], type="morning")
os.environ.pop("BLAVE_SCHEDULED_JOB")
check(open(os.path.join(jd, ".published")).read() == "lib-job-20260926\n", "write_report 在排程回合記下產出的報告 id")
LR.register_schedule("lib-job", "t2", "p", "0 9 * * *", "每天 09:00", "print(2)", tz="Asia/Taipei")
check(json.load(open(os.path.join(jd, "job.json"))).get("agent_consent") is True, "重新登記沒帶 agent_consent:沿用舊值(網頁編輯不會悄悄丟掉同意)")
LR.register_schedule("lib-job", "t2", "p", "0 9 * * *", "每天 09:00", "print(2)", tz="Asia/Taipei", agent_consent=False)
check("agent_consent" not in json.load(open(os.path.join(jd, "job.json"))), "明確 agent_consent=False:撤銷")
for cron, why in (("*/5 * * * *", "每 5 分鐘"), ("0,30 * * * *", "一小時兩次")):
    try:
        LR.register_schedule("lib-fast", "t", "p", cron, "h", "x", tz="Asia/Taipei", agent_consent=True); check(False, why)
    except ValueError as e:
        check("at most hourly" in str(e) and not os.path.exists(os.path.join(LR.JOBS_DIR, "lib-fast", "job.json")),
              f"同意叫 agent 的 job 最密每小時一次({why}要拒,而且不留半份檔)")
json.dump({"max_turns": 1, "trial": True}, open(os.path.join(TMP, "state", "turn_limits.json"), "w"))
try:
    LR.register_schedule("lib-trial", "t", "p", "30 8 * * *", "h", "x", tz="Asia/Taipei", agent_consent=True); check(False, "trial")
except ValueError as e:
    check("data-only" in str(e) and not LR.scheduled_agent_available(), "試用機:不收 agent_consent(R8 直接講排程是數據版)")
os.remove(os.path.join(TMP, "state", "turn_limits.json"))
import lib.report_templates as T
os.environ["BLAVE_REPORT_DEGRADED"] = "daily_cap"
pk = T.Pack("deg", "t", "morning", "t", [T.kpi_row([T.kpi("a", "1")]), T.footnote([("s", "口徑")])], {})
foot = json.load(open(T.publish(pk)))["blocks"][-1]["items"]
check(any(i["id"] == "auto" and "已請 AI 整理過一次" in i["text"] for i in foot), "publish:降級的純資料版尾註一句原因")
os.environ.pop("BLAVE_REPORT_DEGRADED")
check(not any(i["id"] == "auto" for i in json.load(open(T.publish(pk, report_id="deg2")))["blocks"][-1]["items"]),
      "沒有降級:不多這一行")

import turn_slots as TS
_had = os.path.exists(R.LIMITS_PATH)
if _had:
    _keep = open(R.LIMITS_PATH).read(); os.remove(R.LIMITS_PATH)
check(R.single_slot() and R.SLOTS_DIR == TS.SLOTS_DIR and R.LIMITS_PATH == TS.LIMITS_PATH
      and not any(hasattr(R, n) for n in ("_limits", "_live_slots", "_mem_available_mb", "SLOT_STALE_S", "LOW_MEM_MB")),
      "名額跟 bridge 共用 turn_slots(沒有第二份);沒有 turn_limits.json 當成單一名額,不叫 agent")
if _had:
    open(R.LIMITS_PATH, "w").write(_keep)
print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)

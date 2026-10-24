"""write_report 寫檔前先問平台的驗證器(api POST …/report/<id>/validate)。No network.

10-24 實測:報告少一個欄位被 api 退件,但 write_report 已經回傳、agent 已經跟用戶說做好了。鎖:
  ① 400 / 413 → ValueError 帶 api 的訊息,磁碟上什麼都沒留(沒有 JSON、沒有 sidecar)
  ② 200 → 照寫;打的是實際寫入的 id、POST、proxy-{token};image 的 file 換成 sha256 才送(api 不認 file)
  ③ 沒有判決就不擋:404(api 還沒部署這支)、401、429、500、連不上、逾時 → 照寫
  ④ 沒有機器 token、電腦版(BLAVE_AGENT_LOCAL=1)、帳號 token(acct-…,漏帶 LOCAL 也一樣)→ 一個請求都不發
  ⑤ api 回 302 → 不跟(urllib 會把 POST 轉 GET、x-api-key 帶去 Location):重導向目標一個請求都沒收到、照寫
     (這條起兩個本機 HTTP server,只連 127.0.0.1)

Run: cd blave-agent && .venv/bin/python tests/check_report_platform_check.py
"""
import contextlib, http.server, io, json, os, shutil, socket, sys, tempfile, threading, urllib.error, urllib.request
TMP = tempfile.mkdtemp(prefix="pcheck-")
os.environ["BLAVE_AGENT_WORKSPACE"] = os.path.join(TMP, "workspace")
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1"
for k in ("BLAVE_AGENT_LOCAL", "BLAVE_TURN_ID", "BLAVE_SCHEDULED_JOB", "BLAVE_REPORT_URL"):
    os.environ.pop(k, None)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import lib.report as R

fails = 0


def check(cond, msg, got=None):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg + ("" if cond or got is None else f"  → {got!r}"))
    fails += (not cond)


calls = []
answer = {"v": 200}


class _Resp:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b'{"status": "ok"}'


def fake_urlopen(req, timeout=None):
    calls.append({"url": req.full_url, "method": req.get_method(), "key": req.get_header("X-api-key"),
                  "body": json.loads(req.data), "timeout": timeout})
    v = answer["v"]
    if isinstance(v, Exception):
        raise v
    if v == 200:
        return _Resp()
    raise urllib.error.HTTPError(req.full_url, v, "x", {}, io.BytesIO(
        json.dumps({"error": "blocks[1].reflines[0]: missing field(s): emphasis"}).encode() if v in (400, 413)
        else b"<html>Not Found</html>"))


real_open = R._OPENER.open
R._OPENER.open = fake_urlopen
BLOCKS = [{"type": "text", "variant": "lead", "markdown": "結論"},
          {"type": "image", "file": "fig.png", "alt": "圖"}]


def write(rid):
    with contextlib.redirect_stdout(io.StringIO()):
        return R.write_report(rid, "標題", list(BLOCKS), images={"fig.png": b"\x89PNG"})


def left_behind(rid):
    return [n for n in (os.listdir(R.REPORTS_DIR) if os.path.isdir(R.REPORTS_DIR) else []) if n.startswith(rid)]


os.environ["BLAVE_PROXY_TOKEN"] = "tok"
for code in (400, 413):
    answer["v"], calls[:] = code, []
    try:
        write(f"r{code}")
        err = None
    except ValueError as e:
        err = str(e)
    check(err is not None and "emphasis" in err and "nothing was written" in err,
          f"① {code} → ValueError 帶 api 的訊息", err)
    check(left_behind(f"r{code}") == [], f"① {code} → 沒有 JSON、沒有 sidecar", left_behind(f"r{code}"))

answer["v"], calls[:] = 200, []
path = write("ok")
c = calls[0] if calls else {}
img = (c.get("body") or {}).get("blocks", [{}] * 3)[2]
check(os.path.isfile(path) and len(calls) == 1, "② 200 → 照寫,一個請求", len(calls))
check(c.get("url") == "https://api.blave.org/openclaw/agent/report/ok/validate" and c.get("method") == "POST"
      and c.get("key") == "proxy-tok" and c.get("timeout") == R.VALIDATE_TIMEOUT_S,
      "② POST …/report/<id>/validate,proxy-{token},短逾時", c)
check("file" not in img and len(img.get("sha256", "")) == 64, "② image 的 file 換成 sha256 才送", img)
with open(path, encoding="utf-8") as f:
    check(json.load(f)["blocks"][2].get("file") == "fig.png", "② 寫進磁碟的那份 file 不變(uploader 才換)")

calls[:] = []
write("ok")   # id 已有報告 → 寫成 ok-2,驗的也要是 ok-2(api 比對 id 與網址)
check(calls and calls[0]["url"].endswith("/report/ok-2/validate") and calls[0]["body"]["id"] == "ok-2",
      "② 驗的是實際寫入的 id", calls and calls[0]["url"])

for v in (404, 401, 429, 500, urllib.error.URLError("offline"), socket.timeout("timed out")):
    answer["v"], calls[:] = v, []
    rid = "nv" + str(len(os.listdir(R.REPORTS_DIR)))
    try:
        p = write(rid)
        ok = os.path.isfile(p)
    except Exception as e:  # noqa: BLE001
        ok = repr(e)
    check(ok is True and len(calls) == 1, f"③ {v!r} → 不擋,照寫", ok)

answer["v"] = 400
os.environ.pop("BLAVE_PROXY_TOKEN")
calls[:] = []
check(os.path.isfile(write("notoken")) and calls == [], "④ 沒有機器 token → 不發請求、照寫")
os.environ["BLAVE_PROXY_TOKEN"] = "tok"
os.environ["BLAVE_AGENT_LOCAL"] = "1"
check(os.path.isfile(write("desktop")) and calls == [], "④ 電腦版 → 不發請求、照寫")
os.environ.pop("BLAVE_AGENT_LOCAL")
os.environ["BLAVE_PROXY_TOKEN"] = "acct-abc"
check(os.path.isfile(write("acct")) and calls == [], "④ 帳號 token(沒帶 BLAVE_AGENT_LOCAL)→ 不發請求、照寫", calls)


def serve(handler_fn):
    hits = []

    class H(http.server.BaseHTTPRequestHandler):
        def _any(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n:
                self.rfile.read(n)
            hits.append((self.command, self.path, self.headers.get("x-api-key")))
            handler_fn(self)
        do_GET = do_POST = do_HEAD = do_PUT = _any

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, hits


def ok200(h):
    h.send_response(200)
    h.send_header("Content-Length", "2")
    h.end_headers()
    h.wfile.write(b"{}")


target, target_hits = serve(ok200)


def redirect(h):
    h.send_response(302)
    h.send_header("Location", f"http://127.0.0.1:{target.server_port}/stolen")
    h.send_header("Content-Length", "0")
    h.end_headers()


origin, origin_hits = serve(redirect)
R._OPENER.open = real_open
os.environ["BLAVE_PROXY_TOKEN"] = "tok"
R.REPORT_URL = f"http://127.0.0.1:{origin.server_port}/openclaw/agent/report"
try:
    p = write("redir")
    ok = os.path.isfile(p)
except Exception as e:  # noqa: BLE001
    ok = repr(e)
check(len(origin_hits) == 1 and origin_hits[0][0] == "POST", "⑤ validate 有打到(本機假 api)", origin_hits)
check(target_hits == [], "⑤ 302 不跟:重導向目標沒收到任何請求(沒有 token 外流)", target_hits)
check(ok is True, "⑤ 302 → 沒有判決,照寫", ok)
origin.shutdown()
target.shutdown()

shutil.rmtree(TMP, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAIL")
sys.exit(1 if fails else 0)

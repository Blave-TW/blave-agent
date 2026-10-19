// 主行程打 api 的 postJSON / getJSON 一律要 gzip(nginx 對 JSON 有開;雲端策略明細 2.4 MB → 640 KB)。跑法:node tests/check_shell_gzip.js
//   gzip 回應解開、非 200 的 status 照給、沒壓的照舊、多位元組字跨塊不壞、壞掉的 gzip 回錯誤(不當機、不卡住)
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const { PassThrough } = require("stream");
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  ← " + String(d).slice(0, 500))); if (!c) red++; };
function fnSrc(src, name) {
  const a = src.indexOf("function " + name + "("); if (a < 0) throw new Error("找不到 " + name);
  let i = src.indexOf("{", a), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(a, i + 1);
}
const helpers = fnSrc(mainSrc, "readJSONResponse");

// 假的 https:回應分兩塊送,切點由 cut(buf) 決定
function fake(name, { status = 200, enc, bytes, cut }) {
  const seen = {};
  const https = { request: (url, o, cb) => {
    seen.opts = o;
    const req = new PassThrough();
    req.end = () => setImmediate(() => {
      const res = new PassThrough(); res.statusCode = status; res.headers = enc ? { "content-encoding": enc } : {};
      cb(res);
      const k = cut ? cut(bytes) : bytes.length;
      res.write(bytes.subarray(0, k)); res.end(bytes.subarray(k));
    });
    return req;
  } };
  const fn = new Function("require", helpers + "\n" + fnSrc(mainSrc, name) + "\nreturn " + name + ";")((m) => (m === "https" ? https : require(m)));
  return { fn, seen };
}
const within = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r({ hang: true }), ms))]);
const call = (name, f) => (name === "postJSON" ? f("https://x/y", { a: 1 }) : f("https://x/y", { h: "1" }));

(async () => {
  const obj = { candles: Array.from({ length: 20000 }, (_, i) => [i, 1, 2, 0.5, 1.5, 1]), note: "中文跨塊測試" };
  const plain = Buffer.from(JSON.stringify(obj), "utf8");
  const gz = zlib.gzipSync(plain);
  const midChar = (b) => b.indexOf(Buffer.from("文")) + 1;   // 切在「文」三個位元組的中間

  for (const name of ["postJSON", "getJSON"]) {
    { const f = fake(name, { enc: "gzip", bytes: gz, cut: (b) => b.length >> 1 }); const r = await within(call(name, f.fn), 3000);
      ok(`${name}:帶 Accept-Encoding: gzip`, f.seen.opts && f.seen.opts.headers["Accept-Encoding"] === "gzip");
      ok(`${name}:gzip 回應解開`, r.v && r.v.status === 200 && (r.v.body.candles || []).length === 20000 && r.v.body.note === obj.note, JSON.stringify(r).slice(0, 200)); }
    { const f = fake(name, { status: 404, enc: "gzip", bytes: zlib.gzipSync(Buffer.from('{"error":"找不到"}')) }); const r = await within(call(name, f.fn), 3000);
      ok(`${name}:gzip 的 404 照給 status 與 body`, r.v && r.v.status === 404 && r.v.body.error === "找不到", JSON.stringify(r)); }
    { const f = fake(name, { bytes: plain, cut: midChar }); const r = await within(call(name, f.fn), 3000);
      ok(`${name}:沒壓的照舊,多位元組字跨塊不壞`, r.v && r.v.status === 200 && r.v.body.note === obj.note, JSON.stringify(r).slice(0, 200)); }
    { const f = fake(name, { enc: "gzip", bytes: Buffer.alloc(0) }); const r = await within(call(name, f.fn), 3000);
      ok(`${name}:空回應 → {}`, r.v && r.v.status === 200 && JSON.stringify(r.v.body) === "{}", JSON.stringify(r)); }
    { const f = fake(name, { enc: "gzip", bytes: Buffer.concat([gz.subarray(0, 40), Buffer.from("garbage-not-gzip")]) }); const r = await within(call(name, f.fn), 3000);
      ok(`${name}:壞掉的 gzip → reject(不卡住)`, !!r.e, JSON.stringify(r).slice(0, 200)); }
    { const f = fake(name, { enc: "br", bytes: Buffer.from("\x1b\x00") }); const r = await within(call(name, f.fn), 3000);
      ok(`${name}:不認得的編碼 → 照原樣當 JSON 解,失敗就 {}`, r.v && r.v.status === 200 && JSON.stringify(r.v.body) === "{}", JSON.stringify(r)); }
  }
  { const f = fake("postJSON", { bytes: Buffer.from("{}") }); await call("postJSON", (u, b) => f.fn(u, b, { timeout: 60000, family: 4 }));
    ok("postJSON:extra 的 timeout / family 照給", f.seen.opts.timeout === 60000 && f.seen.opts.family === 4 && f.seen.opts.method === "POST"); }

  console.log(red ? `\n${red} 紅` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();

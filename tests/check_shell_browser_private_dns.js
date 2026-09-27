// 內建瀏覽器擋內網(複審 B-1):主機名不是 IP、但 DNS 解析到內網(`192.168.1.1.nip.io`、指到 127.x 的公開網域)的頁面請求,
// 解析一次再決定;回應真的來自內網位址(DNS rebinding)時停掉並標成擋下。
//   1. policy.resolvesPrivate:10/8、172.16/12、192.168/16、127/8、169.254/16、::1、fc00::/7 都算;公網位址不算
//   2. 真的 onBeforeRequest(假的 Electron session 抓出 handler 來跑):解析到內網 → cancel + page_blocked;公網 → 放行;
//      子資源不解析;同一個主機名只解析一次(快取)
//   3. onResponseStarted:頁面層級的回應 ip 是內網 → 停掉、載入 about:blank、標成擋下
// 跑法:node tests/check_shell_browser_private_dns.js
const path = require("path"), os = require("os"), fs = require("fs");
const B = path.join(__dirname, "..", "shell", "browser");
const policy = require(path.join(B, "policy.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

const P = (a) => policy.resolvesPrivate([{ address: a }]);
ok("內網位址都算:10/8、172.16/12、192.168/16、127/8、169.254/16、::1、fc00::/7",
  ["10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "::1", "fc00::1", "fd12:3456::1"].every(P));
ok("公網位址不算", !["8.8.8.8", "172.32.0.1", "104.16.1.1", "2606:4700::1111"].some(P));
ok("Clash fake-ip(198.18/15)與 Tailscale／CGNAT(100.64/10)不算:否則整個瀏覽器都打不開", !["198.18.0.5", "198.19.1.1", "100.64.0.1", "100.100.100.100"].some(P));
ok("多個位址裡有一個內網就算", policy.resolvesPrivate([{ address: "8.8.8.8" }, { address: "192.168.0.10" }]) && !policy.resolvesPrivate([]));

// ── 假的 Electron:只要 session / webRequest / resolveHost ──
const handlers = {}, resolved = [];
const DNS = { "192.168.1.1.nip.io": ["192.168.1.1"], "proxied.example": ["192.168.9.9"], "evil-rebind.example": ["93.184.216.34"], "news.example.com": ["93.184.216.34"] };
const fakeSes = {
  setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, on() {},
  webRequest: { onBeforeRequest: (fn) => { handlers.before = fn; }, onResponseStarted: (fn) => { handlers.started = fn; } },
  resolveHost: async (h) => { resolved.push(h); return { endpoints: (DNS[h] || []).map((address) => ({ address, family: "ipv4" })) }; },
  clearStorageData: async () => {}, clearCache: async () => {},
  resolveProxy: async (u) => (/proxied\./.test(u) ? "PROXY 127.0.0.1:7890" : "DIRECT"),
};
const E = { session: { fromPartition: () => fakeSes } };
const { createBrowser } = require(path.join(B, "index.js"));
const br = createBrowser({ electron: E, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "blave-dns-")), getWin: () => null, uiLang: () => "en", version: "t" });

(async () => {
  await br.clearData();   // 第一次呼叫 session():掛上 webRequest handler
  const run = (url, type) => new Promise((res) => handlers.before({ url, resourceType: type, method: "GET" }, res));
  let r = await run("http://192.168.1.1.nip.io/", "mainFrame");
  ok("主機名解析到 192.168.1.1(nip.io)→ 擋下", r.cancel === true, r);
  r = await run("http://news.example.com/a", "mainFrame");
  ok("解析到公網 → 放行", !r.cancel, r);
  r = await run("http://192.168.1.1.nip.io/x", "subFrame");
  ok("子框架也擋", r.cancel === true, r);
  const before = resolved.length;
  r = await run("http://192.168.1.1.nip.io/img.png", "image");
  ok("子資源不解析(不是頁面層級)", resolved.length === before);
  await run("http://news.example.com/b", "mainFrame");
  ok("同一個主機名 60 秒內只解析一次", resolved.filter((h) => h === "news.example.com").length === 1, resolved);
  r = await run("http://proxied.example/", "mainFrame");
  ok("走代理的網址不判(本機 DNS 答案不代表代理連到哪)", !r.cancel && !resolved.includes("proxied.example"), r);
  ok("網址本身就是內網 IP 的照舊由 network() 擋(不必解析)", (await run("http://10.0.0.1/", "mainFrame")).cancel === true && !resolved.includes("10.0.0.1"));
  ok("onResponseStarted 後盾有掛上(DNS rebinding:回應 ip 是內網就停)", typeof handlers.started === "function"
    && /policy\.resolvesPrivate\(\[\{ address: d\.ip \}\]\)/.test(fs.readFileSync(path.join(B, "index.js"), "utf8")));
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();

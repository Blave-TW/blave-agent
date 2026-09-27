// 來源快照與每輪瀏覽紀錄(不 require electron;tests/check_shell_browser_snapshots.js)。
// 契約:.claude/output/specs/desktop-browser-agent-tools-2026-09-26.md §5.5。
//   state/browser-snapshots/<session>/<snapshot_id>/{shot.webp|shot.png, page.md, meta.json}(0600)+ <session>/turns.jsonl(每輪一列,重開 app 時重建聊天裡的瀏覽區塊)。
//   不上傳、不進報告公開分享。保留:每 session 200 份、全體 1 GB,超過從最舊刪;刪對話連快照一起刪。
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PER_SESSION = 200, TOTAL_BYTES = 1024 * 1024 * 1024;
const SID_RE = /^desktop-[a-z0-9]{4,16}$/, SNAP_RE = /^s[0-9a-f]{16}$/;

function createSnapshots(root, limits) {
  const L = Object.assign({ perSession: PER_SESSION, totalBytes: TOTAL_BYTES }, limits || {});
  const dirOf = (sid) => path.join(root, sid);
  const mk = (d) => fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const write = (f, data) => fs.writeFileSync(f, data, { mode: 0o600 });

  function list(sid) {
    let names = []; try { names = fs.readdirSync(dirOf(sid)).filter((n) => SNAP_RE.test(n)); } catch (_) { return []; }
    return names.map((n) => { let at = 0; try { at = JSON.parse(fs.readFileSync(path.join(dirOf(sid), n, "meta.json"), "utf8")).at || 0; } catch (_) { /* 壞檔當最舊 */ } return { sid, id: n, at }; });
  }
  function size(d) { let s = 0; try { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); const st = fs.statSync(f); s += st.isDirectory() ? size(f) : st.size; } } catch (_) { /* 不在了 */ } return s; }
  function prune(sid) {
    const mine = list(sid).sort((a, b) => a.at - b.at);
    while (mine.length > L.perSession) { const o = mine.shift(); fs.rmSync(path.join(dirOf(o.sid), o.id), { recursive: true, force: true }); }
    let all = []; try { for (const s of fs.readdirSync(root)) if (SID_RE.test(s)) all = all.concat(list(s)); } catch (_) { return; }
    all.sort((a, b) => a.at - b.at);
    let total = all.reduce((n, x) => n + size(path.join(dirOf(x.sid), x.id)), 0);
    while (total > L.totalBytes && all.length) { const o = all.shift(); const d = path.join(dirOf(o.sid), o.id); total -= size(d); fs.rmSync(d, { recursive: true, force: true }); }
  }

  return {
    /** 存一份;回 snapshot_id 或 null。image = { data: Buffer, ext: "webp"|"png" } 或 null。 */
    save(sid, { url, title, markdown, image, turn }) {
      if (!SID_RE.test(String(sid))) return null;
      try {
        const id = "s" + crypto.randomBytes(8).toString("hex"), d = path.join(dirOf(sid), id);
        mk(d);
        write(path.join(d, "meta.json"), JSON.stringify({ url: String(url).slice(0, 2000), title: String(title || "").slice(0, 300), at: Date.now(), turn: turn || null, image: image ? "shot." + image.ext : null }));
        write(path.join(d, "page.md"), String(markdown || "").slice(0, 400000));
        if (image && (image.ext === "webp" || image.ext === "png")) write(path.join(d, "shot." + image.ext), image.data);
        prune(sid);
        return id;
      } catch (_) { return null; }
    },
    /** 讀一份給快照檢視:{ url, title, at, markdown, image: dataURI|null } 或 null。 */
    load(sid, id) {
      if (!SID_RE.test(String(sid)) || !SNAP_RE.test(String(id))) return null;
      const d = path.join(dirOf(sid), id);
      try {
        const m = JSON.parse(fs.readFileSync(path.join(d, "meta.json"), "utf8"));
        let image = null;
        if (m.image === "shot.webp" || m.image === "shot.png") { try { image = "data:image/" + m.image.slice(5) + ";base64," + fs.readFileSync(path.join(d, m.image)).toString("base64"); } catch (_) { /* 圖被清掉了 */ } }
        return { url: m.url, title: m.title, at: m.at, markdown: fs.readFileSync(path.join(d, "page.md"), "utf8"), image };
      } catch (_) { return null; }
    },
    /** 一輪結束記一列(聊天重建用)。rows = [{id,url,title,status,snapshot_id}] */
    logTurn(sid, row) {
      if (!SID_RE.test(String(sid))) return;
      try { mk(dirOf(sid)); fs.appendFileSync(path.join(dirOf(sid), "turns.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 }); } catch (_) { /* 寫不進去只是重開後看不到這一輪的區塊 */ }
    },
    turns(sid) {
      if (!SID_RE.test(String(sid))) return [];
      let lines = []; try { lines = fs.readFileSync(path.join(dirOf(sid), "turns.jsonl"), "utf8").split("\n").filter(Boolean); } catch (_) { return []; }
      const out = []; for (const l of lines.slice(-200)) { try { out.push(JSON.parse(l)); } catch (_) { /* 壞列跳過 */ } } return out;
    },
    /** favicon:<session>/favicons/<sha1(host)>.json(0600),內容 { host, data }——data 是已經驗過 mime 與大小的 data URL */
    saveFavicon(sid, host, dataURI, plate) {
      if (!SID_RE.test(String(sid)) || !/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(String(dataURI)) || dataURI.length > 100000) return false;
      try {
        const d = path.join(dirOf(sid), "favicons"); mk(d);
        write(path.join(d, crypto.createHash("sha1").update(String(host)).digest("hex") + ".json"), JSON.stringify({ host: String(host).slice(0, 300), data: dataURI, plate: !!plate }));
        return true;
      } catch (_) { return false; }
    },
    favicons(sid) {
      const out = {}; if (!SID_RE.test(String(sid))) return out;
      const d = path.join(dirOf(sid), "favicons");
      let names = []; try { names = fs.readdirSync(d).filter((n) => /^[0-9a-f]{40}\.json$/.test(n)).slice(0, 500); } catch (_) { return out; }
      for (const n of names) {
        try { const j = JSON.parse(fs.readFileSync(path.join(d, n), "utf8")); if (typeof j.host === "string" && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(String(j.data))) out[j.host] = { data: j.data, plate: j.plate === true }; } catch (_) { /* 壞檔跳過 */ }
      }
      return out;
    },
    removeSession(sid) { if (SID_RE.test(String(sid))) fs.rmSync(dirOf(sid), { recursive: true, force: true }); },
    clearAll() { try { for (const s of fs.readdirSync(root)) if (SID_RE.test(s)) fs.rmSync(dirOf(s), { recursive: true, force: true }); } catch (_) { /* 目錄不存在 */ } },
    prune,
  };
}

module.exports = { createSnapshots, PER_SESSION, TOTAL_BYTES };

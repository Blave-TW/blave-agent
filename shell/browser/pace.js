// 動態收斂(canon 電腦版內建瀏覽器 第 9 條「密集判定」):agent 連續操作時,刻意設計的
// 動態(讀取帶掃動、游標滑行、點擊環、逐字、平滑捲)本身就是「畫面一直在動」——密集時收成瞬間模式。
// 規則(全在 app 端自己的時鐘判,不加 runtime 欄位):
//   - 下一動作在前一動作「結束」後 1.2s 內到達,或前一動作還沒結束 → 密集,該動作起用瞬間模式
//   - 一串的第一個動作永遠完整效果
//   - 瞬間模式維持到「結束後 3s 沒新動作」才回完整效果
//   - 「結束」按動作類型定義(讀=帶落定、點=點擊落地不含環 0.45s、填=填完、捲=捲完;
//     瞬間模式下=事件到達即結束)——由呼叫端在對的時刻呼叫 end()
// 純函式工廠,tests/check_shell_browser_pace.js 直接跑。
"use strict";

const DENSE_GAP_MS = 1200;
const EXIT_IDLE_MS = 3000;

function createPace(clock) {
  const now = clock || (() => Date.now());
  let mode = "full", running = 0, endAt = null;
  return {
    /** 動作到達。回 { mode: "full"|"instant", cut: 前一動作還在播(要把它的標記跳終態) } */
    arrive() {
      const t = now();
      const cut = running > 0;
      const gap = cut ? 0 : endAt === null ? Infinity : t - endAt;
      mode = gap <= (mode === "instant" ? EXIT_IDLE_MS : DENSE_GAP_MS) ? "instant" : "full";
      running++;
      return { mode, cut: cut && mode === "instant" };
    },
    /** 這個動作「結束」了(定義見上)。 */
    end() { running = Math.max(0, running - 1); endAt = now(); },
  };
}

module.exports = { createPace, DENSE_GAP_MS, EXIT_IDLE_MS };

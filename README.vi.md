# Blave Agent

## Không gian làm việc quant cho AI agent

Xây dựng chiến lược, backtest và giao dịch thật với Claude Code hoặc Codex. Miễn phí, mã nguồn mở.

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Português](README.pt.md) | **Tiếng Việt**

<a href="https://download.blave.org/desktop/mac/Blave-universal.dmg"><img src="docs/readme-dl-mac.vi.png" alt="Tải cho Mac" width="177"></a>&nbsp;&nbsp; <a href="https://download.blave.org/desktop/win/Blave-Setup.exe"><img src="docs/readme-dl-win.vi.png" alt="Tải cho Windows" width="177"></a>

> Bản dịch này dịch từ README tiếng Anh tại commit [`b2584e3`](https://github.com/Blave-TW/blave-agent/blob/b2584e3/README.md) và chỉ gồm các phần ít thay đổi. Sàn giao dịch và dữ liệu, đám mây, cấu trúc thư mục, cách đóng góp và ghi chú cho người bảo trì xem ở [bản tiếng Anh](README.md). Nếu có chỗ khác nhau, bản gốc tiếng Anh là chuẩn.

https://github.com/user-attachments/assets/7b33edb7-9c65-4e19-854a-40295c6e8b74

[Bắt đầu nhanh](#quick-start) · [Vẫn chạy khi tắt máy](https://blave.org/agent/vi)

Nếu thấy hữu ích, hãy Star repo — và bật Watch › Releases để được báo khi có phiên bản mới.

## Điểm khác biệt

Claude Code hoặc Codex có thể viết một bot giao dịch. Phần khó là cho nó chạy thật. Trong terminal, mỗi chiến lược là một thư mục script cùng một đoạn hội thoại, và khi đã có hơn vài cái thì rất khó theo dõi. Tự nối giao dịch tự động nghĩa là bạn phải tự lo lịch chạy, API của sàn, đối soát vị thế, khởi động lại và key. Blave Agent chính là phần còn thiếu đó.

### Chiến lược của bạn nằm trong một app, không rải rác thành các script

![Một chiến lược breakout BTC trong app: các thẻ backtest, giao dịch, quét tham số, kiểm tra ngoài mẫu và code, bên cạnh là nhận định của agent](docs/readme-backtest.png)

Mỗi chiến lược nằm ở thanh bên, kèm backtest, các giao dịch, quét tham số, kiểm tra ngoài mẫu, code và các phiên bản đã lưu. Khôi phục một phiên bản cũ từ danh sách, và đặt mức giao dịch cho từng chiến lược trên trang **Portfolio** (danh mục).

### Giao dịch tự động đã được nối sẵn

- **Kết nối sàn:** Binance, OKX, Bybit, BingX, Gate.io, hoặc President Futures trên Windows. Key được kiểm tra với sàn trước, và key có thể rút tiền sẽ bị từ chối (Gate.io không báo quyền này, nên bạn tự kiểm tra).
- **Đặt số tiền, nhấn Start trading** (bắt đầu giao dịch). App chạy từng chiến lược theo lịch và đưa tài khoản dần về vị thế mục tiêu. Mọi lần thử đặt lệnh đều được ghi lại (`state/audit.jsonl`).
- **Pause trading (keep positions)** (tạm dừng giao dịch, giữ vị thế) từ thanh menu (khay hệ thống trên Windows). Sau khi thoát và mở lại app, không có giao dịch nào cho đến khi bạn nhấn **Start trading** lần nữa.
- **Giao dịch giấy** (paper trading) không cần key.

### Backtest có kiểm tra overfitting và tính phí thật

Overfitting: tham số chỉ tình cờ khớp với dữ liệu quá khứ.

- **p-value MCPT** cho mỗi lần backtest Type A (`lib/validation.py`): dữ liệu bị xáo trộn có làm được tốt như vậy không?
- **Quét tham số** tìm một cao nguyên, không phải một ô tốt nhất (`lib/param_scan.py`); **walk-forward** cho kết quả ngoài mẫu (`lib/walk_forward.py`).
- **Phí thật:** phí bằng 0 sẽ bị cảnh báo (`lib/quality_check.py`).
- **Một ý tưởng, một lần backtest:** kết quả kém được báo đúng như vậy, không âm thầm chỉnh lại tham số (*Iteration Brakes* trong [`AGENTS.md`](AGENTS.md)).

### Chưa có ý tưởng? Agent tìm trên web cho bạn

![Agent tìm ý tưởng chiến lược BTC và ETH trên khoảng chục trang web trong trình duyệt tích hợp](docs/readme-browser.png)

Nhấn **Search the Web for Ideas** (tìm ý tưởng trên web) và agent sẽ đọc khoảng chục trang web, rồi mang về ba ý tưởng có thể backtest, mỗi ý tưởng kèm quy tắc vào lệnh, thoát lệnh và URL nguồn. Chọn một ý tưởng, agent sẽ xây dựng và backtest nó. Các trang agent đọc được mở trong trình duyệt tích hợp của app, ngay trên màn hình của bạn; trang tài khoản của sàn và địa chỉ mạng nội bộ bị chặn.

<a id="quick-start"></a>

## Bắt đầu nhanh

Tải app cho [macOS](https://download.blave.org/desktop/mac/Blave-universal.dmg) hoặc [Windows](https://download.blave.org/desktop/win/Blave-Setup.exe) (macOS 13 trở lên, hoặc Windows 10/11 x64) rồi mở lên.

Lần mở đầu tiên, bạn chọn AI nào chạy agent:

- **Claude Code hoặc Codex của chính bạn.** Không cần tài khoản Blave; Blave không thu phí AI.
- **Key DeepSeek của chính bạn.** DeepSeek tính phí trực tiếp với bạn. Key nằm trong keychain của máy này và không bao giờ đến tay agent.
- **Blave AI.** Đăng nhập bằng tài khoản Blave; tính phí theo mức dùng.

Sau đó, hãy nói ý tưởng của bạn:

- "Backtest BTCUSDT khung 4h: mua khi SMA 20 kỳ cắt lên trên SMA 60 kỳ, đứng ngoài khi cắt xuống lại. Phí 0.05% mỗi chiều."
- "Quét cả hai độ dài SMA của chiến lược đó và cho tôi xem cao nguyên nằm ở đâu."

Trước khi viết code, agent xếp mỗi ý tưởng vào một trong ba loại:

| Loại | Là gì | Backtest |
|---|---|---|
| A | Một mã cố định trên một khung thời gian cố định; một vị thế (mua / bán / đứng ngoài) | Bắt buộc |
| C | Một danh mục: N mã và một vector tỷ trọng có tổng tối đa là 1, tái cân bằng theo lịch | Bắt buộc |
| B | Mọi thứ còn lại: bộ lọc, lưới, chênh lệch giá, cảnh báo, thực thi một lần | Không |

<details>
<summary>Ghi chú theo nền tảng</summary>

- App macOS đóng gói là bản universal (chip Apple và Intel). Windows: các phiên bản Electron 44 hỗ trợ; ARM chưa kiểm thử. Trình cài đặt Windows chưa có chữ ký mã, nên lần cài đầu tiên SmartScreen sẽ cảnh báo: chọn More info › Run anyway.
- Phiên bản Node.js: `shell/package.json` › `engines`. App đóng gói có sẵn Python 3.12 riêng; khi chạy từ mã nguồn, Python của hệ thống (`python3`, hoặc `python` trên Windows) được dùng để tạo venv.
- Codex đi kèm trong app ChatGPT — “ChatGPT” trên Microsoft Store với Windows (`winget install --id 9PLM9XGG6VKS -s msstore`), ChatGPT.app trên Mac. Trên Windows, tạm thời tránh các bản npm `@openai/codex` 0.161–0.162.1 (sandbox của chúng bị lỗi).
- Với Claude Code hoặc Codex của chính bạn, app chỉ khởi chạy CLI; thông tin đăng nhập vẫn nằm ở CLI. Key DeepSeek được lưu mã hóa trên Windows, và app chuyển tiếp yêu cầu của agent ngay trên máy.
- `npm.cmd` vẫn chạy được khi chính sách thực thi của PowerShell chặn script `npm`.
- Giao diện theo ngôn ngữ hệ thống (tiếng Anh hoặc tiếng Trung phồn thể). Để chỉ định: `BLAVE_LANG=en npm start` (PowerShell: `$env:BLAVE_LANG="en"; npm.cmd start`).

</details>

### Chạy từ mã nguồn

Bạn cần macOS 13 trở lên hoặc Windows 10/11 (x64), Node.js 22.12 trở lên, Python 3 trong `PATH`, và một trong các thứ sau: Claude Code hoặc Codex đã đăng nhập, một API key DeepSeek, hoặc một tài khoản Blave.

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

Trên Windows, chạy `npm.cmd install` và `npm.cmd start` trong PowerShell.

## Tin mới

Thay đổi của từng phiên bản xem ở [Releases](https://github.com/Blave-TW/blave-agent/releases).

## An toàn và giới hạn

- **Key:** chỉ cấp quyền đọc và giao dịch. Key có quyền rút tiền sẽ bị từ chối khi kết nối (Binance, OKX, BingX, Bybit); Gate.io không trả về thông tin quyền này, nên hãy tự kiểm tra. Key nằm trong `.env` của workspace trên máy tính của bạn (`~/Blave/workspace/.env`, `%USERPROFILE%\Blave\workspace\.env` trên Windows) hoặc trên máy chủ đám mây riêng của bạn, hoặc được Blave lưu dạng mã hóa khi liên kết trên trang web. Agent đọc được `.env` đó; quy tắc của nó cấm in ra giá trị của key (`references/exchange-connect.md`).
- **Số tiền đầu tư và việc tiếp tục giao dịch do chính bạn làm,** trên trang Auto trading (giao dịch tự động) của bản máy tính hoặc trên workspace web. Agent sẽ từ chối làm thay, kể cả khi được yêu cầu; việc duy nhất nó luôn được tự làm là kích hoạt kill switch.
- **Trên bản máy tính, lệnh chỉ được gửi khi Blave đang chạy.** Sau khi thoát rồi mở lại, giao dịch vẫn tạm dừng cho đến khi bạn nhấn **Start trading**.
- **Kiểm tra rồi mới báo:** lệnh được truy vấn lại từ sàn trước khi agent nói lệnh đã được đặt, và mọi lần thử đặt lệnh đều được ghi vào `state/audit.jsonl`.
- Backtest mô tả quá khứ. MCPT và quét tham số làm giảm khả năng thứ bạn đang thấy chỉ là may mắn; chúng không loại bỏ được khả năng đó. Không có nội dung nào ở đây là tư vấn đầu tư, và giao dịch có thể làm bạn mất toàn bộ tiền.

## Chính sách ký mã

Bản Windows hiện chưa có chữ ký mã: chúng tôi đã đăng ký chương trình mã nguồn mở của [SignPath Foundation](https://signpath.org), và cho đến khi được duyệt, trình cài đặt Windows chưa được ký. Sau khi được duyệt: chữ ký mã miễn phí trên Windows do [SignPath.io](https://signpath.io) cung cấp, chứng chỉ do SignPath Foundation cấp. Các bản phát hành được build bởi workflow GitHub Actions công khai trong repo này từ một commit có gắn tag; mỗi yêu cầu ký đều do chủ sở hữu repo phê duyệt. Vai trò: tác giả và người review — các người bảo trì có quyền ghi; người phê duyệt — chủ sở hữu repo. Chương trình này sẽ không chuyển bất kỳ thông tin nào cho bên thứ ba, ngoại trừ như mô tả trong [chính sách quyền riêng tư](https://blave.org/disclaimer/vi/privacy_policy). Bản macOS được ký và notarize bằng danh tính Apple của chính Blave.

## Giấy phép

**Apache-2.0** — xem [`LICENSE`](LICENSE) và [`NOTICE`](NOTICE). Bạn có thể sử dụng, sửa đổi và phân phối lại, kể cả cho mục đích thương mại; có kèm cấp quyền sáng chế. "Blave" và logo Blave là nhãn hiệu: hãy đổi tên bản fork của bạn.

**Chiến lược bạn viết là của bạn.** Mọi thứ trong `strategies/` không thuộc dự án này và giấy phép không áp dụng cho chúng. Các phần trả phí — máy chủ đám mây, dữ liệu thị trường và LLM proxy của Blave — là dịch vụ của blave.org và không nằm trong repo này.

Claude Code và Codex là sản phẩm của các chủ sở hữu tương ứng. Blave Agent không liên kết với họ và không được họ bảo trợ.

---

## Dành cho người bảo trì và các máy hiện có

Ghi chú cho người bảo trì xem ở bản tiếng Anh: [README.md › For maintainers and existing machines](README.md#for-maintainers-and-existing-machines)

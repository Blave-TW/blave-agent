# Blave Agent

**Không gian làm việc quant**

## Biến agent của bạn thành một quant

Miễn phí, mã nguồn mở. Kết nối Claude Code hoặc Codex của bạn. Bạn nói ý tưởng; nó viết chiến lược, chạy backtest và giao dịch tự động.

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Português](README.pt.md) | **Tiếng Việt**

> Bản dịch này dịch từ README tiếng Anh tại commit [`d2c342a`](https://github.com/Blave-TW/blave-agent/blob/d2c342a/README.md) và chỉ gồm các phần ít thay đổi. Tin mới, sàn giao dịch và dữ liệu, đám mây, cấu trúc thư mục, cách đóng góp và ghi chú cho người bảo trì xem ở [bản tiếng Anh](README.md). Nếu có chỗ khác nhau, bản gốc tiếng Anh là chuẩn.

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![Platform: macOS | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

https://github.com/user-attachments/assets/7b33edb7-9c65-4e19-854a-40295c6e8b74

[Tải cho macOS](https://github.com/Blave-TW/blave-agent/releases/latest) · [Tải cho Windows](https://download.blave.org/desktop/win/Blave-Setup.exe) · [Bắt đầu nhanh (từ mã nguồn)](#quick-start) · [Vẫn chạy khi tắt máy](https://blave.org/agent/vi)

Nếu thấy hữu ích, hãy Star repo — và bật Watch › Releases để được báo khi có phiên bản mới.

## Điểm khác biệt

### Backtest có kiểm tra overfitting và tính phí thật

Overfitting: tham số chỉ tình cờ khớp với dữ liệu quá khứ.

- Mỗi lần backtest Type A, mặc định đều chạy kiểm định hoán vị Monte Carlo (MCPT, `lib/validation.py`) và ghi lại p-value: dữ liệu bị xáo trộn có làm được tốt như vậy không?
- Quét tham số (`lib/param_scan.py`) tìm một cao nguyên tham số mà cả vùng đều hiệu quả, không phải một ô tốt nhất.
- Walk-forward cuốn chiếu (`lib/walk_forward.py`) đo hiệu quả ngoài mẫu.
- Phí phải khớp với thị trường thật. Phí bằng 0 sẽ bị `lib/quality_check.py` đánh dấu và xử lý như một lỗi.
- Mặc định, mỗi ý tưởng chỉ backtest một lần. Kết quả kém thì báo đúng như vậy; agent không âm thầm chỉnh lại tham số cho đến khi con số trông đẹp (xem *Iteration Brakes* trong [`AGENTS.md`](AGENTS.md)).

### Biết được khi chạy thật có đúng là code đã backtest

Mỗi lần backtest sẽ chốt một phiên bản của chiến lược. Nếu code đang chạy thật không còn khớp với phiên bản đó, chiến lược sẽ bị gắn cờ — workspace trên web hiện "Đang chạy · tệp đã đổi" thay vì chỉ "Đang chạy". Cờ này không dừng chiến lược. Nó chỉ áp dụng cho các loại chiến lược có backtest (Type A và C), và chỉ với những chiến lược đã có phiên bản.

### Không có LLM trong vòng lặp đặt lệnh

Agent lo nghiên cứu và viết code. Các lần chạy theo lịch là code tất định trên một bộ lập lịch; `manager/reconciler.py` đưa tài khoản về các vị thế mục tiêu. Kill switch (`state/HALT`) chặn việc mở thêm rủi ro ngay ở tầng thư viện đặt lệnh, trong khi lệnh đóng vị thế và lệnh dừng lỗ vẫn đi qua.

### Báo cáo đọc tin tức trước

Hãy yêu cầu một bản tin buổi sáng, một báo cáo cuối phiên, một bản tóm tắt một mã hoặc một báo cáo nghiên cứu. Agent đọc tin tức trước khi viết — ít nhất ba trang khác nhau — và mọi biểu đồ đều vẽ từ chuỗi dữ liệu thật, không bao giờ từ trí nhớ của mô hình. Mỗi báo cáo kết thúc bằng một phần tóm tắt và một điều kiện mà nếu xảy ra sẽ chứng minh nhận định của nó sai. Bản đồ thanh lý vẽ phần đã thực sự bị thanh lý và phần ước tính của mô hình thành hai lớp, mỗi lớp đều ghi rõ.

### Trình duyệt bạn nhìn thấy được

Khi agent đọc web, nó dùng trình duyệt tích hợp trong app: trang nó đang đọc hiện trên màn hình của bạn, không nằm trong một tiến trình ẩn. Trang tài khoản của sàn và địa chỉ mạng nội bộ bị chặn. Với một URL thuộc trang web nó chưa ghé trong lượt này mà lại mang tham số dài, agent sẽ dừng lại và hỏi bạn trước khi mở.

<a id="quick-start"></a>

## Bắt đầu nhanh (từ mã nguồn)

Bạn cần:

- macOS 13 trở lên. App đóng gói là bản universal: chip Apple và Intel, một lần tải.
- Hoặc Windows 10, 11, x64 (các phiên bản Electron 44 hỗ trợ; ARM chưa kiểm thử). Trình cài đặt chưa có chữ ký mã, nên lần cài đầu tiên Windows sẽ cảnh báo: nhấn vào liên kết bên dưới đoạn mô tả, rồi nhấn nút mới hiện ra ở bên dưới.
- Node.js 22.12 trở lên, kèm npm (`shell/package.json` › `engines`)
- `python3` trong `PATH` của bạn. App đóng gói có sẵn Python 3.12 riêng; khi chạy từ mã nguồn, `python3` của hệ thống được dùng để tạo venv.
- Claude Code hoặc Codex đã cài và đăng nhập, hoặc một tài khoản Blave

```
git clone https://github.com/Blave-TW/blave-agent.git
cd blave-agent/shell
npm install
npm start
```

Lần mở đầu tiên, bạn chọn AI nào chạy agent:

- **Claude Code hoặc Codex của chính bạn.** Không cần tài khoản Blave, và Blave không thu phí AI. App chỉ khởi chạy CLI; thông tin đăng nhập Claude Code hoặc Codex của bạn vẫn nằm ở CLI.
- **Blave AI.** Đăng nhập bằng tài khoản Blave; tính phí theo mức dùng.

Sau đó, hãy nói ý tưởng của bạn. Ví dụ:

- "Backtest BTCUSDT khung 4h: mua khi SMA 20 kỳ cắt lên trên SMA 60 kỳ, đứng ngoài khi cắt xuống lại. Phí 0.05% mỗi chiều."
- "Lập một danh mục BTC, ETH và SOL tỷ trọng bằng nhau, tái cân bằng hằng tuần, rồi backtest."
- "Quét cả hai độ dài SMA của chiến lược đó và cho tôi xem cao nguyên nằm ở đâu."

Trước khi viết code, agent xếp mỗi ý tưởng vào một trong ba loại:

| Loại | Là gì | Backtest |
|---|---|---|
| A | Một mã cố định trên một khung thời gian cố định; một vị thế (mua / bán / đứng ngoài) | Bắt buộc |
| C | Một danh mục: N mã và một vector tỷ trọng có tổng tối đa là 1, tái cân bằng theo lịch | Bắt buộc |
| B | Mọi thứ còn lại: bộ lọc, lưới, chênh lệch giá, cảnh báo, thực thi một lần | Không |

Giao diện theo ngôn ngữ hệ thống (tiếng Anh hoặc tiếng Trung phồn thể). Để chỉ định: `BLAVE_LANG=en npm start`.

## Tin mới

Tin mới xem ở bản tiếng Anh: [README.md › News](README.md#news)

## An toàn và giới hạn

- **Key sàn được lưu ở đâu tùy vào nơi bạn dùng.** Bản máy tính: trong `.env` của workspace trên máy tính của bạn (`~/Blave/workspace/.env` trên macOS, `%USERPROFILE%\Blave\workspace\.env` trên Windows). Máy chủ đám mây: trong `.env` của workspace trên máy chủ riêng của bạn. Sàn liên kết trên trang web: key được Blave lưu dạng mã hóa. Agent đọc được `.env` của workspace; quy tắc của nó cấm in ra giá trị của key (`references/exchange-connect.md`). Chỉ cấp quyền đọc + giao dịch cho key, không bao giờ cấp quyền rút tiền. Key có quyền rút tiền sẽ bị từ chối khi kết nối (Binance, OKX, BingX, Bybit; bản máy tính, máy chủ đám mây và trang web đều như nhau). Gate.io hoàn toàn không trả về thông tin quyền này, nên với sàn này hãy tự kiểm tra.
- Số tiền đầu tư và việc tiếp tục giao dịch do chính bạn làm — trên trang Giao dịch tự động của bản máy tính, hoặc trên workspace web với máy chủ đám mây. Agent sẽ từ chối làm thay bạn, kể cả khi được yêu cầu. Việc duy nhất nó luôn được tự làm là kích hoạt kill switch.
- Trên bản máy tính, lệnh chỉ được gửi khi Blave đang mở; sau khi thoát rồi mở lại, giao dịch vẫn tạm dừng cho đến khi bạn nhấn Bắt đầu giao dịch.
- Agent kiểm tra rồi mới báo: sửa tệp xong sẽ đọc lại, đặt lệnh xong sẽ truy vấn lại sàn rồi mới nói lệnh đã được đặt. Mọi lần thử đặt lệnh đều được ghi vào `state/audit.jsonl`.
- Backtest mô tả quá khứ. Nó không dự đoán hay bảo đảm kết quả tương lai. MCPT kiểm tra kết quả có ý nghĩa thống kê hay không, còn quét tham số kiểm tra có overfitting hay không; cả hai chỉ giảm khả năng bạn bị backtest đánh lừa, và không cái nào loại bỏ được khả năng đó.
- Không có nội dung nào ở đây là tư vấn đầu tư. Giao dịch có thể thua lỗ, kể cả mất toàn bộ.

## Chính sách ký mã

Bản Windows hiện chưa có chữ ký mã: chúng tôi đã đăng ký chương trình mã nguồn mở của [SignPath Foundation](https://signpath.org), và cho đến khi được duyệt, trình cài đặt Windows chưa được ký. Sau khi được duyệt: chữ ký mã miễn phí trên Windows do [SignPath.io](https://signpath.io) cung cấp, chứng chỉ do SignPath Foundation cấp. Các bản phát hành được build bởi workflow GitHub Actions công khai trong repo này từ một commit có gắn tag; mỗi yêu cầu ký đều do chủ sở hữu repo phê duyệt. Vai trò: tác giả và người review — các người bảo trì có quyền ghi; người phê duyệt — chủ sở hữu repo. Chương trình này sẽ không chuyển bất kỳ thông tin nào cho bên thứ ba, ngoại trừ như mô tả trong [chính sách quyền riêng tư](https://blave.org/disclaimer/vi/privacy_policy). Bản macOS được ký và notarize bằng danh tính Apple của chính Blave.

## Giấy phép

**Apache-2.0** — xem [`LICENSE`](LICENSE) và [`NOTICE`](NOTICE). Bạn có thể sử dụng, sửa đổi và phân phối lại, kể cả cho mục đích thương mại; có kèm cấp quyền sáng chế. "Blave" và logo Blave là nhãn hiệu: hãy đổi tên bản fork của bạn.

**Chiến lược bạn viết là của bạn.** Những gì bạn (hoặc agent thay mặt bạn) viết trong `strategies/` không thuộc dự án này và giấy phép không áp dụng cho chúng.

Các phần trả phí không nằm trong repo này: máy chủ đám mây, dữ liệu thị trường và LLM proxy của Blave là dịch vụ của blave.org. Code này chạy miễn phí trên máy tính của bạn, với gói AI của chính bạn và nguồn dữ liệu của chính bạn.

Claude Code và Codex là sản phẩm của các chủ sở hữu tương ứng. Blave Agent không liên kết với họ và không được họ bảo trợ.

---

## Dành cho người bảo trì và các máy hiện có

Ghi chú cho người bảo trì xem ở bản tiếng Anh: [README.md › For maintainers and existing machines](README.md#for-maintainers-and-existing-machines)

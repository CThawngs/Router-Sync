# Danh sách kiểm tra thí điểm chạy thật v3
- **Phục vụ: S9** — Ranh giới cứng: đội bot dừng tuyệt đối ở `READY_FOR_OWNER_LIVE_PILOT`; **chỉ chủ dự án** trực tiếp chạy các bước dưới đây sau khi nhánh chính xanh CI (sổ tay đầy đủ: `docs/runbook/LIVE-E2E-v2.md`).
> **Quy tắc Tiền kiểm Bắt buộc (Đọc trước Bước 1):**
> - **Chọn Combo & `<ID_ROUTER>`:** Chọn combo ít phụ thuộc hoặc tạo riêng `rs-pilot` ngoài vòng xoay tải chính (**không** chọn `rs-fast` hay combo chính đang chạy tải thật); `<ID_ROUTER>` phải khớp đúng `routers[].id` trong `routersync.yaml` (ví dụ `omni` hoặc `nine`, không điền tên adapter `omniroute`/`9router`).
> - **Chọn Harness:** Chọn `Hermes` hoặc `OpenCode`; **không chọn `OpenMausBot` khi dàn bot đang chạy** (sửa `config.json` lúc chạy dễ làm gián đoạn phiên bot; `routines.json` và `bots.json` luôn bị chặn cứng).
> - **Lưu ý D26 (`9Router`):** Hàng combo `kind=null` cần `20–31 giây` (`<= 60 giây`) để phản ánh trên `GET /v1/models`; ghi riêng qua `--serving-reflection-ms`, **không** cộng vào `detectionLatencyMs`.
> - **Tách độ trễ C48:** `detectionLatencyMs` = bắt đầu quét tick → lần ghi `model_pending` đầu tiên (hoặc công bố chính thức → kế hoạch); **không** gộp thời gian chờ gỡ. `removalSettleMs` = lần vắng đầu tiên → gỡ thực tế, **không áp trần**. `observedScanIntervalMs` báo riêng chu kỳ quét.
> - **Cửa sổ không quan sát được:** `providerToFirstScanMs` luôn `null` kèm `unobservableWindow=provider-to-first-scan`; không suy đoán. Phiên live chỉ dùng thông báo first-party thật. Với thông báo đã có hiệu lực, `detectionLatencyMs` đo từ lượt quét hợp lệ đầu tiên đến plan đầu tiên. Ghi riêng `publicationToPlanMs` từ ngày công bố đến plan, không áp trần.
> - **Nhịp chờ vắng mặt:** lần quét hợp lệ đầu tiên (Day 0) ghi nhận vắng; chỉ loại khi đã có **ít nhất 3 lần quét hợp lệ ghi nhận vắng** và lần quét đủ điều kiện loại cách lần vắng đầu **ít nhất 24 giờ**, tôn trọng cổng 15 phút và backoff provider.
> - **Cờ mở khóa ghi thật:** Chỉ chủ dự án tự đặt `ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1` và `ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1` tạm thời trong phiên shell tương tác; tuyệt đối không lưu vào tệp cấu hình, kho mã hay lệnh của bot.
> - Các khối `sh` dùng chung cho PowerShell và Bash. Chạy tại thư mục chứa `routersync.yaml` của phiên thí điểm và thay các giá trị trong `<...>`. Dùng cùng một cấu hình và thư mục trạng thái suốt phiên.
> - Chọn `<STATE_DIR>` mới cho mỗi phiên thí điểm và ghi UTC lúc bắt đầu. Báo cáo mặc định đọc 30 ngày gần nhất; dùng `--pilot-started-at <ISO-8601>` để giới hạn theo phiên khi cần. PowerShell đặt `$env:ROUTERSYNC_STATE_DIR = "<STATE_DIR>"`, Bash đặt `export ROUTERSYNC_STATE_DIR="<STATE_DIR>"`.

0. Trong dashboard router, tự tạo `rs-pilot` ngoài vòng xoay tải với 10 model (9 còn trong danh mục và 1 ID cố ý không tồn tại ở provider). Gỡ 1/10 là đúng trần 10%. Ghi lại danh sách và thứ tự ban đầu.

1. Xác minh phiên đăng nhập tài khoản phát hành npm:
   ```sh
   npm whoami
   ```
   **Kết quả đúng:** Hiển thị đúng tên tài khoản npm của chủ dự án.
2. Sao lưu cấu hình harness vào tệp riêng `.pre-pilot.bak` trước khi áp.
   PowerShell `Copy-Item -LiteralPath "<DUONG_DAN_CONFIG_HARNESS_THAT>" -Destination "<DUONG_DAN_CONFIG_HARNESS_THAT>.pre-pilot.bak" -ErrorAction Stop`
   Bash `cp "<DUONG_DAN_CONFIG_HARNESS_THAT>" "<DUONG_DAN_CONFIG_HARNESS_THAT>.pre-pilot.bak"`
   **Kết quả đúng:** Bản sao harness tách khỏi `.routersync.bak`. Với router, dùng snapshot do RouterSync tạo ở Bước 12 và đối chiếu hàng combo ở Bước 19. Bỏ bản sao toàn DB vì phiên chỉ cần hoàn tác combo và DB đang chạy có WAL cùng dữ liệu sử dụng thay đổi liên tục.
3. Ghi SHA-256 trước áp cho tệp cấu hình harness.
   PowerShell `Get-FileHash -Algorithm SHA256 -LiteralPath "<DUONG_DAN_CONFIG_HARNESS_THAT>"`
   Bash `sha256sum "<DUONG_DAN_CONFIG_HARNESS_THAT>"`
   **Kết quả đúng:** Lưu SHA-256 để so ở Bước 20.
4. Chẩn đoán chỉ đọc cấu hình RouterSync và phụ thuộc vòng:
   ```sh
   routersync doctor --json
   ```
   **Kết quả đúng:** Mã thoát `0`, không có lỗi cấu hình hoặc phụ thuộc vòng.
5. Quét chỉ đọc một chu kỳ để làm mới `status.json` và `tick-catalog.json` (`0` ghi đích):
   ```sh
   routersync tick --mode observe --json
   ```
   **Kết quả đúng:** Mã thoát `0`, làm mới `<STATE_DIR>/status.json` và `<STATE_DIR>/tick-catalog.json`.
6. Chạy cổng tiền kiểm tự động chỉ đọc 7 mục trước khi mở khóa ghi thật:
   ```sh
   routersync live-check --router-target "router:<ID_ROUTER>/rs-pilot" --harness-target harness:hermes --harness-config-path "<DUONG_DAN_CONFIG_HARNESS_THAT>" --json
   ```
   **Kết quả đúng:** Mã thoát `0`, `status: "READY_FOR_OWNER_LIVE_PILOT"`, cả 7 mục đều `passed: true`.
7. Mở khóa ghi thật tạm thời trong phiên shell hiện tại.
   PowerShell `$env:ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE = '1'; $env:ROUTERSYNC_ALLOW_LIVE_HOME_WRITE = '1'`
   Bash `export ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1 ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1`
   **Kết quả đúng:** Hai biến chỉ có hiệu lực trong phiên shell tương tác hiện tại của chủ dự án.
8. Cấp sự đồng ý đứng bậc `propose` cho combo router thí điểm:
   ```sh
   routersync consent grant --target "router:<ID_ROUTER>/rs-pilot" --level propose
   ```
   **Kết quả đúng:** Gõ `consent` trên TTY; tạo chính sách đồng ý đứng có ký HMAC cho combo router.
9. Cấp sự đồng ý đứng bậc `propose` cho harness thí điểm:
   ```sh
   routersync consent grant --target harness:hermes --level propose
   ```
   **Kết quả đúng:** Gõ `consent` trên TTY; tạo chính sách đồng ý đứng có ký HMAC cho harness.
10. Xem trước kế hoạch khô cho combo router:
    ```sh
    routersync plan --json
    ```
    **Kết quả đúng:** Kế hoạch chỉ tác động lên `rs-pilot` và giữ model vắng mặt cho phần diễn tập. Cần một thay đổi thực để sinh biên nhận `propose`. Nếu kế hoạch không đổi hoặc gỡ model thử ở bước này, dừng trước khi áp.
11. Xem trước kế hoạch khô cho cấu hình harness:
    ```sh
    routersync apps plan --app hermes -c "<DUONG_DAN_CONFIG_HARNESS_THAT>" --json
    ```
    **Kết quả đúng:** In danh sách model dự kiến đồng bộ cho harness (`0` ghi đĩa).
12. Áp dụng có kiểm soát bậc `propose` lên combo router:
    ```sh
    routersync apply --write
    ```
    **Kết quả đúng:** Gõ `chay` trên TTY; lưu lại `SNAPSHOT_ID` và biên nhận `readBackVerified: true`.
13. Áp dụng có kiểm soát bậc `propose` lên cấu hình harness:
    ```sh
    routersync apps apply --app hermes -c "<DUONG_DAN_CONFIG_HARNESS_THAT>" --backup "<DUONG_DAN_CONFIG_HARNESS_THAT>.pre-pilot.bak" --write --json
    ```
    **Kết quả đúng:** Gõ `chay` trên TTY; bảo toàn chú thích tệp cấu hình và `readBackVerified: true`.
14. Nâng combo router thí điểm lên bậc `auto-safe`:
    ```sh
    routersync consent grant --target "router:<ID_ROUTER>/rs-pilot" --level auto-safe
    ```
    **Kết quả đúng:** Gõ `consent` trên TTY; nâng lên `auto-safe` nhờ biên nhận `propose` hợp lệ.
15. Nâng harness thí điểm lên bậc `auto-safe`:
    ```sh
    routersync consent grant --target harness:hermes --level auto-safe
    ```
    **Kết quả đúng:** Gõ `consent` trên TTY; nâng lên `auto-safe` nhờ biên nhận `propose` hợp lệ.
16. Chạy ít nhất hai `tick` ở bậc `auto-safe`, cách nhau ít nhất 15 phút và qua thời hạn backoff của provider nếu có. Ghi giờ bắt đầu và kết thúc **mỗi** tick bằng lệnh thời gian bên dưới, ngay trước và sau lệnh tick.
    PowerShell `Get-Date -Format o`
    Bash `date -u +'%Y-%m-%dT%H:%M:%SZ'`
    ```sh
    routersync tick --mode auto-safe --json
    ```
    **Kết quả đúng:** Cả hai lượt thực sự quét provider, `effectiveMode: "auto-safe"` và `tokens: 0`. Ghi kết quả sau hai lượt. Nếu model chỉ vắng mặt, nhánh này cần ít nhất 3 lần quét hợp lệ trong ít nhất 24 giờ từ lần vắng đầu tiên. Ghi riêng số model đã loại, `measuredCount`, `detectionLatencyMs` (kể cả khi vượt 60.000 ms), `removalSettleMs` (không áp trần) và `observedScanIntervalMs`.
17. Diễn tập kích hoạt cầu dao khẩn cấp `freeze`:
    ```sh
    routersync freeze --reason "live-pilot-drill"
    ```
    **Kết quả đúng:** Mã thoát `0`, `frozen: true` chặn tức thì mọi lệnh ghi tiếp theo.
18. Mở khóa cầu dao khẩn cấp `unfreeze` qua TTY:
    ```sh
    routersync unfreeze
    ```
    **Kết quả đúng:** Gõ `unfreeze` trên TTY; `frozen: false`.
19. Hoàn tác combo router về snapshot trước khi áp dụng:
    ```sh
    routersync rollback "<SNAPSHOT_ID>" --write
    ```
    **Kết quả đúng:** Gõ `chay` trên TTY. Đối chiếu các hàng combo được khôi phục với snapshot trước áp, bao gồm thứ tự model. Ghi kết quả đối chiếu vào biên bản.
20. Hoàn tác nguyên tử tệp cấu hình harness từ `.pre-pilot.bak` và đối chiếu SHA-256 gốc:
    ```sh
    routersync apps rollback --app hermes -c "<DUONG_DAN_CONFIG_HARNESS_THAT>" --backup "<DUONG_DAN_CONFIG_HARNESS_THAT>.pre-pilot.bak" --expected-sha256 "<SHA_256_BUOC_3>" --json
    ```
    **Kết quả đúng:** `restored: true`. Chạy lại lệnh băm Bước 3 trên tệp đã khôi phục và đối chiếu SHA-256 gốc.
21. Gỡ hai cờ ghi thật khỏi phiên shell.
    PowerShell `Remove-Item Env:ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE, Env:ROUTERSYNC_ALLOW_LIVE_HOME_WRITE`
    Bash `unset ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE ROUTERSYNC_ALLOW_LIVE_HOME_WRITE`
    **Kết quả đúng:** Hai biến môi trường ghi thật bị xóa hoàn toàn khỏi phiên shell.
22. Tổng hợp báo cáo nghiệm thu chỉ đọc 5 tiêu chí `S9`:
    ```sh
    routersync pilot-report -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --router-target "router:<ID_ROUTER>/rs-pilot" --harness-target harness:hermes --false-removals "<SO_LOAI_NHAM>" --unplanned-interventions "<SO_CAN_THIEP_NGOAI_KE_HOACH>" --json
    ```
    **Kết quả đúng:** `PASS` (mã thoát 0) khi đủ bằng chứng và cả 5 tiêu chí đạt. `INCOMPLETE` khi thiếu phép đo hoặc bằng chứng hoàn tác. `FAIL` khi có vi phạm hoặc bằng chứng hỏng. Đọc riêng khối `removalSettle` (`removalSettleMs`, `removalPaths`, `noticeOrigin`, `observedScanIntervalMs`) và xác nhận `providerToFirstScanMs: null`.

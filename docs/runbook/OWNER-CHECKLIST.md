# Danh sách Kiểm tra Thí điểm Chạy thật 1 Trang Cho Chủ dự án (`OWNER-CHECKLIST.md`)
- **Phục vụ: S9** — Ranh giới cứng: đội bot dừng tuyệt đối ở `READY_FOR_OWNER_LIVE_PILOT`; **chỉ chủ dự án** trực tiếp chạy các bước dưới đây sau khi nhánh chính xanh CI (sổ tay đầy đủ: `docs/runbook/LIVE-E2E-v2.md`).
> **Quy tắc Tiền kiểm Bắt buộc (Đọc trước Bước 1):**
> - **Chọn Combo Router:** Chọn combo ít phụ thuộc hoặc tạo riêng `rs-pilot` ngoài vòng xoay tải chính (**không** chọn `rs-fast` hay combo chính đang phục vụ lưu lượng thật).
> - **Chọn Harness:** Chọn `Hermes` hoặc `OpenCode`; **không chọn `OpenMausBot` khi dàn bot đang chạy** (sửa `config.json` lúc chạy dễ làm gián đoạn phiên bot; `routines.json` và `bots.json` luôn bị chặn cứng).
> - **Lưu ý D26 (`9Router`):** Hàng combo `kind=null` cần `20–31 giây` (`<= 60 giây`) để phản ánh trên `GET /v1/models`; ghi riêng qua `--serving-reflection-ms`, **không** cộng vào `detectionLatencyMs`.
> - **Cờ mở khóa ghi thật:** Chỉ chủ dự án tự đặt `ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1` và `ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1` tạm thời trong phiên shell tương tác; tuyệt đối không lưu vào tệp cấu hình, kho mã hay lệnh của bot.

1. Xác minh phiên đăng nhập tài khoản phát hành npm:
   ```sh
   npm whoami
   ```
   **Kết quả đúng:** Hiển thị đúng tên tài khoản npm của chủ dự án.
2. Sao lưu thủ công DB router (ra ngoài thư mục dữ liệu router) và tệp cấu hình harness sang đuôi `.pre-pilot.bak`:
   ```sh
   cp "<DUONG_DAN_ROUTER_DB>" "<THU_MUC_BACKUP_NGOAI_ROUTER>/router.pre-pilot.bak" && cp "<DUONG_DAN_CONFIG_HARNESS_THAT>" "<DUONG_DAN_CONFIG_HARNESS_THAT>.pre-pilot.bak"
   ```
   **Kết quả đúng:** Cả hai tệp sao lưu `.pre-pilot.bak` tồn tại nguyên vẹn tách biệt khỏi `.routersync.bak`.
3. Ghi nhận mã băm SHA-256 gốc của DB router và cấu hình harness:
   ```sh
   sha256sum "<DUONG_DAN_ROUTER_DB>" "<DUONG_DAN_CONFIG_HARNESS_THAT>"
   ```
   **Kết quả đúng:** Lưu lại 2 mã băm SHA-256 gốc để đối chiếu hoàn tác khớp từng byte.
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
   routersync live-check --router-target router:omniroute/rs-pilot --harness-target harness:hermes --harness-config-path "<DUONG_DAN_CONFIG_HARNESS_THAT>" --json
   ```
   **Kết quả đúng:** Mã thoát `0`, `status: "READY_FOR_OWNER_LIVE_PILOT"`, cả 7 mục đều `passed: true`.
7. Mở khóa ghi thật tạm thời trong phiên shell hiện tại (PowerShell đặt `$env:ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE="1"` và `$env:ROUTERSYNC_ALLOW_LIVE_HOME_WRITE="1"`):
   ```sh
   export ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1 ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1
   ```
   **Kết quả đúng:** Hai biến chỉ có hiệu lực trong phiên shell tương tác hiện tại của chủ dự án.
8. Cấp sự đồng ý đứng bậc `propose` cho combo router thí điểm:
   ```sh
   routersync consent grant --target router:omniroute/rs-pilot --level propose
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
    **Kết quả đúng:** In kế hoạch tất định chỉ tác động lên combo thí điểm (`0` ghi đĩa).
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
    routersync consent grant --target router:omniroute/rs-pilot --level auto-safe
    ```
    **Kết quả đúng:** Gõ `consent` trên TTY; nâng lên `auto-safe` nhờ biên nhận `propose` hợp lệ.
15. Nâng harness thí điểm lên bậc `auto-safe`:
    ```sh
    routersync consent grant --target harness:hermes --level auto-safe
    ```
    **Kết quả đúng:** Gõ `consent` trên TTY; nâng lên `auto-safe` nhờ biên nhận `propose` hợp lệ.
16. Chạy một chu kỳ `tick` tự động an toàn (`0` token LLM):
    ```sh
    routersync tick --mode auto-safe --json
    ```
    **Kết quả đúng:** Mã thoát `0`, `effectiveMode: "auto-safe"`, `tokens: 0`, độ trễ `<= 60000` ms.
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
    **Kết quả đúng:** Gõ `chay` trên TTY; `ok: true` khôi phục đúng các hàng combo ban đầu.
20. Hoàn tác nguyên tử tệp cấu hình harness từ `.pre-pilot.bak` và đối chiếu SHA-256 gốc:
    ```sh
    routersync apps rollback --app hermes -c "<DUONG_DAN_CONFIG_HARNESS_THAT>" --backup "<DUONG_DAN_CONFIG_HARNESS_THAT>.pre-pilot.bak" --json
    ```
    **Kết quả đúng:** `restored: true`, `byteIdenticalToPreApply: true` (khớp `100%` SHA-256 Bước 3).
21. Gỡ sạch hai cờ ghi thật khỏi phiên shell (PowerShell chạy `Remove-Item Env:ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE, Env:ROUTERSYNC_ALLOW_LIVE_HOME_WRITE`):
    ```sh
    unset ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE ROUTERSYNC_ALLOW_LIVE_HOME_WRITE
    ```
    **Kết quả đúng:** Hai biến môi trường ghi thật bị xóa hoàn toàn khỏi phiên shell.
22. Tổng hợp báo cáo nghiệm thu chỉ đọc 5 tiêu chí `S9`:
    ```sh
    routersync pilot-report --state-dir "<STATE_DIR>" --router-target router:omniroute/rs-pilot --harness-target harness:hermes --json
    ```
    **Kết quả đúng:** Mã thoát `0`, `status: "PASS"`, cả 5 tiêu chí `S9` đều đạt và `<STATE_DIR>` nguyên vẹn `100%`.

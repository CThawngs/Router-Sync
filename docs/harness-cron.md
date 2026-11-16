# Khảo sát & Hướng dẫn Tích hợp Cron với Harness (Hermes, DSH)

**Ngày khảo sát**: 2026-11-11  
**Môi trường khảo sát**: Windows 11 host (Hermes tại `%LOCALAPPDATA%\hermes`, DSH tại `~/.dsh`)  
**Mục tiêu**: Đánh giá khả năng tự động hóa chu kỳ quét `routersync tick` qua cron của harness mà không tiêu tốn token LLM (Zero-Token Invariant).

---

## 1. Kết quả kiểm tra thực tế trên host (Bằng chứng Tier A)

### 1.1. Hermes (`%LOCALAPPDATA%\hermes\`)
- **Bộ máy cron**: Có tại `%LOCALAPPDATA%\hermes\cron\` với tệp quản lý `jobs.json` và cơ sở dữ liệu lịch sử `executions.db`.
- **Hỗ trợ gọi lệnh/script không tốn token**: **CÓ (ĐÃ XÁC MINH)**.
  - Bằng chứng thực tế trích xuất trực tiếp từ `jobs.json`:
    ```json
    {
      "id": "<JOB-ID>",
      "name": "Disk-Guardian-1h",
      "prompt": "",
      "script": "disk_guardian.py",
      "no_agent": true,
      "schedule": {
        "kind": "cron",
        "expr": "0 * * * *",
        "display": "0 * * * *"
      },
      "repeat": {
        "times": null,
        "completed": 1462
      },
      "enabled": true,
      "state": "scheduled"
    }
    ```
  - Bằng chứng thực tế từ `executions.db`:
    - Tổng số bản ghi trong bảng `executions`: **1,000** (cửa sổ lưu trữ tối đa của Hermes).
    - Phân bổ theo `job_id`:
      - `<JOB-ID-1>` (`Disk-Guardian-1h`): **687** lượt thực thi trong cơ sở dữ liệu (tổng lũy kế `completed`: **1,462** lần theo `jobs.json`).
      - `<JOB-ID-2>` (`Zen Free Watchdog`): **166** lượt.
      - `<JOB-ID-3>`: **143** lượt.
      - Các job khác: 4 lượt.
- **Cơ chế**: Khi `no_agent: true`, scheduler của Hermes khởi động script trực tiếp dưới dạng tiến trình con của hệ điều hành, hoàn toàn không dispatch prompt tới LLM.
- **LƯU Ý AN TOÀN**: Agent **tuyệt đối không tự ý ghi đè hoặc chỉnh sửa** `%LOCALAPPDATA%\hermes\cron\jobs.json` của người dùng. Mọi cấu hình phải do chủ dự án tự thêm hoặc qua giao diện/CLI của Hermes.

### 1.2. DeepSeek Harness — DSH (`~\.dsh\`)
- **Kiểm tra lệnh CLI**: gọi `dsh --help`:
  ```text
  Usage: dsh [--profile] <name> [options] [app-args...]
         dsh plugin --profile <name> <pnpm-args...>

  dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch
  layers under your own overrides.

  Arguments:
    args                           arguments for the booted profile's app (see:
                                   dsh --profile <name> --help)

  Options:
    -V, --version                  output the version number
    --profile <name>               the profile under $DSH_HOME/profiles to boot
    --from-default-profile <name>  initialize a new custom profile from a shipped
                                   profile template
    --patch <path>                 extra patch-list overlay applied after the
                                   profile layer (repeatable)
    --dump-config                  print the composed profile tree and exit
    --dump-config-schema           print JSON Schema for profile entries and
                                   patches without mounting
    --dump-default-config          print the profile tree without its user layer
                                   or --patch overlays and exit
  ```
- **Kết luận**: CLI của DSH chỉ hỗ trợ khởi động profile (`web`, `tui`, `headless`, `rescue`) và quản lý plugin. **CHƯA-XÁC-MINH** khả năng hỗ trợ cron nội bộ độc lập.
- **Khuyến nghị cho DSH**: Bắt buộc sử dụng bộ lập lịch của hệ điều hành qua `routersync schedule install` (Windows Task Scheduler hoặc cron hệ điều hành).

---

## 2. Cách tích hợp `routersync tick` với Hermes Cron (Zero-Token)

Để dùng Hermes cron điều phối `routersync tick`:

1. **Tạo script wrapper** tại `%LOCALAPPDATA%\hermes\scripts\routersync_tick.bat`:
   ```bat
   @echo off
   node "<REPO>\packages\cli\dist\index.js" tick --mode propose
   ```
   *(Dùng đường dẫn tuyệt đối tới `node` và `packages\cli\dist\index.js` để tránh phụ thuộc vào biến môi trường PATH của pnpm trong tiến trình con của Hermes).*

2. **Khai báo job** trong `%LOCALAPPDATA%\hermes\cron\jobs.json` do chủ dự án tự thêm theo mẫu:
   ```json
   {
     "id": "routersync-tick-15m",
     "name": "RouterSync-Tick-15m",
     "prompt": "",
     "script": "routersync_tick.bat",
     "no_agent": true,
     "enabled": true,
     "schedule": {
       "kind": "cron",
       "expr": "*/15 * * * *"
     }
   }
   ```
3. **Đặc tính đảm bảo**:
   - `no_agent: true`: 0 token LLM tiêu tốn.
   - Cổng 15 phút: Bỏ qua các lệnh gọi mạng trùng lặp nếu làm lại trong 15 phút (`requests=0`).
   - File lock: `~/.routersync/tick.lock` ngăn chặn thực thi song song nhiều tiến trình tick.

---

## 3. Tích hợp tương tác khi mở phiên Agent (MCP inbox_list & verify_requests)

Khi chủ dự án mở phiên trò chuyện với bất kỳ Agent nào (Hermes, DSH, Claude Code, Antigravity, OpenClaw):
- Không cần trigger quét live tốn thời gian/token.
- MCP Server của RouterSync cung cấp công cụ `inbox_list` và `verify_requests`:
  - `inbox_list`: Đọc tức thì các đề xuất mới từ `~/.routersync/inbox.json` do `tick` ghi sẵn:
    - `NEW-CANDIDATE`: Model mới phát hiện từ L1 scan hoặc L2/L3.
    - `ABSENT-UNCONFIRMED`: Model vắng mặt quá số chu kỳ ân hạn nhưng chưa có kiểm tra đơn lẻ.
    - `ABSENT-STABLE`: Gateway không hỗ trợ GET đơn lẻ đã vắng mặt ổn định.
    - `AUTH_ERROR`: Cảnh báo lỗi xác thực 401/403 cần kiểm tra khóa.
    - `NGHI-NGỪNG`: Model vắng mặt ở L1 nhưng L2 còn thông tin, nghi ngờ sắp ngừng.
    - `SẮP-NGỪNG`: L3 phát hiện thông báo ngừng hỗ trợ trong tương lai có thời hạn cụ thể.
    - `ĐÃ-XÁC-NHẬN-NGỪNG`: L3 phát hiện thông báo chính thức model đã ngừng hỗ trợ hoàn toàn.
    - `CHƯA-XÁC-MINH`: Model vắng mặt nhưng thiếu nguồn đối chiếu để kết luận.
  - `verify_requests`: Trả tối đa 10 mục cần tìm kiếm web kèm câu hỏi và gợi ý URL.
- Chi phí token khi mở phiên: **0 token quét mạng**.

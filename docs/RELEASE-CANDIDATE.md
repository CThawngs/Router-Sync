# RouterSync — Kế hoạch Phát hành & Cổng Cắt Bản (`RELEASE-CANDIDATE.md`)

- **Phục vụ:** `S10` (chuẩn hóa chính sách phát hành `1.0.0` và định danh lại `0.1.0` theo C45 §4 WP0)
- **Nguồn đặc tả:** `docs/SPEC.md` (`S1`–`S10`)
- **Công cụ chuẩn bị nâng phiên bản:** `tools/release/prepare-v1-release.mjs` (mặc định `--dry-run`; đội bot **không** tự nâng số phiên bản lên `main`, **không** tạo tag, **không** chạy `npm publish`)

---

## 1. Định danh lại `0.1.0` và Chiến lược Phát hành `1.0.0`

| Phiên bản | Trạng thái chính thức | Mục đích & Phạm vi | Quyền phát hành |
|---|---|---|---|
| **`0.1.0`** | **Bản chẩn đoán chỉ đọc — KHÔNG phát hành** *(Read-Only Diagnostic Snapshot, Unreleased)* | Ảnh chụp nền tảng M1–M4 (quét L1/L2/L3, lập kế hoạch tất định, 24 công cụ MCP chỉ đọc, grant/token/read-back trên combo thử nghiệm, đóng gói tarball 5 OS). Chưa đáp ứng mục tiêu tối cao S1–S9 nên **không đưa lên npm**. | Không phát hành |
| **`1.0.0-rc.1`** *(tùy chọn)* | **Ứng viên phát hành trên dist-tag `next`** *(sau khi hoàn tất `WP9`)* | Bản xem trước đầy đủ đặc tả `S1`–`S10` trên npm với dist-tag `next`, chỉ xuất bản nếu chủ dự án muốn kiểm thử cài đặt công khai trước khi cắt `1.0.0`. | **Chỉ chủ dự án** (`chờ chủ dự án`) |
| **`1.0.0`** | **Bản phát hành công khai đầu tiên (`latest`)** | Bản đầy đủ đặc tả `S1`–`S10` (`WP0`–`WP9`) sau khi chủ dự án hoàn tất đợt thí điểm chạy thật ở `WP9` và xác nhận đạt toàn bộ tiêu chí đo được. | **Chỉ chủ dự án** (`chờ chủ dự án`) |

> **Lý do giữ nguyên `0.1.0` trong `package.json` trong suốt `WP0`–`WP9`:** Bộ kiểm thử chấp nhận đóng gói (`test/acceptance/at-167-release-packaging.test.ts`) đang khóa kiểm tra phiên bản `0.1.0` trên nền hiện hành để tránh lệch phát hành sớm. Khi `WP9` hoàn tất và chủ dự án chốt cắt bản `1.0.0-rc.1` hoặc `1.0.0`, chủ dự án (hoặc vé cắt bản riêng được chủ dự án duyệt) chạy `tools/release/prepare-v1-release.mjs` với `--write` để nâng đồng bộ phiên bản workspace và cập nhật kiểm thử chấp nhận tương ứng.

---

## 2. Danh sách 8 gói công bố (`@routersync/*`) và 2 gói nội bộ

| STT | Tên gói npm | Thư mục workspace | `private` | Phiên bản nền | Đích phát hành |
|---:|---|---|---|---:|---:|
| 1 | `@routersync/adapter-sdk` | `packages/adapter-sdk` | `false` | `0.1.0` | `1.0.0` *(hoặc `1.0.0-rc.1`)* |
| 2 | `@routersync/core` | `packages/core` | `false` | `0.1.0` | `1.0.0` *(hoặc `1.0.0-rc.1`)* |
| 3 | `@routersync/sources` | `packages/sources` | `false` | `0.1.0` | `1.0.0` *(hoặc `1.0.0-rc.1`)* |
| 4 | `@routersync/adapter-9router` | `packages/adapter-9router` | `false` | `0.1.0` | `1.0.0` *(hoặc `1.0.0-rc.1`)* |
| 5 | `@routersync/adapter-omniroute` | `packages/adapter-omniroute` | `false` | `0.1.0` | `1.0.0` *(hoặc `1.0.0-rc.1`)* |
| 6 | `@routersync/daemon` | `packages/daemon` | `false` | `0.1.0` | `1.0.0` *(hoặc `1.0.0-rc.1`)* |
| 7 | `@routersync/cli` | `packages/cli` | `false` | `0.1.0` | `1.0.0` *(hoặc `1.0.0-rc.1`)* |
| 8 | `@routersync/mcp-server` | `packages/mcp-server` | `false` | `0.1.0` | `1.0.0` *(hoặc `1.0.0-rc.1`)* |
| — | `routersync` *(gói gốc monorepo)* | `.` | `true` | `0.1.0` | Đồng bộ phiên bản, **không publish** |
| — | `@routersync/ui` *(giao diện cục bộ)* | `packages/ui` | `true` | `0.1.0` | Đồng bộ phiên bản, **không publish** |

---

## 3. Cổng tiền điều kiện trước khi chủ dự án phát hành

Chủ dự án chỉ nên thực hiện phát hành khi toàn bộ các cổng sau đều **XANH**:

1. **Hoàn tất đủ 10 gói việc `WP0`–`WP9`** trong `docs/BACKLOG.md` với đủ 4 bằng chứng RACI (PR squash-merged bởi Ops, commit trên `main`, CI `main` 5 OS xanh ở `attempt=1`, gói bằng chứng `evidence/d1`, `evidence/d2`, `evidence/d3` đạt verifier chuẩn SẠCH).
2. **Thí điểm chạy thật `WP9` đạt 100% tiêu chí** do chính chủ dự án xác nhận trên mục tiêu thí điểm (1 combo + 1 tệp cấu hình harness qua `propose` → `auto-safe`, 0 model loại sai, hoàn tác khớp từng byte, độ trễ phát hiện và chi phí token nằm trong ngưỡng chấp nhận).
3. **Kiểm đóng gói & bảo mật sạch:**
   ```sh
   pnpm verify:release
   node tools/agent/pack-verify.mjs
   node tools/agent/security-audit.mjs
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```
4. **Quyền sở hữu scope `@routersync` trên npm** đã được chủ dự án thiết lập và đăng nhập (`npm whoami`), cập nhật ngày phát hành thực tế trong `CHANGELOG.md`.

---

## 4. Lệnh chuẩn bị & phát hành (Chỉ chủ dự án tự chạy)

### Bước 1 — Xem trước nâng phiên bản workspace (mặc định chỉ đọc `--dry-run`)

```sh
# Xem trước cắt bản xem trước 1.0.0-rc.1 (dist-tag next)
node tools/release/prepare-v1-release.mjs --target 1.0.0-rc.1 --dry-run

# Xem trước cắt bản chính thức 1.0.0 (dist-tag latest)
node tools/release/prepare-v1-release.mjs --target 1.0.0 --dry-run
```

### Bước 2 — Áp nâng phiên bản (chỉ chạy trên nhánh release sau WP9)

```sh
# Tùy chọn A: cắt bản 1.0.0-rc.1
node tools/release/prepare-v1-release.mjs --target 1.0.0-rc.1 --write

# Hoặc Tùy chọn B: cắt thẳng 1.0.0
node tools/release/prepare-v1-release.mjs --target 1.0.0 --write
```

Sau khi áp nâng phiên bản, chạy lại kiểm thử đầy đủ và kiểm đóng gói:

```sh
pnpm build
pnpm verify:release
node tools/agent/pack-verify.mjs
```

### Bước 3 — Gắn tag đơn lẻ tường minh & xuất bản lên npm (chỉ chủ dự án)

> **Quy tắc git an toàn:** Luôn gắn và đẩy **từng tag đơn lẻ tường minh** (tuyệt đối không đẩy hàng loạt nhánh hoặc toàn bộ tag một lúc).

#### Tùy chọn A — Phát hành bản xem trước `1.0.0-rc.1` lên dist-tag `next`

```sh
git tag -a v1.0.0-rc.1 -m "Release v1.0.0-rc.1"
git push origin v1.0.0-rc.1

# Xuất bản đúng 8 gói private=false theo thứ tự phụ thuộc lên dist-tag next
for pkg in adapter-sdk core sources adapter-9router adapter-omniroute daemon cli mcp-server; do
  pnpm --filter "./packages/${pkg}" publish --access public --tag next --no-git-checks
done
```

#### Tùy chọn B — Phát hành chính thức `1.0.0` lên dist-tag `latest`

```sh
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0

# Xuất bản đúng 8 gói private=false theo thứ tự phụ thuộc lên dist-tag latest
for pkg in adapter-sdk core sources adapter-9router adapter-omniroute daemon cli mcp-server; do
  pnpm --filter "./packages/${pkg}" publish --access public --no-git-checks
done
```

---

## 5. Hàng đợi `chờ chủ dự án`

1. Xác nhận/tạo tổ chức hoặc scope `@routersync` trên npm trước khi phát hành `1.0.0-rc.1` hoặc `1.0.0`.
2. Chọn mục tiêu thí điểm thật cho `WP9` (1 combo router + 1 tệp cấu hình harness) và tự chạy đợt thí điểm khi đội báo trạng thái "sẵn sàng chạy thật".
3. Quyết định đi thẳng `1.0.0` hay xuất bản `1.0.0-rc.1` lên dist-tag `next` trước, rồi trực tiếp chạy các lệnh gắn tag và `publish` ở Mục 4.

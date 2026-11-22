# Tạo combo `rs-fast` và `rs-max` trong 9Router

Hai danh sách này được lập **chỉ từ bước đã đo** (hai lượt C32). Không bước nào
được thêm vì "nghe là ngon". `rs-fast` ưu tiên tốc độ; `rs-max` dùng nhiều provider
và account nhất mà không đưa bước treo (`HANG`) hoặc bước chết (`DEAD`) vào.

## 1. Tạo combo trong dashboard 9Router

1. Vào dashboard 9Router → **Combos** → **New combo**.
2. Tên: `rs-fast` hoặc `rs-max`. Chọn chiến lược **Fallback** (`fallback`).
3. Dán danh sách bước từ `combo-rs.real.txt` (bản trên chat), **mỗi dòng một bước**,
   giữ nguyên thứ tự.
4. Lưu. Không cần restart router.

## 2. Kiểm nhanh (chỉ gọi combo)

```
node packages/cli/dist/index.js combos probe --mode combo \
  --combo rs-fast --yes-spend-tokens --repeat 5 --combo-timeout-sec 120
```

Làm tương tự với `rs-max`. Kết quả mong đợi: `OK` và header dưới vài giây. Nếu vẫn
`HANG`, xem `x-9r-models-cache` (phải `hit` đa số) và bước phục vụ trong `usageHistory`.

## 3. Dùng trong agent

Trỏ model của agent vào `rs-fast` (hoặc `rs-max`). Đây vẫn là combo 9Router, nên
giữ nguyên khả năng failover giữa các account/provider.

## 4. Xóa combo thử

Nếu không dùng, xóa combo trong dashboard. RouterSync không xóa giúp: mọi thao tác
ghi vào router cần chủ dự án tự làm.

## Giữ xoay vòng tài khoản, dùng fallback ở cấp combo

- Giữ nguyên cấu hình provider/account (nhiều tài khoản mỗi provider) — đây là nơi xoay vòng khi hết quota.
- Với `rs-fast` / `rs-max`, chọn **Fallback**; không copy chiến lược `round-robin` của `9Router-Agent` (combo treo lặp lại trong W1).
- Nếu muốn thử `round-robin`, đổi trong dashboard rồi đo lại bằng `routersync combos probe --mode combo --combo <tên> --yes-spend-tokens`.

## Lưu ý

- `rs-max` có nhiều bước hơn nhưng vẫn nằm trong một combo — router thử theo thứ tự.
- Các bước `HANG`/`DEAD` nằm ở danh sách "nên loại" trong `evidence/c37/REPORT.md`;
  không tự đưa lại vào combo.
- Nếu muốn thêm bước mới, chạy `routersync combos reliability` rồi lập lại danh sách.